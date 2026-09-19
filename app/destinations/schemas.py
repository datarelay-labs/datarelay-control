"""Pydantic schemas for Destination API."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, field_validator


DestinationTypeLiteral = Literal["SYSLOG_UDP", "SYSLOG_TCP", "SYSLOG_TLS", "WEBHOOK_POST", "AI_PROVIDER_POST"]


def _require_non_blank_name(value: str | None) -> str | None:
    if value is None:
        return value
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Destination name must be a non-empty string")
    return value


class DestinationBase(BaseModel):
    name: str | None = None
    destination_type: DestinationTypeLiteral | None = None
    config_json: dict | None = None
    rate_limit_json: dict | None = None
    enabled: bool | None = None

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, value: str | None) -> str | None:
        return _require_non_blank_name(value)


class DestinationCreate(DestinationBase):
    name: str
    destination_type: DestinationTypeLiteral
    config_json: dict
    rate_limit_json: dict | None = None
    enabled: bool | None = True


class DestinationPreviewTest(DestinationBase):
    """Body for POST /destinations/preview-test — same shape as create, without persisting."""

    name: str
    destination_type: DestinationTypeLiteral
    config_json: dict


class DestinationUpdate(DestinationBase):
    """Partial destination update. ``expected_updated_at`` is the optimistic-concurrency token."""

    expected_updated_at: datetime


class DestinationRead(DestinationBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    destination_type: DestinationTypeLiteral
    config_json: dict
    rate_limit_json: dict
    enabled: bool
    created_at: datetime | None = None
    updated_at: datetime | None = None
    last_connectivity_test_at: datetime | None = None
    last_connectivity_test_success: bool | None = None
    last_connectivity_test_latency_ms: float | None = None
    last_connectivity_test_message: str | None = None


class DestinationRouteUsage(BaseModel):
    """One route linking a stream to this destination."""

    route_id: int
    stream_id: int
    stream_name: str
    route_enabled: bool
    route_status: str


class DestinationListItem(DestinationRead):
    """List row including route/stream usage (routes table is source of truth)."""

    streams_using_count: int
    routes: list[DestinationRouteUsage]


class DestinationTestResult(BaseModel):
    """Result of POST /destinations/{id}/test (connectivity probe)."""

    success: bool
    latency_ms: float
    message: str
    tested_at: str
    detail: dict | None = None
