"""Pydantic schemas for governance approval workflow (M19.5)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, StrictBool

ApprovalEventType = Literal[
    "SUBMITTED_FOR_REVIEW",
    "APPROVED",
    "REJECTED",
    "REQUEST_CHANGES",
    "ACTIVATED",
    "CANCELLED",
]

ApprovalWindow = Literal["24h", "7d", "30d"]
PolicyStatus = Literal["DRAFT", "REVIEW", "ACTIVE", "RETIRED"]


class GovernanceApprovalActionRequest(BaseModel):
    comment: str | None = Field(default=None, max_length=2000)
    # F-187: approve/activate is refused (403) for the user who submitted the policy unless the
    # caller explicitly sends JSON ``true`` (strict: strings such as "true" or 1 are rejected with
    # 422). It has no effect on any other action.
    allow_self_approval: StrictBool = False


class GovernanceApprovalHistoryEntry(BaseModel):
    event_time: datetime
    event_type: ApprovalEventType
    actor: str
    comment: str | None = None


class GovernanceApprovalPolicySummary(BaseModel):
    id: int
    name: str
    description: str | None = None
    category: str
    status: PolicyStatus
    version: int
    assigned_stream_count: int = 0
    assigned_stream_ids: list[int] = Field(default_factory=list)


class GovernanceApprovalImpactSummary(BaseModel):
    impact_data_available: bool = False
    impact_matched_events: int | None = None
    impact_summary: dict[str, Any] | None = None
    affected_stream_count: int = 0


class GovernanceApprovalSimulationSummary(BaseModel):
    simulation_available: bool = False
    dry_run_summary: str | None = None
    action_breakdown: dict[str, int] = Field(default_factory=dict)


class GovernanceApprovalQueueEntry(BaseModel):
    policy_id: int
    policy_name: str
    policy_status: PolicyStatus
    approval_status: str
    requester: str | None = None
    reviewer: str | None = None
    submitted_at: datetime | None = None
    last_action: ApprovalEventType | None = None
    last_action_at: datetime | None = None
    last_comment: str | None = None
    impact_label: str | None = None


class GovernanceApprovalListResponse(BaseModel):
    window: ApprovalWindow
    total: int
    approvals: list[GovernanceApprovalQueueEntry]


class GovernanceApprovalDetailResponse(BaseModel):
    policy: GovernanceApprovalPolicySummary
    current_status: PolicyStatus
    approval_status: str
    requester: str | None = None
    reviewer: str | None = None
    submitted_at: datetime | None = None
    review_comment: str | None = None
    is_approved: bool = False
    history: list[GovernanceApprovalHistoryEntry]
    impact: GovernanceApprovalImpactSummary | None = None
    simulation: GovernanceApprovalSimulationSummary | None = None


class GovernanceApprovalActionResponse(BaseModel):
    policy_id: int
    policy_status: PolicyStatus
    approval_status: str
    event_type: ApprovalEventType
    message: str
