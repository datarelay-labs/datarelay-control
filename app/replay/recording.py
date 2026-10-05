"""Record protected delivery payloads on final destination failures."""

from __future__ import annotations

import logging
from app.runtime.copy_utils import copy_events
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.formatters.message_prefix import MessagePrefixResolveContext
from app.replay.eligibility import is_replay_record_eligible
from app.replay.metrics import log_replay_event_record_failed, log_replay_event_recorded
from app.replay.models import (
    DELIVERY_KINDS,
    REPLAY_CONTEXT_ORIGIN_DELIVERY_FAILURE,
    REPLAY_CONTEXT_ORIGIN_KEY,
    REPLAY_STATUS_PENDING,
    StreamReplayEvent,
)

logger = logging.getLogger(__name__)

_MAX_REPLAY_EVENTS = 500


def _prefix_context_dict(ctx: MessagePrefixResolveContext | dict[str, Any] | None) -> dict[str, Any]:
    if ctx is None:
        return {}
    if isinstance(ctx, dict):
        return {
            "stream_name": str(ctx.get("stream_name") or ""),
            "stream_id": int(ctx.get("stream_id") or 0),
            "destination_name": str(ctx.get("destination_name") or ""),
            "destination_type": str(ctx.get("destination_type") or ""),
            "route_id": int(ctx.get("route_id") or 0),
        }
    return {
        "stream_name": str(getattr(ctx, "stream_name", "") or ""),
        "stream_id": int(getattr(ctx, "stream_id", 0) or 0),
        "destination_name": str(getattr(ctx, "destination_name", "") or ""),
        "destination_type": str(getattr(ctx, "destination_type", "") or ""),
        "route_id": int(getattr(ctx, "route_id", 0) or 0),
    }


def build_delivery_context_json(
    *,
    destination_type: str,
    formatter_override: dict[str, Any] | None,
    prefix_context: MessagePrefixResolveContext | None,
) -> dict[str, Any]:
    return {
        "destination_type": str(destination_type or "").strip().upper(),
        "formatter_override": dict(formatter_override) if isinstance(formatter_override, dict) and formatter_override else None,
        "prefix_context": _prefix_context_dict(prefix_context),
        REPLAY_CONTEXT_ORIGIN_KEY: REPLAY_CONTEXT_ORIGIN_DELIVERY_FAILURE,
    }


def _snapshot_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return copy_events(events, limit=_MAX_REPLAY_EVENTS)


def record_stream_replay_event(
    db: Session,
    *,
    stream_id: int,
    destination_id: int,
    delivery_kind: str,
    events: list[dict[str, Any]],
    destination_type: str,
    formatter_override: dict[str, Any] | None,
    prefix_context: MessagePrefixResolveContext | None,
    error: Exception | None = None,
    rate_limited: bool = False,
    route_id: int | None = None,
    dynamic_route_id: int | None = None,
    failover_route_id: int | None = None,
) -> StreamReplayEvent | None:
    """Persist a replay event when a destination delivery finally failed."""

    if delivery_kind not in DELIVERY_KINDS:
        return None
    if not events:
        return None
    if not is_replay_record_eligible(error=error, rate_limited=rate_limited):
        return None

    payload = _snapshot_events(events)
    if not payload:
        return None

    now = datetime.now(timezone.utc)
    row = StreamReplayEvent(
        stream_id=int(stream_id),
        destination_id=int(destination_id),
        route_id=int(route_id) if route_id is not None else None,
        dynamic_route_id=int(dynamic_route_id) if dynamic_route_id is not None else None,
        failover_route_id=int(failover_route_id) if failover_route_id is not None else None,
        delivery_kind=delivery_kind,
        status=REPLAY_STATUS_PENDING,
        protected_payload_json={"events": payload},
        delivery_context_json=build_delivery_context_json(
            destination_type=destination_type,
            formatter_override=formatter_override,
            prefix_context=prefix_context,
        ),
        error_type=type(error).__name__ if error is not None else None,
        error_message=str(error)[:2000] if error is not None else None,
        retry_count=0,
        event_count=len(payload),
        created_at=now,
        updated_at=now,
    )
    try:
        db.add(row)
        db.flush()
        log_replay_event_recorded(
            db,
            stream_id=int(stream_id),
            destination_id=int(destination_id),
            replay_event_id=int(row.id),
            delivery_kind=delivery_kind,
            event_count=len(payload),
            route_id=route_id,
        )
        return row
    except Exception as exc:
        logger.exception(
            "replay_event_record_failed stream_id=%s destination_id=%s",
            stream_id,
            destination_id,
        )
        try:
            log_replay_event_record_failed(
                db,
                stream_id=int(stream_id),
                destination_id=int(destination_id),
                route_id=route_id,
                delivery_kind=delivery_kind,
                error_message=str(exc),
            )
        except Exception:
            logger.exception("replay_event_record_failed_log_failed stream_id=%s", stream_id)
        return None
