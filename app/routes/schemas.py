"""Pydantic schemas for Route API."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, field_validator

RouteFailurePolicy = Literal[
    "LOG_AND_CONTINUE",
    "PAUSE_STREAM_ON_FAILURE",
    "RETRY_AND_BACKOFF",
    "DISABLE_ROUTE_ON_FAILURE",
]

_ROUTE_FAILURE_POLICIES = frozenset(
    {
        "LOG_AND_CONTINUE",
        "PAUSE_STREAM_ON_FAILURE",
        "RETRY_AND_BACKOFF",
        "DISABLE_ROUTE_ON_FAILURE",
    }
)


class RouteBase(BaseModel):
    stream_id: int | None = None
    destination_id: int | None = None
    enabled: bool | None = None
    disable_reason: str | None = None
    failure_policy: RouteFailurePolicy | None = None
    formatter_config_json: dict | None = None
    rate_limit_json: dict | None = None
    status: str | None = None

    @field_validator("failure_policy", mode="before")
    @classmethod
    def _normalize_failure_policy(cls, value: object) -> object:
        if value is None:
            return value
        normalized = str(value).strip().upper()
        if normalized not in _ROUTE_FAILURE_POLICIES:
            raise ValueError(
                "failure_policy must be one of: "
                + ", ".join(sorted(_ROUTE_FAILURE_POLICIES))
            )
        return normalized


class RouteCreate(RouteBase):
    stream_id: int
    destination_id: int


class RouteUpdate(RouteBase):
    """Partial route update. ``expected_updated_at`` is the optimistic-concurrency token."""

    expected_updated_at: datetime


class RouteRead(RouteBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime | None = None
    updated_at: datetime | None = None
