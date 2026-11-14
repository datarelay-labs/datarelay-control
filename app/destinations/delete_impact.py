"""Destination delete retention rules and impact summary (E-129 / E-130).

Retention behaviour when a destination is deleted (all of it disclosed by the dialog and audit):

* Delivery logs are KEPT. ``delivery_logs.destination_id`` is set to NULL, the same way Route
  delete sets ``route_id`` to NULL. The logs stay searchable by stream and route.
* Replay jobs for the destination are REMOVED. They can only be delivered to this destination,
  and ``stream_replay_events.destination_id`` is NOT NULL with ON DELETE RESTRICT.
* Runtime snapshots and analytics for the destination are removed (derived data).
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.logs.models import DeliveryLog
from app.replay.models import REPLAY_TERMINAL_STATUSES, StreamReplayEvent
from app.routes.models import Route


def destination_delete_impact(db: Session, destination_id: int) -> dict[str, int]:
    """Counts of what deleting the destination retains (delivery logs) and removes (replay jobs)."""

    replay_total = db.query(StreamReplayEvent).filter(StreamReplayEvent.destination_id == destination_id).count()
    pending = (
        db.query(StreamReplayEvent)
        .filter(
            StreamReplayEvent.destination_id == destination_id,
            StreamReplayEvent.status.notin_(tuple(REPLAY_TERMINAL_STATUSES)),
        )
        .count()
    )
    route_rows = db.query(Route.stream_id).filter(Route.destination_id == destination_id).all()
    return {
        "routes": len(route_rows),
        "streams": len({int(r[0]) for r in route_rows}),
        "delivery_logs_retained": int(
            db.query(DeliveryLog).filter(DeliveryLog.destination_id == destination_id).count()
        ),
        "pending_replay_jobs": int(pending),
        "completed_replay_jobs": int(replay_total - pending),
    }


def detach_destination_history(db: Session, destination_id: int) -> None:
    """Keep delivery logs (destination_id -> NULL) and remove undeliverable replay jobs.

    Does not commit; the caller owns the transaction.
    """

    db.query(DeliveryLog).filter(DeliveryLog.destination_id == destination_id).update(
        {DeliveryLog.destination_id: None}, synchronize_session=False
    )
    db.query(StreamReplayEvent).filter(StreamReplayEvent.destination_id == destination_id).delete(
        synchronize_session=False
    )
