"""Persistence helpers for backfill jobs and progress events."""

from __future__ import annotations

import hashlib

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session, joinedload

from app.backfill.models import BackfillJob, BackfillProgressEvent
from app.streams.models import Stream


def get_stream_with_source(db: Session, stream_id: int) -> Stream | None:
    q = select(Stream).options(joinedload(Stream.source)).where(Stream.id == int(stream_id))
    return db.scalars(q).first()


def insert_backfill_job(db: Session, row: BackfillJob) -> BackfillJob:
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def list_backfill_jobs(db: Session, *, limit: int = 100) -> list[BackfillJob]:
    lim = max(1, min(int(limit), 500))
    q = select(BackfillJob).order_by(BackfillJob.id.desc()).limit(lim)
    return list(db.scalars(q).all())


def get_backfill_job(db: Session, job_id: int) -> BackfillJob | None:
    return db.get(BackfillJob, int(job_id))


def get_backfill_job_for_update(db: Session, job_id: int) -> BackfillJob | None:
    q = select(BackfillJob).where(BackfillJob.id == int(job_id)).with_for_update()
    return db.scalars(q).first()


def save_job(db: Session, row: BackfillJob) -> BackfillJob:
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _stream_advisory_lock_key(stream_id: int) -> int:
    digest = hashlib.sha256(f"gdc:backfill:stream:{int(stream_id)}".encode()).digest()
    return int.from_bytes(digest[:8], "big", signed=True)


def acquire_stream_backfill_xact_lock(db: Session, stream_id: int) -> None:
    """Serialize start/cancel and stream-level conflict checks for one stream (PostgreSQL)."""

    key = _stream_advisory_lock_key(stream_id)
    db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": key})


def count_active_backfills_on_stream(db: Session, stream_id: int, *, exclude_job_id: int | None = None) -> int:
    q = select(func.count()).select_from(BackfillJob).where(
        BackfillJob.stream_id == int(stream_id),
        BackfillJob.status.in_(("RUNNING", "CANCELLING")),
    )
    if exclude_job_id is not None:
        q = q.where(BackfillJob.id != int(exclude_job_id))
    return int(db.execute(q).scalar_one())


def list_active_backfill_jobs(db: Session) -> list[BackfillJob]:
    """Jobs in RUNNING/CANCELLING that can block stream-level backfill starts."""

    q = (
        select(BackfillJob)
        .where(BackfillJob.status.in_(("RUNNING", "CANCELLING")))
        .order_by(BackfillJob.id.asc())
    )
    return list(db.scalars(q).all())


def stage_progress_event(
    db: Session,
    *,
    backfill_job_id: int,
    stream_id: int,
    event_type: str,
    level: str,
    message: str,
    progress_json: dict | None = None,
    error_code: str | None = None,
) -> BackfillProgressEvent:
    """Append a progress row in the current transaction (caller commits)."""

    row = BackfillProgressEvent(
        backfill_job_id=int(backfill_job_id),
        stream_id=int(stream_id),
        event_type=str(event_type),
        level=str(level),
        message=str(message),
        progress_json=progress_json,
        error_code=error_code,
    )
    db.add(row)
    return row


def list_progress_events_for_job(db: Session, job_id: int) -> list[BackfillProgressEvent]:
    q = (
        select(BackfillProgressEvent)
        .where(BackfillProgressEvent.backfill_job_id == int(job_id))
        .order_by(BackfillProgressEvent.created_at.asc(), BackfillProgressEvent.id.asc())
    )
    return list(db.scalars(q).all())
