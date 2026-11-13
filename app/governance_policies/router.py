"""Governance policy REST API (M18.1 Policy Builder)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.auth.governance_rbac import (
    require_governance_read,
    require_governance_write,
    require_policy_activate,
    resolve_governance_actor,
)
from app.governance_approval.schemas import GovernanceApprovalActionRequest
from app.governance_approval.service import GovernanceSeparationOfDutiesError, enforce_separation_of_duties

from app.database import get_db, get_db_read_bounded
from app.governance_policies.impact_service import analyze_policy_impact_preview, analyze_saved_policy_impact
from app.governance_policies.schemas import (
    GovernancePolicyAssignmentsRequest,
    GovernancePolicyAssignmentsResponse,
    GovernancePolicyCreateRequest,
    GovernancePolicyImpactPreviewRequest,
    GovernancePolicyImpactResponse,
    GovernancePolicyListResponse,
    GovernancePolicyPreviewResponse,
    GovernancePolicyResponse,
    GovernancePolicySimulateByIdRequest,
    GovernancePolicySimulateRequest,
    GovernancePolicySimulateResponse,
    GovernancePolicyUpdateRequest,
    PolicyJsonBody,
    StreamAssignmentEntry,
)
from app.governance_policies.simulation_service import (
    GovernancePolicySimulationError,
    simulate_policy_json,
    simulate_saved_policy,
)
from app.governance_policies.service import (
    GovernancePolicyLifecycleError,
    GovernancePolicyNotFoundError,
    GovernancePolicyStreamNotFoundError,
    GovernancePolicyValidationError,
    activate_policy,
    create_governance_policy,
    delete_governance_policy,
    get_governance_policy,
    get_governance_policy_entry,
    list_governance_policies,
    list_policy_assignments,
    preview_governance_policy,
    preview_policy_json,
    retire_policy,
    set_policy_assignments,
    submit_policy_for_review,
    update_governance_policy,
)

router = APIRouter()


def _policy_response(db: Session, policy_id: int) -> GovernancePolicyResponse:
    entry = get_governance_policy_entry(db, policy_id)
    if entry is None:
        raise GovernancePolicyNotFoundError(policy_id)
    return GovernancePolicyResponse(policy=entry)


@router.get("/policies", response_model=GovernancePolicyListResponse)
async def get_governance_policies(
    db: Session = Depends(get_db_read_bounded),
    _auth=Depends(require_governance_read()),
) -> GovernancePolicyListResponse:
    return GovernancePolicyListResponse(policies=list_governance_policies(db))


@router.post("/policies", response_model=GovernancePolicyResponse, status_code=201)
async def post_governance_policy(
    body: GovernancePolicyCreateRequest,
    db: Session = Depends(get_db),
    _auth=Depends(require_governance_write()),
) -> GovernancePolicyResponse:
    try:
        row = create_governance_policy(
            db,
            name=body.name,
            description=body.description,
            category=body.category,
            status=body.status,
            policy_json=body.policy_json.model_dump(),
        )
        db.commit()
    except GovernancePolicyValidationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail={"error_code": "GOVERNANCE_POLICY_VALIDATION", "message": str(exc)},
        ) from exc
    except GovernancePolicyLifecycleError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={"error_code": "GOVERNANCE_POLICY_LIFECYCLE", "message": str(exc)},
        ) from exc
    return _policy_response(db, row.id)


@router.get("/policies/{policy_id}", response_model=GovernancePolicyResponse)
async def get_governance_policy_by_id(
    policy_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> GovernancePolicyResponse:
    entry = get_governance_policy_entry(db, policy_id)
    if entry is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "GOVERNANCE_POLICY_NOT_FOUND", "message": f"policy {policy_id} not found"},
        )
    return GovernancePolicyResponse(policy=entry)


@router.put("/policies/{policy_id}", response_model=GovernancePolicyResponse)
async def put_governance_policy(
    policy_id: int,
    body: GovernancePolicyUpdateRequest,
    db: Session = Depends(get_db),
    _auth=Depends(require_governance_write()),
) -> GovernancePolicyResponse:
    try:
        update_governance_policy(
            db,
            policy_id=policy_id,
            name=body.name,
            description=body.description,
            category=body.category,
            status=body.status,
            policy_json=body.policy_json.model_dump() if body.policy_json is not None else None,
        )
        db.commit()
    except GovernancePolicyNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "GOVERNANCE_POLICY_NOT_FOUND", "message": str(exc)},
        ) from exc
    except GovernancePolicyValidationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail={"error_code": "GOVERNANCE_POLICY_VALIDATION", "message": str(exc)},
        ) from exc
    except GovernancePolicyLifecycleError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={"error_code": "GOVERNANCE_POLICY_LIFECYCLE", "message": str(exc)},
        ) from exc
    return _policy_response(db, policy_id)


def _lifecycle_response(db: Session, policy_id: int) -> GovernancePolicyResponse:
    try:
        return _policy_response(db, policy_id)
    except GovernancePolicyNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "GOVERNANCE_POLICY_NOT_FOUND", "message": str(exc)},
        ) from exc


@router.post("/policies/{policy_id}/submit-review", response_model=GovernancePolicyResponse)
async def post_governance_policy_submit_review(
    policy_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _auth=Depends(require_governance_write()),
) -> GovernancePolicyResponse:
    try:
        # F-187: record the submitter exactly like POST /governance/approvals/{id}/submit does.
        submit_policy_for_review(db, policy_id, actor=resolve_governance_actor(request))
        db.commit()
    except GovernancePolicyNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "GOVERNANCE_POLICY_NOT_FOUND", "message": str(exc)},
        ) from exc
    except GovernancePolicyLifecycleError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={"error_code": "GOVERNANCE_POLICY_LIFECYCLE", "message": str(exc)},
        ) from exc
    return _lifecycle_response(db, policy_id)


@router.post("/policies/{policy_id}/activate", response_model=GovernancePolicyResponse)
async def post_governance_policy_activate(
    policy_id: int,
    request: Request,
    body: GovernanceApprovalActionRequest | None = None,
    db: Session = Depends(get_db),
    _auth=Depends(require_policy_activate()),
) -> GovernancePolicyResponse:
    try:
        # F-187: the same separation of duties as the approval workflow's activate, so the policy
        # author cannot sidestep it through this endpoint.
        row = get_governance_policy(db, policy_id)
        if row is not None:
            enforce_separation_of_duties(
                db,
                row,
                action="activate",
                actor=resolve_governance_actor(request),
                allow_self_approval=bool(body and body.allow_self_approval),
            )
        activate_policy(db, policy_id)
        db.commit()
    except GovernancePolicyNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "GOVERNANCE_POLICY_NOT_FOUND", "message": str(exc)},
        ) from exc
    except GovernanceSeparationOfDutiesError as exc:
        db.rollback()
        raise HTTPException(
            status_code=403,
            detail={"error_code": exc.error_code, "message": str(exc)},
        ) from exc
    except GovernancePolicyLifecycleError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={"error_code": "GOVERNANCE_POLICY_LIFECYCLE", "message": str(exc)},
        ) from exc
    return _lifecycle_response(db, policy_id)


@router.post("/policies/{policy_id}/retire", response_model=GovernancePolicyResponse)
async def post_governance_policy_retire(
    policy_id: int,
    db: Session = Depends(get_db),
    _auth=Depends(require_policy_activate()),
) -> GovernancePolicyResponse:
    try:
        retire_policy(db, policy_id)
        db.commit()
    except GovernancePolicyNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "GOVERNANCE_POLICY_NOT_FOUND", "message": str(exc)},
        ) from exc
    except GovernancePolicyLifecycleError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={"error_code": "GOVERNANCE_POLICY_LIFECYCLE", "message": str(exc)},
        ) from exc
    return _lifecycle_response(db, policy_id)


@router.delete("/policies/{policy_id}", status_code=204)
async def delete_governance_policy_by_id(
    policy_id: int,
    db: Session = Depends(get_db),
    _auth=Depends(require_governance_write()),
) -> None:
    try:
        delete_governance_policy(db, policy_id)
        db.commit()
    except GovernancePolicyNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "GOVERNANCE_POLICY_NOT_FOUND", "message": str(exc)},
        ) from exc
    except GovernancePolicyLifecycleError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={"error_code": "GOVERNANCE_POLICY_LIFECYCLE", "message": str(exc)},
        ) from exc


@router.get("/policies/{policy_id}/assignments", response_model=GovernancePolicyAssignmentsResponse)
async def get_governance_policy_assignments(
    policy_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> GovernancePolicyAssignmentsResponse:
    try:
        assignments = list_policy_assignments(db, policy_id)
    except GovernancePolicyNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "GOVERNANCE_POLICY_NOT_FOUND", "message": str(exc)},
        ) from exc
    return GovernancePolicyAssignmentsResponse(
        policy_id=policy_id,
        assignments=[StreamAssignmentEntry(**entry) for entry in assignments],
    )


@router.put("/policies/{policy_id}/assignments", response_model=GovernancePolicyAssignmentsResponse)
async def put_governance_policy_assignments(
    policy_id: int,
    body: GovernancePolicyAssignmentsRequest,
    db: Session = Depends(get_db),
    _auth=Depends(require_governance_write()),
) -> GovernancePolicyAssignmentsResponse:
    try:
        assignments = set_policy_assignments(
            db,
            policy_id=policy_id,
            assignments=[entry.model_dump() for entry in body.assignments],
        )
        db.commit()
    except GovernancePolicyNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "GOVERNANCE_POLICY_NOT_FOUND", "message": str(exc)},
        ) from exc
    except GovernancePolicyStreamNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": str(exc)},
        ) from exc
    except GovernancePolicyValidationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail={"error_code": "GOVERNANCE_POLICY_VALIDATION", "message": str(exc)},
        ) from exc
    return GovernancePolicyAssignmentsResponse(
        policy_id=policy_id,
        assignments=[StreamAssignmentEntry(**entry) for entry in assignments],
    )


@router.get("/policies/{policy_id}/preview", response_model=GovernancePolicyPreviewResponse)
async def get_governance_policy_preview(
    policy_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> GovernancePolicyPreviewResponse:
    try:
        preview = preview_governance_policy(db, policy_id)
    except GovernancePolicyNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "GOVERNANCE_POLICY_NOT_FOUND", "message": str(exc)},
        ) from exc
    except GovernancePolicyValidationError as exc:
        raise HTTPException(
            status_code=400,
            detail={"error_code": "GOVERNANCE_POLICY_VALIDATION", "message": str(exc)},
        ) from exc
    return GovernancePolicyPreviewResponse(**preview)


@router.post("/policies/preview", response_model=GovernancePolicyPreviewResponse)
async def post_governance_policy_preview(
    body: PolicyJsonBody,
) -> GovernancePolicyPreviewResponse:
    try:
        preview = preview_policy_json(body.model_dump())
    except GovernancePolicyValidationError as exc:
        raise HTTPException(
            status_code=400,
            detail={"error_code": "GOVERNANCE_POLICY_VALIDATION", "message": str(exc)},
        ) from exc
    return GovernancePolicyPreviewResponse(policy_id=0, **preview)


@router.post("/policies/impact-preview", response_model=GovernancePolicyImpactResponse)
async def post_governance_policy_impact_preview(
    body: GovernancePolicyImpactPreviewRequest,
    db: Session = Depends(get_db_read_bounded),
) -> GovernancePolicyImpactResponse:
    try:
        impact = analyze_policy_impact_preview(
            db,
            policy_json=body.policy_json.model_dump(),
            policy_id=body.policy_id,
            stream_ids=body.stream_ids,
        )
    except GovernancePolicyNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "GOVERNANCE_POLICY_NOT_FOUND", "message": str(exc)},
        ) from exc
    except GovernancePolicyValidationError as exc:
        raise HTTPException(
            status_code=400,
            detail={"error_code": "GOVERNANCE_POLICY_VALIDATION", "message": str(exc)},
        ) from exc
    return GovernancePolicyImpactResponse(**impact)


@router.get("/policies/{policy_id}/impact", response_model=GovernancePolicyImpactResponse)
async def get_governance_policy_impact(
    policy_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> GovernancePolicyImpactResponse:
    try:
        impact = analyze_saved_policy_impact(db, policy_id)
    except GovernancePolicyNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "GOVERNANCE_POLICY_NOT_FOUND", "message": str(exc)},
        ) from exc
    except GovernancePolicyValidationError as exc:
        raise HTTPException(
            status_code=400,
            detail={"error_code": "GOVERNANCE_POLICY_VALIDATION", "message": str(exc)},
        ) from exc
    return GovernancePolicyImpactResponse(**impact)


@router.post("/policies/simulate", response_model=GovernancePolicySimulateResponse)
async def post_governance_policy_simulate(
    body: GovernancePolicySimulateRequest,
    db: Session = Depends(get_db_read_bounded),
) -> GovernancePolicySimulateResponse:
    try:
        result = simulate_policy_json(
            policy_json=body.policy_json.model_dump(),
            sample_events=body.sample_events,
            db=db,
            stream_ids=body.stream_ids,
        )
    except GovernancePolicySimulationError as exc:
        raise HTTPException(
            status_code=400,
            detail={"error_code": "GOVERNANCE_POLICY_SIMULATION", "message": str(exc)},
        ) from exc
    return GovernancePolicySimulateResponse(**result)


@router.post("/policies/{policy_id}/simulate", response_model=GovernancePolicySimulateResponse)
async def post_governance_policy_simulate_by_id(
    policy_id: int,
    body: GovernancePolicySimulateByIdRequest,
    db: Session = Depends(get_db_read_bounded),
) -> GovernancePolicySimulateResponse:
    try:
        result = simulate_saved_policy(
            db,
            policy_id=policy_id,
            sample_events=body.sample_events,
            stream_ids=body.stream_ids,
        )
    except GovernancePolicyNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "GOVERNANCE_POLICY_NOT_FOUND", "message": str(exc)},
        ) from exc
    except GovernancePolicySimulationError as exc:
        raise HTTPException(
            status_code=400,
            detail={"error_code": "GOVERNANCE_POLICY_SIMULATION", "message": str(exc)},
        ) from exc
    return GovernancePolicySimulateResponse(**result)
