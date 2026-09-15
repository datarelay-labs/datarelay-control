"""M11 replay engine — list, replay, discard, summary.

Delivery state (P1-D):
  pending|failed → replaying (durable claim + attempt_id, committed before send)
                → replayed | failed

Crash after external send but before final commit leaves status=replaying.
Recovery reuses the same attempt identity and exposes prior_delivery_uncertain.
Guarantee is at-least-once unless the destination can dedupe via idempotency_key.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.checkpoints.repository import get_checkpoint_by_stream_id
from app.delivery.syslog_sender import SyslogSender
from app.delivery.webhook_sender import WebhookSender
from app.destinations.adapters.registry import DestinationAdapterRegistry
from app.destinations.repository import get_destination_by_id
from app.formatters.message_prefix import MessagePrefixResolveContext
from app.rate_limit.destination_limiter import DestinationRateLimiter
from app.rate_limit.process_destination_limiter import get_process_destination_rate_limiter
from app.replay.metrics import (
    REPLAY_EVENT_DISCARDED_STAGE,
    REPLAY_EVENT_REPLAY_FAILED_STAGE,
    REPLAY_EVENT_REPLAYED_STAGE,
    persist_replay_observability_log,
)
from app.replay.models import (
    DELIVERY_ATTEMPT_CONTEXT_KEY,
    REPLAY_DELIVERY_GUARANTEE_AT_LEAST_ONCE,
    REPLAY_STATUS_DISCARDED,
    REPLAY_STATUS_FAILED,
    REPLAY_STATUS_PENDING,
    REPLAY_STATUS_REPLAYED,
    REPLAY_STATUS_REPLAYING,
    REPLAY_TERMINAL_STATUSES,
    StreamReplayEvent,
)

logger = logging.getLogger(__name__)

_REPLAYABLE_STATUSES = frozenset(
    {REPLAY_STATUS_PENDING, REPLAY_STATUS_FAILED, REPLAY_STATUS_REPLAYING}
)
_LOCK_NOT_AVAILABLE_MARKERS = ("could not obtain lock", "lock_not_available", "55p03")
REPLAY_DESTINATION_RATE_LIMITED = "REPLAY_DESTINATION_RATE_LIMITED"
# Fresh replaying claim → concurrent caller gets ReplayInProgressError.
# Stale claim → crash recovery (reuse attempt_id; prior delivery may have occurred).
REPLAY_CLAIM_STALE_AFTER_SECONDS = 120


def _lock_replay_event_row(db: Session, event_id: int) -> StreamReplayEvent | None:
    """SELECT … FOR UPDATE NOWAIT — concurrent replay/discard on same id serializes."""

    try:
        return (
            db.query(StreamReplayEvent)
            .filter(StreamReplayEvent.id == int(event_id))
            .with_for_update(nowait=True)
            .first()
        )
    except OperationalError as exc:
        err = str(exc).lower()
        if any(marker in err for marker in _LOCK_NOT_AVAILABLE_MARKERS):
            raise ReplayInProgressError(event_id) from exc
        raise


class ReplayEventNotFoundError(Exception):
    def __init__(self, event_id: int) -> None:
        self.event_id = event_id
        super().__init__(f"replay event not found: {event_id}")


class ReplayEventStateError(Exception):
    def __init__(self, error_code: str, message: str) -> None:
        self.error_code = error_code
        self.message = message
        super().__init__(message)


class ReplayInProgressError(Exception):
    """Another request holds the row lock or a fresh replaying claim for this event."""

    def __init__(self, event_id: int) -> None:
        self.event_id = event_id
        super().__init__(f"replay already in progress for event {event_id}")


def _payload_hash(events: list[dict[str, Any]]) -> str:
    canonical = json.dumps(events, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _extract_stored_events(row: StreamReplayEvent) -> list[dict[str, Any]]:
    raw = row.protected_payload_json if isinstance(row.protected_payload_json, dict) else {}
    events = raw.get("events")
    if not isinstance(events, list):
        return []
    out: list[dict[str, Any]] = []
    for item in events:
        if isinstance(item, dict):
            out.append(deepcopy(item))
    return out


def _prefix_from_context(ctx: dict[str, Any]) -> MessagePrefixResolveContext | None:
    if not ctx:
        return None
    return {
        "stream_name": str(ctx.get("stream_name") or ""),
        "stream_id": int(ctx.get("stream_id") or 0),
        "destination_name": str(ctx.get("destination_name") or ""),
        "destination_type": str(ctx.get("destination_type") or ""),
        "route_id": int(ctx.get("route_id") or 0),
    }


def _delivery_attempt_from_row(row: StreamReplayEvent) -> dict[str, Any]:
    ctx = row.delivery_context_json if isinstance(row.delivery_context_json, dict) else {}
    raw = ctx.get(DELIVERY_ATTEMPT_CONTEXT_KEY)
    return dict(raw) if isinstance(raw, dict) else {}


def _parse_claimed_at(raw: Any) -> datetime | None:
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _claim_is_fresh(attempt: dict[str, Any], *, now: datetime) -> bool:
    claimed_at = _parse_claimed_at(attempt.get("claimed_at"))
    if claimed_at is None:
        return False
    return claimed_at >= now - timedelta(seconds=REPLAY_CLAIM_STALE_AFTER_SECONDS)


def _build_attempt_meta(
    *,
    event_id: int,
    attempt_id: str,
    claimed_at: datetime,
    prior_delivery_uncertain: bool,
) -> dict[str, Any]:
    return {
        "attempt_id": attempt_id,
        "idempotency_key": f"replay-{int(event_id)}-{attempt_id}",
        "delivery_guarantee": REPLAY_DELIVERY_GUARANTEE_AT_LEAST_ONCE,
        "prior_delivery_uncertain": bool(prior_delivery_uncertain),
        "claimed_at": claimed_at.isoformat(),
    }


def _delivery_state_fields(attempt: dict[str, Any]) -> dict[str, Any]:
    return {
        "attempt_id": attempt.get("attempt_id"),
        "idempotency_key": attempt.get("idempotency_key"),
        "delivery_guarantee": attempt.get("delivery_guarantee") or REPLAY_DELIVERY_GUARANTEE_AT_LEAST_ONCE,
        "prior_delivery_uncertain": bool(attempt.get("prior_delivery_uncertain")),
        "claimed_at": attempt.get("claimed_at"),
    }


def replay_event_to_dict(row: StreamReplayEvent) -> dict[str, Any]:
    attempt = _delivery_attempt_from_row(row)
    base = {
        "id": row.id,
        "stream_id": row.stream_id,
        "destination_id": row.destination_id,
        "route_id": row.route_id,
        "dynamic_route_id": row.dynamic_route_id,
        "failover_route_id": row.failover_route_id,
        "delivery_kind": row.delivery_kind,
        "status": row.status,
        "error_type": row.error_type,
        "error_message": row.error_message,
        "retry_count": row.retry_count,
        "event_count": row.event_count,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "last_replay_at": row.last_replay_at,
    }
    if attempt:
        base.update(_delivery_state_fields(attempt))
    return base


def list_stream_replay_events(
    db: Session,
    stream_id: int,
    *,
    status: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    lim = max(1, min(int(limit), 200))
    stmt = select(StreamReplayEvent).where(StreamReplayEvent.stream_id == int(stream_id))
    if status:
        stmt = stmt.where(StreamReplayEvent.status == str(status))
    stmt = stmt.order_by(StreamReplayEvent.created_at.desc(), StreamReplayEvent.id.desc()).limit(lim)
    rows = list(db.execute(stmt).scalars())
    return [replay_event_to_dict(r) for r in rows]


def _count_by_status(db: Session, stream_id: int | None = None) -> dict[str, int]:
    stmt = select(StreamReplayEvent.status, func.count(StreamReplayEvent.id)).group_by(StreamReplayEvent.status)
    if stream_id is not None:
        stmt = stmt.where(StreamReplayEvent.stream_id == int(stream_id))
    counts = {
        REPLAY_STATUS_PENDING: 0,
        REPLAY_STATUS_REPLAYING: 0,
        REPLAY_STATUS_REPLAYED: 0,
        REPLAY_STATUS_FAILED: 0,
        REPLAY_STATUS_DISCARDED: 0,
    }
    for status, cnt in db.execute(stmt).all():
        if status in counts:
            counts[str(status)] = int(cnt or 0)
    return counts


def build_stream_replay_summary(db: Session, stream_id: int) -> dict[str, Any]:
    counts = _count_by_status(db, stream_id)
    latest = (
        db.execute(
            select(StreamReplayEvent)
            .where(StreamReplayEvent.stream_id == int(stream_id))
            .order_by(StreamReplayEvent.created_at.desc(), StreamReplayEvent.id.desc())
            .limit(1)
        )
        .scalar_one_or_none()
    )
    return {
        "stream_id": stream_id,
        "pending_count": counts[REPLAY_STATUS_PENDING],
        "replaying_count": counts[REPLAY_STATUS_REPLAYING],
        "replayed_count": counts[REPLAY_STATUS_REPLAYED],
        "failed_count": counts[REPLAY_STATUS_FAILED],
        "discarded_count": counts[REPLAY_STATUS_DISCARDED],
        "total_count": sum(counts.values()),
        "last_recorded_at": latest.created_at if latest is not None else None,
    }


def build_platform_replay_summary(db: Session) -> dict[str, Any]:
    counts = _count_by_status(db, None)
    stream_rows = db.execute(
        select(StreamReplayEvent.stream_id, func.count(StreamReplayEvent.id))
        .where(StreamReplayEvent.status == REPLAY_STATUS_PENDING)
        .group_by(StreamReplayEvent.stream_id)
        .order_by(func.count(StreamReplayEvent.id).desc())
        .limit(20)
    ).all()
    return {
        "pending_count": counts[REPLAY_STATUS_PENDING],
        "replaying_count": counts[REPLAY_STATUS_REPLAYING],
        "replayed_count": counts[REPLAY_STATUS_REPLAYED],
        "failed_count": counts[REPLAY_STATUS_FAILED],
        "discarded_count": counts[REPLAY_STATUS_DISCARDED],
        "total_count": sum(counts.values()),
        "streams_with_pending": [
            {"stream_id": int(sid), "pending_count": int(cnt)} for sid, cnt in stream_rows
        ],
    }


def checkpoint_unchanged(db: Session, stream_id: int, before: dict[str, Any]) -> bool:
    row = get_checkpoint_by_stream_id(db, stream_id)
    if row is None:
        return before == {}
    after = row.checkpoint_value_json if isinstance(row.checkpoint_value_json, dict) else {}
    return after == before


def discard_replay_event(db: Session, event_id: int) -> dict[str, Any]:
    row = _lock_replay_event_row(db, event_id)
    if row is None:
        raise ReplayEventNotFoundError(event_id)
    if row.status in REPLAY_TERMINAL_STATUSES:
        raise ReplayEventStateError(
            "REPLAY_INVALID_STATE",
            f"cannot discard replay event in status {row.status!r}",
        )
    now = datetime.now(timezone.utc)
    row.status = REPLAY_STATUS_DISCARDED
    row.updated_at = now
    persist_replay_observability_log(
        db,
        stage=REPLAY_EVENT_DISCARDED_STAGE,
        stream_id=int(row.stream_id),
        destination_id=int(row.destination_id),
        replay_event_id=int(row.id),
        status=row.status,
        retry_count=int(row.retry_count),
        route_id=row.route_id,
        message="replay event discarded",
    )
    db.flush()
    return replay_event_to_dict(row)


def _effective_replay_rate_limit_json(db: Session, row: StreamReplayEvent, destination: Any) -> tuple[int, dict[str, Any]]:
    """Route limit overrides destination limit (same precedence as StreamRunner)."""

    rate_limit: dict[str, Any] = {}
    limiter_key = int(row.destination_id)
    if row.route_id is not None:
        from app.routes.models import Route

        route = db.get(Route, int(row.route_id))
        if route is not None:
            limiter_key = int(route.id)
            route_rl = route.rate_limit_json if isinstance(route.rate_limit_json, dict) else {}
            if route_rl:
                rate_limit = dict(route_rl)
    if not rate_limit:
        dest_rl = destination.rate_limit_json if isinstance(destination.rate_limit_json, dict) else {}
        if dest_rl:
            rate_limit = dict(dest_rl)
    return limiter_key, rate_limit


def _commit_replay_claim(
    db: Session,
    row: StreamReplayEvent,
    *,
    attempt: dict[str, Any],
    now: datetime,
) -> dict[str, Any]:
    """Persist replaying + attempt identity before any external side effect."""

    ctx = dict(row.delivery_context_json) if isinstance(row.delivery_context_json, dict) else {}
    ctx[DELIVERY_ATTEMPT_CONTEXT_KEY] = attempt
    row.delivery_context_json = ctx
    row.status = REPLAY_STATUS_REPLAYING
    row.updated_at = now
    row.last_replay_at = now
    row.error_type = None
    row.error_message = None
    db.flush()
    db.commit()
    return attempt


def execute_replay_event(
    db: Session,
    event_id: int,
    *,
    destination_registry: DestinationAdapterRegistry | None = None,
    destination_limiter: DestinationRateLimiter | None = None,
) -> dict[str, Any]:
    """Resend stored protected payload; never updates checkpoints.

    Commits a durable ``replaying`` claim (with attempt_id) before destination.send
    so a crash after the external side effect cannot silently revert to pending and
    invite an unaware duplicate without recovery metadata.
    """

    row = _lock_replay_event_row(db, event_id)
    if row is None:
        raise ReplayEventNotFoundError(event_id)
    if row.status == REPLAY_STATUS_DISCARDED:
        raise ReplayEventStateError(
            "REPLAY_DISCARDED",
            "discarded replay events cannot be replayed",
        )
    if row.status == REPLAY_STATUS_REPLAYED:
        raise ReplayEventStateError(
            "REPLAY_ALREADY_REPLAYED",
            "replayed events cannot be replayed again",
        )
    if row.status not in _REPLAYABLE_STATUSES:
        raise ReplayEventStateError(
            "REPLAY_INVALID_STATE",
            f"replay not allowed for status {row.status!r}",
        )

    now = datetime.now(timezone.utc)
    existing_attempt = _delivery_attempt_from_row(row)
    prior_delivery_uncertain = False
    if row.status == REPLAY_STATUS_REPLAYING:
        if _claim_is_fresh(existing_attempt, now=now):
            raise ReplayInProgressError(event_id)
        # Stale claim: prior send may have completed; reuse attempt identity.
        prior_delivery_uncertain = True
        attempt_id = str(existing_attempt.get("attempt_id") or "").strip() or uuid.uuid4().hex
    else:
        attempt_id = uuid.uuid4().hex

    events = _extract_stored_events(row)
    if not events:
        raise ReplayEventStateError("REPLAY_PAYLOAD_EMPTY", "stored protected payload is empty")

    before_hash = _payload_hash(events)

    destination = get_destination_by_id(db, int(row.destination_id))
    if destination is None:
        raise ReplayEventStateError("REPLAY_DESTINATION_NOT_FOUND", "destination not found")
    if not bool(destination.enabled):
        raise ReplayEventStateError("REPLAY_DESTINATION_DISABLED", "destination is disabled")

    ctx = row.delivery_context_json if isinstance(row.delivery_context_json, dict) else {}
    destination_type = str(ctx.get("destination_type") or destination.destination_type or "").strip().upper()
    formatter_override = ctx.get("formatter_override")
    formatter: dict[str, Any] | None = None
    if isinstance(formatter_override, dict) and formatter_override:
        formatter = dict(formatter_override)
    prefix_context = _prefix_from_context(
        ctx.get("prefix_context") if isinstance(ctx.get("prefix_context"), dict) else {}
    )

    registry = destination_registry or DestinationAdapterRegistry(
        syslog_sender=SyslogSender(),
        webhook_sender=WebhookSender(),
    )
    from app.ai_providers.runtime_config import resolve_destination_runtime_config

    destination_config = resolve_destination_runtime_config(
        db,
        destination_type,
        dict(destination.config_json or {}),
    )

    limiter = destination_limiter or get_process_destination_rate_limiter()
    limiter_key, effective_rl = _effective_replay_rate_limit_json(db, row, destination)
    if not limiter.allow(limiter_key, effective_rl):
        persist_replay_observability_log(
            db,
            stage=REPLAY_EVENT_REPLAY_FAILED_STAGE,
            stream_id=int(row.stream_id),
            destination_id=int(row.destination_id),
            replay_event_id=int(row.id),
            status=row.status,
            retry_count=int(row.retry_count or 0),
            route_id=row.route_id,
            message="destination rate limited",
            level="WARN",
            log_status="RATE_LIMITED",
            error_code=REPLAY_DESTINATION_RATE_LIMITED,
        )
        db.flush()
        raise ReplayEventStateError(
            REPLAY_DESTINATION_RATE_LIMITED,
            "destination rate limited",
        )

    attempt = _build_attempt_meta(
        event_id=int(row.id),
        attempt_id=attempt_id,
        claimed_at=now,
        prior_delivery_uncertain=prior_delivery_uncertain,
    )
    # Preserve idempotency_key from an existing stale claim when present.
    if prior_delivery_uncertain and existing_attempt.get("idempotency_key"):
        attempt["idempotency_key"] = str(existing_attempt["idempotency_key"])
    attempt = _commit_replay_claim(db, row, attempt=attempt, now=now)
    idempotency_key = str(attempt.get("idempotency_key") or "")

    send_started = time.monotonic()
    send_error: Exception | None = None
    try:
        registry.get(destination_type).send(
            events,
            destination_config,
            formatter_override=formatter,
            prefix_context=prefix_context,
            idempotency_key=idempotency_key or None,
        )
    except Exception as exc:
        send_error = exc

    # Re-lock after external I/O; claim commit released the prior row lock.
    row = _lock_replay_event_row(db, event_id)
    if row is None:
        raise ReplayEventNotFoundError(event_id)
    if row.status == REPLAY_STATUS_DISCARDED:
        raise ReplayEventStateError(
            "REPLAY_DISCARDED",
            "replay event was discarded during delivery",
        )
    if row.status == REPLAY_STATUS_REPLAYED:
        raise ReplayEventStateError(
            "REPLAY_ALREADY_REPLAYED",
            "replayed events cannot be replayed again",
        )

    finish_now = datetime.now(timezone.utc)
    latency_ms = max(0, int((time.monotonic() - send_started) * 1000))

    if send_error is not None:
        row.status = REPLAY_STATUS_FAILED
        row.retry_count = int(row.retry_count or 0) + 1
        row.updated_at = finish_now
        row.last_replay_at = finish_now
        row.error_type = type(send_error).__name__
        row.error_message = str(send_error)[:2000]
        # Keep attempt metadata for operator visibility after failure.
        failed_ctx = dict(row.delivery_context_json) if isinstance(row.delivery_context_json, dict) else {}
        failed_ctx[DELIVERY_ATTEMPT_CONTEXT_KEY] = {
            **attempt,
            "prior_delivery_uncertain": True,
        }
        row.delivery_context_json = failed_ctx
        persist_replay_observability_log(
            db,
            stage=REPLAY_EVENT_REPLAY_FAILED_STAGE,
            stream_id=int(row.stream_id),
            destination_id=int(row.destination_id),
            replay_event_id=int(row.id),
            status=row.status,
            retry_count=int(row.retry_count),
            route_id=row.route_id,
            message=str(send_error)[:500],
            level="ERROR",
            log_status="FAILED",
            error_code=type(send_error).__name__,
            extra={
                "latency_ms": latency_ms,
                "event_count": len(events),
                "attempt_id": attempt.get("attempt_id"),
                "delivery_guarantee": REPLAY_DELIVERY_GUARANTEE_AT_LEAST_ONCE,
            },
        )
        db.flush()
        return {
            **replay_event_to_dict(row),
            "outcome": "failed",
            "message": str(send_error),
            "payload_hash": before_hash,
            **_delivery_state_fields(
                {**attempt, "prior_delivery_uncertain": True},
            ),
        }

    after_hash = _payload_hash(_extract_stored_events(row))
    if after_hash != before_hash:
        logger.warning(
            "replay_payload_hash_mismatch replay_event_id=%s before=%s after=%s",
            row.id,
            before_hash[:16],
            after_hash[:16],
        )

    row.status = REPLAY_STATUS_REPLAYED
    row.retry_count = int(row.retry_count or 0) + 1
    row.updated_at = finish_now
    row.last_replay_at = finish_now
    row.error_type = None
    row.error_message = None
    success_ctx = dict(row.delivery_context_json) if isinstance(row.delivery_context_json, dict) else {}
    success_ctx[DELIVERY_ATTEMPT_CONTEXT_KEY] = attempt
    row.delivery_context_json = success_ctx
    persist_replay_observability_log(
        db,
        stage=REPLAY_EVENT_REPLAYED_STAGE,
        stream_id=int(row.stream_id),
        destination_id=int(row.destination_id),
        replay_event_id=int(row.id),
        status=row.status,
        retry_count=int(row.retry_count),
        route_id=row.route_id,
        message="replay delivered successfully (at-least-once)",
        extra={
            "latency_ms": latency_ms,
            "event_count": len(events),
            "payload_hash": before_hash,
            "attempt_id": attempt.get("attempt_id"),
            "idempotency_key": attempt.get("idempotency_key"),
            "delivery_guarantee": REPLAY_DELIVERY_GUARANTEE_AT_LEAST_ONCE,
            "prior_delivery_uncertain": bool(attempt.get("prior_delivery_uncertain")),
        },
    )
    db.flush()
    return {
        **replay_event_to_dict(row),
        "outcome": "replayed",
        "message": (
            "Replay delivered successfully (checkpoint unchanged; "
            "at-least-once — destination may see duplicates if it cannot dedupe)."
        ),
        "payload_hash": before_hash,
        **_delivery_state_fields(attempt),
    }
