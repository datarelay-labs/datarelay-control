"""Operational retention: preview and batched deletes outside StreamRunner transactions."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from sqlalchemy import and_, func, not_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql import ColumnElement
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy import cast, DateTime

from app.backfill.models import BackfillJob, BackfillProgressEvent
from app.config import settings
from app.db.delivery_log_partitions import calculate_delivery_log_partition_drop_targets, drop_delivery_log_partitions
from app.logs.models import DeliveryLog
from app.platform_admin import journal
from app.platform_admin.models import PlatformAuditEvent, PlatformRetentionPolicy
from app.retention.batch import batch_delete_by_time_before, eligible_count_and_oldest
from app.retention.config import effective_retention_policies, supplement_interval_seconds
from app.retention.safety import AUTOMATIC_RETENTION_TRIGGERS, retention_execution_decision
from app.validation.models import ContinuousValidation, ValidationRecoveryEvent, ValidationRun

logger = logging.getLogger(__name__)

UTC = timezone.utc

RetentionRunStatus = Literal["ok", "skipped", "error"]

ACTIVE_BACKFILL_STATUSES = ("PENDING", "RUNNING", "CANCELLING")


def _backfill_retention_time_column():
    """Terminal retention basis: completed_at when set, else created_at fallback."""

    return func.coalesce(BackfillJob.completed_at, BackfillJob.created_at)


def _validation_snapshot_time_column():
    """Prefer embedded snapshot captured_at; fall back to updated_at for legacy rows."""

    captured_raw = cast(ContinuousValidation.last_perf_snapshot_json, JSONB).op("->>")("captured_at")
    captured = cast(captured_raw, DateTime(timezone=True))
    return func.coalesce(captured, ContinuousValidation.updated_at)

ALL_TABLE_KEYS = frozenset(
    {
        "delivery_logs",
        "validation_runs",
        "validation_recovery_events",
        "validation_snapshots",
        "backfill_jobs",
        "backfill_progress_events",
    }
)


def _now() -> datetime:
    return datetime.now(UTC)


def retention_cutoff(*, days: int) -> datetime:
    """UTC cutoff: rows with ``created_at`` (or snapshot time) **strictly before** this instant are eligible."""

    return _now() - timedelta(days=max(1, int(days)))


@dataclass
class RetentionPreviewRow:
    table: str
    rows_eligible: int
    oldest_row_timestamp: datetime | None
    retention_days: int
    cutoff_utc: datetime
    notes: dict[str, Any] = field(default_factory=dict)


@dataclass
class RetentionRunTableOutcome:
    table: str
    status: RetentionRunStatus
    matched_count: int
    deleted_count: int
    retention_days: int
    cutoff_utc: datetime
    duration_ms: int
    message: str = ""
    notes: dict[str, Any] = field(default_factory=dict)


def _batch_size(row: PlatformRetentionPolicy) -> int:
    return max(100, int(row.cleanup_batch_size or 5000))


def _backfill_job_guard() -> ColumnElement[bool]:
    return not_(BackfillJob.status.in_(ACTIVE_BACKFILL_STATUSES))


def preview_retention(db: Session, row: PlatformRetentionPolicy) -> list[RetentionPreviewRow]:
    """Dry-run counts for operator preview (read-only queries)."""

    pol = effective_retention_policies(row)
    out: list[RetentionPreviewRow] = []

    c_logs = retention_cutoff(days=pol["delivery_logs_days"])
    n, oldest = eligible_count_and_oldest(db, model=DeliveryLog, time_column=DeliveryLog.created_at, cutoff=c_logs)
    partition_targets = calculate_delivery_log_partition_drop_targets(
        db,
        retention_days=pol["delivery_logs_days"],
        now=_now(),
    )
    out.append(
        RetentionPreviewRow(
            table="delivery_logs",
            rows_eligible=n,
            oldest_row_timestamp=oldest,
            retention_days=pol["delivery_logs_days"],
            cutoff_utc=c_logs,
            notes={
                "partition_drop_enabled": bool(settings.GDC_RETENTION_DELIVERY_LOG_PARTITION_DROP_ENABLED),
                "partition_drop_targets": [
                    {
                        "partition_name": t.partition_name,
                        "month_start": t.month_start.isoformat(),
                        "month_end": t.month_end.isoformat(),
                        "row_count": t.row_count,
                    }
                    for t in partition_targets
                ],
                "protected_partitions": "current and next month partitions are never eligible.",
            },
        )
    )

    c_met = retention_cutoff(days=pol["runtime_metrics_days"])
    n2, o2 = eligible_count_and_oldest(db, model=ValidationRun, time_column=ValidationRun.created_at, cutoff=c_met)
    out.append(
        RetentionPreviewRow(
            table="validation_runs",
            rows_eligible=n2,
            oldest_row_timestamp=o2,
            retention_days=pol["runtime_metrics_days"],
            cutoff_utc=c_met,
        )
    )
    n3, o3 = eligible_count_and_oldest(
        db, model=ValidationRecoveryEvent, time_column=ValidationRecoveryEvent.created_at, cutoff=c_met
    )
    out.append(
        RetentionPreviewRow(
            table="validation_recovery_events",
            rows_eligible=n3,
            oldest_row_timestamp=o3,
            retention_days=pol["runtime_metrics_days"],
            cutoff_utc=c_met,
        )
    )

    c_vs = retention_cutoff(days=pol["validation_snapshots_days"])
    vs_time = _validation_snapshot_time_column()
    flt_vs = and_(
        vs_time < c_vs,
        ContinuousValidation.last_perf_snapshot_json.is_not(None),
    )
    n4 = int(db.query(ContinuousValidation).filter(flt_vs).count())
    o4 = db.scalar(select(vs_time).where(flt_vs).order_by(vs_time.asc()).limit(1))
    out.append(
        RetentionPreviewRow(
            table="continuous_validations (last_perf_snapshot_json)",
            rows_eligible=n4,
            oldest_row_timestamp=o4,
            retention_days=pol["validation_snapshots_days"],
            cutoff_utc=c_vs,
            notes={
                "column": "last_perf_snapshot_json",
                "time_basis": "coalesce(captured_at, updated_at)",
            },
        )
    )

    c_bf = retention_cutoff(days=pol["backfill_jobs_days"])
    bf_time = _backfill_retention_time_column()
    flt_bf = and_(bf_time < c_bf, _backfill_job_guard())
    n5 = int(db.query(BackfillJob).filter(flt_bf).count())
    o5 = db.scalar(select(bf_time).where(flt_bf).order_by(bf_time.asc()).limit(1))
    out.append(
        RetentionPreviewRow(
            table="backfill_jobs",
            rows_eligible=n5,
            oldest_row_timestamp=o5,
            retention_days=pol["backfill_jobs_days"],
            cutoff_utc=c_bf,
            notes={
                "protected_statuses": list(ACTIVE_BACKFILL_STATUSES),
                "time_basis": "coalesce(completed_at, created_at)",
            },
        )
    )

    c_bpe = retention_cutoff(days=pol["backfill_progress_events_days"])
    flt_bpe = and_(
        BackfillProgressEvent.created_at < c_bpe,
        _backfill_job_guard(),
    )
    n6 = int(db.query(BackfillProgressEvent).join(BackfillJob, BackfillJob.id == BackfillProgressEvent.backfill_job_id).filter(flt_bpe).count())
    o6 = db.scalar(
        select(BackfillProgressEvent.created_at)
        .join(BackfillJob, BackfillJob.id == BackfillProgressEvent.backfill_job_id)
        .where(flt_bpe)
        .order_by(BackfillProgressEvent.created_at.asc())
        .limit(1)
    )
    out.append(
        RetentionPreviewRow(
            table="backfill_progress_events",
            rows_eligible=n6,
            oldest_row_timestamp=o6,
            retention_days=pol["backfill_progress_events_days"],
            cutoff_utc=c_bpe,
            notes={"protected_parent_statuses": list(ACTIVE_BACKFILL_STATUSES)},
        )
    )

    return out


def _delete_backfill_progress_batched(
    db: Session,
    *,
    cutoff: datetime,
    batch_size: int,
    dry_run: bool,
) -> tuple[int, int]:
    flt = and_(BackfillProgressEvent.created_at < cutoff, _backfill_job_guard())
    matched = int(
        db.query(BackfillProgressEvent)
        .join(BackfillJob, BackfillJob.id == BackfillProgressEvent.backfill_job_id)
        .filter(flt)
        .count()
    )
    if dry_run or matched == 0:
        return matched, 0
    total_deleted = 0
    iterations = 0
    max_iter = 200
    while iterations < max_iter:
        iterations += 1
        ids_subq = (
            select(BackfillProgressEvent.id)
            .join(BackfillJob, BackfillJob.id == BackfillProgressEvent.backfill_job_id)
            .where(flt)
            .order_by(BackfillProgressEvent.created_at.asc(), BackfillProgressEvent.id.asc())
            .limit(max(1, int(batch_size)))
            .scalar_subquery()
        )
        deleted = db.query(BackfillProgressEvent).filter(BackfillProgressEvent.id.in_(ids_subq)).delete(synchronize_session=False)
        if deleted is None:
            deleted = 0
        if deleted <= 0:
            break
        total_deleted += int(deleted)
        db.commit()
        if int(deleted) < int(batch_size):
            break
    return matched, total_deleted


def _clear_validation_snapshots_batched(
    db: Session,
    *,
    cutoff: datetime,
    batch_size: int,
    dry_run: bool,
) -> tuple[int, int]:
    vs_time = _validation_snapshot_time_column()
    flt = and_(
        vs_time < cutoff,
        ContinuousValidation.last_perf_snapshot_json.is_not(None),
    )
    matched = int(db.query(ContinuousValidation).filter(flt).count())
    if dry_run or matched == 0:
        return matched, 0
    total_cleared = 0
    iterations = 0
    max_iter = 200
    while iterations < max_iter:
        iterations += 1
        ids = db.scalars(
            select(ContinuousValidation.id)
            .where(flt)
            .order_by(vs_time.asc(), ContinuousValidation.id.asc())
            .limit(max(1, int(batch_size)))
        ).all()
        if not ids:
            break
        result = (
            db.query(ContinuousValidation)
            .filter(ContinuousValidation.id.in_(list(ids)))
            .update({ContinuousValidation.last_perf_snapshot_json: None}, synchronize_session=False)
        )
        cleared = int(result or 0)
        total_cleared += cleared
        db.commit()
        if cleared < int(batch_size):
            break
    return matched, total_cleared


def run_operational_retention(
    db: Session,
    row: PlatformRetentionPolicy,
    *,
    dry_run: bool,
    actor_username: str,
    trigger: str,
    tables: set[str] | None = None,
) -> list[RetentionRunTableOutcome]:
    """Batched deletes for operational tables (separate short transactions per batch).

    Never touches ``checkpoints``, connectors, streams, routes, or destinations.
    """

    want = set(tables) if tables is not None else set(ALL_TABLE_KEYS)
    want &= ALL_TABLE_KEYS
    if not want:
        return []
    pol = effective_retention_policies(row)
    bs = _batch_size(row)
    outcomes: list[RetentionRunTableOutcome] = []
    decision = retention_execution_decision(trigger=trigger)
    effective_dry_run = dry_run or not decision.allowed

    def _append(
        table: str,
        *,
        status: RetentionRunStatus,
        matched: int,
        deleted: int,
        days: int,
        cutoff: datetime,
        start: float,
        message: str = "",
        notes: dict[str, Any] | None = None,
    ) -> None:
        final_status = status
        final_deleted = deleted
        final_message = message
        final_notes = dict(notes or {})
        if not dry_run and not decision.allowed:
            final_status = "skipped"
            final_deleted = 0
            final_message = f"retention execution skipped: {decision.reason}"
            final_notes["execution_guard"] = decision.notes
        outcomes.append(
            RetentionRunTableOutcome(
                table=table,
                status=final_status,
                matched_count=matched,
                deleted_count=final_deleted,
                retention_days=days,
                cutoff_utc=cutoff,
                duration_ms=int((time.monotonic() - start) * 1000),
                message=final_message,
                notes=final_notes,
            )
        )

    if "backfill_progress_events" in want:
        t0 = time.monotonic()
        try:
            cutoff_bpe = retention_cutoff(days=pol["backfill_progress_events_days"])
            m, d = _delete_backfill_progress_batched(db, cutoff=cutoff_bpe, batch_size=bs, dry_run=effective_dry_run)
            _append(
                "backfill_progress_events",
                status="ok",
                matched=m,
                deleted=d,
                days=pol["backfill_progress_events_days"],
                cutoff=cutoff_bpe,
                start=t0,
                message=f"matched={m}, deleted={d}" if not effective_dry_run else f"dry_run matched={m}",
            )
        except Exception as exc:  # pragma: no cover - defensive
            db.rollback()
            logger.exception("%s", {"stage": "retention_backfill_progress_failed", "error": str(exc)})
            _append(
                "backfill_progress_events",
                status="error",
                matched=0,
                deleted=0,
                days=pol["backfill_progress_events_days"],
                cutoff=retention_cutoff(days=pol["backfill_progress_events_days"]),
                start=t0,
                message=str(exc),
            )

    if "backfill_jobs" in want:
        t0 = time.monotonic()
        try:
            cutoff_bf = retention_cutoff(days=pol["backfill_jobs_days"])
            m, d = batch_delete_by_time_before(
                db,
                model=BackfillJob,
                time_column=_backfill_retention_time_column(),
                cutoff=cutoff_bf,
                batch_size=bs,
                dry_run=effective_dry_run,
                extra=_backfill_job_guard(),
            )
            _append(
                "backfill_jobs",
                status="ok",
                matched=m,
                deleted=d,
                days=pol["backfill_jobs_days"],
                cutoff=cutoff_bf,
                start=t0,
                message=f"matched={m}, deleted={d}" if not effective_dry_run else f"dry_run matched={m}",
                notes={
                    "protected_statuses": list(ACTIVE_BACKFILL_STATUSES),
                    "time_basis": "coalesce(completed_at, created_at)",
                },
            )
        except Exception as exc:  # pragma: no cover
            db.rollback()
            logger.exception("%s", {"stage": "retention_backfill_jobs_failed", "error": str(exc)})
            _append(
                "backfill_jobs",
                status="error",
                matched=0,
                deleted=0,
                days=pol["backfill_jobs_days"],
                cutoff=retention_cutoff(days=pol["backfill_jobs_days"]),
                start=t0,
                message=str(exc),
            )

    if "delivery_logs" in want:
        t0 = time.monotonic()
        if not bool(row.logs_enabled):
            _append(
                "delivery_logs",
                status="skipped",
                matched=0,
                deleted=0,
                days=pol["delivery_logs_days"],
                cutoff=retention_cutoff(days=pol["delivery_logs_days"]),
                start=t0,
                message="delivery_logs retention disabled (logs_enabled=false).",
            )
        elif (
            not dry_run
            and not decision.allowed
            and str(trigger) in AUTOMATIC_RETENTION_TRIGGERS
        ):
            _append(
                "delivery_logs",
                status="skipped",
                matched=0,
                deleted=0,
                days=pol["delivery_logs_days"],
                cutoff=retention_cutoff(days=pol["delivery_logs_days"]),
                start=t0,
                message=f"retention execution skipped without preview count: {decision.reason}",
                notes={"count_skipped": True, "execution_guard": decision.notes},
            )
        else:
            try:
                c = retention_cutoff(days=pol["delivery_logs_days"])
                target_now = _now()
                partition_targets = calculate_delivery_log_partition_drop_targets(
                    db,
                    retention_days=pol["delivery_logs_days"],
                    now=target_now,
                )
                partition_dropped_rows = 0
                partition_drop_enabled = bool(settings.GDC_RETENTION_DELIVERY_LOG_PARTITION_DROP_ENABLED)
                if partition_drop_enabled and not effective_dry_run and partition_targets:
                    partition_dropped_rows = drop_delivery_log_partitions(db, partition_targets, now=target_now)
                    db.commit()
                m, d = batch_delete_by_time_before(
                    db,
                    model=DeliveryLog,
                    time_column=DeliveryLog.created_at,
                    cutoff=c,
                    batch_size=bs,
                    dry_run=effective_dry_run,
                )
                _append(
                    "delivery_logs",
                    status="ok",
                    matched=m,
                    deleted=d + partition_dropped_rows,
                    days=pol["delivery_logs_days"],
                    cutoff=c,
                    start=t0,
                    message=(
                        f"matched={m}, deleted={d}, partition_dropped_rows={partition_dropped_rows}"
                        if not effective_dry_run
                        else f"dry_run matched={m}"
                    ),
                    notes={
                        "partition_drop_enabled": partition_drop_enabled,
                        "partition_dropped_rows": partition_dropped_rows,
                        "partition_drop_targets": [
                            {
                                "partition_name": t.partition_name,
                                "month_start": t.month_start.isoformat(),
                                "month_end": t.month_end.isoformat(),
                                "row_count": t.row_count,
                            }
                            for t in partition_targets
                        ],
                        "protected_partitions": "current and next month partitions are never eligible.",
                    },
                )
            except Exception as exc:  # pragma: no cover
                db.rollback()
                logger.exception("%s", {"stage": "retention_delivery_logs_failed", "error": str(exc)})
                _append(
                    "delivery_logs",
                    status="error",
                    matched=0,
                    deleted=0,
                    days=pol["delivery_logs_days"],
                    cutoff=retention_cutoff(days=pol["delivery_logs_days"]),
                    start=t0,
                    message=str(exc),
                )

    if "validation_runs" in want:
        t0 = time.monotonic()
        c = retention_cutoff(days=pol["runtime_metrics_days"])
        if not bool(row.runtime_metrics_enabled):
            _append(
                "validation_runs",
                status="skipped",
                matched=0,
                deleted=0,
                days=pol["runtime_metrics_days"],
                cutoff=c,
                start=t0,
                message="runtime metrics retention disabled (runtime_metrics_enabled=false).",
            )
        else:
            try:
                m, d = batch_delete_by_time_before(
                    db,
                    model=ValidationRun,
                    time_column=ValidationRun.created_at,
                    cutoff=c,
                    batch_size=bs,
                    dry_run=effective_dry_run,
                )
                _append(
                    "validation_runs",
                    status="ok",
                    matched=m,
                    deleted=d,
                    days=pol["runtime_metrics_days"],
                    cutoff=c,
                    start=t0,
                    message=f"matched={m}, deleted={d}" if not effective_dry_run else f"dry_run matched={m}",
                )
            except Exception as exc:  # pragma: no cover
                db.rollback()
                logger.exception("%s", {"stage": "retention_validation_runs_failed", "error": str(exc)})
                _append(
                    "validation_runs",
                    status="error",
                    matched=0,
                    deleted=0,
                    days=pol["runtime_metrics_days"],
                    cutoff=c,
                    start=t0,
                    message=str(exc),
                )

    if "validation_recovery_events" in want:
        t0 = time.monotonic()
        c = retention_cutoff(days=pol["runtime_metrics_days"])
        if not bool(row.runtime_metrics_enabled):
            _append(
                "validation_recovery_events",
                status="skipped",
                matched=0,
                deleted=0,
                days=pol["runtime_metrics_days"],
                cutoff=c,
                start=t0,
                message="runtime metrics retention disabled (runtime_metrics_enabled=false).",
            )
        else:
            try:
                m2, d2 = batch_delete_by_time_before(
                    db,
                    model=ValidationRecoveryEvent,
                    time_column=ValidationRecoveryEvent.created_at,
                    cutoff=c,
                    batch_size=bs,
                    dry_run=effective_dry_run,
                )
                _append(
                    "validation_recovery_events",
                    status="ok",
                    matched=m2,
                    deleted=d2,
                    days=pol["runtime_metrics_days"],
                    cutoff=c,
                    start=t0,
                    message=f"matched={m2}, deleted={d2}" if not effective_dry_run else f"dry_run matched={m2}",
                )
            except Exception as exc:  # pragma: no cover
                db.rollback()
                logger.exception("%s", {"stage": "retention_validation_recovery_failed", "error": str(exc)})
                _append(
                    "validation_recovery_events",
                    status="error",
                    matched=0,
                    deleted=0,
                    days=pol["runtime_metrics_days"],
                    cutoff=c,
                    start=t0,
                    message=str(exc),
                )

    if "validation_snapshots" in want:
        t0 = time.monotonic()
        c = retention_cutoff(days=pol["validation_snapshots_days"])
        if not bool(row.runtime_metrics_enabled):
            _append(
                "continuous_validations (last_perf_snapshot_json)",
                status="skipped",
                matched=0,
                deleted=0,
                days=pol["validation_snapshots_days"],
                cutoff=c,
                start=t0,
                message="validation snapshot clearing skipped (runtime_metrics_enabled=false).",
            )
        else:
            try:
                snapshot_cleanup_enabled = bool(settings.GDC_RUNTIME_AGGREGATE_SNAPSHOT_CLEANUP_ENABLED)
                snapshot_dry_run = effective_dry_run or not snapshot_cleanup_enabled
                m, d = _clear_validation_snapshots_batched(db, cutoff=c, batch_size=bs, dry_run=snapshot_dry_run)
                status: RetentionRunStatus = "ok"
                message = (
                    f"cleared snapshot fields: matched={m}, cleared={d}"
                    if not snapshot_dry_run
                    else f"dry_run matched={m}"
                )
                notes = {
                    "column": "last_perf_snapshot_json",
                    "time_basis": "updated_at",
                    "snapshot_cleanup_enabled": snapshot_cleanup_enabled,
                }
                if not effective_dry_run and not snapshot_cleanup_enabled:
                    status = "skipped"
                    message = "validation snapshot cleanup skipped; snapshot cleanup is disabled by config."
                _append(
                    "continuous_validations (last_perf_snapshot_json)",
                    status=status,
                    matched=m,
                    deleted=d,
                    days=pol["validation_snapshots_days"],
                    cutoff=c,
                    start=t0,
                    message=message,
                    notes=notes,
                )
            except Exception as exc:  # pragma: no cover
                db.rollback()
                logger.exception("%s", {"stage": "retention_validation_snapshots_failed", "error": str(exc)})
                _append(
                    "continuous_validations (last_perf_snapshot_json)",
                    status="error",
                    matched=0,
                    deleted=0,
                    days=pol["validation_snapshots_days"],
                    cutoff=retention_cutoff(days=pol["validation_snapshots_days"]),
                    start=t0,
                    message=str(exc),
                )

    if not dry_run and decision.allowed and outcomes:
        journal.record_audit_event(
            db,
            action="OPERATIONAL_RETENTION_RUN",
            actor_username=actor_username,
            entity_type="RETENTION_OPERATIONAL",
            entity_id=int(row.id),
            entity_name="operational_retention",
            details={
                "trigger": trigger,
                "dry_run": False,
                "tables": [o.table for o in outcomes],
                "outcomes": [
                    {
                        "table": o.table,
                        "status": o.status,
                        "matched_count": o.matched_count,
                        "deleted_count": o.deleted_count,
                        "duration_ms": o.duration_ms,
                    }
                    for o in outcomes
                ],
            },
        )
        _touch_supplement_meta(db, row, outcomes)
        db.commit()
    else:
        db.rollback()

    return outcomes


def _touch_supplement_meta(db: Session, row: PlatformRetentionPolicy, outcomes: list[RetentionRunTableOutcome]) -> None:
    """Record last supplement sweep time for the dedicated daily scheduler throttle."""

    meta = dict(row.operational_retention_meta or {})
    meta["last_operational_retention_at"] = _now().isoformat()
    meta["last_operational_retention_tables"] = {
        o.table: {"deleted": o.deleted_count, "matched": o.matched_count, "status": o.status} for o in outcomes
    }
    row.operational_retention_meta = meta


def supplement_due(row: PlatformRetentionPolicy, *, now: datetime | None = None) -> bool:
    """Return True when the supplement scheduler may run (default interval: daily)."""

    if not bool(row.cleanup_scheduler_enabled):
        return False
    t = (now or _now()).astimezone(UTC)
    meta = row.operational_retention_meta or {}
    raw = meta.get("supplement_next_after")
    if not raw:
        return True
    try:
        nxt = datetime.fromisoformat(str(raw))
        if nxt.tzinfo is None:
            nxt = nxt.replace(tzinfo=UTC)
        return nxt <= t
    except ValueError:
        return True


def schedule_next_supplement(db: Session, row: PlatformRetentionPolicy, *, now: datetime | None = None) -> None:
    meta = dict(row.operational_retention_meta or {})
    t = (now or _now()).astimezone(UTC)
    meta["supplement_next_after"] = (t + timedelta(seconds=max(60.0, supplement_interval_seconds()))).isoformat()
    row.operational_retention_meta = meta
    db.add(row)
    db.commit()


def run_supplement_bundle(
    db: Session,
    row: PlatformRetentionPolicy,
    *,
    dry_run: bool,
    actor_username: str,
    trigger: str,
) -> list[RetentionRunTableOutcome]:
    """Backfill + validation snapshot targets only (used by the daily supplement thread)."""

    tables = {"backfill_progress_events", "backfill_jobs", "validation_snapshots"}
    out = run_operational_retention(db, row, dry_run=dry_run, actor_username=actor_username, trigger=trigger, tables=tables)
    guard_blocked = any("execution_guard" in dict(o.notes or {}) for o in out)
    has_error = any(o.status == "error" for o in out)
    if not dry_run and not guard_blocked and not has_error:
        db.refresh(row)
        schedule_next_supplement(db, row)
    return out


def last_operational_retention_audit_row(db: Session) -> PlatformAuditEvent | None:
    """Most recent ``OPERATIONAL_RETENTION_RUN`` audit entry (read-only)."""

    return db.scalars(
        select(PlatformAuditEvent)
        .where(PlatformAuditEvent.action == "OPERATIONAL_RETENTION_RUN")
        .order_by(PlatformAuditEvent.id.desc())
        .limit(1)
    ).first()


__all__ = [
    "ALL_TABLE_KEYS",
    "RetentionPreviewRow",
    "RetentionRunTableOutcome",
    "last_operational_retention_audit_row",
    "preview_retention",
    "retention_cutoff",
    "run_operational_retention",
    "run_supplement_bundle",
    "schedule_next_supplement",
    "supplement_due",
]
