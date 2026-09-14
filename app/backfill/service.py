"""Backfill job orchestration (API-facing; short DB transactions)."""

from __future__ import annotations

import copy
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.backfill.models import BackfillJob, BackfillProgressEvent
from app.backfill.repository import (
    acquire_stream_backfill_xact_lock,
    count_active_backfills_on_stream,
    get_backfill_job,
    get_backfill_job_for_update,
    get_stream_with_source,
    insert_backfill_job,
    list_active_backfill_jobs,
    list_backfill_jobs,
    list_progress_events_for_job,
    save_job,
    stage_progress_event,
)
from app.backfill.runtime import BackfillRuntimeCoordinator
from app.backfill.schemas import BackfillJobCreate, BackfillReplayRequest
from app.backfill.worker import BackfillWorker
from app.database import utcnow
from app.security.secrets import mask_config_payload

_ALLOWED_MODES = frozenset(
    {
        "CHECKPOINT_REWIND",
        "TIME_RANGE_REPLAY",
        "OBJECT_REPLAY",
        "FILE_REPLAY",
        "INITIAL_FILL",
    }
)

_DEFAULT_PROGRESS: dict[str, Any] = {"phase": "queued", "chunks_done": 0, "chunks_total": None}

_coordinator_singleton = BackfillRuntimeCoordinator()


def get_coordinator() -> BackfillRuntimeCoordinator:
    """Process-wide coordinator instance (Phase 1; future: injectable / worker-scoped)."""

    return _coordinator_singleton


_OWNERSHIP_LOST_MSG = (
    "Backfill ownership lost after process restart; job was not resumed "
    "(fail-closed: exact replay position cannot be guaranteed)"
)


def reconcile_orphaned_backfill_jobs(db: Session) -> dict[str, int]:
    """Fail-closed startup recovery for jobs stuck in RUNNING/CANCELLING without a live owner.

    Process-local coordinator ownership is lost on restart. Orphaned RUNNING jobs become FAILED
    (never auto-resume external delivery). Orphaned CANCELLING jobs become CANCELLED.
    """

    coord = get_coordinator()
    failed = 0
    cancelled = 0
    for probe in list_active_backfill_jobs(db):
        job_id = int(probe.id)
        if coord.is_job_owned(job_id):
            continue
        stream_id = int(probe.stream_id)
        acquire_stream_backfill_xact_lock(db, stream_id)
        job = get_backfill_job_for_update(db, job_id)
        if job is None or job.status not in ("RUNNING", "CANCELLING"):
            db.rollback()
            continue
        if coord.is_job_owned(job_id):
            db.rollback()
            continue

        if job.status == "RUNNING":
            now = utcnow()
            job.status = "FAILED"
            job.failed_at = now
            job.error_summary = _OWNERSHIP_LOST_MSG
            merged = copy.deepcopy(job.progress_json or {})
            merged.update({"phase": "failed", "reconcile": "ownership_lost_on_restart"})
            job.progress_json = merged
            stage_progress_event(
                db,
                backfill_job_id=job_id,
                stream_id=stream_id,
                event_type="job_failed",
                level="ERROR",
                message=_OWNERSHIP_LOST_MSG,
                error_code="OWNERSHIP_LOST_ON_RESTART",
                progress_json={"reconcile": True},
            )
            failed += 1
        else:
            now = utcnow()
            job.status = "CANCELLED"
            if job.completed_at is None:
                job.completed_at = now
            merged = copy.deepcopy(job.progress_json or {})
            merged.update({"phase": "cancelled", "reconcile": "ownership_lost_on_restart"})
            job.progress_json = merged
            stage_progress_event(
                db,
                backfill_job_id=job_id,
                stream_id=stream_id,
                event_type="job_cancelled",
                level="INFO",
                message="Orphaned CANCELLING job finalized after process restart",
                error_code="OWNERSHIP_LOST_ON_RESTART",
                progress_json={"reconcile": True},
            )
            cancelled += 1

        db.commit()
        coord.clear_job_session(job_id)

    return {"orphaned_failed": failed, "orphaned_cancelled": cancelled}


def _build_source_config_snapshot(stream: Any) -> dict[str, Any]:
    """Capture non-credential stream/source shape for job provenance (secrets masked)."""

    src = stream.source
    return {
        "stream": {
            "id": int(stream.id),
            "name": stream.name,
            "stream_type": stream.stream_type,
            "config_json": mask_config_payload(copy.deepcopy(stream.config_json or {})),
        },
        "source": (
            {
                "id": int(src.id),
                "source_type": src.source_type,
                # Never copy auth_json; config_json is masked under the shared contract.
                "config_json": mask_config_payload(copy.deepcopy(src.config_json or {})),
            }
            if src is not None
            else {}
        ),
    }


def replay_stream_backfill(db: Session, payload: BackfillReplayRequest) -> BackfillJob:
    """Create a TIME_RANGE_REPLAY job and run it synchronously through StreamRunner."""

    if payload.start_time >= payload.end_time:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="start_time must be before end_time",
        )
    create_payload = BackfillJobCreate(
        stream_id=int(payload.stream_id),
        backfill_mode="TIME_RANGE_REPLAY",
        requested_by=str(payload.requested_by or "unknown")[:256],
        runtime_options_json={
            "start_time": payload.start_time.isoformat(),
            "end_time": payload.end_time.isoformat(),
            "dry_run": bool(payload.dry_run),
        },
    )
    job = create_backfill_job(db, create_payload)
    return start_backfill_job(db, int(job.id))


def create_backfill_job(db: Session, payload: BackfillJobCreate) -> BackfillJob:
    if str(payload.backfill_mode) not in _ALLOWED_MODES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid backfill_mode")

    stream = get_stream_with_source(db, payload.stream_id)
    if stream is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="stream not found")

    coord = get_coordinator()
    ck_snap = coord.capture_checkpoint_snapshot(db, int(stream.id))

    row = BackfillJob(
        stream_id=int(stream.id),
        source_type=str(stream.stream_type),
        status="PENDING",
        backfill_mode=str(payload.backfill_mode),
        requested_by=str(payload.requested_by or "unknown")[:256],
        source_config_snapshot_json=_build_source_config_snapshot(stream),
        checkpoint_snapshot_json=ck_snap,
        runtime_options_json=copy.deepcopy(payload.runtime_options_json or {}),
        progress_json=copy.deepcopy(_DEFAULT_PROGRESS),
        delivery_summary_json=None,
        error_summary=None,
    )
    job = insert_backfill_job(db, row)
    coord.register_job_session(job.id, checkpoint_snapshot=ck_snap)
    stage_progress_event(
        db,
        backfill_job_id=int(job.id),
        stream_id=int(job.stream_id),
        event_type="job_created",
        level="INFO",
        message="Backfill job registered",
        progress_json={"backfill_mode": job.backfill_mode},
    )
    db.commit()
    db.refresh(job)
    return job


def list_jobs(db: Session, *, limit: int = 100) -> list[BackfillJob]:
    return list_backfill_jobs(db, limit=limit)


def get_job(db: Session, job_id: int) -> BackfillJob | None:
    return get_backfill_job(db, job_id)


def list_progress_events(db: Session, job_id: int) -> list[BackfillProgressEvent]:
    return list_progress_events_for_job(db, job_id)


def _raise_invalid_transition(current: str, action: str) -> None:
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=f"invalid backfill job status transition ({action}) from {current}",
    )


def start_backfill_job(db: Session, job_id: int) -> BackfillJob:
    """PENDING → RUNNING with stream-level lock; then worker dry-run lifecycle (non-blocking)."""

    probe = get_backfill_job(db, job_id)
    if probe is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="backfill job not found")

    stream_id = int(probe.stream_id)
    acquire_stream_backfill_xact_lock(db, stream_id)
    job = get_backfill_job_for_update(db, job_id)
    if job is None:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="backfill job not found")

    if job.status != "PENDING":
        db.rollback()
        _raise_invalid_transition(job.status, "start")

    if count_active_backfills_on_stream(db, stream_id, exclude_job_id=int(job.id)) > 0:
        stage_progress_event(
            db,
            backfill_job_id=int(job.id),
            stream_id=stream_id,
            event_type="job_failed",
            level="WARNING",
            message="Start rejected: another backfill job is already active for this stream",
            error_code="CONCURRENT_BACKFILL_ACTIVE",
            progress_json={"blocked": True},
        )
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="another backfill job is already active for this stream",
        )

    now = utcnow()
    job.status = "RUNNING"
    if job.started_at is None:
        job.started_at = now
    stage_progress_event(
        db,
        backfill_job_id=int(job.id),
        stream_id=stream_id,
        event_type="job_started",
        level="INFO",
        message="Backfill job started",
        progress_json={"phase": "starting"},
    )
    db.commit()
    db.refresh(job)

    coord = get_coordinator()
    coord.register_job_session(job.id, checkpoint_snapshot=job.checkpoint_snapshot_json)
    worker = BackfillWorker(db, coord)
    worker.start_job(int(job.id))
    db.refresh(job)
    return get_backfill_job(db, job_id) or job


def cancel_backfill_job(db: Session, job_id: int) -> BackfillJob:
    probe = get_backfill_job(db, job_id)
    if probe is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="backfill job not found")

    stream_id = int(probe.stream_id)
    coord = get_coordinator()

    # PENDING: single transaction to CANCELLED
    if probe.status == "PENDING":
        acquire_stream_backfill_xact_lock(db, stream_id)
        job = get_backfill_job_for_update(db, job_id)
        if job is None or job.status != "PENDING":
            db.rollback()
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="backfill job status changed")
        job.status = "CANCELLED"
        stage_progress_event(
            db,
            backfill_job_id=int(job.id),
            stream_id=stream_id,
            event_type="cancellation_requested",
            level="INFO",
            message="Cancellation requested",
        )
        stage_progress_event(
            db,
            backfill_job_id=int(job.id),
            stream_id=stream_id,
            event_type="job_cancelled",
            level="INFO",
            message="Backfill job cancelled",
        )
        db.commit()
        coord.clear_job_session(int(job_id))
        db.refresh(job)
        return job

    if probe.status == "RUNNING":
        acquire_stream_backfill_xact_lock(db, stream_id)
        job = get_backfill_job_for_update(db, job_id)
        if job is None or job.status != "RUNNING":
            db.rollback()
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="backfill job status changed")
        job.status = "CANCELLING"
        coord.request_cancel(int(job_id))
        stage_progress_event(
            db,
            backfill_job_id=int(job.id),
            stream_id=stream_id,
            event_type="cancellation_requested",
            level="INFO",
            message="Cancellation requested",
        )
        db.commit()
        db.refresh(job)

        # Live worker owns the job: wait for worker ack (RUNNING → CANCELLING → CANCELLED).
        if coord.is_job_owned(int(job_id)):
            return job

        # No live owner (sync worker already exited, or orphan): finalize safely.
        return _finalize_cancelling_without_owner(db, job_id=int(job_id), stream_id=stream_id)

    if probe.status == "CANCELLING":
        coord.request_cancel(int(job_id))
        if coord.is_job_owned(int(job_id)):
            job = get_backfill_job(db, job_id)
            if job is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="backfill job not found")
            return job
        return _finalize_cancelling_without_owner(db, job_id=int(job_id), stream_id=stream_id)

    if probe.status in ("CANCELLED", "COMPLETED", "FAILED"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"cannot cancel backfill job in status {probe.status}",
        )

    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=f"cannot cancel backfill job in status {probe.status}",
    )


def _finalize_cancelling_without_owner(db: Session, *, job_id: int, stream_id: int) -> BackfillJob:
    """Terminalize CANCELLING when no process-local worker remains to acknowledge cancel."""

    coord = get_coordinator()
    acquire_stream_backfill_xact_lock(db, stream_id)
    job = get_backfill_job_for_update(db, job_id)
    if job is None:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="backfill job not found")
    if job.status == "CANCELLED":
        db.rollback()
        return job
    if job.status != "CANCELLING":
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="backfill job status changed")
    if coord.is_job_owned(int(job_id)):
        db.rollback()
        return job

    job.status = "CANCELLED"
    if job.completed_at is None:
        job.completed_at = utcnow()
    stage_progress_event(
        db,
        backfill_job_id=int(job.id),
        stream_id=stream_id,
        event_type="job_cancelled",
        level="INFO",
        message="Backfill job cancelled",
    )
    db.commit()
    coord.clear_job_session(int(job_id))
    db.refresh(job)
    return job
