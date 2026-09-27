"""Pydantic models for stream governance Contract v1 API."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class GovernanceRouteOverrideNested(BaseModel):
    """Nested override under a governance rule (authoring mirror)."""

    route_id: int
    protection_action: str | None = None
    delivery_behavior: str | None = None
    classification_level: str | None = None
    enabled: bool = True
    override_key: str | None = None


class GovernanceRule(BaseModel):
    """Stream default governance rule for one field."""

    rule_key: str | None = None
    field_path: str
    sensitivity_type: str | None = None
    default_protection_action: str = "audit"
    default_delivery_behavior: str = "continue"
    enabled: bool = True
    route_overrides: list[GovernanceRouteOverrideNested] = Field(default_factory=list)


class GovernanceRouteOverride(BaseModel):
    """Flat canonical route override record."""

    override_key: str | None = None
    field_path: str | None = None
    route_id: int
    protection_action: str | None = None
    delivery_behavior: str | None = None
    classification_level: str | None = None
    enabled: bool = True


class StreamGovernanceDocument(BaseModel):
    """GET/PUT body for /runtime/streams/{id}/governance."""

    enabled: bool = True
    rules: list[GovernanceRule] = Field(default_factory=list)
    route_overrides: list[GovernanceRouteOverride] = Field(default_factory=list)


class StreamGovernanceWrite(StreamGovernanceDocument):
    """PUT body. expected_updated_at is the stream revision from the GET used to merge."""

    expected_updated_at: datetime


class StreamGovernanceResponse(StreamGovernanceDocument):
    """GET response."""

    stream_id: int
    updated_at: datetime | None = None


class EffectiveProtectionAction(BaseModel):
    protection_action: str | None = None
    protection_mode: str | None = None
    delivery_behavior: str | None = None
    source: str
    mutates_field: bool = False
    enforcement: str | None = None


class EffectiveRouteOverrideRef(BaseModel):
    override_key: str | None = None
    protection_action: str | None = None
    delivery_behavior: str | None = None
    classification_level: str | None = None
    enabled: bool = True


class EffectivePerRouteField(BaseModel):
    route_id: int
    effective: EffectiveProtectionAction
    override: EffectiveRouteOverrideRef | None = None


class EffectiveFieldStreamDefault(BaseModel):
    protection_action: str | None = None
    delivery_behavior: str | None = None
    sensitivity_type: str | None = None


class EffectiveProtectionField(BaseModel):
    field_path: str
    stream_default: EffectiveFieldStreamDefault | None = None
    per_route: list[EffectivePerRouteField] = Field(default_factory=list)


class EffectiveProtectionRouteRef(BaseModel):
    route_id: int
    destination_name: str | None = None
    enabled: bool = True


class EffectiveProtectionSummary(BaseModel):
    protection_rule_count: int = 0
    route_override_count: int = 0
    routes_with_divergence: int = 0


class EffectiveProtectionResponse(BaseModel):
    stream_id: int
    generated_at: datetime
    routes: list[EffectiveProtectionRouteRef] = Field(default_factory=list)
    fields: list[EffectiveProtectionField] = Field(default_factory=list)
    summary: EffectiveProtectionSummary = Field(default_factory=EffectiveProtectionSummary)

    model_config = {"json_schema_extra": {"example": {}}}


class GovernanceErrorDetail(BaseModel):
    error_code: str
    message: str


def governance_error_detail(error_code: str, message: str) -> dict[str, Any]:
    return {"error_code": error_code, "message": message}
