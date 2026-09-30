"""API schemas for per-route policy operator endpoints."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.protection.policy_schemas import PolicyActionType, PolicyConditionJson

RoutePolicyProcessingStatus = Literal["Inherited", "Overridden", "Mixed"]


class RoutePolicyRuleEntry(BaseModel):
    id: int
    route_id: int
    stream_id: int
    name: str
    enabled: bool
    condition_json: dict[str, Any]
    action_type: str
    created_at: datetime
    updated_at: datetime


class RoutePolicyRulesResponse(BaseModel):
    route_id: int
    stream_id: int
    rules: list[RoutePolicyRuleEntry] = Field(default_factory=list)
    rule_count: int = 0


class RoutePolicyRuleCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    enabled: bool = True
    condition_json: PolicyConditionJson
    action_type: PolicyActionType = "audit_only"


class RoutePolicyRulePatchRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    enabled: bool | None = None
    condition_json: PolicyConditionJson | None = None
    action_type: PolicyActionType | None = None


class RoutePolicyRuleResponse(BaseModel):
    rule: RoutePolicyRuleEntry


class RoutePolicyEffectiveResponse(BaseModel):
    route_id: int
    stream_id: int
    persisted_source: Literal["route", "stream"]
    fallback_used: bool
    rule_count: int
    processing_status: RoutePolicyProcessingStatus
    latest_rule_updated_at: datetime | None = None
