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
    REPLAY_CONTEXT_EVENT_IDENTITIES_KEY,
    REPLAY_CONTEXT_EVENTS_FINGERPRINT_KEY,
    REPLAY_CONTEXT_FAILURE_OCCURRENCES_KEY,
    REPLAY_CONTEXT_ORIGIN_DELIVERY_FAILURE,
    REPLAY_CONTEXT_ORIGIN_KEY,
    REPLAY_STATUS_PENDING,
    StreamReplayEvent,
)
from app.replay.reconciliation import (
    compute_event_identities,
    find_open_duplicate_job,
    identities_fingerprint,
    note_repeated_failure,
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
    event_identities: list[str] | None = None,
) -> dict[str, Any]:
    context: dict[str, Any] = {
        "destination_type": str(destination_type or "").strip().upper(),
        "formatter_override": dict(formatter_override) if isinstance(formatter_override, dict) and formatter_override else None,
        "prefix_context": _prefix_context_dict(prefix_context),
        REPLAY_CONTEXT_ORIGIN_KEY: REPLAY_CONTEXT_ORIGIN_DELIVERY_FAILURE,
    }
    if event_identities:
        context[REPLAY_CONTEXT_EVENT_IDENTITIES_KEY] = list(event_identities)
        context[REPLAY_CONTEXT_EVENTS_FINGERPRINT_KEY] = identities_fingerprint(event_identities)
        context[REPLAY_CONTEXT_FAILURE_OCCURRENCES_KEY] = 1
    return context


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
    """Persist a replay event when a destination delivery finally failed.

    A held checkpoint window re-fails the same events on every poll. When an open job
    already covers exactly these events for the same Stream / Route / Destination, the
    failure is folded into it (occurrence count) instead of creating another job (E-114).
    """

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
    identities = compute_event_identities(payload)
    try:
        existing = find_open_duplicate_job(
            db,
            stream_id=int(stream_id),
            destination_id=int(destination_id),
            route_id=int(route_id) if route_id is not None else None,
            dynamic_route_id=int(dynamic_route_id) if dynamic_route_id is not None else None,
            failover_route_id=int(failover_route_id) if failover_route_id is not None else None,
            delivery_kind=delivery_kind,
            identities=identities,
        )
        if existing is not None:
            note_repeated_failure(existing, error=error, now=now)
            db.flush()
            return existing
    except Exception:
        # Never lose the failure record because the duplicate lookup failed.
        logger.exception("replay_event_dedupe_failed stream_id=%s destination_id=%s", stream_id, destination_id)
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
            event_identities=identities,
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
