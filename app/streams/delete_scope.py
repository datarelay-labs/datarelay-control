"""Transactional delete of a stream and stream-scoped rows (never deletes connectors or destinations)."""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.enrichments.models import Enrichment
from app.logs.models import DeliveryLog
from app.mappings.models import Mapping
from app.route_transform.models import RouteEnrichment, RouteMapping
from app.routes.models import Route
from app.streams.models import Stream
from app.streams.repository import get_stream_by_id


def delete_stream_and_dependencies(db: Session, stream_id: int) -> None:
    """Remove stream configuration and routes for this stream only.

    Deletes routes (detaching destinations), mappings, enrichments, checkpoints,
    and delivery_logs rows scoped to this stream or its routes.
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
