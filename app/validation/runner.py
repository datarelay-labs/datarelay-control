"""Execute continuous validation via real StreamRunner (no synthetic runtime shortcuts)."""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Sequence
from typing import Any

from sqlalchemy.orm import Session

from app.config import settings
from app.database import SessionLocal, utcnow
from app.logs.models import DeliveryLog
from app.runners.stream_loader import load_stream_context
from app.runners.stream_runner import StreamRunner
from app.runtime.errors import SourceFetchError
from app.validation.alert_service import apply_validation_alert_cycle
from app.validation.execution_lock import try_validation_execution_lock
from app.validation.health import compute_health_status, next_consecutive_failures
from app.validation.models import ContinuousValidation, ValidationRun
from app.validation.schemas import RunRowStatus

logger = logging.getLogger(__name__)


def _append_run(
    db: Session,
    *,
    validation_id: int,
    stream_id: int | None,
    run_id: str | None,
    status: RunRowStatus,
    stage: str,
    message: str,
    latency_ms: int | None,
) -> int:
    row = ValidationRun(
        validation_id=validation_id,
        stream_id=stream_id,
        run_id=run_id,
        status=status,
        validation_stage=stage,
        message=message,
        latency_ms=latency_ms,
    )
    db.add(row)
    db.flush()
    return int(row.id)


def _delivery_log_stats(logs: Sequence[DeliveryLog]) -> dict[str, Any]:
    stages = [str(r.stage) for r in logs]
    return {
        "route_send_success": sum(1 for s in stages if s == "route_send_success"),
        "route_send_failed": sum(1 for s in stages if s == "route_send_failed"),
        "route_retry_failed": sum(1 for s in stages if s == "route_retry_failed"),
        "run_complete": sum(1 for s in stages if s == "run_complete"),
    }


def _evaluate_checks(
    *,
    validation_type: str,
    summary: dict[str, Any],
    stats: dict[str, Any],
    expect_checkpoint_advance: bool,
) -> tuple[RunRowStatus, list[str]]:
    messages: list[str] = []
    outcome = str(summary.get("outcome") or "")
    tx_ok = bool(summary.get("transaction_committed"))
    extracted = summary.get("extracted_event_count")
    delivered = summary.get("delivered_batch_event_count")
    cp_updated = bool(summary.get("checkpoint_updated"))

    if outcome == "skipped_lock":
        return "WARN", ["stream runner lock held (validation did not execute pipeline)"]

    if outcome in ("configuration_error", "exception", "source_fetch_failed"):
        return "FAIL", [str(summary.get("message") or outcome)]

    if validation_type == "AUTH_ONLY":
        if not tx_ok and outcome not in ("skipped_lock",):
            return "FAIL", ["transaction not committed after run (auth/fetch failure path likely)"]
        if outcome in ("no_events", "completed") and tx_ok:
            return "PASS", ["auth and source fetch completed"]
        return "FAIL", [f"unexpected outcome={outcome} transaction_committed={tx_ok}"]

    if validation_type == "FETCH_ONLY":
        if not tx_ok:
            return "FAIL", ["fetch stage did not reach a committed runtime outcome"]
        if isinstance(extracted, int) and extracted > 0:
            return "PASS", [f"extracted_event_count={extracted}"]
        if outcome == "no_events" and tx_ok:
            return "WARN", ["fetch committed but zero events extracted"]
        return "FAIL", ["no events extracted for FETCH_ONLY validation"]

    if validation_type == "FULL_RUNTIME":
        if not tx_ok:
            return "FAIL", ["full runtime did not commit (delivery/checkpoint logs unavailable)"]
        if not isinstance(extracted, int) or extracted < 1:
            return "WARN", ["no extracted events; skipping strict delivery/checkpoint assertions"]
        if not isinstance(delivered, int) or delivered < 1:
            return "FAIL", ["expected delivered_batch_event_count>=1 for FULL_RUNTIME"]
        if stats["route_send_success"] < 1:
            return "FAIL", ["missing delivery_logs route_send_success for this run_id"]
        if stats["route_send_failed"] or stats["route_retry_failed"]:
            return "FAIL", [
                f"delivery failure signals present route_send_failed={stats['route_send_failed']} "
                f"route_retry_failed={stats['route_retry_failed']}"
            ]
        if expect_checkpoint_advance and not cp_updated:
            return "FAIL", ["checkpoint drift: events delivered but checkpoint_updated is false"]
        if not stats["run_complete"]:
            return "FAIL", ["missing run_complete delivery_log row"]
        return "PASS", ["delivery_logs and checkpoint behavior match FULL_RUNTIME expectations"]

    return "FAIL", [f"unknown validation_type={validation_type}"]


def execute_continuous_validation_row(
    definition: ContinuousValidation,
    *,
    runner: StreamRunner | None = None,
) -> dict[str, Any]:
    """Run one validation definition; persists ``validation_runs`` and updates the definition row."""

    if not definition.enabled:
        return {"skipped": True, "reason": "disabled"}

    with try_validation_execution_lock(int(definition.id)) as acquired:
        if not acquired:
            db = SessionLocal()
            try:
                row = db.get(ContinuousValidation, definition.id)
                if row is None:
                    return {"skipped": True, "reason": "missing"}
                _append_run(
                    db,
                    validation_id=row.id,
                    stream_id=row.target_stream_id,
                    run_id=None,
                    status="WARN",
                    stage="validation_lock",
                    message="validation run skipped: another validation execution holds the lock",
                    latency_ms=0,
                )  # lock rows do not drive alert storms; skip alert cycle
                row.last_run_at = utcnow()
                row.updated_at = utcnow()
                db.commit()
            finally:
                db.close()
            return {"skipped": True, "reason": "validation_lock"}

        return _execute_continuous_validation_locked(definition, runner=runner)


def _execute_continuous_validation_locked(
    definition: ContinuousValidation,
    *,
    runner: StreamRunner | None = None,
) -> dict[str, Any]:
    runner = runner or StreamRunner()
    t0 = time.monotonic()
    summary: dict[str, Any] = {}
    stream_id = definition.target_stream_id

    if stream_id is None:
        summary = {"outcome": "configuration_error", "message": "target_stream_id is not set", "run_id": None}
    else:
        run_db = SessionLocal()
        try:
            context = load_stream_context(run_db, int(stream_id), require_enabled_stream=False)
            summary = runner.run(context, db=run_db)
        except SourceFetchError as exc:
            summary = {
                "stream_id": int(stream_id),
                "outcome": "source_fetch_failed",
                "message": str(exc),
                "transaction_committed": False,
                "run_id": None,
            }
        except Exception as exc:  # pragma: no cover - defensive path
            logger.error(
                "%s",
                {
                    "stage": "continuous_validation_runtime_exception",
                    "validation_id": definition.id,
                    "stream_id": stream_id,
                    "error_type": type(exc).__name__,
                    "message": str(exc),
                },
            )
            summary = {
                "stream_id": int(stream_id),
                "outcome": "exception",
                "message": f"{type(exc).__name__}: {exc}",
                "transaction_committed": False,
                "run_id": None,
            }
        finally:
            run_db.close()

    latency_ms = max(0, int((time.monotonic() - t0) * 1000))
    run_id = summary.get("run_id") if isinstance(summary.get("run_id"), str) else None
    stream_id_eff: int | None = None
    if summary.get("stream_id") is not None:
        stream_id_eff = int(summary["stream_id"])
    elif stream_id is not None:
        stream_id_eff = int(stream_id)

    logs: list[DeliveryLog] = []
    log_db = SessionLocal()
    try:
        if run_id and stream_id_eff is not None:
            logs = (
                log_db.query(DeliveryLog)
                .filter(DeliveryLog.stream_id == stream_id_eff, DeliveryLog.run_id == run_id)
                .order_by(DeliveryLog.id.asc())
                .all()
            )
    finally:
        log_db.close()

    stats = _delivery_log_stats(logs)
    overall, messages = _evaluate_checks(
        validation_type=str(definition.validation_type),
        summary=summary,
        stats=stats,
        expect_checkpoint_advance=bool(definition.expect_checkpoint_advance),
    )

    had_auth_failure = str(summary.get("outcome")) == "source_fetch_failed"
    had_checkpoint_drift = any("checkpoint drift" in m.lower() for m in messages)

    persist = SessionLocal()
    try:
        row = persist.get(ContinuousValidation, definition.id)
        if row is None:
            return {"skipped": True, "reason": "missing"}

        prev_health = str(row.last_status)
        row_status: RunRowStatus = "PASS" if overall == "PASS" else ("WARN" if overall == "WARN" else "FAIL")
        validation_run_pk = _append_run(
            persist,
            validation_id=row.id,
            stream_id=stream_id_eff,
            run_id=run_id,
            status=row_status,
            stage="runner_summary",
            message="; ".join(messages) if messages else str(summary.get("message") or overall),
            latency_ms=latency_ms,
        )

        row.last_run_at = utcnow()
        row.updated_at = utcnow()
        row.consecutive_failures = next_consecutive_failures(int(row.consecutive_failures or 0), overall)
        if overall == "PASS":
            row.last_success_at = utcnow()
            row.last_error = None
        else:
            row.last_error = "; ".join(messages[:3]) if messages else str(summary.get("message"))

        new_health = compute_health_status(
            enabled=bool(row.enabled),
            overall_status=overall,
            consecutive_failures=int(row.consecutive_failures or 0),
            had_auth_failure=had_auth_failure,
            had_checkpoint_drift=had_checkpoint_drift,
        )
        if new_health == "HEALTHY":
            row.last_failing_started_at = None
        elif new_health in ("DEGRADED", "FAILING"):
            if row.last_failing_started_at is None or prev_health == "HEALTHY":
                row.last_failing_started_at = utcnow()
        row.last_status = new_health

        tk_perf = str(row.template_key or "")
        if bool(getattr(settings, "ENABLE_DEV_VALIDATION_PERFORMANCE", False)) and tk_perf.startswith("dev_lab_"):
            route_lat = [
                int(x.latency_ms)
                for x in logs
                if x.latency_ms is not None and str(x.stage) == "route_send_success"
            ]
            snap = {
                "run_duration_ms": latency_ms,
                "extracted_event_count": summary.get("extracted_event_count"),
                "delivered_batch_event_count": summary.get("delivered_batch_event_count"),
                "checkpoint_updated": bool(summary.get("checkpoint_updated")),
                "route_send_success": int(stats.get("route_send_success", 0)),
                "avg_route_send_latency_ms": int(sum(route_lat) / len(route_lat)) if route_lat else None,
                "overall_status": overall,
                "error_count": int(stats.get("route_send_failed", 0) + stats.get("route_retry_failed", 0)),
                "captured_at": utcnow().isoformat(),
            }
            row.last_perf_snapshot_json = json.dumps(snap)

        apply_validation_alert_cycle(
            persist,
            validation=row,
            prev_last_status=prev_health,
            overall=overall,
            messages=messages,
            stats=stats,
            summary=summary,
            had_auth_failure=had_auth_failure,
            had_checkpoint_drift=had_checkpoint_drift,
            validation_run_id=validation_run_pk,
            latency_ms=latency_ms,
        )
        persist.commit()

        return {
            "validation_id": row.id,
            "stream_id": stream_id_eff,
            "overall_status": overall,
            "run_id": run_id,
            "latency_ms": latency_ms,
            "messages": messages,
        }
    finally:
        persist.close()
