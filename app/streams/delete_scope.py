"""Transactional delete of a stream and stream-scoped rows (never deletes connectors or destinations)."""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.enrichments.models import Enrichment
from app.logs.models import DeliveryLog
from app.mappings.models import Mapping
from app.platform_admin.models import PlatformAlertHistory
from app.quarantine.models import QUARANTINE_STATUS_QUARANTINED, StreamQuarantineEvent
from app.replay.models import REPLAY_TERMINAL_STATUSES, StreamReplayEvent
from app.route_transform.models import RouteEnrichment, RouteMapping
from app.routes.models import Route
from app.runtime.models import RuntimeAnalyticsBucket1m, RuntimeAnalyticsBucket5m
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


def purge_runtime_analytics(
    db: Session,
    *,
    stream_id: int | None = None,
    route_id: int | None = None,
    destination_id: int | None = None,
    include_alert_history: bool = False,
) -> dict[str, int]:
    """Delete derived analytics rows keyed to an entity that no longer exists (F-229).

    Pre-aggregated 1m/5m buckets carry plain integer ids (no foreign key), so deleting a
    stream, route or destination otherwise leaves rows that keep feeding charts and totals
    for an object that is gone. Exactly one selector is expected. Rows of other entities and
    the retention settings are not touched. ``include_alert_history`` also removes webhook
    alert history rows for the stream (only used when the whole stream is deleted).
    Does not commit; the caller owns the transaction.
    """

    selectors = {
        "stream_id": stream_id,
        "route_id": route_id,
        "destination_id": destination_id,
    }
    active = {k: v for k, v in selectors.items() if v is not None}
    if len(active) != 1:
        raise ValueError("purge_runtime_analytics requires exactly one of stream_id, route_id, destination_id")
    column_name, value = next(iter(active.items()))
    removed = {"buckets_1m": 0, "buckets_5m": 0, "alert_history": 0}
    for key, model in (("buckets_1m", RuntimeAnalyticsBucket1m), ("buckets_5m", RuntimeAnalyticsBucket5m)):
        removed[key] = int(
            db.query(model).filter(getattr(model, column_name) == value).delete(synchronize_session=False)
        )
    if include_alert_history and column_name == "stream_id":
        removed["alert_history"] = int(
            db.query(PlatformAlertHistory)
            .filter(PlatformAlertHistory.stream_id == value)
            .delete(synchronize_session=False)
        )
    return removed


def delete_stream_and_dependencies(db: Session, stream_id: int) -> None:
    """Remove the stream and the configuration that belongs to it.

    Deletes the stream row, its routes, route mapping and enrichment rows,
    stream mapping and enrichment rows, the checkpoint, and delivery_logs
    rows scoped to this stream or its routes, and the derived analytics buckets and alert
    history rows keyed to the stream (see ``purge_runtime_analytics``). Route protection, classification,
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

    purge_runtime_analytics(db, stream_id=stream_id, include_alert_history=True)

    db.query(Stream).filter(Stream.id == stream_id).delete(synchronize_session=False)
    db.commit()
