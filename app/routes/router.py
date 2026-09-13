"""Route HTTP routes — placeholder responses only."""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.database import get_db, utcnow
from app.platform_admin import journal
from app.platform_admin.config_entity_snapshots import serialize_route_config
from app.destinations.models import Destination
from app.logs.models import DeliveryLog
from app.routes.models import Route
from app.routes.schemas import RouteCreate, RouteRead, RouteUpdate
from app.streams.models import Stream

router = APIRouter()


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


@router.get("/", response_model=list[RouteRead])
async def list_routes(db: Session = Depends(get_db)) -> list[RouteRead]:
    rows = db.query(Route).order_by(Route.id.asc()).all()
    return [RouteRead.model_validate(r) for r in rows]


@router.post("/", response_model=RouteRead, status_code=status.HTTP_201_CREATED)
async def create_route(payload: RouteCreate, request: Request, db: Session = Depends(get_db)) -> RouteRead:
    stream = db.query(Stream).filter(Stream.id == payload.stream_id).first()
    if stream is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {payload.stream_id}"},
        )
    destination = db.query(Destination).filter(Destination.id == payload.destination_id).first()
    if destination is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error_code": "DESTINATION_NOT_FOUND", "message": f"destination not found: {payload.destination_id}"},
        )

    row = Route(
        stream_id=payload.stream_id,
        destination_id=payload.destination_id,
        enabled=True if payload.enabled is None else bool(payload.enabled),
        failure_policy=payload.failure_policy or "LOG_AND_CONTINUE",
        formatter_config_json=dict(payload.formatter_config_json or {}),
        rate_limit_json=dict(payload.rate_limit_json or {}),
        status=payload.status or ("ENABLED" if payload.enabled is not False else "DISABLED"),
    )
    db.add(row)
    db.flush()
    db.refresh(row)
    stream_name = str(stream.name)
    journal.record_audit_event(
        db,
        action="ROUTE_CREATED",
        entity_type="ROUTE",
        entity_id=int(row.id),
        entity_name=stream_name,
        details={
            "stream_id": int(row.stream_id),
            "destination_id": int(row.destination_id),
            "enabled": bool(row.enabled),
        },
        request=request,
    )
    journal.record_config_version(
        db,
        entity_type="ROUTE_CONFIG",
        entity_id=int(row.id),
        entity_name=stream_name,
        summary="Route created",
        snapshot_before=None,
        snapshot_after=serialize_route_config(row),
    )
    db.commit()
    db.refresh(row)
    return RouteRead.model_validate(row)


@router.get("/{route_id}", response_model=RouteRead)
async def get_route(route_id: int, db: Session = Depends(get_db)) -> RouteRead:
    row = db.query(Route).filter(Route.id == route_id).first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {route_id}"},
        )
    return RouteRead.model_validate(row)


@router.put("/{route_id}", response_model=RouteRead)
async def update_route(route_id: int, payload: RouteUpdate, request: Request, db: Session = Depends(get_db)) -> RouteRead:
    # Row lock makes the expected_updated_at precondition authoritative for concurrent writers.
    row = db.query(Route).filter(Route.id == route_id).with_for_update().first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {route_id}"},
        )

    update = payload.model_dump(exclude_unset=True)
    expected_updated_at = update.pop("expected_updated_at")
    current_updated_at = getattr(row, "updated_at", None)
    if current_updated_at is None or _as_utc(current_updated_at) != _as_utc(expected_updated_at):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error_code": "ROUTE_STALE_WRITE",
                "message": (
                    "Route changed since you started editing. Refresh the latest route "
                    "before saving again; unsaved local edits are not applied."
                ),
                "expected_updated_at": expected_updated_at.isoformat(),
                "current_updated_at": current_updated_at.isoformat() if current_updated_at is not None else None,
            },
        )

    if "stream_id" in update:
        stream = db.query(Stream).filter(Stream.id == int(update["stream_id"])).first()
        if stream is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {update['stream_id']}"},
            )
    if "destination_id" in update:
        destination = db.query(Destination).filter(Destination.id == int(update["destination_id"])).first()
        if destination is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error_code": "DESTINATION_NOT_FOUND", "message": f"destination not found: {update['destination_id']}"},
            )

    prev_enabled = bool(row.enabled)
    route_before = serialize_route_config(row)
    for key, value in update.items():
        setattr(row, key, value)
    # Ensure concurrency token advances even when SQLAlchemy onupdate is skipped in tests.
    row.updated_at = utcnow()
    stream = db.query(Stream).filter(Stream.id == int(row.stream_id)).first()
    stream_name = str(stream.name) if stream is not None else None
    if prev_enabled and not bool(row.enabled):
        journal.record_audit_event(
            db,
            action="ROUTE_DISABLED",
            entity_type="ROUTE",
            entity_id=route_id,
            entity_name=stream_name,
            details={"stream_id": int(row.stream_id), "destination_id": int(row.destination_id)},
            request=request,
        )
    elif not prev_enabled and bool(row.enabled):
        journal.record_audit_event(
            db,
            action="ROUTE_ENABLED",
            entity_type="ROUTE",
            entity_id=route_id,
            entity_name=stream_name,
            details={"stream_id": int(row.stream_id), "destination_id": int(row.destination_id)},
            request=request,
        )
    journal.record_audit_event(
        db,
        action="ROUTE_UPDATED",
        entity_type="ROUTE",
        entity_id=route_id,
        entity_name=stream_name,
        details={"updated_fields": sorted(update.keys())},
        request=request,
    )
    journal.record_config_version(
        db,
        entity_type="ROUTE_CONFIG",
        entity_id=route_id,
        entity_name=stream_name,
        summary=f"Route updated ({','.join(sorted(update.keys()))})",
        snapshot_before=route_before,
        snapshot_after=serialize_route_config(row),
    )
    db.commit()
    db.refresh(row)
    return RouteRead.model_validate(row)


@router.delete("/{route_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_route(route_id: int, request: Request, db: Session = Depends(get_db)) -> None:
    row = db.query(Route).filter(Route.id == route_id).first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {route_id}"},
        )
    if bool(getattr(row, "enabled", True)):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error_code": "ROUTE_DELETE_WHILE_ENABLED",
                "message": "Disable the route before deleting it.",
            },
        )
    # delivery_logs.route_id FK — detach historical rows so the route row can be removed.
    db.query(DeliveryLog).filter(DeliveryLog.route_id == route_id).update(
        {DeliveryLog.route_id: None},
        synchronize_session=False,
    )
    stream = db.query(Stream).filter(Stream.id == int(row.stream_id)).first()
    stream_name = str(stream.name) if stream is not None else None
    db.delete(row)
    journal.record_audit_event(
        db,
        action="ROUTE_DELETED",
        entity_type="ROUTE",
        entity_id=int(route_id),
        entity_name=stream_name,
        details={"stream_id": int(row.stream_id), "destination_id": int(row.destination_id)},
        request=request,
    )
    db.commit()
