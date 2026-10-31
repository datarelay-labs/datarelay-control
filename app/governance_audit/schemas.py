"""Pydantic schemas for governance audit trail API (M19.3)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

AuditEventType = Literal[
    "POLICY_ACTIVATED",
    "SUBMITTED_FOR_REVIEW",
    "APPROVED",
    "REJECTED",
    "REQUEST_CHANGES",
    "APPROVAL_ACTIVATED",
    "VIOLATION_CREATED",
    "QUARANTINE_CREATED",
    "QUARANTINE_RELEASED",
    "QUARANTINE_DISCARDED",
    "REPLAY_STARTED",
    "REPLAY_COMPLETED",
    "REPLAY_FAILED",
]

AuditStatus = Literal[
    "ACTIVE",
    "OPEN",
    "QUARANTINED",
    "RELEASED",
    "DISCARDED",
    "IN_PROGRESS",
    "DELIVERED",
    "FAILED",
]

AuditWindow = Literal["24h", "7d", "30d"]
AuditOutcome = Literal["DELIVERED", "DISCARDED", "FAILED"]


class GovernanceAuditEntry(BaseModel):
    event_time: datetime
    policy_id: int | None = None
    policy_name: str
    stream_id: int | None = None
    stream_name: str | None = None
    event_type: AuditEventType
    status: AuditStatus
    correlation_id: str


class GovernanceAuditListResponse(BaseModel):
    window: AuditWindow
    total: int
    events: list[GovernanceAuditEntry] = Field(default_factory=list)


class GovernanceAuditTimelineStep(BaseModel):
    event_time: datetime
    event_type: AuditEventType
    summary: str
    actor: str | None = None


class GovernanceAuditViolationRef(BaseModel):
    violation_id: str
    status: str
    reason: str | None = None


class GovernanceAuditQuarantineRef(BaseModel):
    quarantine_event_id: int
    status: str


class GovernanceAuditReplayRef(BaseModel):
    replay_event_id: int
    status: str
    event_count: int


class GovernanceAuditDetailResponse(BaseModel):
    correlation_id: str
    policy_id: int | None = None
    policy_name: str
    stream_id: int | None = None
    stream_name: str | None = None
    current_status: AuditStatus
    outcome: AuditOutcome | None = None
    timeline: list[GovernanceAuditTimelineStep] = Field(default_factory=list)
    related_violation: GovernanceAuditViolationRef | None = None
    related_quarantine: GovernanceAuditQuarantineRef | None = None
    related_replay: GovernanceAuditReplayRef | None = None
