"""Transactional delete of a stream and stream-scoped rows (never deletes connectors or destinations)."""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.enrichments.models import Enrichment
from app.logs.models import DeliveryLog
from app.mappings.models import Mapping
from app.quarantine.models import QUARANTINE_STATUS_QUARANTINED, StreamQuarantineEvent
from app.replay.models import REPLAY_TERMINAL_STATUSES, StreamReplayEvent
from app.route_transform.models import RouteEnrichment, RouteMapping
from app.routes.models import Route
from app.streams.models import Stream
from app.streams.repository import get_stream_by_id


def stream_delete_impact(db: Session, stream_id: int) -> dict[str, int]:
    """Counts of data a stream delete destroys that an operator may still need.

    ``quarantined_events``: events still held in quarantine (status ``quarantined``). They are
    removed by the stream row's ON DELETE CASCADE and can no longer be released or replayed.
    ``pending_replay_jobs``: replay jobs that have not reached a terminal status
    (pending, replaying or failed), so they will never be delivered.
    """

    quarantined = (
        db.query(StreamQuarantineEvent)
        .filter(
            StreamQuarantineEvent.stream_id == stream_id,
            StreamQuarantineEvent.status == QUARANTINE_STATUS_QUARANTINED,
        )
        .count()
    )
    pending = (
        db.query(StreamReplayEvent)
        .filter(
            StreamReplayEvent.stream_id == stream_id,
            StreamReplayEvent.status.notin_(tuple(REPLAY_TERMINAL_STATUSES)),
        )
        .count()
    )
    return {"quarantined_events": int(quarantined), "pending_replay_jobs": int(pending)}


def delete_stream_and_dependencies(db: Session, stream_id: int) -> None:
    """Remove the stream and the configuration that belongs to it.

    Deletes the stream row, its routes, route mapping and enrichment rows,
    stream mapping and enrichment rows, the checkpoint, and delivery_logs
    rows scoped to this stream or its routes. Route protection, classification,
    policy, and runtime snapshot rows follow route deletion through database
    ON DELETE CASCADE, as do quarantine events and replay jobs (see
    ``stream_delete_impact`` for the counts callers must surface and audit).
    Does not delete connector, source, or destination entities.
    Caller must verify the stream is not RUNNING.
    """

    stream = get_stream_by_id(db, stream_id)
    if stream is None:
        raise ValueError("STREAM_NOT_FOUND")

    route_ids = [int(r[0]) for r in db.query(Route.id).filter(Route.stream_id == stream_id).all()]
    if route_ids:
        db.query(DeliveryLog).filter(DeliveryLog.route_id.in_(route_ids)).delete(synchronize_session=False)
        db.query(RouteMapping).filter(RouteMapping.route_id.in_(route_ids)).delete(synchronize_session=False)
        db.query(RouteEnrichment).filter(RouteEnrichment.route_id.in_(route_ids)).delete(synchronize_session=False)
    db.query(DeliveryLog).filter(DeliveryLog.stream_id == stream_id).delete(synchronize_session=False)

    db.query(Route).filter(Route.stream_id == stream_id).delete(synchronize_session=False)

    db.query(Mapping).filter(Mapping.stream_id == stream_id).delete(synchronize_session=False)
    db.query(Enrichment).filter(Enrichment.stream_id == stream_id).delete(synchronize_session=False)
    db.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).delete(synchronize_session=False)

    db.query(Stream).filter(Stream.id == stream_id).delete(synchronize_session=False)
    db.commit()
