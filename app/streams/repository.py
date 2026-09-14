"""DB repository for streams."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.orm import Session, joinedload

from app.streams.models import Stream
from app.streams.runtime_eligibility import is_stream_scheduler_runnable


@dataclass(frozen=True, slots=True)
class StreamSchedulerGateRow:
    """Detached light projection for scheduler enabled-state bulk refresh."""

    stream_id: int
    enabled: bool
    status: str
    polling_interval: float
    name: str | None


def get_stream_by_id(db: Session, stream_id: int) -> Stream | None:
    """Return stream by primary key."""

    return db.query(Stream).filter(Stream.id == stream_id).first()


def update_stream_status(db: Session, stream_id: int, status: str) -> Stream | None:
    """Update stream status by stream id."""

    stream = get_stream_by_id(db, stream_id)
    if stream is None:
        return None
    stream.status = status
    db.add(stream)
    return stream


def list_stream_scheduler_gates(db: Session) -> list[StreamSchedulerGateRow]:
    """Bulk-load id/enabled/status/polling_interval/name for scheduler workers (one query)."""

    rows = db.query(Stream.id, Stream.enabled, Stream.status, Stream.polling_interval, Stream.name).all()
    return [
        StreamSchedulerGateRow(
            stream_id=int(row[0]),
            enabled=bool(row[1]),
            status=str(row[2] or ""),
            polling_interval=float(row[3] or 60),
            name=row[4],
        )
        for row in rows
    ]


def get_enabled_stream_ids(db: Session) -> list[int]:
    """Return Stream IDs eligible for scheduler delivery (enabled + RUNNING)."""

    from app.dev_validation_lab.runtime_gates import dev_validation_runtime_enabled

    q = db.query(Stream.id, Stream.enabled, Stream.status).filter(Stream.enabled == True)  # noqa: E712
    if not dev_validation_runtime_enabled():
        from app.dev_validation_lab.templates import LAB_NAME_PREFIX

        q = q.filter(~Stream.name.startswith(LAB_NAME_PREFIX))
    rows = q.all()
    return [
        int(row[0])
        for row in rows
        if is_stream_scheduler_runnable(enabled=bool(row[1]), status=row[2])
    ]


def list_streams(db: Session) -> list[Stream]:
    """All streams ordered by id (read-only list for UI)."""

    return db.query(Stream).options(joinedload(Stream.source)).order_by(Stream.id.asc()).all()
