"""Pydantic schemas for governance notifications API (M20.2)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

NotificationChannel = Literal["email", "webhook"]
NotificationEventStatus = Literal["PENDING", "SENT", "FAILED"]


class GovernanceNotificationConfigResponse(BaseModel):
    approval_events: bool = True
    violation_events: bool = True
    quarantine_events: bool = True
    replay_events: bool = True
    email_enabled: bool = False
    email_recipients: list[str] = Field(default_factory=list)
    webhook_enabled: bool = False
    webhook_url: str | None = None
    updated_at: datetime | None = None


class GovernanceNotificationConfigUpdateRequest(BaseModel):
    approval_events: bool | None = None
    violation_events: bool | None = None
    quarantine_events: bool | None = None
    replay_events: bool | None = None
    email_enabled: bool | None = None
    email_recipients: list[str] | None = None
    webhook_enabled: bool | None = None
    webhook_url: str | None = None


class GovernanceNotificationTestRequest(BaseModel):
    channel: NotificationChannel


class GovernanceNotificationTestResponse(BaseModel):
    channel: NotificationChannel
    success: bool
    message: str


class GovernanceNotificationEventEntry(BaseModel):
    id: int
    event_type: str
    event_category: str
    severity: str
    status: NotificationEventStatus
    payload: dict | None = None
    created_at: datetime
    sent_at: datetime | None = None


class GovernanceNotificationEventsResponse(BaseModel):
    total: int = 0
    events: list[GovernanceNotificationEventEntry] = Field(default_factory=list)


class GovernanceNotificationHealthResponse(BaseModel):
    pending_notifications: int = 0
    failed_notifications: int = 0
    last_delivery_time: datetime | None = None
    pending_delivery_jobs: int = 0
    leased_delivery_jobs: int = 0
    retry_scheduled_delivery_jobs: int = 0
    dead_letter_delivery_jobs: int = 0
