"""Governance quarantine REST API (M19.2 Quarantine Operations)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.auth.governance_rbac import require_governance_read, require_quarantine_action, require_replay_action

from app.database import get_db, get_db_read_bounded
from app.governance_quarantine.models import QUARANTINE_DISPLAY_STATUSES, QUARANTINE_WINDOWS
from app.governance_quarantine.schemas import (
    GovernanceQuarantineBulkRequest,
    GovernanceQuarantineBulkResponse,
    GovernanceQuarantineDetailResponse,
    GovernanceQuarantineListResponse,
)
from app.governance_quarantine.service import (
    GovernanceQuarantineNotFoundError,
    bulk_discard_quarantine_events,
    bulk_release_quarantine_events,
    bulk_replay_quarantine_events,
    get_governance_quarantine_detail,
    list_governance_quarantine_events,
    supported_classifications,
)
from app.governance_violations.models import VIOLATION_SEVERITIES

router = APIRouter()


@router.get("/quarantine", response_model=GovernanceQuarantineListResponse)
async def get_governance_quarantine_events(
    window: str = Query(default="24h"),
    policy_id: int | None = Query(default=None),
    stream_id: int | None = Query(default=None),
    severity: str | None = Query(default=None),
    classification: str | None = Query(default=None),
    status: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=200),
    db: Session = Depends(get_db_read_bounded),
    _auth=Depends(require_governance_read()),
) -> GovernanceQuarantineListResponse:
    win = str(window).strip().lower()
    if win not in QUARANTINE_WINDOWS:
        raise HTTPException(status_code=400, detail=f"unsupported window: {window!r}")

    if severity is not None and str(severity).upper() not in VIOLATION_SEVERITIES:
        raise HTTPException(status_code=400, detail=f"unsupported severity: {severity!r}")
    if status is not None and str(status).upper() not in QUARANTINE_DISPLAY_STATUSES:
        raise HTTPException(status_code=400, detail=f"unsupported status: {status!r}")
    if classification is not None and str(classification).upper() not in supported_classifications():
        raise HTTPException(status_code=400, detail=f"unsupported classification: {classification!r}")

    sev = str(severity).upper() if severity is not None else None
    st = str(status).upper() if status is not None else None
    cls = str(classification).upper() if classification is not None else None

    events = list_governance_quarantine_events(
        db,
        window=win,
        policy_id=policy_id,
        stream_id=stream_id,
        severity=sev,
        classification=cls,
        status=st,
        limit=limit,
    )
    return GovernanceQuarantineListResponse(window=win, total=len(events), quarantine_events=events)


@router.get("/quarantine/{quarantine_id}", response_model=GovernanceQuarantineDetailResponse)
async def get_governance_quarantine_by_id(
    quarantine_id: int,
    window: str = Query(default="30d"),
    db: Session = Depends(get_db_read_bounded),
    _auth=Depends(require_governance_read()),
) -> GovernanceQuarantineDetailResponse:
    win = str(window).strip().lower()
    if win not in QUARANTINE_WINDOWS:
        raise HTTPException(status_code=400, detail=f"unsupported window: {window!r}")
    try:
        return get_governance_quarantine_detail(db, quarantine_id, window=win)
    except GovernanceQuarantineNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/quarantine/release", response_model=GovernanceQuarantineBulkResponse)
async def release_governance_quarantine_events(
    payload: GovernanceQuarantineBulkRequest,
    request: Request,
    db: Session = Depends(get_db),
    _auth=Depends(require_quarantine_action()),
) -> GovernanceQuarantineBulkResponse:
    if not payload.ids:
        raise HTTPException(status_code=400, detail="ids must not be empty")
    return bulk_release_quarantine_events(db, payload.ids, request=request)


@router.post("/quarantine/discard", response_model=GovernanceQuarantineBulkResponse)
async def discard_governance_quarantine_events(
    payload: GovernanceQuarantineBulkRequest,
    request: Request,
    db: Session = Depends(get_db),
    _auth=Depends(require_quarantine_action()),
) -> GovernanceQuarantineBulkResponse:
    if not payload.ids:
        raise HTTPException(status_code=400, detail="ids must not be empty")
    return bulk_discard_quarantine_events(db, payload.ids, request=request)


@router.post("/quarantine/replay", response_model=GovernanceQuarantineBulkResponse)
async def replay_governance_quarantine_events(
    payload: GovernanceQuarantineBulkRequest,
    request: Request,
    db: Session = Depends(get_db),
    _auth=Depends(require_replay_action()),
) -> GovernanceQuarantineBulkResponse:
    if not payload.ids:
        raise HTTPException(status_code=400, detail="ids must not be empty")
    return bulk_replay_quarantine_events(db, payload.ids, request=request)
