"""Source HTTP routes."""

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.config_concurrency import pop_expected_updated_at, require_fresh_updated_at
from app.connectors.models import Connector
from app.database import get_db, utcnow
from app.platform_admin import journal
from app.security.secrets import mask_secrets, preserve_masked_secrets
from app.sources.models import Source
from app.sources.schemas import SourceCreate, SourceRead, SourceUpdate
from app.streams.models import Stream

router = APIRouter()


def _masked_read(row: Source) -> SourceRead:
    item = SourceRead.model_validate(row).model_dump()
    item["config_json"] = mask_secrets(item.get("config_json"))
    item["auth_json"] = mask_secrets(item.get("auth_json"))
    return SourceRead.model_validate(item)


@router.get("/", response_model=list[SourceRead])
async def list_sources(db: Session = Depends(get_db)) -> list[SourceRead]:
    rows = db.query(Source).order_by(Source.id.asc()).all()
    return [_masked_read(row) for row in rows]


@router.post("/", response_model=SourceRead, status_code=status.HTTP_201_CREATED)
async def create_source(payload: SourceCreate, request: Request, db: Session = Depends(get_db)) -> SourceRead:
    connector = db.query(Connector).filter(Connector.id == payload.connector_id).first()
    if connector is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error_code": "CONNECTOR_NOT_FOUND", "message": f"connector not found: {payload.connector_id}"},
        )
    row = Source(
        connector_id=payload.connector_id,
        source_type=payload.source_type,
        config_json=dict(payload.config_json or {}),
        auth_json=dict(payload.auth_json or {}),
        enabled=True if payload.enabled is None else bool(payload.enabled),
    )
    db.add(row)
    db.flush()
    db.refresh(row)
    journal.record_audit_event(
        db,
        action="SOURCE_CREATED",
        entity_type="SOURCE",
        entity_id=int(row.id),
        entity_name=f"source-{row.id}",
        details={"connector_id": int(row.connector_id), "source_type": str(row.source_type)},
        request=request,
    )
    db.commit()
    db.refresh(row)
    return _masked_read(row)


@router.get("/{source_id}", response_model=SourceRead)
async def get_source(source_id: int, db: Session = Depends(get_db)) -> SourceRead:
    row = db.query(Source).filter(Source.id == source_id).first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error_code": "SOURCE_NOT_FOUND", "message": f"source not found: {source_id}"},
        )
    return _masked_read(row)


@router.put("/{source_id}", response_model=SourceRead)
async def update_source(
    source_id: int, payload: SourceUpdate, request: Request, db: Session = Depends(get_db)
) -> SourceRead:
    row = db.query(Source).filter(Source.id == source_id).with_for_update().first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error_code": "SOURCE_NOT_FOUND", "message": f"source not found: {source_id}"},
        )
    update = payload.model_dump(exclude_unset=True)
    expected_updated_at = pop_expected_updated_at(update)
    require_fresh_updated_at(
        entity_label="Source",
        error_code="SOURCE_STALE_WRITE",
        current_updated_at=getattr(row, "updated_at", None),
        expected_updated_at=expected_updated_at,
    )
    if "connector_id" in update:
        new_connector_id = int(update["connector_id"])
        connector = db.query(Connector).filter(Connector.id == new_connector_id).first()
        if connector is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error_code": "CONNECTOR_NOT_FOUND", "message": f"connector not found: {new_connector_id}"},
            )
        if new_connector_id != int(row.connector_id):
            stream_count = db.query(Stream).filter(Stream.source_id == source_id).count()
            if stream_count > 0:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={
                        "error_code": "SOURCE_REASSIGN_BLOCKED_IN_USE",
                        "message": (
                            "Source is referenced by stream(s); reassigning connector_id would break "
                            "stream.connector_id == source.connector_id consistency."
                        ),
                        "stream_count": int(stream_count),
                    },
                )
    if "config_json" in update and update["config_json"] is not None:
        update["config_json"] = preserve_masked_secrets(dict(update["config_json"]), dict(row.config_json or {}))
    if "auth_json" in update and update["auth_json"] is not None:
        update["auth_json"] = preserve_masked_secrets(dict(update["auth_json"]), dict(row.auth_json or {}))
    for key, value in update.items():
        setattr(row, key, value)
    row.updated_at = utcnow()
    # Keep compound Connector concurrency token aligned when Source mutates independently.
    parent = db.query(Connector).filter(Connector.id == int(row.connector_id)).with_for_update().first()
    if parent is not None:
        parent.updated_at = utcnow()
    journal.record_audit_event(
        db,
        action="SOURCE_UPDATED",
        entity_type="SOURCE",
        entity_id=source_id,
        entity_name=f"source-{source_id}",
        details={"updated_fields": sorted(update.keys())},
        request=request,
    )
    db.commit()
    db.refresh(row)
    return _masked_read(row)


@router.delete("/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_source(source_id: int, request: Request, db: Session = Depends(get_db)) -> None:
    row = db.query(Source).filter(Source.id == source_id).with_for_update().first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error_code": "SOURCE_NOT_FOUND", "message": f"source not found: {source_id}"},
        )
    stream_count = db.query(Stream).filter(Stream.source_id == source_id).count()
    if stream_count > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error_code": "SOURCE_DELETE_BLOCKED_IN_USE",
                "message": "Source is still referenced by stream(s); delete or reassign streams first.",
                "stream_count": int(stream_count),
            },
        )
    journal.record_audit_event(
        db,
        action="SOURCE_DELETED",
        entity_type="SOURCE",
        entity_id=source_id,
        entity_name=f"source-{source_id}",
        details={"connector_id": int(row.connector_id)},
        request=request,
    )
    db.delete(row)
    db.commit()
