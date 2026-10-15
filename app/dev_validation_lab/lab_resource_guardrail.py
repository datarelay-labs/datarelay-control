"""Lab resource budget checker and pause gate.

Hard caps apply only when ``lab_effective()`` and ``GDC_LAB_RESOURCE_GUARDRAIL_ENABLED``.
Production / non-lab processes leave the guardrail inactive so core platform traffic
is never paused by these limits.
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import settings

logger = logging.getLogger(__name__)

UTC = timezone.utc

_CACHE_LOCK = threading.Lock()
_CACHED_RESULT: dict[str, Any] | None = None
_CACHED_AT_MONO: float = 0.0
_CACHE_TTL_SEC = 5.0

_PAUSE_STATE_LOCK = threading.Lock()
_LAB_PAUSED: bool = False
_LAB_PAUSE_REASON: str | None = None
_NEXT_RETRY_AFTER: datetime | None = None
_LAST_CHECK: dict[str, Any] | None = None


def lab_resource_guardrail_enabled() -> bool:
    """True when lab is effective and the resource guardrail flag is on.

    Production/prod never enables this path via ``lab_effective()`` alone.
    """

    from app.dev_validation_lab.seeder import lab_effective

    if not lab_effective():
        return False
    return bool(getattr(settings, "GDC_LAB_RESOURCE_GUARDRAIL_ENABLED", True))


def lab_resource_budget_limits() -> dict[str, Any]:
    return {
        "enabled": lab_resource_guardrail_enabled(),
        "max_delivery_log_rows": int(getattr(settings, "GDC_LAB_MAX_DELIVERY_LOG_ROWS", 100_000) or 100_000),
        "max_delivery_log_size_bytes": int(
            getattr(settings, "GDC_LAB_MAX_DELIVERY_LOG_SIZE_BYTES", 536_870_912) or 536_870_912
        ),
        "max_alert_history_rows": int(getattr(settings, "GDC_LAB_MAX_ALERT_HISTORY_ROWS", 20_000) or 20_000),
        "max_replay_event_rows": int(getattr(settings, "GDC_LAB_MAX_REPLAY_EVENT_ROWS", 20_000) or 20_000),
        "max_wiremock_journal_entries": int(
            getattr(settings, "GDC_LAB_MAX_WIREMOCK_JOURNAL_ENTRIES", 500) or 500
        ),
        "max_recent_eps": float(getattr(settings, "GDC_LAB_MAX_RECENT_EPS", 20.0) or 20.0),
        "max_rows_per_10m": int(getattr(settings, "GDC_LAB_MAX_ROWS_PER_10M", 12_000) or 12_000),
        "pause_on_budget_exceeded": bool(getattr(settings, "GDC_LAB_PAUSE_ON_BUDGET_EXCEEDED", True)),
        "wiremock_journal_auto_reset": bool(getattr(settings, "GDC_LAB_WIREMOCK_JOURNAL_AUTO_RESET", True)),
        "pause_backoff_seconds": float(getattr(settings, "GDC_LAB_PAUSE_BACKOFF_SECONDS", 30.0) or 30.0),
    }


def _scalar_int(db: Session, sql: str) -> int | None:
    try:
        val = db.execute(text(sql)).scalar()
        return int(val) if val is not None else 0
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass
        return None


def _approx_table_rows(db: Session, relation: str) -> int | None:
    """Cheap row estimate via pg_class.reltuples (avoids COUNT(*) on huge tables)."""

    try:
        val = db.execute(
            text("SELECT GREATEST(reltuples::bigint, 0) FROM pg_class WHERE oid = :rel::regclass"),
            {"rel": relation},
        ).scalar()
        return int(val) if val is not None else 0
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass
        return None


def _collect_db_metrics(db: Session) -> dict[str, Any]:
    # Prefer estimates for large catalog tables — exact COUNT(*) on multi-GB
    # delivery_logs can take tens of seconds and must not block the scheduler.
    rows_total = _approx_table_rows(db, "delivery_logs")
    size_bytes = _scalar_int(db, "SELECT pg_total_relation_size('delivery_logs'::regclass)")
    alert_rows = _approx_table_rows(db, "platform_alert_history")
    replay_rows = _approx_table_rows(db, "stream_replay_events")

    # Keep the physical stage-row count for observability, but do not use it as
    # event EPS. One logical run emits many stage rows, and webhook ingress may
    # emit one run per event; treating those rows as events makes compliant
    # 5-20 EPS lab traffic pause itself.
    rows_10m: int | None = None
    lab_run_rows_10m: int | None = None
    max_stream_input_events_10m: int | None = None
    try:
        db.execute(text("SET LOCAL statement_timeout = '3000ms'"))
        rows_10m = _scalar_int(
            db,
            "SELECT count(*) FROM delivery_logs "
            "WHERE created_at >= (NOW() AT TIME ZONE 'utc') - INTERVAL '10 minutes'",
        )
        row = db.execute(
            text(
                """
                WITH recent_lab_runs AS (
                    SELECT
                        dl.stream_id,
                        COUNT(*)::bigint AS run_rows,
                        COALESCE(
                            SUM(
                                CASE
                                    WHEN json_typeof(dl.payload_sample) = 'object'
                                         AND COALESCE(dl.payload_sample ->> 'input_events', '') ~ '^[0-9]+$'
                                    THEN (dl.payload_sample ->> 'input_events')::bigint
                                    ELSE 0
                                END
                            ),
                            0
                        )::bigint AS input_events
                    FROM delivery_logs AS dl
                    JOIN streams AS s ON s.id = dl.stream_id
                    WHERE dl.created_at >= (NOW() AT TIME ZONE 'utc') - INTERVAL '10 minutes'
                      AND dl.stage = 'run_complete'
                      AND (
                          s.name LIKE '[DEV VALIDATION] %'
                          OR s.name LIKE '[DEV E2E] %'
                      )
                    GROUP BY dl.stream_id
                )
                SELECT
                    COALESCE(SUM(run_rows), 0)::bigint,
                    COALESCE(MAX(input_events), 0)::bigint
                FROM recent_lab_runs
                """
            )
        ).one()
        lab_run_rows_10m = int(row[0] or 0)
        max_stream_input_events_10m = int(row[1] or 0)
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass
        # Fail closed to the historical physical-row approximation when the
        # richer lab accounting query is unavailable.
        lab_run_rows_10m = None
        max_stream_input_events_10m = None

    recent_eps = None
    if max_stream_input_events_10m is not None:
        recent_eps = round(float(max_stream_input_events_10m) / 600.0, 4)
    elif rows_10m is not None:
        recent_eps = round(float(rows_10m) / 600.0, 4)

    return {
        "delivery_logs_rows": rows_total,
        "delivery_logs_rows_last_10m": rows_10m,
        "lab_run_rows_last_10m": lab_run_rows_10m,
        "max_stream_input_events_last_10m": max_stream_input_events_10m,
        "delivery_logs_estimated_size": size_bytes,
        "recent_eps": recent_eps,
        "alert_history_rows": alert_rows,
        "replay_event_rows": replay_rows,
    }


def _wiremock_journal_snapshot() -> dict[str, Any]:
    from app.dev_validation_lab.lab_throughput_wiremock import (
        reset_wiremock_request_journal,
        wiremock_journal_entry_count,
    )

    limits = lab_resource_budget_limits()
    count, detail = wiremock_journal_entry_count()
    out: dict[str, Any] = {
        "wiremock_journal_entries": count,
        "wiremock_journal_detail": detail,
        "wiremock_reset_attempted": False,
        "wiremock_reset_ok": None,
    }
    max_j = int(limits["max_wiremock_journal_entries"])
    auto_reset = bool(limits["wiremock_journal_auto_reset"])
    if (
        lab_resource_guardrail_enabled()
        and auto_reset
        and count is not None
        and count >= max_j
    ):
        out["wiremock_reset_attempted"] = True
        ok = reset_wiremock_request_journal()
        out["wiremock_reset_ok"] = ok
        if ok:
            count2, detail2 = wiremock_journal_entry_count()
            out["wiremock_journal_entries"] = count2
            out["wiremock_journal_detail"] = detail2
        else:
            out["wiremock_reset_failed"] = True
    return out


def _scheduler_backoff_snapshot() -> dict[str, Any]:
    try:
        from app.scheduler import runtime_state as scheduler_runtime_state

        summary = scheduler_runtime_state.stream_backoff_summary()
        if not summary:
            return {"scheduler_streams_in_backoff": 0, "scheduler_backoff": []}
        items = [
            {
                "stream_id": int(sid),
                "consecutive_failures": int(info.get("consecutive_failures") or 0),
                "wait_sec": float(info.get("wait_sec") or 0),
                "last_error": info.get("last_error"),
            }
            for sid, info in summary.items()
            if isinstance(info, dict)
        ]
        return {"scheduler_streams_in_backoff": len(items), "scheduler_backoff": items}
    except Exception:
        return {"scheduler_streams_in_backoff": 0, "scheduler_backoff": []}


def evaluate_lab_resource_budget(
    db: Session | None = None,
    *,
    metrics_override: dict[str, Any] | None = None,
    attempt_wiremock_reset: bool = True,
) -> dict[str, Any]:
    """Evaluate lab resource budget. Does not mutate DB.

    ``metrics_override`` is for unit tests (skip live DB/WireMock probes).
    """

    from app.dev_validation_lab.lab_retention import last_lab_cleanup_snapshot
    from app.dev_validation_lab.seeder import lab_effective

    now = datetime.now(UTC)
    limits = lab_resource_budget_limits()
    enabled = bool(limits["enabled"])

    base: dict[str, Any] = {
        "checked_at": now.isoformat(),
        "resource_guardrail_enabled": enabled,
        "lab_effective": bool(lab_effective()),
        "status": "ok",
        "exceeded_reasons": [],
        "warning_reasons": [],
        "recommended_action": "none",
        "should_pause_lab": False,
        "limits": {k: v for k, v in limits.items() if k != "enabled"},
        "delivery_logs_rows": None,
        "delivery_logs_rows_last_10m": None,
        "lab_run_rows_last_10m": None,
        "max_stream_input_events_last_10m": None,
        "delivery_logs_estimated_size": None,
        "recent_eps": None,
        "alert_history_rows": None,
        "replay_event_rows": None,
        "wiremock_journal_entries": None,
        "scheduler_streams_in_backoff": 0,
        **last_lab_cleanup_snapshot(),
    }

    if not enabled:
        base["status"] = "ok"
        base["recommended_action"] = "guardrail_disabled"
        return base

    metrics: dict[str, Any] = {}
    if metrics_override is not None:
        metrics = dict(metrics_override)
    else:
        owns_session = db is None
        session = db
        if session is None:
            from app.database import SessionLocal

            session = SessionLocal()
        try:
            metrics.update(_collect_db_metrics(session))
        finally:
            if owns_session:
                session.close()
        if attempt_wiremock_reset:
            metrics.update(_wiremock_journal_snapshot())
        else:
            from app.dev_validation_lab.lab_throughput_wiremock import wiremock_journal_entry_count

            count, detail = wiremock_journal_entry_count()
            metrics["wiremock_journal_entries"] = count
            metrics["wiremock_journal_detail"] = detail
        metrics.update(_scheduler_backoff_snapshot())

    for key in (
        "delivery_logs_rows",
        "delivery_logs_rows_last_10m",
        "lab_run_rows_last_10m",
        "max_stream_input_events_last_10m",
        "delivery_logs_estimated_size",
        "recent_eps",
        "alert_history_rows",
        "replay_event_rows",
        "wiremock_journal_entries",
        "scheduler_streams_in_backoff",
        "wiremock_reset_attempted",
        "wiremock_reset_ok",
        "wiremock_reset_failed",
        "scheduler_backoff",
        "wiremock_journal_detail",
    ):
        if key in metrics:
            base[key] = metrics[key]

    exceeded: list[str] = []
    warnings: list[str] = []

    def _over(value: int | float | None, limit: int | float, reason: str) -> None:
        if value is None:
            return
        if float(value) > float(limit):
            exceeded.append(reason)

    def _near(value: int | float | None, limit: int | float, reason: str, *, ratio: float = 0.9) -> None:
        if value is None:
            return
        if float(value) >= float(limit) * ratio and float(value) <= float(limit):
            warnings.append(reason)

    _over(
        base.get("delivery_logs_rows"),
        limits["max_delivery_log_rows"],
        f"delivery_logs_rows>{limits['max_delivery_log_rows']}",
    )
    _over(
        base.get("delivery_logs_estimated_size"),
        limits["max_delivery_log_size_bytes"],
        f"delivery_logs_size>{limits['max_delivery_log_size_bytes']}",
    )
    _over(
        base.get("alert_history_rows"),
        limits["max_alert_history_rows"],
        f"alert_history_rows>{limits['max_alert_history_rows']}",
    )
    _over(
        base.get("replay_event_rows"),
        limits["max_replay_event_rows"],
        f"replay_event_rows>{limits['max_replay_event_rows']}",
    )
    _over(
        base.get("recent_eps"),
        limits["max_recent_eps"],
        f"recent_eps>{limits['max_recent_eps']}",
    )
    # The 10-minute activity budget historically used every delivery stage row,
    # which multiplies one logical event into many rows. Live collection now
    # supplies run-complete activity; metrics_override callers without the new
    # field retain the historical fallback for compatibility/fail-closed tests.
    lab_run_rows = base.get("lab_run_rows_last_10m")
    if lab_run_rows is not None:
        _over(
            lab_run_rows,
            limits["max_rows_per_10m"],
            f"lab_run_rows_last_10m>{limits['max_rows_per_10m']}",
        )
    else:
        _over(
            base.get("delivery_logs_rows_last_10m"),
            limits["max_rows_per_10m"],
            f"delivery_logs_rows_last_10m>{limits['max_rows_per_10m']}",
        )

    journal = base.get("wiremock_journal_entries")
    max_j = int(limits["max_wiremock_journal_entries"])
    if metrics.get("wiremock_reset_failed"):
        exceeded.append("wiremock_journal_reset_failed")
    elif journal is not None and int(journal) > max_j:
        exceeded.append(f"wiremock_journal_entries>{max_j}")
    elif journal is not None and int(journal) >= max_j:
        # At cap after optional reset — still pause to avoid OOM growth.
        if not metrics.get("wiremock_reset_ok"):
            exceeded.append(f"wiremock_journal_entries>={max_j}")
        else:
            warnings.append(f"wiremock_journal_at_cap_after_reset={journal}")
    else:
        _near(journal, max_j, f"wiremock_journal_near_cap={journal}/{max_j}")

    _near(
        base.get("delivery_logs_rows"),
        limits["max_delivery_log_rows"],
        "delivery_logs_rows_near_cap",
    )
    _near(
        base.get("delivery_logs_estimated_size"),
        limits["max_delivery_log_size_bytes"],
        "delivery_logs_size_near_cap",
    )

    pause = bool(limits["pause_on_budget_exceeded"]) and bool(exceeded)
    if exceeded:
        status = "exceeded"
        recommended = (
            "auto_remediation_then_pause_if_unrecovered; "
            "partition DROP/TRUNCATE/VACUUM FULL remain manual"
        )
    elif warnings:
        status = "warning"
        recommended = "monitor growth; auto remediation idle"
    else:
        status = "ok"
        recommended = "none"

    base["status"] = status
    base["exceeded_reasons"] = exceeded
    base["warning_reasons"] = warnings
    base["recommended_action"] = recommended
    # Tentative; check_lab_resource_budget may clear this after auto remediation.
    base["should_pause_lab"] = pause
    return base


def _apply_pause_state(result: dict[str, Any]) -> dict[str, Any]:
    global _LAB_PAUSED, _LAB_PAUSE_REASON, _NEXT_RETRY_AFTER, _LAST_CHECK

    backoff = float(lab_resource_budget_limits()["pause_backoff_seconds"])
    now = datetime.now(UTC)
    should_pause = bool(result.get("should_pause_lab"))
    explicit = result.get("lab_pause_reason") or result.get("pause_reason")
    reasons = list(result.get("exceeded_reasons") or [])
    reason = explicit or ("; ".join(reasons) if reasons else None)

    with _PAUSE_STATE_LOCK:
        _LAST_CHECK = dict(result)
        if should_pause:
            _LAB_PAUSED = True
            _LAB_PAUSE_REASON = reason
            _NEXT_RETRY_AFTER = now.replace(microsecond=0) + timedelta(seconds=backoff)
        else:
            if _LAB_PAUSED:
                logger.info(
                    "%s",
                    {
                        "stage": "lab_resource_budget_resumed",
                        "previous_reason": _LAB_PAUSE_REASON,
                    },
                )
            _LAB_PAUSED = False
            _LAB_PAUSE_REASON = None
            _NEXT_RETRY_AFTER = None

        result = dict(result)
        result["lab_paused"] = _LAB_PAUSED
        result["lab_pause_reason"] = _LAB_PAUSE_REASON
        result["next_retry_after"] = _NEXT_RETRY_AFTER.isoformat() if _NEXT_RETRY_AFTER else None
        return result


def _maybe_auto_remediate(
    db: Session | None,
    result: dict[str, Any],
    *,
    force_remediation: bool = False,
    remediation_hook: Any | None = None,
) -> dict[str, Any]:
    """Run safe auto remediation before finalizing pause decision."""

    from app.dev_validation_lab.lab_auto_remediation import (
        auto_remediation_snapshot,
        lab_auto_cleanup_on_budget_exceeded,
        run_lab_auto_remediation,
    )

    result = dict(result)
    result["auto_remediation"] = None
    if not result.get("should_pause_lab") and result.get("status") != "exceeded":
        result.update({k: v for k, v in auto_remediation_snapshot().items()})
        return result
    if not lab_auto_cleanup_on_budget_exceeded():
        result.update({k: v for k, v in auto_remediation_snapshot().items()})
        return result

    if remediation_hook is not None:
        rem = remediation_hook(db, result)
    else:
        rem = run_lab_auto_remediation(db, result, force=force_remediation)

    result["auto_remediation"] = rem
    result.update(
        {
            "auto_remediation_enabled": True,
            "auto_cleanup_enabled": True,
            "auto_cleanup_last_run_at": rem.get("auto_cleanup_last_run_at"),
            "auto_cleanup_last_result": rem,
            "auto_cleanup_deleted_rows": rem.get("deleted_rows"),
            "auto_cleanup_recovered_budget": rem.get("recovered_budget"),
            "auto_cleanup_cooldown_until": rem.get("auto_cleanup_cooldown_until"),
            "destructive_cleanup_required": rem.get("destructive_cleanup_required"),
            "partition_drop_candidates": rem.get("partition_drop_candidates") or [],
        }
    )

    if rem.get("recovered_budget"):
        result["should_pause_lab"] = False
        result["status"] = "ok"
        result["exceeded_reasons"] = []
        result["recommended_action"] = rem.get("recommended_action") or "auto_remediation_recovered"
        result["pause_reason"] = None
        result["lab_pause_reason"] = None
        result["recoverability_status"] = rem.get("recoverability_status") or "within_budget"
        result["auto_cleanup_cycles_estimated"] = rem.get("auto_cleanup_cycles_estimated")
        result["destructive_cleanup_required"] = False
        result["destructive_cleanup_recommended"] = bool(rem.get("destructive_cleanup_recommended"))
        result["warning_reasons"] = list(result.get("warning_reasons") or []) + [
            "budget_recovered_via_auto_remediation"
        ]
    elif rem.get("should_pause_lab"):
        result["should_pause_lab"] = True
        result["pause_reason"] = rem.get("pause_reason") or "cleanup_insufficient"
        result["lab_pause_reason"] = result["pause_reason"]
        result["recoverability_status"] = rem.get("recoverability_status")
        result["auto_cleanup_cycles_estimated"] = rem.get("auto_cleanup_cycles_estimated")
        result["destructive_cleanup_required"] = bool(rem.get("destructive_cleanup_required"))
        result["destructive_cleanup_recommended"] = bool(rem.get("destructive_cleanup_recommended"))
        result["recommended_action"] = rem.get("recommended_action") or (
            f"lab_paused_after_remediation:{result['pause_reason']}; "
            "manual partition DROP may be required if destructive_cleanup_required"
        )
        if rem.get("budget_after"):
            after = rem["budget_after"]
            if after.get("exceeded_reasons"):
                result["exceeded_reasons"] = list(after["exceeded_reasons"])
            result["status"] = "exceeded"
    else:
        # Auto-recoverable / multi-cycle / recommended — do not pause lab generation.
        # destructive_cleanup_recommended is advisory only; required/failed pause above.
        result["should_pause_lab"] = False
        result["pause_reason"] = None
        result["lab_pause_reason"] = None
        result["recoverability_status"] = rem.get("recoverability_status")
        result["auto_cleanup_cycles_estimated"] = rem.get("auto_cleanup_cycles_estimated")
        result["destructive_cleanup_required"] = bool(rem.get("destructive_cleanup_required"))
        result["destructive_cleanup_recommended"] = bool(rem.get("destructive_cleanup_recommended"))
        result["recommended_action"] = rem.get("recommended_action") or (
            "Auto cleanup is running. Wait for next cleanup cycle."
        )
        warnings = list(result.get("warning_reasons") or [])
        status = rem.get("recoverability_status")
        if status == "needs_multiple_auto_cleanup_cycles":
            warnings.append("auto_cleanup_multi_cycle_in_progress")
        elif status == "destructive_cleanup_recommended":
            warnings.append("destructive_cleanup_recommended_lab_not_paused")
        elif status == "recoverable_by_auto_cleanup":
            warnings.append("auto_cleanup_recoverable_in_progress")
        result["warning_reasons"] = warnings
    return result


def check_lab_resource_budget(
    db: Session | None = None,
    *,
    force: bool = False,
    metrics_override: dict[str, Any] | None = None,
    attempt_wiremock_reset: bool = False,
    run_remediation: bool | None = None,
    remediation_hook: Any | None = None,
) -> dict[str, Any]:
    """Cached budget check used by feeder/scheduler gates.

    On budget exceeded, attempts lab auto remediation (safe deletes + WireMock
    reset) before pausing lab generation. Core streams are never paused here.
    """

    global _CACHED_RESULT, _CACHED_AT_MONO

    do_remediation = True if run_remediation is None else bool(run_remediation)
    # Unit tests with metrics_override skip live remediation unless explicitly enabled.
    if metrics_override is not None and run_remediation is None and remediation_hook is None:
        do_remediation = False

    if metrics_override is not None:
        result = evaluate_lab_resource_budget(
            db,
            metrics_override=metrics_override,
            attempt_wiremock_reset=False,
        )
        if do_remediation:
            result = _maybe_auto_remediate(
                db, result, force_remediation=force, remediation_hook=remediation_hook
            )
        result = _apply_pause_state(result)
        with _CACHE_LOCK:
            _CACHED_RESULT = dict(result)
            _CACHED_AT_MONO = time.monotonic()
        return result

    now_mono = time.monotonic()
    with _CACHE_LOCK:
        if (
            not force
            and _CACHED_RESULT is not None
            and (now_mono - _CACHED_AT_MONO) < _CACHE_TTL_SEC
        ):
            return dict(_CACHED_RESULT)

    # WireMock reset is owned by auto remediation orchestration (not evaluate).
    result = evaluate_lab_resource_budget(
        db,
        attempt_wiremock_reset=attempt_wiremock_reset,
    )
    if do_remediation:
        result = _maybe_auto_remediate(
            db, result, force_remediation=force, remediation_hook=remediation_hook
        )
    result = _apply_pause_state(result)

    if result.get("should_pause_lab"):
        logger.warning(
            "%s",
            {
                "stage": "lab_resource_budget_exceeded",
                "status": result.get("status"),
                "exceeded_reasons": result.get("exceeded_reasons"),
                "should_pause_lab": True,
                "lab_pause_reason": result.get("lab_pause_reason"),
                "auto_cleanup_recovered_budget": result.get("auto_cleanup_recovered_budget"),
            },
        )

    with _CACHE_LOCK:
        _CACHED_RESULT = dict(result)
        _CACHED_AT_MONO = time.monotonic()
    return result


def lab_generation_should_pause(db: Session | None = None, *, force: bool = False) -> tuple[bool, str | None]:
    """Return (should_pause, reason) for lab feeder / lab stream polls."""

    if not lab_resource_guardrail_enabled():
        return False, None
    if not force:
        with _CACHE_LOCK:
            if _CACHED_RESULT is not None and (time.monotonic() - _CACHED_AT_MONO) < _CACHE_TTL_SEC:
                cached = _CACHED_RESULT
                if cached.get("should_pause_lab") or cached.get("lab_paused"):
                    return True, cached.get("lab_pause_reason") or "; ".join(
                        cached.get("exceeded_reasons") or []
                    ) or "budget_exceeded"
                return False, None
    result = check_lab_resource_budget(db, force=force)
    if result.get("should_pause_lab") or result.get("lab_paused"):
        return True, result.get("lab_pause_reason") or "; ".join(result.get("exceeded_reasons") or []) or "budget_exceeded"
    return False, None


def lab_pause_snapshot() -> dict[str, Any]:
    """Process-local pause state for status/health APIs."""

    with _PAUSE_STATE_LOCK:
        return {
            "lab_paused": _LAB_PAUSED,
            "lab_pause_reason": _LAB_PAUSE_REASON,
            "next_retry_after": _NEXT_RETRY_AFTER.isoformat() if _NEXT_RETRY_AFTER else None,
            "last_check": dict(_LAST_CHECK) if _LAST_CHECK else None,
        }


def clear_lab_pause_state_for_tests() -> None:
    """Test helper: reset process-local pause/cache state."""

    global _CACHED_RESULT, _CACHED_AT_MONO, _LAB_PAUSED, _LAB_PAUSE_REASON, _NEXT_RETRY_AFTER, _LAST_CHECK
    with _CACHE_LOCK:
        _CACHED_RESULT = None
        _CACHED_AT_MONO = 0.0
    with _PAUSE_STATE_LOCK:
        _LAB_PAUSED = False
        _LAB_PAUSE_REASON = None
        _NEXT_RETRY_AFTER = None
        _LAST_CHECK = None


def mark_cleanup_failed_pause(message: str) -> None:
    """Set pause reason when safe auto-cleanup fails (lab generation must not continue)."""

    global _LAB_PAUSED, _LAB_PAUSE_REASON, _NEXT_RETRY_AFTER, _LAST_CHECK, _CACHED_RESULT, _CACHED_AT_MONO
    now = datetime.now(UTC)
    backoff = float(lab_resource_budget_limits()["pause_backoff_seconds"])
    reason = f"cleanup_failed: {message}"[:400]
    with _PAUSE_STATE_LOCK:
        _LAB_PAUSED = True
        _LAB_PAUSE_REASON = reason
        _NEXT_RETRY_AFTER = now.replace(microsecond=0) + timedelta(seconds=backoff)
        _LAST_CHECK = {
            "status": "exceeded",
            "should_pause_lab": True,
            "exceeded_reasons": ["cleanup_failed"],
            "lab_paused": True,
            "lab_pause_reason": reason,
            "checked_at": now.isoformat(),
        }
    with _CACHE_LOCK:
        _CACHED_RESULT = dict(_LAST_CHECK)
        _CACHED_AT_MONO = time.monotonic()
    logger.warning("%s", {"stage": "lab_resource_cleanup_failed_pause", "reason": reason})


__all__ = [
    "check_lab_resource_budget",
    "clear_lab_pause_state_for_tests",
    "evaluate_lab_resource_budget",
    "lab_generation_should_pause",
    "lab_pause_snapshot",
    "lab_resource_budget_limits",
    "lab_resource_guardrail_enabled",
    "mark_cleanup_failed_pause",
]
