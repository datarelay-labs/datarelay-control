"""Replay job identity, de-duplication and delivery reconciliation (WP-E).

A replay job (``stream_replay_events`` row) is a protected snapshot of the events a Route
failed to deliver. Three problems made the Replay Center unsafe:

* E-114: every poll of a held checkpoint window re-recorded the *same* failed events, so
  the queue grew by one job per poll. Recording now collapses onto the open job that
  already covers the same events for the same Stream / Route / Destination.
* E-113: when the receiver later got those events (automatic redelivery, another replay
  path) the job stayed Pending and executable. Every successful delivery path now
  *supersedes* open jobs whose events were all delivered.
* E-051: Logs "Replay delivery" and Replay Center jobs for the same failure were not
  reconciled. Both paths share the helpers below and refuse to re-deliver events that
  another path already delivered unless the operator passes an explicit override.

Event identity is the occurrence-aware content fingerprint already used for per-Route
delivery state (runtime ``__gdc_*`` metadata excluded), so it is stable across polls.
All metadata lives in ``delivery_context_json``; no schema migration is required.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.checkpoints.route_delivery_state import event_fingerprints
from app.replay.models import (
    REPLAY_CONTEXT_EVENT_IDENTITIES_KEY,
    REPLAY_CONTEXT_EVENTS_FINGERPRINT_KEY,
    REPLAY_CONTEXT_FAILURE_OCCURRENCES_KEY,
    REPLAY_CONTEXT_LAST_FAILURE_AT_KEY,
    REPLAY_CONTEXT_ORIGIN_DELIVERY_FAILURE,
    REPLAY_CONTEXT_ORIGIN_KEY,
    REPLAY_CONTEXT_RECONCILIATION_KEY,
    REPLAY_OPEN_STATUSES,
    REPLAY_RECONCILIATION_SUPERSEDED,
    REPLAY_STATUS_DISCARDED,
    REPLAY_STATUS_PENDING,
    REPLAY_STATUS_REPLAYED,
    StreamReplayEvent,
)

REPLAY_ALREADY_DELIVERED = "REPLAY_ALREADY_DELIVERED"
REPLAY_SUPERSEDED = "REPLAY_SUPERSEDED"

SUPERSEDE_SOURCE_RUNTIME_DELIVERY = "runtime_delivery"
SUPERSEDE_SOURCE_REPLAY_JOB = "replay_job"
SUPERSEDE_SOURCE_LOGS_REPLAY = "logs_replay"

_FINGERPRINT_HEX_LEN = 32
_MAX_GUARD_CANDIDATES = 100


def compute_event_identities(events: list[dict[str, Any]]) -> list[str]:
    """Stable per-event identities for a recorded / delivered event list."""

    return event_fingerprints([e for e in events if isinstance(e, dict)])


def identities_fingerprint(identities: list[str]) -> str:
    """Order-independent digest of an identity set (duplicate-job lookup key)."""

    digest = hashlib.sha256("\n".join(sorted(identities)).encode("utf-8")).hexdigest()
    return digest[:_FINGERPRINT_HEX_LEN]


def _context(row: StreamReplayEvent) -> dict[str, Any]:
    return row.delivery_context_json if isinstance(row.delivery_context_json, dict) else {}


def row_identities(row: StreamReplayEvent) -> list[str]:
    """Identities stored on the job, or derived from its payload for legacy rows."""

    stored = _context(row).get(REPLAY_CONTEXT_EVENT_IDENTITIES_KEY)
    if isinstance(stored, list) and stored and all(isinstance(x, str) for x in stored):
        return list(stored)
    payload = row.protected_payload_json if isinstance(row.protected_payload_json, dict) else {}
    events = payload.get("events")
    if not isinstance(events, list):
        return []
    return compute_event_identities(events)


def is_delivery_failure_origin(row: StreamReplayEvent) -> bool:
    origin = str(_context(row).get(REPLAY_CONTEXT_ORIGIN_KEY) or "").strip().lower()
    # Rows written before the origin key existed are delivery-failure recordings.
    return origin in {"", REPLAY_CONTEXT_ORIGIN_DELIVERY_FAILURE}


def reconciliation_info(row: StreamReplayEvent) -> dict[str, Any] | None:
    info = _context(row).get(REPLAY_CONTEXT_RECONCILIATION_KEY)
    return dict(info) if isinstance(info, dict) else None


def is_superseded(row: StreamReplayEvent) -> bool:
    info = reconciliation_info(row)
    return bool(info) and info.get("state") == REPLAY_RECONCILIATION_SUPERSEDED


def failure_occurrences(row: StreamReplayEvent) -> int:
    raw = _context(row).get(REPLAY_CONTEXT_FAILURE_OCCURRENCES_KEY)
    try:
        return max(1, int(raw))
    except (TypeError, ValueError):
        return 1


def _nullable_eq(column: Any, value: int | None) -> Any:
    return column.is_(None) if value is None else column == int(value)


def _scope_filters(
    *,
    stream_id: int,
    destination_id: int,
    route_id: int | None,
    dynamic_route_id: int | None,
    failover_route_id: int | None,
) -> list[Any]:
    return [
        StreamReplayEvent.stream_id == int(stream_id),
        StreamReplayEvent.destination_id == int(destination_id),
        _nullable_eq(StreamReplayEvent.route_id, route_id),
        _nullable_eq(StreamReplayEvent.dynamic_route_id, dynamic_route_id),
        _nullable_eq(StreamReplayEvent.failover_route_id, failover_route_id),
    ]


def find_open_duplicate_job(
    db: Session,
    *,
    stream_id: int,
    destination_id: int,
    route_id: int | None,
    dynamic_route_id: int | None,
    failover_route_id: int | None,
    delivery_kind: str,
    identities: list[str],
) -> StreamReplayEvent | None:
    """Return the open job that already covers exactly these events (E-114)."""

    if not identities:
        return None
    fingerprint = identities_fingerprint(identities)
    stmt = (
        select(StreamReplayEvent)
        .where(
            *_scope_filters(
                stream_id=stream_id,
                destination_id=destination_id,
                route_id=route_id,
                dynamic_route_id=dynamic_route_id,
                failover_route_id=failover_route_id,
            ),
            StreamReplayEvent.delivery_kind == delivery_kind,
            StreamReplayEvent.status.in_(sorted(REPLAY_OPEN_STATUSES)),
            StreamReplayEvent.delivery_context_json[REPLAY_CONTEXT_EVENTS_FINGERPRINT_KEY].astext
            == fingerprint,
        )
        .order_by(StreamReplayEvent.id.desc())
        .limit(1)
    )
    return db.execute(stmt).scalars().first()


def note_repeated_failure(
    row: StreamReplayEvent,
    *,
    error: Exception | None,
    now: datetime | None = None,
) -> None:
    """Fold another failure of the same events into the existing open job."""

    stamp = now or datetime.now(timezone.utc)
    ctx = dict(_context(row))
    ctx[REPLAY_CONTEXT_FAILURE_OCCURRENCES_KEY] = failure_occurrences(row) + 1
    ctx[REPLAY_CONTEXT_LAST_FAILURE_AT_KEY] = stamp.isoformat()
    row.delivery_context_json = ctx
    row.updated_at = stamp
    # Only a never-replayed job mirrors the latest recording error; a failed replay keeps
    # the error of the replay attempt the operator last saw.
    if error is not None and str(row.status) == REPLAY_STATUS_PENDING:
        row.error_type = type(error).__name__
        row.error_message = str(error)[:2000]


def _supersede_message(source: str, detail: str | None) -> str:
    if source == SUPERSEDE_SOURCE_REPLAY_JOB:
        base = "These events were already delivered by another replay job"
    elif source == SUPERSEDE_SOURCE_LOGS_REPLAY:
        base = "These events were already delivered by a Logs delivery replay"
    else:
        base = "These events were later delivered to this destination automatically"
    return f"{base} ({detail})." if detail else f"{base}."


def supersede_delivered_jobs(
    db: Session,
    *,
    stream_id: int,
    destination_id: int,
    route_id: int | None,
    dynamic_route_id: int | None = None,
    failover_route_id: int | None = None,
    delivered_events: list[dict[str, Any]] | None = None,
    delivered_identities: list[str] | None = None,
    source: str,
    detail: str | None = None,
    exclude_ids: tuple[int, ...] = (),
) -> list[int]:
    """Close open jobs whose events were all delivered; return the superseded ids (E-113).

    Superseded jobs become ``discarded`` (terminal, never executable) and carry a
    reconciliation marker so the Replay Center and Logs can explain why. Never raises on
    contention: rows locked by an executing replay are skipped.
    """

    delivered = list(delivered_identities or [])
    if not delivered and delivered_events:
        delivered = compute_event_identities(delivered_events)
    if not delivered:
        return []
    delivered_set = set(delivered)

    stmt = (
        select(StreamReplayEvent)
        .where(
            *_scope_filters(
                stream_id=stream_id,
                destination_id=destination_id,
                route_id=route_id,
                dynamic_route_id=dynamic_route_id,
                failover_route_id=failover_route_id,
            ),
            StreamReplayEvent.status.in_(sorted(REPLAY_OPEN_STATUSES)),
        )
        .order_by(StreamReplayEvent.id)
        .with_for_update(skip_locked=True)
    )
    rows = list(db.execute(stmt).scalars())
    if not rows:
        return []

    from app.replay.metrics import REPLAY_EVENT_DISCARDED_STAGE, persist_replay_observability_log

    now = datetime.now(timezone.utc)
    superseded: list[int] = []
    for row in rows:
        if int(row.id) in exclude_ids or not is_delivery_failure_origin(row):
            continue
        identities = row_identities(row)
        if not identities or not set(identities) <= delivered_set:
            continue
        message = _supersede_message(source, detail)
        ctx = dict(_context(row))
        ctx[REPLAY_CONTEXT_RECONCILIATION_KEY] = {
            "state": REPLAY_RECONCILIATION_SUPERSEDED,
            "source": source,
            "detail": detail,
            "message": message,
            "at": now.isoformat(),
        }
        row.delivery_context_json = ctx
        row.status = REPLAY_STATUS_DISCARDED
        row.updated_at = now
        persist_replay_observability_log(
            db,
            stage=REPLAY_EVENT_DISCARDED_STAGE,
            stream_id=int(row.stream_id),
            destination_id=int(row.destination_id),
            replay_event_id=int(row.id),
            status=row.status,
            retry_count=int(row.retry_count or 0),
            route_id=row.route_id,
            message=f"replay event superseded: {message}",
            extra={"superseded": True, "superseded_source": source},
        )
        superseded.append(int(row.id))
    if superseded:
        db.flush()
    return superseded


def _delivered_at(row: StreamReplayEvent) -> datetime | None:
    if str(row.status) == REPLAY_STATUS_REPLAYED:
        return row.last_replay_at or row.updated_at
    info = reconciliation_info(row)
    if str(row.status) == REPLAY_STATUS_DISCARDED and info and info.get("state") == REPLAY_RECONCILIATION_SUPERSEDED:
        raw = info.get("at")
        if isinstance(raw, str):
            try:
                parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            except ValueError:
                return row.updated_at
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        return row.updated_at
    return None


def find_prior_delivery(
    db: Session,
    *,
    stream_id: int,
    destination_id: int,
    route_id: int | None,
    dynamic_route_id: int | None,
    failover_route_id: int | None,
    identities: list[str],
    since: datetime,
    exclude_id: int | None = None,
) -> StreamReplayEvent | None:
    """Return a job that already delivered all ``identities`` after ``since``.

    ``since`` is when the failure being replayed was recorded: only a delivery that
    happened afterwards can have satisfied it (identical content recorded earlier must
    not block a genuinely new failure).
    """

    if not identities:
        return None
    wanted = set(identities)
    stmt = (
        select(StreamReplayEvent)
        .where(
            *_scope_filters(
                stream_id=stream_id,
                destination_id=destination_id,
                route_id=route_id,
                dynamic_route_id=dynamic_route_id,
                failover_route_id=failover_route_id,
            ),
            StreamReplayEvent.status.in_([REPLAY_STATUS_REPLAYED, REPLAY_STATUS_DISCARDED]),
            StreamReplayEvent.updated_at >= since,
        )
        .order_by(StreamReplayEvent.id.desc())
        .limit(_MAX_GUARD_CANDIDATES)
    )
    for candidate in db.execute(stmt).scalars():
        if exclude_id is not None and int(candidate.id) == int(exclude_id):
            continue
        delivered_at = _delivered_at(candidate)
        if delivered_at is None or delivered_at < since:
            continue
        if wanted <= set(row_identities(candidate)):
            return candidate
    return None


def describe_prior_delivery(prior: StreamReplayEvent) -> str:
    if str(prior.status) == REPLAY_STATUS_REPLAYED:
        return f"replay job #{int(prior.id)} already replayed them"
    info = reconciliation_info(prior) or {}
    return str(info.get("message") or f"replay job #{int(prior.id)} was closed because they were delivered")
