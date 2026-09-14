"""Stream HTTP routes — includes start/stop (execution is always stream-scoped)."""

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy.orm import Session

from app.config_concurrency import pop_expected_updated_at, require_fresh_updated_at
from app.connectors.models import Connector
from app.database import get_db, get_db_read_bounded, utcnow
from app.sources.models import Source
from app.streams import repository as streams_repository
from app.streams.delete_scope import delete_stream_and_dependencies
from app.streams.models import Stream
from app.platform_admin import journal
from app.platform_admin.config_entity_snapshots import serialize_stream_config
from app.runners.stream_runner import StreamRunner
from app.runtime import control_service
from app.runtime.schemas import RuntimeStreamControlResponse
from app.scheduler import runtime_state as scheduler_runtime_state
from app.streams.schemas import StreamCreate, StreamRead, StreamUpdate

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/", response_model=list[StreamRead])
async def list_streams(db: Session = Depends(get_db_read_bounded)) -> list[StreamRead]:
    """List streams from DB (read-only)."""

    rows = streams_repository.list_streams(db)
    out: list[StreamRead] = []
    for row in rows:
        try:
            out.append(StreamRead.model_validate(row))
        except Exception:
            logger.exception("streams_list_row_skipped stream_id=%s", getattr(row, "id", None))
    return out


@router.post("/", response_model=StreamRead, status_code=status.HTTP_201_CREATED)
async def create_stream(payload: StreamCreate, request: Request, db: Session = Depends(get_db)) -> StreamRead:
    connector = db.query(Connector).filter(Connector.id == payload.connector_id).first()
    if connector is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error_code": "CONNECTOR_NOT_FOUND", "message": f"connector not found: {payload.connector_id}"},
        )

    source = db.query(Source).filter(Source.id == payload.source_id).first()
    if source is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error_code": "SOURCE_NOT_FOUND", "message": f"source not found: {payload.source_id}"},
        )

    if int(source.connector_id) != int(payload.connector_id):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error_code": "SOURCE_CONNECTOR_MISMATCH", "message": "source does not belong to connector"},
        )

    row = Stream(
        name=payload.name,
        connector_id=payload.connector_id,
        source_id=payload.source_id,
        stream_type=payload.stream_type or "HTTP_API_POLLING",
        config_json=dict(payload.config_json or {}),
        polling_interval=int(payload.polling_interval or 60),
        # Create ≠ Start: default disabled + STOPPED so scheduler cannot deliver until /start.
        enabled=False if payload.enabled is None else bool(payload.enabled),
        # Runtime status is owned by /start and /stop — never forge RUNNING via create.
        status="STOPPED",
        rate_limit_json=dict(payload.rate_limit_json or {}),
    )
    db.add(row)
    db.flush()
    db.refresh(row)
    journal.record_audit_event(
        db,
        action="STREAM_CREATED",
        entity_type="STREAM",
        entity_id=int(row.id),
        entity_name=str(row.name),
        details={"connector_id": int(row.connector_id), "source_id": int(row.source_id)},
        request=request,
    )
    journal.record_config_version(
        db,
        entity_type="STREAM_CONFIG",
        entity_id=int(row.id),
        entity_name=str(row.name),
        summary="Stream created",
        snapshot_before=None,
        snapshot_after=serialize_stream_config(row),
    )
    db.commit()
    db.refresh(row)
    return StreamRead.model_validate(row)


@router.get("/{stream_id}", response_model=StreamRead)
async def get_stream(stream_id: int, db: Session = Depends(get_db)) -> StreamRead:
    row = streams_repository.get_stream_by_id(db, stream_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    return StreamRead.model_validate(row)


@router.put("/{stream_id}", response_model=StreamRead)
async def update_stream(stream_id: int, payload: StreamUpdate, request: Request, db: Session = Depends(get_db)) -> StreamRead:
    # Row lock makes the expected_updated_at precondition authoritative for concurrent writers.
    row = db.query(Stream).filter(Stream.id == stream_id).with_for_update().first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )

    update = payload.model_dump(exclude_unset=True)
    expected_updated_at = pop_expected_updated_at(update)
    require_fresh_updated_at(
        entity_label="Stream",
        error_code="STREAM_STALE_WRITE",
        current_updated_at=getattr(row, "updated_at", None),
        expected_updated_at=expected_updated_at,
    )
    # Defense in depth: status / source_type must never mutate via configuration PUT.
    update.pop("status", None)
    update.pop("source_type", None)
    if "connector_id" in update:
        connector = db.query(Connector).filter(Connector.id == int(update["connector_id"])).first()
        if connector is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error_code": "CONNECTOR_NOT_FOUND", "message": f"connector not found: {update['connector_id']}"},
            )

    if "source_id" in update:
        source = db.query(Source).filter(Source.id == int(update["source_id"])).first()
        if source is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error_code": "SOURCE_NOT_FOUND", "message": f"source not found: {update['source_id']}"},
            )

    connector_id = int(update.get("connector_id", row.connector_id))
    source_id = int(update.get("source_id", row.source_id))
    source = db.query(Source).filter(Source.id == source_id).first()
    if source is None or int(source.connector_id) != connector_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error_code": "SOURCE_CONNECTOR_MISMATCH", "message": "source does not belong to connector"},
        )

    before_snap = serialize_stream_config(row)
    for key, value in update.items():
        setattr(row, key, value)
    row.updated_at = utcnow()
    after_snap = serialize_stream_config(row)
    journal.record_audit_event(
        db,
        action="STREAM_UPDATED",
        entity_type="STREAM",
        entity_id=stream_id,
        entity_name=str(row.name),
        details={"updated_fields": sorted(update.keys())},
        request=request,
    )
    journal.record_config_version(
        db,
        entity_type="STREAM_CONFIG",
        entity_id=stream_id,
        entity_name=str(row.name),
        summary=f"Stream fields: {','.join(sorted(update.keys()))}",
        snapshot_before=before_snap,
        snapshot_after=after_snap,
    )
    db.commit()
    db.refresh(row)
    return StreamRead.model_validate(row)


@router.delete("/{stream_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_stream(stream_id: int, request: Request, db: Session = Depends(get_db)) -> None:
    row = streams_repository.get_stream_by_id(db, stream_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    if not bool(row.enabled) and str(row.status) in {"RUNNING", "STOPPING"}:
        control_service.reconcile_stale_stream_runtime(db, stream_id)
        db.expire_all()
        row = streams_repository.get_stream_by_id(db, stream_id)
    lock_held = StreamRunner.is_lock_held(stream_id)
    worker_alive = scheduler_runtime_state.is_stream_worker_alive(stream_id)
    worker_owned = StreamRunner.is_worker_ownership_held(stream_id)
    if row is not None and (
        str(row.status) in {"RUNNING", "STOPPING"} or lock_held or worker_alive or worker_owned
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error_code": "STREAM_DELETE_BLOCKED_RUNNING",
                "message": "Stop the stream and wait for runtime ownership to be released before deleting it.",
            },
        )
    stream_name = str(row.name)
    try:
        journal.record_audit_event(
            db,
            action="STREAM_DELETED",
            entity_type="STREAM",
            entity_id=stream_id,
            entity_name=stream_name,
            request=request,
        )
        delete_stream_and_dependencies(db, stream_id)
    except ValueError as exc:
        if str(exc) == "STREAM_NOT_FOUND":
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
            ) from exc
        raise


@router.post("/{stream_id}/start", response_model=RuntimeStreamControlResponse)
async def start_stream(
    stream_id: int, request: Request, db: Session = Depends(get_db)
) -> RuntimeStreamControlResponse:
    try:
        return control_service.start_stream(db, stream_id, request=request)
    except control_service.StreamNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {exc.stream_id}"},
        ) from exc


@router.post("/{stream_id}/stop", response_model=RuntimeStreamControlResponse)
async def stop_stream(
    stream_id: int, request: Request, response: Response, db: Session = Depends(get_db)
) -> RuntimeStreamControlResponse:
    try:
        result = control_service.stop_stream(db, stream_id, request=request)
        response.status_code = 200 if result.terminal and result.status == "STOPPED" else 202
        return result
    except control_service.StreamNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {exc.stream_id}"},
        ) from exc
    except control_service.StreamStopFailedError as exc:
        raise HTTPException(
            status_code=409,
            detail={"error_code": "STREAM_STOP_FAILED", "message": exc.message},
        ) from exc
