"""Record protected delivery payloads when policy quarantine matches."""

from __future__ import annotations

import logging
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.protection.policy_engine import PolicyBatchResult
from app.quarantine.metrics import (
    QUARANTINE_EVENT_CREATE_FAILED_STAGE,
    QUARANTINE_EVENT_CREATED_STAGE,
    persist_quarantine_observability_log,
)
from app.quarantine.models import (
    QUARANTINE_SOURCE_POLICY,
    QUARANTINE_STATUS_QUARANTINED,
    StreamQuarantineEvent,
)
from app.quarantine.policy_integration import build_quarantine_reason, matched_quarantine_evaluations

logger = logging.getLogger(__name__)

_MAX_EVENTS = 500


def _snapshot_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in events[:_MAX_EVENTS]:
        if isinstance(item, dict):
            out.append(deepcopy(item))
    return out


def record_policy_quarantine_event(
    db: Session,
    *,
    stream_id: int,
    delivery_events: list[dict[str, Any]],
    policy_result: PolicyBatchResult,
    route_id: int | None = None,
) -> StreamQuarantineEvent | None:
    """Persist quarantine row from protected delivery batch; never stores enriched events."""

    matched = matched_quarantine_evaluations(policy_result)
    if not matched:
        return None

    payload = _snapshot_events(delivery_events)
    if not payload:
        return None

    reason = build_quarantine_reason(policy_result)
    now = datetime.now(timezone.utc)
    metadata = {
        "event_count": len(payload),
        "policy_ids": [int(item.policy_id) for item in matched],
        "policy_names": [str(item.policy_name) for item in matched],
    }
    if route_id is not None:
        metadata["route_id"] = int(route_id)
    row = StreamQuarantineEvent(
        stream_id=int(stream_id),
        route_id=int(route_id) if route_id is not None else None,
        quarantine_reason=reason[:256],
        quarantine_source=QUARANTINE_SOURCE_POLICY,
        status=QUARANTINE_STATUS_QUARANTINED,
        protected_payload_json={"events": payload},
        metadata_json=metadata,
        created_at=now,
        updated_at=now,
    )
    try:
        db.add(row)
        db.flush()
        persist_quarantine_observability_log(
            db,
            stage=QUARANTINE_EVENT_CREATED_STAGE,
            stream_id=int(stream_id),
            quarantine_event_id=int(row.id),
            status=row.status,
            quarantine_reason=reason,
            message="quarantine event created",
            extra={"event_count": len(payload), "quarantine_source": QUARANTINE_SOURCE_POLICY},
        )
        try:
            from app.governance_violations.service import record_quarantine_governance_notifications

            record_quarantine_governance_notifications(db, row)
        except Exception:
            logger.exception("governance_quarantine_notification_failed quarantine_event_id=%s", row.id)
        return row
    except Exception as exc:
        logger.exception("quarantine_event_record_failed stream_id=%s", stream_id)
        try:
            persist_quarantine_observability_log(
                db,
                stage=QUARANTINE_EVENT_CREATE_FAILED_STAGE,
                stream_id=int(stream_id),
                quarantine_event_id=0,
                status=QUARANTINE_STATUS_QUARANTINED,
                quarantine_reason=reason,
                message=str(exc)[:500],
                level="ERROR",
                log_status="FAILED",
                error_code="QUARANTINE_RECORD_FAILED",
            )
        except Exception:
            logger.exception("quarantine_event_create_failed_log_failed stream_id=%s", stream_id)
        return None


def record_route_policy_quarantine_event(
    db: Session,
    *,
    stream_id: int,
    route_id: int,
    destination_id: int,
    delivery_events: list[dict[str, Any]],
    policy_result: PolicyBatchResult,
    decision_reason: str,
    classification_result: Any | None = None,
    override_delivery_behavior: str | None = None,
    drift_quarantine: bool = False,
) -> StreamQuarantineEvent | None:
    """Route-scoped quarantine from per-route policy stage (M13.5)."""

    matched = matched_quarantine_evaluations(policy_result)
    explicit_override_quarantine = str(override_delivery_behavior or "").strip().lower() == "quarantine"
    if not matched and not drift_quarantine and not explicit_override_quarantine:
        return None

    payload = _snapshot_events(delivery_events)
    if not payload:
        return None

    if matched:
        reason = build_quarantine_reason(policy_result)
    elif drift_quarantine:
        reason = f"policy:drift_quarantine:{decision_reason}"[:256]
    else:
        reason = f"policy:delivery_behavior_quarantine:{decision_reason}"[:256]

    now = datetime.now(timezone.utc)
    cls_level = getattr(classification_result, "effective_level", None) if classification_result else None
    metadata: dict[str, Any] = {
        "event_count": len(payload),
        "route_id": int(route_id),
        "destination_id": int(destination_id),
        "decision_reason": decision_reason,
        "delivery_behavior_override": override_delivery_behavior,
        "classification_level": cls_level,
        "drift_quarantine": drift_quarantine,
    }
    if matched:
        metadata["policy_ids"] = [int(item.policy_id) for item in matched]
        metadata["policy_names"] = [str(item.policy_name) for item in matched]

    row = StreamQuarantineEvent(
        stream_id=int(stream_id),
        route_id=int(route_id),
        quarantine_reason=reason[:256],
        quarantine_source=QUARANTINE_SOURCE_POLICY,
        status=QUARANTINE_STATUS_QUARANTINED,
        protected_payload_json={"events": payload},
        metadata_json=metadata,
        created_at=now,
        updated_at=now,
    )
    try:
        db.add(row)
        db.flush()
        persist_quarantine_observability_log(
            db,
            stage=QUARANTINE_EVENT_CREATED_STAGE,
            stream_id=int(stream_id),
            quarantine_event_id=int(row.id),
            status=row.status,
            quarantine_reason=reason,
            message="route policy quarantine event created",
            extra={
                "event_count": len(payload),
                "quarantine_source": QUARANTINE_SOURCE_POLICY,
                "route_id": int(route_id),
            },
        )
        try:
            from app.governance_violations.service import record_quarantine_governance_notifications

            record_quarantine_governance_notifications(db, row)
        except Exception:
            logger.exception("governance_quarantine_notification_failed quarantine_event_id=%s", row.id)
        return row
    except Exception as exc:
        logger.exception("quarantine_event_record_failed stream_id=%s route_id=%s", stream_id, route_id)
        try:
            persist_quarantine_observability_log(
                db,
                stage=QUARANTINE_EVENT_CREATE_FAILED_STAGE,
                stream_id=int(stream_id),
                quarantine_event_id=0,
                status=QUARANTINE_STATUS_QUARANTINED,
                quarantine_reason=reason,
                message=str(exc)[:500],
                level="ERROR",
                log_status="FAILED",
                error_code="QUARANTINE_RECORD_FAILED",
                extra={"route_id": int(route_id)},
            )
        except Exception:
            logger.exception("quarantine_event_create_failed_log_failed stream_id=%s", stream_id)
        return None
