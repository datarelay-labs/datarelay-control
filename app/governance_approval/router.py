"""Governance approval REST API (M19.5)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.auth.governance_rbac import (
    require_governance_read,
    require_governance_write,
    require_policy_activate,
    require_policy_approve,
    resolve_governance_actor,
)
from app.database import get_db, get_db_read_bounded
from app.governance_approval.models import APPROVAL_WINDOWS
from app.governance_approval.schemas import (
    GovernanceApprovalActionRequest,
    GovernanceApprovalActionResponse,
    GovernanceApprovalDetailResponse,
    GovernanceApprovalListResponse,
)
from app.governance_approval.service import (
    GovernanceApprovalError,
    GovernanceApprovalNotFoundError,
    GovernanceSelfApprovalError,
    activate_approved_policy,
    approve_policy,
    get_governance_approval_detail,
    list_governance_approvals,
    reject_policy,
    submit_policy_approval,
)
from app.governance_policies.models import POLICY_STATUSES
from app.governance_policies.service import GovernancePolicyNotFoundError

router = APIRouter()


@router.get("/approvals", response_model=GovernanceApprovalListResponse)
async def get_governance_approvals(
    window: str = Query(default="24h"),
    policy_id: int | None = Query(default=None),
    status: str | None = Query(default=None),
    requester: str | None = Query(default=None),
    reviewer: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=200),
    db: Session = Depends(get_db_read_bounded),
    _auth=Depends(require_governance_read()),
) -> GovernanceApprovalListResponse:
    win = str(window).strip().lower()
    if win not in APPROVAL_WINDOWS:
        raise HTTPException(status_code=400, detail=f"unsupported window: {window!r}")
    if status is not None and str(status).upper() not in POLICY_STATUSES and str(status).upper() not in {
        "PENDING_REVIEW",
        "APPROVED",
        "REJECTED",
        "REQUEST_CHANGES",
        "ACTIVATED",
        "CANCELLED",
    }:
        raise HTTPException(status_code=400, detail=f"unsupported status: {status!r}")

    approvals = list_governance_approvals(
        db,
        window=win,
        policy_id=policy_id,
        status=str(status).upper() if status is not None else None,
        requester=requester,
        reviewer=reviewer,
        limit=limit,
    )
    return GovernanceApprovalListResponse(window=win, total=len(approvals), approvals=approvals)  # type: ignore[arg-type]


@router.get("/approvals/{policy_id}", response_model=GovernanceApprovalDetailResponse)
async def get_governance_approval_by_policy_id(
    policy_id: int,
    db: Session = Depends(get_db_read_bounded),
    _auth=Depends(require_governance_read()),
) -> GovernanceApprovalDetailResponse:
    try:
        return get_governance_approval_detail(db, policy_id)
    except GovernanceApprovalNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


def _self_approval_forbidden(exc: GovernanceSelfApprovalError) -> HTTPException:
    return HTTPException(
        status_code=403,
        detail={"error_code": "GOVERNANCE_SELF_APPROVAL_FORBIDDEN", "message": str(exc)},
    )


def _action_response(
    *,
    policy_id: int,
    policy_status: str,
    approval_status: str,
    event_type: str,
    message: str,
) -> GovernanceApprovalActionResponse:
    return GovernanceApprovalActionResponse(
        policy_id=policy_id,
        policy_status=policy_status,  # type: ignore[arg-type]
        approval_status=approval_status,
        event_type=event_type,  # type: ignore[arg-type]
        message=message,
    )


@router.post("/approvals/{policy_id}/submit", response_model=GovernanceApprovalActionResponse)
async def post_governance_approval_submit(
    policy_id: int,
    body: GovernanceApprovalActionRequest,
    request: Request,
    db: Session = Depends(get_db),
    _auth=Depends(require_governance_write()),
) -> GovernanceApprovalActionResponse:
    actor = resolve_governance_actor(request)
    try:
        row = submit_policy_approval(db, policy_id, comment=body.comment, actor=actor)
        db.commit()
    except GovernancePolicyNotFoundError as exc:
        db.rollback()
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except GovernanceApprovalError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={"error_code": "GOVERNANCE_APPROVAL", "message": str(exc)},
        ) from exc
    return _action_response(
        policy_id=policy_id,
        policy_status=row.status,
        approval_status="PENDING_REVIEW",
        event_type="SUBMITTED_FOR_REVIEW",
        message="Policy submitted for review",
    )


@router.post("/approvals/{policy_id}/approve", response_model=GovernanceApprovalActionResponse)
async def post_governance_approval_approve(
    policy_id: int,
    body: GovernanceApprovalActionRequest,
    request: Request,
    db: Session = Depends(get_db),
    _auth=Depends(require_policy_approve()),
) -> GovernanceApprovalActionResponse:
    actor = resolve_governance_actor(request)
    try:
        row = approve_policy(
            db,
            policy_id,
            comment=body.comment,
            actor=actor,
            allow_self_approval=body.allow_self_approval,
        )
        db.commit()
    except GovernancePolicyNotFoundError as exc:
        db.rollback()
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except GovernanceSelfApprovalError as exc:
        db.rollback()
        raise _self_approval_forbidden(exc) from exc
    except GovernanceApprovalError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={"error_code": "GOVERNANCE_APPROVAL", "message": str(exc)},
        ) from exc
    return _action_response(
        policy_id=policy_id,
        policy_status=row.status,
        approval_status="APPROVED",
        event_type="APPROVED",
        message="Policy approved — ready for activation",
    )


@router.post("/approvals/{policy_id}/reject", response_model=GovernanceApprovalActionResponse)
async def post_governance_approval_reject(
    policy_id: int,
    body: GovernanceApprovalActionRequest,
    request: Request,
    db: Session = Depends(get_db),
    _auth=Depends(require_policy_approve()),
) -> GovernanceApprovalActionResponse:
    actor = resolve_governance_actor(request)
    try:
        row = reject_policy(db, policy_id, comment=body.comment, actor=actor)
        db.commit()
    except GovernancePolicyNotFoundError as exc:
        db.rollback()
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except GovernanceApprovalError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={"error_code": "GOVERNANCE_APPROVAL", "message": str(exc)},
        ) from exc
    return _action_response(
        policy_id=policy_id,
        policy_status=row.status,
        approval_status="REJECTED",
        event_type="REJECTED",
        message="Policy returned to draft",
    )


@router.post("/approvals/{policy_id}/activate", response_model=GovernanceApprovalActionResponse)
async def post_governance_approval_activate(
    policy_id: int,
    body: GovernanceApprovalActionRequest,
    request: Request,
    db: Session = Depends(get_db),
    _auth=Depends(require_policy_activate()),
) -> GovernanceApprovalActionResponse:
    actor = resolve_governance_actor(request)
    try:
        row = activate_approved_policy(
            db,
            policy_id,
            comment=body.comment,
            actor=actor,
            allow_self_approval=body.allow_self_approval,
        )
        db.commit()
    except GovernancePolicyNotFoundError as exc:
        db.rollback()
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except GovernanceSelfApprovalError as exc:
        db.rollback()
        raise _self_approval_forbidden(exc) from exc
    except GovernanceApprovalError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={"error_code": "GOVERNANCE_APPROVAL", "message": str(exc)},
        ) from exc
    return _action_response(
        policy_id=policy_id,
        policy_status=row.status,
        approval_status="ACTIVATED",
        event_type="ACTIVATED",
        message="Policy activated",
    )
