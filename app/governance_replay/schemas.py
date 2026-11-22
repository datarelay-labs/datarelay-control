"""Pydantic schemas for governance replay operations (M20.1)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

ReplayDisplayStatus = Literal["PENDING", "RUNNING", "COMPLETED", "FAILED", "DISCARDED"]
ReplayWindow = Literal["24h", "7d", "30d"]
ReplayOutcomeLabel = Literal["Success", "Failure", "Discarded"]


class GovernanceReplayEntry(BaseModel):
    id: int
    policy_id: int | None = None
    policy_name: str
    stream_id: int
    stream_name: str
    status: ReplayDisplayStatus
    created_at: datetime
    completed_at: datetime | None = None
    outcome: ReplayOutcomeLabel | None = None
    event_count: int = 0
    correlation_id: str | None = None
    route_id: int | None = None
    destination_id: int | None = None
    # Number of failed polls folded into this job (E-114); 1 for a single failure.
    occurrence_count: int = 1
    # Explains a non-obvious state, e.g. why a Discarded job was superseded (E-113).
    status_note: str | None = None


class GovernanceReplayListResponse(BaseModel):
    window: ReplayWindow
    total: int
    replay_events: list[GovernanceReplayEntry] = Field(default_factory=list)
    queue_count: int = 0
    failed_count: int = 0
    recent_count: int = 0


class GovernanceReplayPolicySummary(BaseModel):
    policy_id: int | None = None
    policy_name: str
    policy_status: str | None = None
    policy_version: int | None = None


class GovernanceReplayViolationRef(BaseModel):
    violation_id: str
    status: str
    reason: str


class GovernanceReplayQuarantineRef(BaseModel):
    quarantine_event_id: int
    status: str
    quarantine_reason: str
    created_at: datetime


class GovernanceReplaySource(BaseModel):
    origin: str
    violation: GovernanceReplayViolationRef | None = None
    quarantine: GovernanceReplayQuarantineRef | None = None


class GovernanceReplayTimelineStep(BaseModel):
    step: str
    label: str
    event_time: datetime | None = None


class GovernanceReplayDetailResponse(BaseModel):
    entry: GovernanceReplayEntry
    policy_summary: GovernanceReplayPolicySummary
    correlation_id: str | None = None
    source: GovernanceReplaySource
    timeline: list[GovernanceReplayTimelineStep] = Field(default_factory=list)
    outcome: ReplayOutcomeLabel | None = None
    error_type: str | None = None
    error_message: str | None = None
    can_execute: bool = False
    can_discard: bool = False


class GovernanceReplayExecuteRequest(BaseModel):
    # Explicit operator override for events another path already delivered (duplicates).
    allow_redelivery: bool = False


class GovernanceReplayBulkRequest(BaseModel):
    ids: list[int] = Field(default_factory=list, min_length=1)
    allow_redelivery: bool = False


class GovernanceReplayBulkItemResult(BaseModel):
    id: int
    outcome: str
    message: str
    status: str | None = None
    error_code: str | None = None


class GovernanceReplayBulkResponse(BaseModel):
    total: int
    succeeded: int
    failed: int
    results: list[GovernanceReplayBulkItemResult] = Field(default_factory=list)


class GovernanceReplayExecuteResponse(BaseModel):
    id: int
    outcome: str
    message: str
    status: str | None = None
    error_code: str | None = None
