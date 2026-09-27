"""Stream governance Contract v1 runtime API."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db, get_db_read_bounded
from app.stream_governance.errors import StreamGovernanceValidationError
from app.stream_governance.schemas import (
    EffectiveProtectionResponse,
    StreamGovernanceResponse,
    StreamGovernanceWrite,
    governance_error_detail,
)
from app.stream_governance.service import (
    build_effective_protection,
    get_stream_governance,
    put_stream_governance,
)

router = APIRouter()


@router.get("/streams/{stream_id}/governance", response_model=StreamGovernanceResponse)
async def get_stream_governance_endpoint(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> StreamGovernanceResponse:
    doc = get_stream_governance(db, stream_id)
    if doc is None:
        raise HTTPException(
            status_code=404,
            detail=governance_error_detail("STREAM_NOT_FOUND", f"stream not found: {stream_id}"),
        )
    return doc


@router.put("/streams/{stream_id}/governance", response_model=StreamGovernanceResponse)
async def put_stream_governance_endpoint(
    stream_id: int,
    body: StreamGovernanceWrite,
    db: Session = Depends(get_db),
) -> StreamGovernanceResponse:
    try:
        doc = put_stream_governance(db, stream_id, body)
    except StreamGovernanceValidationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=422,
            detail=governance_error_detail(exc.error_code, exc.message),
        ) from exc

    if doc is None:
        raise HTTPException(
            status_code=404,
            detail=governance_error_detail("STREAM_NOT_FOUND", f"stream not found: {stream_id}"),
        )
    return doc


@router.get(
    "/streams/{stream_id}/governance/effective-protection",
    response_model=EffectiveProtectionResponse,
)
async def get_effective_protection_endpoint(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> EffectiveProtectionResponse:
    doc = build_effective_protection(db, stream_id)
    if doc is None:
        raise HTTPException(
            status_code=404,
            detail=governance_error_detail("STREAM_NOT_FOUND", f"stream not found: {stream_id}"),
        )
    return doc
