"""Pydantic schemas for governance violation feed (M19.1)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

ViolationStatus = Literal["OPEN", "QUARANTINED", "RELEASED", "REPLAYED", "DISCARDED"]
ViolationSeverity = Literal["HIGH", "MEDIUM", "LOW"]
ViolationWindow = Literal["24h", "7d", "30d"]


class GovernanceViolationEntry(BaseModel):
    id: str
    policy_id: int | None = None
    policy_name: str
    stream_id: int
    stream_name: str
    event_time: datetime
    severity: ViolationSeverity
    reason: str
    status: ViolationStatus
    quarantine_event_id: int | None = None


class GovernanceViolationListResponse(BaseModel):
    window: ViolationWindow
    total: int
    violations: list[GovernanceViolationEntry] = Field(default_factory=list)


class GovernanceViolationPolicySummary(BaseModel):
    policy_id: int | None = None
    policy_name: str
    policy_status: str | None = None
    policy_version: int | None = None
    rule_summary: str | None = None


class GovernanceViolationQuarantineRef(BaseModel):
    quarantine_event_id: int
    status: str
    quarantine_reason: str
    created_at: datetime
    released_at: datetime | None = None


class GovernanceViolationReplayRef(BaseModel):
    replay_event_id: int
    status: str
    event_count: int
    last_replay_at: datetime | None = None


class GovernanceViolationDetailResponse(BaseModel):
    violation: GovernanceViolationEntry
    policy_summary: GovernanceViolationPolicySummary
    related_quarantine: GovernanceViolationQuarantineRef | None = None
    related_replays: list[GovernanceViolationReplayRef] = Field(default_factory=list)
