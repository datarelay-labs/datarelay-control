"""API schemas for per-route classification operator endpoints."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.classification.schemas import ClassificationLevel, ClassificationRuleConditionJson

RouteClassificationProcessingStatus = Literal["Inherited", "Overridden", "Mixed"]


class RouteClassificationRuleEntry(BaseModel):
    id: int
    route_id: int
    stream_id: int
    name: str
    enabled: bool
    condition_json: dict[str, Any]
    classification_level: str
    created_at: datetime
    updated_at: datetime


class RouteClassificationRulesResponse(BaseModel):
    route_id: int
    stream_id: int
    rules: list[RouteClassificationRuleEntry] = Field(default_factory=list)
    rule_count: int = 0


class RouteClassificationRuleCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    enabled: bool = True
    condition_json: ClassificationRuleConditionJson
    classification_level: ClassificationLevel


class RouteClassificationRulePatchRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    enabled: bool | None = None
    condition_json: ClassificationRuleConditionJson | None = None
    classification_level: ClassificationLevel | None = None


class RouteClassificationRulesReplaceRequest(BaseModel):
    """Complete desired classification rule set for one route."""

    rules: list[RouteClassificationRuleCreateRequest]


class RouteClassificationRuleResponse(BaseModel):
    rule: RouteClassificationRuleEntry


class RouteClassificationEffectiveResponse(BaseModel):
    route_id: int
    stream_id: int
    persisted_source: Literal["route", "stream"]
    fallback_used: bool
    rule_count: int
    processing_status: RouteClassificationProcessingStatus
    message: str
