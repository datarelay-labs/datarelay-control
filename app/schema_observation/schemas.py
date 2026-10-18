"""API schemas for Stream observed schema read endpoints."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class ObservedFieldEntry(BaseModel):
    path: str
    type: str
    observation_count: int = 0
    occurrence_count: int | None = None


class StreamObservedSchemaResponse(BaseModel):
    stream_id: int
    observation_enabled: bool
    paths: list[ObservedFieldEntry] = Field(default_factory=list)
    path_count: int = 0
    occurrence_sampled_events: int | None = None
    occurrence_complete: bool | None = None
    occurrence_warnings: list[str] = Field(default_factory=list)
    historical_events_excluded: int | None = None
    total_events_observed: int = 0
    observation_run_count: int = 0
    last_observation_at: datetime | None = None
    updated_at: datetime | None = None


class SchemaFieldDriftEntry(BaseModel):
    id: int
    field_path: str
    category: str
    status: str
    first_detected_at: datetime
    last_confirmed_at: datetime
    finding: dict[str, str] | None = None
    operator_note: str | None = None
    resolution: str | None = None
    acknowledged_at: datetime | None = None
    resolved_at: datetime | None = None


class StreamSchemaFieldDriftsResponse(BaseModel):
    stream_id: int
    drift_detection_enabled: bool
    baseline_established: bool
    baseline_established_at: datetime | None = None
    baseline_path_count: int = 0
    baseline_version: int = 1
    baseline_reset_at: datetime | None = None
    status_filter: Literal["open", "acknowledged", "all"] = "open"
    findings: list[SchemaFieldDriftEntry] = Field(default_factory=list)
    finding_count: int = 0


class SchemaFieldDriftCategoryCounts(BaseModel):
    field_added: int = 0
    field_removed: int = 0
    field_type_changed: int = 0


class StreamSchemaFieldDriftsSummaryResponse(BaseModel):
    stream_id: int
    open_count: int = 0
    acknowledged_count: int = 0
    resolved_count: int = 0
    by_category: SchemaFieldDriftCategoryCounts
    baseline_version: int = 1
    baseline_established_at: datetime | None = None
    baseline_reset_at: datetime | None = None
    drift_detection_enabled: bool = False


class SchemaFieldDriftAcknowledgeRequest(BaseModel):
    note: str | None = None


class SchemaFieldDriftAcknowledgeResponse(BaseModel):
    id: int
    stream_id: int
    field_path: str
    category: str
    status: str
    acknowledged_at: datetime
    acknowledged_by: str
    operator_note: str | None = None


class SchemaBaselineResetRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=2000)


class SchemaBaselineResetResponse(BaseModel):
    stream_id: int
    baseline_version: int
    baseline_path_count: int
    baseline_established_at: datetime | None = None
    baseline_reset_at: datetime | None = None
    baseline_reset_by: str | None = None
    baseline_reset_reason: str | None = None
    resolved_open_finding_count: int = 0
