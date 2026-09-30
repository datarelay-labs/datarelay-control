"""Policy delivery_logs metrics (bounded reads; no full-table scans)."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.platform_summary.stage_metrics import load_latest_stage_row, load_recent_stage_rows
from app.protection.policy_engine import PolicyBatchResult

POLICY_EVALUATION_COMPLETE_STAGE = "policy_evaluation_complete"
_DEFAULT_RECENT_LOG_LIMIT = 500


def load_cumulative_policy_totals(db: Session, stream_id: int) -> dict[str, int]:
    """Read running totals from the latest committed policy_evaluation_complete row (one row)."""

    row = load_latest_stage_row(
        db,
        stream_id=int(stream_id),
        stage=POLICY_EVALUATION_COMPLETE_STAGE,
    )
    if row is None:
        return {"total_audit_events": 0, "total_matched_policies": 0}
    sample = row.payload_sample if isinstance(row.payload_sample, dict) else {}
    return {
        "total_audit_events": max(0, int(sample.get("total_audit_events") or 0)),
        "total_matched_policies": max(0, int(sample.get("total_matched_policies") or 0)),
    }


def build_policy_evaluation_complete_payload(
    *,
    stream_id: int,
    result: PolicyBatchResult,
    cumulative_totals: dict[str, int] | None = None,
    route_id: int | None = None,
) -> dict[str, Any]:
    """Structured payload for policy_evaluation_complete delivery_logs row."""

    processing_time_ms = max(0, int(result.duration_ms or 0))
    matched_this_run = max(0, int(result.matched_policy_count or 0))
    audit_this_run = 1 if matched_this_run > 0 else 0
    prev_audit = int((cumulative_totals or {}).get("total_audit_events") or 0)
    prev_matched = int((cumulative_totals or {}).get("total_matched_policies") or 0)
    total_audit_events = prev_audit + audit_this_run
    total_matched_policies = prev_matched + matched_this_run

    payload: dict[str, Any] = {
        "stage": POLICY_EVALUATION_COMPLETE_STAGE,
        "stream_id": stream_id,
        "message": "policy evaluation complete",
        "policy_count": int(result.policy_count or 0),
        "matched_policy_count": matched_this_run,
        "audit_event_count": int(result.audit_event_count or 0),
        "processing_time_ms": processing_time_ms,
        "latency_ms": processing_time_ms,
        "total_audit_events": total_audit_events,
        "total_matched_policies": total_matched_policies,
    }
    if route_id is not None:
        payload["route_id"] = int(route_id)
    return payload


def load_policy_runtime_metrics(
    db: Session,
    stream_id: int,
    *,
    total_policies: int,
    recent_log_limit: int = _DEFAULT_RECENT_LOG_LIMIT,
) -> dict[str, Any]:
    """Bounded metrics for policy summary / runtime UI."""

    latest = load_latest_stage_row(
        db,
        stream_id=int(stream_id),
        stage=POLICY_EVALUATION_COMPLETE_STAGE,
    )
    if latest is not None:
        sample = latest.payload_sample if isinstance(latest.payload_sample, dict) else {}
        if "total_audit_events" in sample or "total_matched_policies" in sample:
            return {
                "total_policies": max(0, int(total_policies)),
                "matched_policies": max(0, int(sample.get("total_matched_policies") or 0)),
                "audit_events": max(0, int(sample.get("total_audit_events") or 0)),
                "last_evaluated_at": latest.created_at,
            }

    rows = load_recent_stage_rows(
        db,
        stream_id=int(stream_id),
        stage=POLICY_EVALUATION_COMPLETE_STAGE,
        limit=recent_log_limit,
    )
    audit_events = 0
    matched_policies = 0
    last_at: datetime | None = None
    for row in rows:
        sample = row.payload_sample if isinstance(row.payload_sample, dict) else {}
        matched_policies += max(0, int(sample.get("matched_policy_count") or 0))
        if max(0, int(sample.get("matched_policy_count") or 0)) > 0:
            audit_events += 1
        if last_at is None:
            last_at = row.created_at
    return {
        "total_policies": max(0, int(total_policies)),
        "matched_policies": matched_policies,
        "audit_events": audit_events,
        "last_evaluated_at": last_at,
    }
