"""Pydantic schemas for connector operations dashboard aggregation."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

AuthHealthCheckInterval = Literal["disabled", "15m", "1h", "6h", "24h"]
ConnectorStreamHealthLabel = Literal["healthy", "warning", "critical", "stopped"]


class ConnectorStreamOpsSummary(BaseModel):
    stream_id: int
    stream_name: str
    status: str
    enabled: bool = True
    health: ConnectorStreamHealthLabel = "healthy"
    primary_issue: str | None = None
    events_1h: int = 0
    last_success_at: datetime | None = None
    destination_count: int = 0


class ConnectorOperationsRow(BaseModel):
    connector_id: int
    stream_count: int = 0
    destination_count: int = 0
    affected_stream_count: int = 0
    affected_destination_count: int = 0
    streams: list[ConnectorStreamOpsSummary] = Field(default_factory=list)
    streams_healthy_count: int = 0
    streams_warning_count: int = 0
    streams_critical_count: int = 0
    streams_stopped_count: int = 0
    stale_stream_count: int = 0
    last_event_at: datetime | None = None
    last_event_at_active: datetime | None = None
    events_1h: int = 0
    events_24h: int = 0
    events_last_1h: int = 0
    events_previous_1h: int = 0
    event_trend_percent: float | None = None
    eps: float = 0.0
    auth_health_check_interval: AuthHealthCheckInterval = "disabled"
    last_auth_check_at: datetime | None = None
    last_auth_check_status: Literal["success", "failed"] | None = None
    last_auth_error: str | None = None


class ConnectorOperationsSummaryResponse(BaseModel):
    window: str = "1h"
    generated_at: datetime | None = None
    connectors: list[ConnectorOperationsRow] = Field(default_factory=list)


class ConnectorAuthCheckRequest(BaseModel):
    """Optional body for POST /connectors/{id}/auth-check."""

    method: str = "GET"
    test_path: str = "/"


class ConnectorAuthCheckPersistedResponse(BaseModel):
    success: bool
    status_code: int | None = None
    message: str | None = None
    error_code: str | None = None
    last_auth_check_at: datetime
    last_auth_check_status: Literal["success", "failed"]
    last_auth_error: str | None = None
    response_time_ms: int | None = None
