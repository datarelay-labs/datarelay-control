"""Pydantic schemas for governance quarantine operations (M19.2)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

QuarantineDisplayStatus = Literal["QUARANTINED", "RELEASED", "DISCARDED", "REPLAYED"]
QuarantineSeverity = Literal["HIGH", "MEDIUM", "LOW"]
QuarantineWindow = Literal["24h", "7d", "30d"]


class GovernanceQuarantineEntry(BaseModel):
    id: int
    policy_id: int | None = None
    policy_name: str
    stream_id: int
    stream_name: str
    classification: str | None = None
    severity: QuarantineSeverity
    reason: str
    status: QuarantineDisplayStatus
    quarantined_at: datetime
    violation_id: str | None = None


class GovernanceQuarantineListResponse(BaseModel):
    window: QuarantineWindow
    total: int
    quarantine_events: list[GovernanceQuarantineEntry] = Field(default_factory=list)


class GovernanceQuarantinePolicySummary(BaseModel):
    policy_id: int | None = None
    policy_name: str
    policy_status: str | None = None
    policy_version: int | None = None
    rule_summary: str | None = None


class GovernanceQuarantineSensitiveFinding(BaseModel):
    field_path: str
    sensitivity_class: str
    status: str


class GovernanceQuarantineProtectionAction(BaseModel):
    field_path: str
    sensitivity_class: str
    protection_mode: str


class GovernanceQuarantinePolicyDecision(BaseModel):
    action: str
    summary: str | None = None


class GovernanceQuarantineReplayRef(BaseModel):
    replay_event_id: int
    status: str
    event_count: int
    last_replay_at: datetime | None = None


class GovernanceQuarantineViolationRef(BaseModel):
    violation_id: str
    status: str
    reason: str


class GovernanceQuarantineMetadata(BaseModel):
    quarantine_event_id: int
    quarantine_source: str
    event_count: int
    created_at: datetime
    updated_at: datetime
    released_at: datetime | None = None
    released_by: str | None = None


class GovernanceQuarantineRootCauseStrip(BaseModel):
    detected: str
    action: str
    policy: str
    result: str
    summary: str


class GovernanceQuarantineDetailResponse(BaseModel):
    entry: GovernanceQuarantineEntry
    policy_summary: GovernanceQuarantinePolicySummary
    violation_reason: str
    classification: str | None = None
    sensitive_findings: list[GovernanceQuarantineSensitiveFinding] = Field(default_factory=list)
    protection_actions: list[GovernanceQuarantineProtectionAction] = Field(default_factory=list)
    policy_decision: GovernanceQuarantinePolicyDecision
    related_replay: list[GovernanceQuarantineReplayRef] = Field(default_factory=list)
    # The Replay action only succeeds when a pending replay job can be associated (F-182).
    replay_available: bool = False
    replay_unavailable_reason: str | None = None
    related_violation: GovernanceQuarantineViolationRef | None = None
    related_quarantine: GovernanceQuarantineMetadata
    quarantine_metadata: GovernanceQuarantineMetadata
    root_cause_strip: GovernanceQuarantineRootCauseStrip


class GovernanceQuarantineBulkRequest(BaseModel):
    ids: list[int] = Field(default_factory=list, min_length=1)


class GovernanceQuarantineBulkItemResult(BaseModel):
    id: int
    outcome: str
    message: str
    status: str | None = None
    replay_event_id: int | None = None


class GovernanceQuarantineBulkResponse(BaseModel):
    total: int
    succeeded: int
    failed: int
    results: list[GovernanceQuarantineBulkItemResult] = Field(default_factory=list)
