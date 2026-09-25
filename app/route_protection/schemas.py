"""API schemas for per-route protection operator endpoints."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.protection.schemas import ProtectionMode, SensitivityClass

RouteProtectionProcessingStatus = Literal["Inherited", "Overridden", "Mixed"]


class RouteProtectionRuleEntry(BaseModel):
    id: int
    route_id: int
    stream_id: int
    field_path: str
    sensitivity_class: str
    protection_mode: str
    enabled: bool
    source_finding_id: int | None = None
    created_by: str
    created_at: datetime
    updated_at: datetime


class RouteProtectionRulesResponse(BaseModel):
    route_id: int
    stream_id: int
    protection_enabled: bool
    rules: list[RouteProtectionRuleEntry] = Field(default_factory=list)
    rule_count: int = 0


class RouteProtectionRuleCreateRequest(BaseModel):
    field_path: str = Field(min_length=1, max_length=4096)
    sensitivity_class: SensitivityClass
    protection_mode: ProtectionMode
    enabled: bool = True
    source_finding_id: int | None = None


class RouteProtectionRulePatchRequest(BaseModel):
    protection_mode: ProtectionMode | None = None
    enabled: bool | None = None
    sensitivity_class: SensitivityClass | None = None


class RouteProtectionRulesReplaceRequest(BaseModel):
    """Complete desired protection rule set for one route."""

    rules: list[RouteProtectionRuleCreateRequest]


class RouteProtectionRuleResponse(BaseModel):
    rule: RouteProtectionRuleEntry


class RouteProtectionEffectiveResponse(BaseModel):
    route_id: int
    stream_id: int
    persisted_source: Literal["route", "stream"]
    fallback_used: bool
    rule_count: int
    processing_status: RouteProtectionProcessingStatus
    message: str
