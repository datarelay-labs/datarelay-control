"""HTTP API for continuous validation definitions and run history."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.platform_admin import journal
from app.validation.echo_receiver import router as echo_router
from app.validation import alert_service
from app.validation.ops_read import list_recovery_events
from app.validation.schemas import (
    ContinuousValidationCreate,
    ContinuousValidationRead,
    ContinuousValidationUpdate,
    ValidationAlertRead,
    ValidationFailuresSummaryResponse,
    ValidationManualRunResponse,
    ValidationRecoveryEventRead,
    ValidationRunRead,
)
from app.validation import service
from app.validation.templates import list_builtin_templates

router = APIRouter()
router.include_router(echo_router)


@router.get("/templates", response_model=list[dict])
async def builtin_templates() -> list[dict]:
    """Built-in validation template hints (English-only metadata)."""

    return list_builtin_templates()


@router.get("/", response_model=list[ContinuousValidationRead])
async def list_validations(
    enabled_only: bool = Query(default=False),
    db: Session = Depends(get_db),
) -> list[ContinuousValidationRead]:
    rows = service.list_validations(db, enabled_only=enabled_only)
    return [ContinuousValidationRead.model_validate(r) for r in rows]


@router.post("/", response_model=ContinuousValidationRead, status_code=status.HTTP_201_CREATED)
async def create_validation(
    payload: ContinuousValidationCreate, request: Request, db: Session = Depends(get_db)
) -> ContinuousValidationRead:
    row = service.create_validation(db, payload)
    journal.record_audit_event(
        db,
        action="CONTINUOUS_VALIDATION_CREATED",
        entity_type="CONTINUOUS_VALIDATION",
        entity_id=int(row.id),
        entity_name=str(row.name),
        details={"enabled": bool(row.enabled), "validation_type": str(row.validation_type)},
        request=request,
    )
    db.commit()
    return ContinuousValidationRead.model_validate(row)


@router.get("/runs", response_model=list[ValidationRunRead])
async def list_runs(
    validation_id: int | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
) -> list[ValidationRunRead]:
    rows = service.list_validation_runs(db, validation_id=validation_id, limit=limit)
    return [ValidationRunRead.model_validate(r) for r in rows]


@router.get("/alerts", response_model=list[ValidationAlertRead])
async def list_alerts(
    status: str | None = Query(default=None),
    validation_id: int | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
) -> list[ValidationAlertRead]:
    rows = alert_service.list_alerts(db, status=status, validation_id=validation_id, limit=limit)
    return [ValidationAlertRead.model_validate(r) for r in rows]


@router.get("/failures/summary", response_model=ValidationFailuresSummaryResponse)
async def validation_failures_summary(
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
) -> ValidationFailuresSummaryResponse:
    raw = alert_service.build_failures_summary(db, limit=limit)
    return ValidationFailuresSummaryResponse.model_validate(raw)


@router.get("/recovery-events", response_model=list[ValidationRecoveryEventRead])
async def validation_recovery_events(
    validation_id: int | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
) -> list[ValidationRecoveryEventRead]:
    rows = list_recovery_events(db, validation_id=validation_id, limit=limit)
    return [ValidationRecoveryEventRead.model_validate(r) for r in rows]


@router.get("/alerts/{alert_id}", response_model=ValidationAlertRead)
async def get_alert(alert_id: int, db: Session = Depends(get_db)) -> ValidationAlertRead:
    row = alert_service.get_alert(db, alert_id)
    if row is None:
        raise HTTPException(status_code=404, detail={"error_code": "VALIDATION_ALERT_NOT_FOUND", "message": str(alert_id)})
    return ValidationAlertRead.model_validate(row)


@router.post("/alerts/{alert_id}/acknowledge", response_model=ValidationAlertRead)
async def acknowledge_alert(
    alert_id: int, request: Request, db: Session = Depends(get_db)
) -> ValidationAlertRead:
    snap = alert_service.get_alert(db, alert_id)
    if snap is None:
        raise HTTPException(status_code=404, detail={"error_code": "VALIDATION_ALERT_NOT_FOUND", "message": str(alert_id)})
    if str(snap.status) != "OPEN":
        raise HTTPException(
            status_code=409,
            detail={"error_code": "VALIDATION_ALERT_NOT_ACKABLE", "message": str(snap.status)},
        )
    row = alert_service.acknowledge_alert(db, alert_id)
    assert row is not None
    journal.record_audit_event(
        db,
        action="CONTINUOUS_VALIDATION_ALERT_ACKNOWLEDGED",
        entity_type="VALIDATION_ALERT",
        entity_id=int(alert_id),
        details={"validation_id": int(row.validation_id)},
        request=request,
    )
    db.commit()
    return ValidationAlertRead.model_validate(row)


@router.post("/alerts/{alert_id}/resolve", response_model=ValidationAlertRead)
async def resolve_alert(alert_id: int, request: Request, db: Session = Depends(get_db)) -> ValidationAlertRead:
    snap = alert_service.get_alert(db, alert_id)
    if snap is None:
        raise HTTPException(status_code=404, detail={"error_code": "VALIDATION_ALERT_NOT_FOUND", "message": str(alert_id)})
    if str(snap.status) == "RESOLVED":
        raise HTTPException(
            status_code=409,
            detail={"error_code": "VALIDATION_ALERT_ALREADY_RESOLVED", "message": str(alert_id)},
        )
    row = alert_service.resolve_alert_manual(db, alert_id)
    assert row is not None
    journal.record_audit_event(
        db,
        action="CONTINUOUS_VALIDATION_ALERT_RESOLVED",
        entity_type="VALIDATION_ALERT",
        entity_id=int(alert_id),
        details={"validation_id": int(row.validation_id)},
        request=request,
    )
    db.commit()
    return ValidationAlertRead.model_validate(row)


@router.get("/{validation_id}", response_model=ContinuousValidationRead)
async def get_validation(validation_id: int, db: Session = Depends(get_db)) -> ContinuousValidationRead:
    row = service.get_validation(db, validation_id)
    if row is None:
        raise HTTPException(status_code=404, detail={"error_code": "VALIDATION_NOT_FOUND", "message": str(validation_id)})
    return ContinuousValidationRead.model_validate(row)


@router.patch("/{validation_id}", response_model=ContinuousValidationRead)
async def patch_validation(
    validation_id: int,
    payload: ContinuousValidationUpdate,
    request: Request,
    db: Session = Depends(get_db),
) -> ContinuousValidationRead:
    row = service.update_validation(db, validation_id, payload)
    if row is None:
        raise HTTPException(status_code=404, detail={"error_code": "VALIDATION_NOT_FOUND", "message": str(validation_id)})
    journal.record_audit_event(
        db,
        action="CONTINUOUS_VALIDATION_UPDATED",
        entity_type="CONTINUOUS_VALIDATION",
        entity_id=int(row.id),
        entity_name=str(row.name),
        details={"updated_fields": sorted(payload.model_dump(exclude_unset=True).keys())},
        request=request,
    )
    db.commit()
    return ContinuousValidationRead.model_validate(row)


@router.post("/{validation_id}/run", response_model=ValidationManualRunResponse)
async def run_validation(
    validation_id: int, request: Request, db: Session = Depends(get_db)
) -> ValidationManualRunResponse:
    out = service.run_validation_now(db, validation_id)
    if out.get("error") == "not_found":
        raise HTTPException(status_code=404, detail={"error_code": "VALIDATION_NOT_FOUND", "message": str(validation_id)})
    journal.record_audit_event(
        db,
        action="CONTINUOUS_VALIDATION_RUN",
        entity_type="CONTINUOUS_VALIDATION",
        entity_id=int(validation_id),
        details={
            "overall_status": out.get("overall_status"),
            "run_id": out.get("run_id"),
            "skipped": bool(out.get("skipped")),
        },
        request=request,
    )
    db.commit()
    if out.get("skipped"):
        return ValidationManualRunResponse(
            validation_id=validation_id,
            stream_id=None,
            overall_status="WARN",
            run_id=None,
            latency_ms=0,
            message=str(out.get("reason") or "skipped"),
        )
    oc = str(out.get("overall_status") or "FAIL")
    st: str = oc if oc in ("PASS", "FAIL", "WARN") else "FAIL"
    return ValidationManualRunResponse(
        validation_id=int(out.get("validation_id", validation_id)),
        stream_id=out.get("stream_id"),
        overall_status=st,  # type: ignore[arg-type]
        run_id=out.get("run_id"),
        latency_ms=int(out.get("latency_ms") or 0),
        message="; ".join(out.get("messages") or []) or st,
    )


@router.post("/{validation_id}/enable", response_model=ContinuousValidationRead)
async def enable_validation(
    validation_id: int, request: Request, db: Session = Depends(get_db)
) -> ContinuousValidationRead:
    row = service.set_enabled(db, validation_id, enabled=True)
    if row is None:
        raise HTTPException(status_code=404, detail={"error_code": "VALIDATION_NOT_FOUND", "message": str(validation_id)})
    journal.record_audit_event(
        db,
        action="CONTINUOUS_VALIDATION_ENABLED",
        entity_type="CONTINUOUS_VALIDATION",
        entity_id=int(row.id),
        entity_name=str(row.name),
        request=request,
    )
    db.commit()
    return ContinuousValidationRead.model_validate(row)


@router.post("/{validation_id}/disable", response_model=ContinuousValidationRead)
async def disable_validation(
    validation_id: int, request: Request, db: Session = Depends(get_db)
) -> ContinuousValidationRead:
    row = service.set_enabled(db, validation_id, enabled=False)
    if row is None:
        raise HTTPException(status_code=404, detail={"error_code": "VALIDATION_NOT_FOUND", "message": str(validation_id)})
    journal.record_audit_event(
        db,
        action="CONTINUOUS_VALIDATION_DISABLED",
        entity_type="CONTINUOUS_VALIDATION",
        entity_id=int(row.id),
        entity_name=str(row.name),
        request=request,
    )
    db.commit()
    return ContinuousValidationRead.model_validate(row)
