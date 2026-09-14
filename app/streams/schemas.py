"""Pydantic schemas for Stream API."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schema_drift_policy.schemas import validate_schema_drift_policy_payload


class StreamBase(BaseModel):
    name: str | None = None
    connector_id: int | None = None
    source_id: int | None = None
    stream_type: str | None = None
    source_type: str | None = None
    config_json: dict | None = None
    polling_interval: int | None = None
    enabled: bool | None = None
    status: str | None = Field(default=None, description="StreamStatus value when populated")
    rate_limit_json: dict | None = None

    @model_validator(mode="after")
    def _validate_schema_drift_policy(self) -> "StreamBase":
        if self.config_json is None:
            return self
        governance = self.config_json.get("governance")
        if not isinstance(governance, dict):
            return self
        raw_policy = governance.get("schema_drift_policy")
        if raw_policy is None:
            return self
        if not isinstance(raw_policy, dict):
            raise ValueError("schema_drift_policy must be an object")
        validate_schema_drift_policy_payload(raw_policy)
        return self


class StreamCreate(StreamBase):
    name: str
    connector_id: int
    source_id: int


class StreamUpdate(BaseModel):
    """Partial stream configuration update.

    ``source_type`` is read-only (derived from the linked Source).
    Runtime ``status`` is controlled only via ``/start`` and ``/stop``.
    ``expected_updated_at`` is the optimistic-concurrency token.
    """

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    connector_id: int | None = None
    source_id: int | None = None
    stream_type: str | None = None
    config_json: dict | None = None
    polling_interval: int | None = None
    enabled: bool | None = None
    rate_limit_json: dict | None = None
    expected_updated_at: datetime

    @model_validator(mode="after")
    def _validate_schema_drift_policy(self) -> "StreamUpdate":
        if self.config_json is None:
            return self
        governance = self.config_json.get("governance")
        if not isinstance(governance, dict):
            return self
        raw_policy = governance.get("schema_drift_policy")
        if raw_policy is None:
            return self
        if not isinstance(raw_policy, dict):
            raise ValueError("schema_drift_policy must be an object")
        validate_schema_drift_policy_payload(raw_policy)
        return self


class StreamRead(StreamBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    status: str | None = Field(default=None, description="StreamStatus value when populated")
    created_at: datetime | None = None
    updated_at: datetime | None = None
