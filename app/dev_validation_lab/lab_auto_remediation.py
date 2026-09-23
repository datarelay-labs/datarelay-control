"""Lab auto remediation: safe cleanup before pausing lab generation.

Runs only when ``lab_effective()`` and auto-remediation flags are on.
Never DROP/TRUNCATE/VACUUM FULL. Production / lab-off always inactive.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import settings

logger = logging.getLogger(__name__)

UTC = timezone.utc
_ERROR_COOLDOWN_FLOOR_SECONDS = 900

_STATE_LOCK = threading.Lock()
_LAST_RUN_AT: datetime | None = None
_COOLDOWN_UNTIL: datetime | None = None
_LAST_RESULT: dict[str, Any] | None = None


def lab_auto_remediation_enabled() -> bool:
    from app.dev_validation_lab.seeder import lab_effective

    if not lab_effective():
        return False
    return bool(getattr(settings, "GDC_LAB_AUTO_REMEDIATION_ENABLED", True))


def lab_auto_cleanup_on_budget_exceeded() -> bool:
    return lab_auto_remediation_enabled() and bool(
        getattr(settings, "GDC_LAB_AUTO_CLEANUP_ON_BUDGET_EXCEEDED", True)
    )


def auto_remediation_settings() -> dict[str, Any]:
    return {
        "auto_remediation_enabled": lab_auto_remediation_enabled(),
        "auto_cleanup_enabled": lab_auto_cleanup_on_budget_exceeded(),
        "auto_wiremock_reset": bool(getattr(settings, "GDC_LAB_AUTO_WIREMOCK_RESET", True)),
        "cooldown_seconds": int(getattr(settings, "GDC_LAB_AUTO_CLEANUP_COOLDOWN_SECONDS", 120) or 120),
        "max_rows_per_run": int(getattr(settings, "GDC_LAB_AUTO_CLEANUP_MAX_ROWS_PER_RUN", 100_000) or 100_000),
        "statement_timeout_ms": int(
            getattr(settings, "GDC_LAB_AUTO_CLEANUP_STATEMENT_TIMEOUT_MS", 30_000) or 30_000
        ),
    }


def auto_remediation_snapshot() -> dict[str, Any]:
    with _STATE_LOCK:
        return {
            "auto_remediation_enabled": lab_auto_remediation_enabled(),
            "auto_cleanup_enabled": lab_auto_cleanup_on_budget_exceeded(),
            "auto_cleanup_last_run_at": _LAST_RUN_AT.isoformat() if _LAST_RUN_AT else None,
            "auto_cleanup_last_result": dict(_LAST_RESULT) if _LAST_RESULT else None,
            "auto_cleanup_deleted_rows": (
                int((_LAST_RESULT or {}).get("deleted_rows") or 0) if _LAST_RESULT else 0
            ),
            "auto_cleanup_recovered_budget": bool((_LAST_RESULT or {}).get("recovered_budget"))
            if _LAST_RESULT
            else False,
            "auto_cleanup_cooldown_until": _COOLDOWN_UNTIL.isoformat() if _COOLDOWN_UNTIL else None,
            "destructive_cleanup_required": bool((_LAST_RESULT or {}).get("destructive_cleanup_required"))
            if _LAST_RESULT
            else False,
            "partition_drop_candidates": list((_LAST_RESULT or {}).get("partition_drop_candidates") or [])
            if _LAST_RESULT
            else [],
        }


def clear_auto_remediation_state_for_tests() -> None:
    global _LAST_RUN_AT, _COOLDOWN_UNTIL, _LAST_RESULT
    with _STATE_LOCK:
        _LAST_RUN_AT = None
        _COOLDOWN_UNTIL = None
        _LAST_RESULT = None


def _in_cooldown(now: datetime) -> bool:
    with _STATE_LOCK:
        return _COOLDOWN_UNTIL is not None and now < _COOLDOWN_UNTIL


def _set_result(result: dict[str, Any], *, cooldown_seconds: int) -> dict[str, Any]:
    global _LAST_RUN_AT, _COOLDOWN_UNTIL, _LAST_RESULT
    now = datetime.now(UTC)
    with _STATE_LOCK:
        _LAST_RUN_AT = now
        _COOLDOWN_UNTIL = now + timedelta(seconds=max(0, int(cooldown_seconds)))
        _LAST_RESULT = dict(result)
        result = dict(result)
        result["auto_cleanup_last_run_at"] = _LAST_RUN_AT.isoformat()
        result["auto_cleanup_cooldown_until"] = _COOLDOWN_UNTIL.isoformat()
        return result


def _reset_wiremock_if_needed(budget: dict[str, Any], *, enabled: bool) -> dict[str, Any]:
    out: dict[str, Any] = {
        "attempted": False,
        "ok": None,
        "before": budget.get("wiremock_journal_entries"),
        "after": budget.get("wiremock_journal_entries"),
    }
    if not enabled:
        return out
    reasons = " ".join(budget.get("exceeded_reasons") or [])
    journal = budget.get("wiremock_journal_entries")
    max_j = int((budget.get("limits") or {}).get("max_wiremock_journal_entries") or 500)
    need = (
        "wiremock_journal" in reasons
        or (journal is not None and int(journal) >= max_j)
        or bool(budget.get("wiremock_reset_failed"))
    )
    if not need:
        return out
    from app.dev_validation_lab.lab_throughput_wiremock import (
        reset_wiremock_request_journal,
        wiremock_journal_entry_count,
    )

    out["attempted"] = True
    ok = reset_wiremock_request_journal()
    out["ok"] = ok
    if ok:
        after, detail = wiremock_journal_entry_count()
        out["after"] = after
        out["detail"] = detail
    return out


def _delete_retention_rows(
    db: Session,
    *,
    max_rows_per_run: int,
    statement_timeout_ms: int,
) -> dict[str, Any]:
    """Safe row deletes only. Never DROP/TRUNCATE/VACUUM FULL."""

    from app.dev_validation_lab.lab_retention import lab_retention_settings, preview_lab_cleanup
    from app.logs.models import DeliveryLog
    from app.platform_admin.models import PlatformAlertHistory
    from app.replay.models import StreamReplayEvent
    from app.retention.batch import batch_delete_by_time_before

    cfg = lab_retention_settings()
    preview = preview_lab_cleanup(db)
    partition_candidates = list(preview.get("partition_drop_candidates") or [])
    outcomes: list[dict[str, Any]] = []
    errors: list[str] = []
    deleted_total = 0
    remaining_budget = max(0, int(max_rows_per_run))

    if not cfg.get("enabled"):
        return {
            "status": "skipped",
            "reason": "lab_retention_disabled",
            "deleted_rows": 0,
            "outcomes": [],
            "errors": ["lab_retention_disabled"],
            "partition_drop_candidates": partition_candidates,
            "partition_drop_performed": False,
        }

    try:
        db.execute(text(f"SET LOCAL statement_timeout = '{int(statement_timeout_ms)}ms'"))
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass

    def _cutoff(days: int) -> datetime:
        return datetime.now(UTC) - timedelta(days=max(1, int(days)))

    def _run(table: str, model: type, time_column: Any, days: int) -> None:
        nonlocal deleted_total, remaining_budget
        if remaining_budget <= 0:
            outcomes.append(
                {
                    "table": table,
                    "status": "skipped_budget",
                    "matched_count": 0,
                    "deleted_count": 0,
                }
            )
            return
        cutoff = _cutoff(days)
        try:
            matched, deleted = batch_delete_by_time_before(
                db,
                model=model,
                time_column=time_column,
                cutoff=cutoff,
                batch_size=min(5000, remaining_budget),
                dry_run=False,
                max_deleted=remaining_budget,
            )
            deleted_i = int(deleted)
            deleted_total += deleted_i
            remaining_budget = max(0, remaining_budget - deleted_i)
            outcomes.append(
                {
                    "table": table,
                    "status": "ok",
                    "matched_count": int(matched),
                    "deleted_count": deleted_i,
                    "cutoff_utc": cutoff.isoformat(),
                }
            )
        except Exception as exc:
            try:
                db.rollback()
            except Exception:
                pass
            msg = f"{type(exc).__name__}: {exc}"
            errors.append(f"{table}: {msg}")
            outcomes.append(
                {
                    "table": table,
                    "status": "error",
                    "matched_count": 0,
                    "deleted_count": 0,
                    "message": msg,
                }
            )

    # Order: alert → replay → delivery_logs (matches requested remediation order after WireMock).
    _run(
        "platform_alert_history",
        PlatformAlertHistory,
        PlatformAlertHistory.created_at,
        int(cfg["alert_history_retention_days"]),
    )
    _run(
        "stream_replay_events",
        StreamReplayEvent,
        StreamReplayEvent.created_at,
        int(cfg["replay_event_retention_days"]),
    )
    _run(
        "delivery_logs",
        DeliveryLog,
        DeliveryLog.created_at,
        int(cfg["delivery_log_retention_days"]),
    )

    return {
        "status": "error" if errors else "ok",
        "deleted_rows": deleted_total,
        "outcomes": outcomes,
        "errors": errors,
        "partition_drop_candidates": partition_candidates,
        "partition_drop_performed": False,
        "max_rows_per_run": max_rows_per_run,
        "rows_budget_remaining": remaining_budget,
    }


def run_lab_auto_remediation(
    db: Session | None,
    budget: dict[str, Any],
    *,
    force: bool = False,
    reevaluate: Callable[..., dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Attempt safe remediation when budget is exceeded.

    Returns a result dict including ``recovered_budget``, ``should_pause_lab``,
    and ``pause_reason`` (if still over budget after remediation).
    """

    cfg = auto_remediation_settings()
    now = datetime.now(UTC)
    base: dict[str, Any] = {
        "attempted": False,
        "skipped": False,
        "reason": None,
        "recovered_budget": False,
        "should_pause_lab": False,
        "pause_reason": None,
        "deleted_rows": 0,
        "wiremock_reset": None,
        "cleanup": None,
        "destructive_cleanup_required": False,
        "partition_drop_candidates": [],
        "errors": [],
        "status": "skipped",
    }

    if not cfg["auto_remediation_enabled"] or not cfg["auto_cleanup_enabled"]:
        base["reason"] = "auto_remediation_disabled"
        return base

    if not budget.get("exceeded_reasons") and budget.get("status") != "exceeded":
        base["reason"] = "budget_not_exceeded"
        return base

    if not force and _in_cooldown(now):
        snap = auto_remediation_snapshot()
        base["skipped"] = True
        base["reason"] = "cooldown"
        base["auto_cleanup_cooldown_until"] = snap.get("auto_cleanup_cooldown_until")
        base["auto_cleanup_last_result"] = snap.get("auto_cleanup_last_result")
        # During cooldown, preserve the prior pause decision (recommended must stay unpaused).
        last = snap.get("auto_cleanup_last_result") or {}
        if last.get("recovered_budget"):
            base["recovered_budget"] = True
            base["should_pause_lab"] = False
        else:
            base["should_pause_lab"] = bool(last.get("should_pause_lab"))
            base["pause_reason"] = last.get("pause_reason")
            base["destructive_cleanup_required"] = bool(last.get("destructive_cleanup_required"))
            base["destructive_cleanup_recommended"] = bool(last.get("destructive_cleanup_recommended"))
            base["recoverability_status"] = last.get("recoverability_status")
            base["partition_drop_candidates"] = list(last.get("partition_drop_candidates") or [])
            base["recommended_action"] = last.get("recommended_action")
        base["status"] = "cooldown"
        return base

    owns_session = db is None
    session = db
    if session is None:
        from app.database import SessionLocal

        session = SessionLocal()

    attempted = True
    errors: list[str] = []
    try:
        wiremock = _reset_wiremock_if_needed(budget, enabled=bool(cfg["auto_wiremock_reset"]))
        if wiremock.get("attempted") and wiremock.get("ok") is False:
            errors.append("wiremock_journal_reset_failed")

        cleanup = _delete_retention_rows(
            session,
            max_rows_per_run=int(cfg["max_rows_per_run"]),
            statement_timeout_ms=int(cfg["statement_timeout_ms"]),
        )
        errors.extend(list(cleanup.get("errors") or []))
        partition_candidates = list(cleanup.get("partition_drop_candidates") or [])

        # Re-evaluate budget after safe cleanup (no nested remediation).
        if reevaluate is None:
            from app.dev_validation_lab.lab_resource_guardrail import evaluate_lab_resource_budget

            def reevaluate(db_arg: Session | None = None, **kwargs: Any) -> dict[str, Any]:
                return evaluate_lab_resource_budget(
                    db_arg,
                    attempt_wiremock_reset=False,
                    **kwargs,
                )

        after = reevaluate(session)
        still_exceeded = bool(after.get("exceeded_reasons")) or after.get("status") == "exceeded"
        recovered = not still_exceeded

        from app.dev_validation_lab.lab_cleanup_recoverability import (
            assess_lab_cleanup_recoverability,
            should_pause_lab_for_recoverability,
        )

        eligible_rows = None
        for row in (cleanup.get("outcomes") or []):
            if row.get("table") == "delivery_logs":
                eligible_rows = int(row.get("matched_count") or 0)
                break
        if eligible_rows is None:
            eligible_rows = sum(
                int(c.get("estimated_rows") or 0)
                for c in partition_candidates
                if c.get("safe_to_drop_candidate")
            )

        recoverability = assess_lab_cleanup_recoverability(
            budget=after if still_exceeded else budget,
            delivery_logs_rows=after.get("delivery_logs_rows") if still_exceeded else budget.get("delivery_logs_rows"),
            delivery_logs_size=after.get("delivery_logs_estimated_size")
            if still_exceeded
            else budget.get("delivery_logs_estimated_size"),
            delivery_logs_eligible_rows=eligible_rows,
            max_rows_per_run=int(cfg["max_rows_per_run"]),
            partition_candidates=partition_candidates,
            remediation_recovered=recovered,
            remediation_still_exceeded=still_exceeded,
            remediation_errors=errors,
        )

        # Fixed policy: recommended is advisory-only; required/failed/insufficient pause.
        # Core scheduler tasks are never paused by this path.
        if recovered:
            should_pause, pause_reason = False, None
        elif still_exceeded or errors:
            should_pause, pause_reason = should_pause_lab_for_recoverability(
                recoverability.get("recoverability_status"),
                remediation_errors=errors,
                remediation_recovered=False,
            )
        else:
            should_pause, pause_reason = False, None

        destructive = bool(recoverability.get("destructive_cleanup_required"))
        # Never escalate recommended → required; recommended must not pause lab generation.
        if pause_reason == "destructive_cleanup_required":
            destructive = True

        result = {
            "attempted": attempted,
            "skipped": False,
            "reason": None,
            "status": "ok" if recovered else ("error" if errors else "insufficient"),
            "recovered_budget": recovered,
            "should_pause_lab": should_pause,
            "pause_reason": pause_reason,
            "deleted_rows": int(cleanup.get("deleted_rows") or 0),
            "wiremock_reset": wiremock,
            "cleanup": cleanup,
            "destructive_cleanup_required": destructive,
            "destructive_cleanup_recommended": bool(recoverability.get("destructive_cleanup_recommended")),
            "recoverability_status": recoverability.get("recoverability_status"),
            "auto_cleanup_cycles_estimated": recoverability.get("auto_cleanup_cycles_estimated"),
            "recommended_action": recoverability.get("recommended_action"),
            "partition_drop_candidates": partition_candidates,
            "errors": errors,
            "budget_after": {
                "status": after.get("status"),
                "exceeded_reasons": after.get("exceeded_reasons"),
                "delivery_logs_rows": after.get("delivery_logs_rows"),
                "delivery_logs_estimated_size": after.get("delivery_logs_estimated_size"),
                "alert_history_rows": after.get("alert_history_rows"),
                "replay_event_rows": after.get("replay_event_rows"),
                "wiremock_journal_entries": after.get("wiremock_journal_entries"),
                "recent_eps": after.get("recent_eps"),
            },
        }
        cooldown = int(cfg["cooldown_seconds"])
        if result.get("status") == "error" or errors:
            cooldown = max(cooldown, _ERROR_COOLDOWN_FLOOR_SECONDS)
        result = _set_result(result, cooldown_seconds=cooldown)
        logger.info(
            "%s",
            {
                "stage": "lab_auto_remediation_complete",
                "recovered_budget": recovered,
                "deleted_rows": result["deleted_rows"],
                "should_pause_lab": should_pause,
                "pause_reason": pause_reason,
                "recoverability_status": result.get("recoverability_status"),
                "errors": errors[:5],
            },
        )
        return result
    except Exception as exc:
        try:
            if session is not None:
                session.rollback()
        except Exception:
            pass
        msg = f"{type(exc).__name__}: {exc}"
        result = {
            "attempted": True,
            "skipped": False,
            "reason": "exception",
            "status": "error",
            "recovered_budget": False,
            "should_pause_lab": True,
            "pause_reason": "cleanup_failed",
            "deleted_rows": 0,
            "wiremock_reset": None,
            "cleanup": None,
            "destructive_cleanup_required": False,
            "partition_drop_candidates": [],
            "errors": [msg],
        }
        result = _set_result(
            result,
            cooldown_seconds=max(int(cfg["cooldown_seconds"]), _ERROR_COOLDOWN_FLOOR_SECONDS),
        )
        logger.warning("%s", {"stage": "lab_auto_remediation_failed", "message": msg[:300]})
        return result
    finally:
        if owns_session and session is not None:
            session.close()


__all__ = [
    "auto_remediation_settings",
    "auto_remediation_snapshot",
    "clear_auto_remediation_state_for_tests",
    "lab_auto_cleanup_on_budget_exceeded",
    "lab_auto_remediation_enabled",
    "run_lab_auto_remediation",
]
