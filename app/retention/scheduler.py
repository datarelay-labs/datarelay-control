"""Single daemon thread for operational retention: category cleanup + supplement bundle.

Runs outside ``StreamRunner`` and does not touch checkpoint semantics. Category
cleanup uses ``platform_admin.cleanup_service`` (delivery logs, validation rows,
preview cache placeholder, backup temp files). The supplement pass applies
``run_supplement_bundle`` (backfill tables + validation snapshots) when throttled
by ``operational_retention_meta.supplement_next_after``.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone

from app.config import settings
from app.database import SessionLocal
from app.db.orm_bootstrap import ensure_orm_models_registered
from app.platform_admin.cleanup_service import collect_due_categories, run_cleanup
from app.platform_admin.repository import get_retention_policy_row
from app.retention.service import run_supplement_bundle, supplement_due

logger = logging.getLogger(__name__)

UTC = timezone.utc

_DEFAULT_TICK_SECONDS = 60.0
_SHORT_SLEEP_SECONDS = 5.0

_operational_retention_scheduler: OperationalRetentionScheduler | None = None


class OperationalRetentionScheduler:
    """One lightweight background thread for all scheduled retention work."""

    def __init__(self, *, tick_seconds: float | None = None) -> None:
        self._tick_seconds = float(tick_seconds or _DEFAULT_TICK_SECONDS)
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._started_at: datetime | None = None
        self._last_tick_at: datetime | None = None
        self._last_category_summary: str | None = None
        self._last_supplement_summary: str | None = None
        self._lock = threading.RLock()
        self._logs_cumulative_deleted: int = 0
        self._logs_category_sweeps: int = 0

    @property
    def started_at(self) -> datetime | None:
        return self._started_at

    def is_running(self) -> bool:
        t = self._thread
        return t is not None and t.is_alive()

    def last_tick_at(self) -> datetime | None:
        return self._last_tick_at

    def last_outcome_summary(self) -> str | None:
        """Combined human-readable summary for admin / maintenance APIs."""

        cat = self._last_category_summary
        sup = self._last_supplement_summary
        if cat is None and sup is None:
            return None
        parts: list[str] = []
        if cat is not None:
            parts.append(f"categories:{cat}")
        if sup is not None:
            parts.append(f"supplement:{sup}")
        return "; ".join(parts) if parts else None

    def last_category_summary(self) -> str | None:
        return self._last_category_summary

    def last_supplement_summary(self) -> str | None:
        return self._last_supplement_summary

    def delivery_logs_cleanup_metrics(self) -> dict[str, int]:
        """Cumulative ``delivery_logs`` row deletes from category sweeps in this process."""

        with self._lock:
            return {
                "logs_cumulative_deleted_since_process_start": int(self._logs_cumulative_deleted),
                "logs_category_sweeps": int(self._logs_category_sweeps),
            }

    def start(self) -> None:
        if self.is_running():
            return
        ensure_orm_models_registered()
        self._stop_event.clear()
        self._started_at = datetime.now(UTC)
        self._thread = threading.Thread(
            target=self._loop,
            name="operational-retention-scheduler",
            daemon=True,
        )
        self._thread.start()
        logger.info("%s", {"stage": "operational_retention_scheduler_started"})

    def stop(self) -> None:
        self._stop_event.set()
        t = self._thread
        if t is not None:
            t.join(timeout=5.0)
        self._thread = None
        logger.info("%s", {"stage": "operational_retention_scheduler_stopped"})

    def trigger_once(self) -> None:
        """Run one synchronous sweep (tests and diagnostics)."""

        self._sweep()

    def _loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                self._sweep()
            except Exception as exc:  # pragma: no cover - defensive
                logger.exception(
                    "%s",
                    {
                        "stage": "operational_retention_scheduler_error",
                        "error_type": type(exc).__name__,
                        "message": str(exc),
                    },
                )
            self._stop_event.wait(max(self._tick_seconds, _SHORT_SLEEP_SECONDS))

    def _sweep(self) -> None:
        with self._lock:
            self._last_tick_at = datetime.now(UTC)
            self._last_category_summary = None
            self._last_supplement_summary = None
            tick_at = self._last_tick_at
            db = SessionLocal()
            try:
                row = get_retention_policy_row(db)
                if not bool(row.cleanup_scheduler_enabled):
                    self._last_category_summary = "scheduler disabled in retention policy"
                    return

                due = collect_due_categories(row, now=tick_at)
                if due:
                    outcomes = run_cleanup(
                        db,
                        categories=due,
                        dry_run=False,
                        actor_username="operational_retention_scheduler",
                        trigger="scheduler",
                    )
                    summary = ", ".join(
                        f"{o.category}:{o.status}({o.deleted_count})" for o in outcomes
                    )
                    self._last_category_summary = summary
                    for o in outcomes:
                        if o.category == "logs" and o.status == "ok":
                            self._logs_cumulative_deleted += int(o.deleted_count or 0)
                            self._logs_category_sweeps += 1
                    logger.info(
                        "%s",
                        {
                            "stage": "retention_category_cleanup_swept",
                            "categories": list(due),
                            "summary": summary,
                        },
                    )
                else:
                    self._last_category_summary = "no categories due"

                db.expire_all()
                row = get_retention_policy_row(db)

                if not bool(settings.GDC_OPERATIONAL_RETENTION_SUPPLEMENT_ENABLED):
                    self._last_supplement_summary = "supplement disabled by settings"
                    return

                if not supplement_due(row, now=tick_at):
                    self._last_supplement_summary = "supplement not due"
                    return

                outcomes_sup = run_supplement_bundle(
                    db,
                    row,
                    dry_run=False,
                    actor_username="operational_retention_scheduler",
                    trigger="supplement_scheduler",
                )
                summary_sup = ",".join(
                    f"{o.table}:{o.status}({o.deleted_count})" for o in outcomes_sup
                )
                self._last_supplement_summary = summary_sup or "no tables"
                logger.info(
                    "%s",
                    {
                        "stage": "retention_supplement_bundle_swept",
                        "summary": summary_sup,
                    },
                )
            finally:
                db.close()


def register_operational_retention_scheduler(scheduler: OperationalRetentionScheduler | None) -> None:
    global _operational_retention_scheduler
    _operational_retention_scheduler = scheduler


def get_operational_retention_scheduler() -> OperationalRetentionScheduler | None:
    return _operational_retention_scheduler


# Deprecated names — use OperationalRetentionScheduler / register_operational_retention_scheduler.
OperationalRetentionSupplementScheduler = OperationalRetentionScheduler


def register_operational_retention_supplement_scheduler(
    scheduler: OperationalRetentionScheduler | None,
) -> None:
    register_operational_retention_scheduler(scheduler)


def get_operational_retention_supplement_scheduler() -> OperationalRetentionScheduler | None:
    return get_operational_retention_scheduler()


__all__ = [
    "OperationalRetentionScheduler",
    "OperationalRetentionSupplementScheduler",
    "get_operational_retention_scheduler",
    "get_operational_retention_supplement_scheduler",
    "register_operational_retention_scheduler",
    "register_operational_retention_supplement_scheduler",
]
