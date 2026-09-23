"""Retention cleanup execution for delivery logs, validation runs, and backup temp files.

Design notes
------------

* The cleanup engine operates outside ``StreamRunner`` and never touches the
  ``checkpoints`` table or any active configuration entity (Stream / Route /
  Destination / Source / Connector / Mapping / Enrichment).
* Row deletes are batched with ``id IN (SELECT id ... LIMIT batch_size)`` so we
  never take a long lock on ``delivery_logs`` or ``validation_runs``.
* When a category does not yet have a backing table (currently
  ``preview_cache``) the helper reports ``not_applicable`` instead of pretending
  to delete rows.
* Each invocation persists structured per-category state on
  ``platform_retention_policy`` (last cleanup timestamp, duration, status,
  deleted count) so the operator can read meaningful values in the UI.
"""

from __future__ import annotations

import logging
import os
import shutil
import time
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Literal

from sqlalchemy.orm import Session

from app.logs.models import DeliveryLog
from app.platform_admin import journal
from app.platform_admin.models import PlatformRetentionPolicy
from app.platform_admin.repository import get_retention_policy_row
from app.retention.batch import batch_delete_by_time_before
from app.retention.safety import AUTOMATIC_RETENTION_TRIGGERS, retention_execution_decision
from app.validation.models import ValidationRecoveryEvent, ValidationRun

logger = logging.getLogger(__name__)

UTC = timezone.utc

CleanupStatus = Literal["ok", "skipped", "not_applicable", "error"]

CATEGORIES: tuple[str, ...] = ("logs", "runtime_metrics", "preview_cache", "backup_temp")

_BACKUP_TEMP_DIRS_ENV = "GDC_BACKUP_TEMP_DIRS"
_DEFAULT_BACKUP_TEMP_DIRS = ("backups",)


@dataclass(frozen=True)
class CleanupOutcome:
    """Result of a single category cleanup pass."""

    category: str
    status: CleanupStatus
    deleted_count: int = 0
    matched_count: int = 0
    duration_ms: int = 0
    dry_run: bool = False
    cutoff: datetime | None = None
    retention_days: int = 0
    enabled: bool = True
    message: str = ""
    notes: dict[str, object] = field(default_factory=dict)


def _now_utc() -> datetime:
    return datetime.now(UTC)


def _batch_delete_by_age(
    db: Session,
    *,
    model: type,
    cutoff: datetime,
    batch_size: int,
    dry_run: bool,
) -> tuple[int, int]:
    """Compatibility wrapper — delegates to ``batch_delete_by_time_before``."""

    return batch_delete_by_time_before(
        db,
        model=model,
        time_column=model.created_at,
        cutoff=cutoff,
        batch_size=batch_size,
        dry_run=dry_run,
    )


def _validation_runs_cleanup(
    db: Session,
    *,
    cutoff: datetime,
    batch_size: int,
    dry_run: bool,
) -> tuple[int, int]:
    """Cleanup ``validation_runs`` and orphan ``validation_recovery_events`` rows."""

    matched_runs, deleted_runs = _batch_delete_by_age(
        db,
        model=ValidationRun,
        cutoff=cutoff,
        batch_size=batch_size,
        dry_run=dry_run,
    )
    matched_recovery, deleted_recovery = _batch_delete_by_age(
        db,
        model=ValidationRecoveryEvent,
        cutoff=cutoff,
        batch_size=batch_size,
        dry_run=dry_run,
    )
    return (
        matched_runs + matched_recovery,
        deleted_runs + deleted_recovery,
    )


def _resolve_backup_dirs() -> list[Path]:
    raw = os.environ.get(_BACKUP_TEMP_DIRS_ENV, "").strip()
    if raw:
        candidates: Iterable[str] = (p.strip() for p in raw.split(","))
    else:
        candidates = _DEFAULT_BACKUP_TEMP_DIRS
    resolved: list[Path] = []
    cwd = Path.cwd()
    for c in candidates:
        if not c:
            continue
        p = Path(c)
        if not p.is_absolute():
            p = cwd / p
        if p.is_dir():
            resolved.append(p.resolve())
    return resolved


def _backup_temp_cleanup(
    *,
    cutoff: datetime,
    dry_run: bool,
) -> tuple[int, int, dict[str, object]]:
    """Delete *.tmp / *.partial / *.bak files older than ``cutoff``.

    Returns ``(matched_count, deleted_count, notes)``.

    We only delete files matching well-known temp suffixes and skip directories
    entirely; this guarantees we never remove operator-owned backup archives.
    """

    matched = 0
    deleted = 0
    inspected_dirs: list[str] = []
    skipped_archive_files = 0
    cutoff_ts = cutoff.timestamp()
    temp_suffixes = (".tmp", ".partial", ".bak")
    for d in _resolve_backup_dirs():
        inspected_dirs.append(str(d))
        try:
            for child in d.iterdir():
                if not child.is_file():
                    continue
                if not child.name.endswith(temp_suffixes):
                    skipped_archive_files += 1
                    continue
                try:
                    mtime = child.stat().st_mtime
                except OSError:
                    continue
                if mtime >= cutoff_ts:
                    continue
                matched += 1
                if dry_run:
                    continue
                try:
                    child.unlink()
                    deleted += 1
                except OSError as exc:  # pragma: no cover - filesystem variability
                    logger.warning(
                        "%s",
                        {
                            "stage": "retention_backup_temp_unlink_failed",
                            "path": str(child),
                            "error_type": type(exc).__name__,
                            "message": str(exc),
                        },
                    )
        except OSError as exc:  # pragma: no cover - filesystem variability
            logger.warning(
                "%s",
                {
                    "stage": "retention_backup_temp_iterdir_failed",
                    "path": str(d),
                    "error_type": type(exc).__name__,
                    "message": str(exc),
                },
            )
    notes: dict[str, object] = {
        "inspected_dirs": inspected_dirs,
        "skipped_non_temp_files": skipped_archive_files,
    }
    return matched, deleted, notes


def _category_retention_days(row: PlatformRetentionPolicy, category: str) -> int:
    return int(getattr(row, f"{category}_retention_days"))


def _category_enabled(row: PlatformRetentionPolicy, category: str) -> bool:
    return bool(getattr(row, f"{category}_enabled"))


def _persist_outcome(
    db: Session,
    row: PlatformRetentionPolicy,
    outcome: CleanupOutcome,
    *,
    next_cleanup_at: datetime | None,
) -> None:
    if outcome.dry_run:
        return  # Never mutate scheduler state on dry-run inspections.

    cat = outcome.category
    setattr(row, f"{cat}_last_cleanup_at", _now_utc())
    setattr(row, f"{cat}_last_deleted_count", int(outcome.deleted_count))
    setattr(row, f"{cat}_last_duration_ms", int(outcome.duration_ms))
    setattr(row, f"{cat}_last_status", outcome.status)
    if next_cleanup_at is not None:
        setattr(row, f"{cat}_next_cleanup_at", next_cleanup_at)


def _compute_next_cleanup(row: PlatformRetentionPolicy) -> datetime:
    interval = max(1, int(row.cleanup_interval_minutes or 60))
    return _now_utc() + timedelta(minutes=interval)


def _run_category(
    db: Session,
    row: PlatformRetentionPolicy,
    category: str,
    *,
    dry_run: bool,
) -> CleanupOutcome:
    retention_days = _category_retention_days(row, category)
    enabled = _category_enabled(row, category)
    batch_size = max(100, int(row.cleanup_batch_size or 5000))
    cutoff = _now_utc() - timedelta(days=max(1, retention_days))
    start = time.monotonic()

    if not enabled:
        return CleanupOutcome(
            category=category,
            status="skipped",
            duration_ms=int((time.monotonic() - start) * 1000),
            cutoff=cutoff,
            retention_days=retention_days,
            enabled=False,
            dry_run=dry_run,
            message=f"{category} cleanup disabled in retention policy.",
        )

    try:
        if category == "logs":
            matched, deleted = _batch_delete_by_age(
                db,
                model=DeliveryLog,
                cutoff=cutoff,
                batch_size=batch_size,
                dry_run=dry_run,
            )
            notes: dict[str, object] = {"table": "delivery_logs"}
            status: CleanupStatus = "ok"
            message = (
                f"delivery_logs older than {retention_days} days: matched={matched}"
                f", deleted={deleted}"
            )
        elif category == "runtime_metrics":
            matched, deleted = _validation_runs_cleanup(
                db,
                cutoff=cutoff,
                batch_size=batch_size,
                dry_run=dry_run,
            )
            notes = {"tables": ["validation_runs", "validation_recovery_events"]}
            status = "ok"
            message = (
                f"validation_runs / recovery_events older than {retention_days} days:"
                f" matched={matched}, deleted={deleted}"
            )
        elif category == "preview_cache":
            matched = 0
            deleted = 0
            notes = {"reason": "preview cache table is not present in this build."}
            status = "not_applicable"
            message = "Preview cache cleanup is not applicable (no backing table)."
        elif category == "backup_temp":
            matched, deleted, fs_notes = _backup_temp_cleanup(cutoff=cutoff, dry_run=dry_run)
            notes = dict(fs_notes)
            status = "ok"
            message = f"backup temp files older than {retention_days} days: matched={matched}, deleted={deleted}"
        else:  # pragma: no cover - defensive
            return CleanupOutcome(
                category=category,
                status="error",
                duration_ms=int((time.monotonic() - start) * 1000),
                cutoff=cutoff,
                retention_days=retention_days,
                enabled=enabled,
                dry_run=dry_run,
                message=f"Unknown retention category: {category}",
            )
    except Exception as exc:  # pragma: no cover - safety net
        logger.exception(
            "%s",
            {
                "stage": "retention_cleanup_error",
                "category": category,
                "error_type": type(exc).__name__,
                "message": str(exc),
            },
        )
        return CleanupOutcome(
            category=category,
            status="error",
            duration_ms=int((time.monotonic() - start) * 1000),
            cutoff=cutoff,
            retention_days=retention_days,
            enabled=enabled,
            dry_run=dry_run,
            message=f"{category} cleanup failed: {exc}",
        )

    duration_ms = int((time.monotonic() - start) * 1000)
    return CleanupOutcome(
        category=category,
        status=status,
        deleted_count=int(deleted),
        matched_count=int(matched),
        duration_ms=duration_ms,
        dry_run=dry_run,
        cutoff=cutoff,
        retention_days=retention_days,
        enabled=enabled,
        message=message,
        notes=notes,
    )


def run_cleanup(
    db: Session,
    *,
    categories: Iterable[str] | None = None,
    dry_run: bool = False,
    actor_username: str = "system",
    trigger: str = "manual",
) -> list[CleanupOutcome]:
    """Run cleanup for the requested categories (defaults to all four).

    The retention policy row is updated in a single commit at the end.  Audit
    events are appended (one per executed category, plus one summary event).
    """

    row = get_retention_policy_row(db)
    requested = tuple(categories) if categories is not None else CATEGORIES
    outcomes: list[CleanupOutcome] = []
    next_at = _compute_next_cleanup(row)
    decision = retention_execution_decision(trigger=trigger)
    effective_dry_run = dry_run or not decision.allowed
    automatic_blocked = str(trigger) in AUTOMATIC_RETENTION_TRIGGERS and not decision.allowed
    for cat in requested:
        if cat not in CATEGORIES:
            continue
        if automatic_blocked:
            # Disabled destructive retention must not preview-count large tables.
            outcome = CleanupOutcome(
                category=cat,
                status="skipped",
                duration_ms=0,
                cutoff=_now_utc() - timedelta(days=max(1, _category_retention_days(row, cat))),
                retention_days=_category_retention_days(row, cat),
                enabled=_category_enabled(row, cat),
                dry_run=False,
                message=f"retention execution skipped without preview count: {decision.reason}",
                notes={"count_skipped": True, "execution_guard": decision.notes},
            )
        else:
            outcome = _run_category(db, row, cat, dry_run=effective_dry_run)
        if (
            not automatic_blocked
            and not dry_run
            and not decision.allowed
            and outcome.status != "not_applicable"
        ):
            outcome = replace(
                outcome,
                status="skipped",
                deleted_count=0,
                message=f"retention execution skipped: {decision.reason}",
                notes={**dict(outcome.notes or {}), "execution_guard": decision.notes},
            )
        outcomes.append(outcome)
        _persist_outcome(db, row, outcome, next_cleanup_at=next_at)
        if not dry_run and decision.allowed:
            journal.record_audit_event(
                db,
                action="RETENTION_CLEANUP_EXECUTED",
                actor_username=actor_username,
                entity_type="RETENTION_POLICY",
                entity_id=int(row.id),
                entity_name=cat,
                details={
                    "category": cat,
                    "status": outcome.status,
                    "deleted_count": outcome.deleted_count,
                    "matched_count": outcome.matched_count,
                    "retention_days": outcome.retention_days,
                    "dry_run": dry_run,
                    "duration_ms": outcome.duration_ms,
                    "trigger": trigger,
                },
            )

    db.commit()
    return outcomes


def collect_due_categories(row: PlatformRetentionPolicy, *, now: datetime | None = None) -> list[str]:
    """Return categories whose ``next_cleanup_at`` has elapsed."""

    t = (now or _now_utc()).astimezone(UTC)
    due: list[str] = []
    for cat in CATEGORIES:
        if not _category_enabled(row, cat):
            continue
        next_at = getattr(row, f"{cat}_next_cleanup_at")
        if next_at is None:
            due.append(cat)
            continue
        next_at_utc = next_at if next_at.tzinfo else next_at.replace(tzinfo=UTC)
        if next_at_utc <= t:
            due.append(cat)
    return due


__all__ = [
    "CATEGORIES",
    "CleanupOutcome",
    "CleanupStatus",
    "collect_due_categories",
    "run_cleanup",
]
