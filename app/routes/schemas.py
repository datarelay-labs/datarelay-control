"""Pydantic schemas for Route API."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class RouteBase(BaseModel):
    stream_id: int | None = None
    destination_id: int | None = None
    enabled: bool | None = None
    disable_reason: str | None = None
    failure_policy: str | None = None
    formatter_config_json: dict | None = None
    rate_limit_json: dict | None = None
    status: str | None = None


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
