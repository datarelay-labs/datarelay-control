"""SQLAlchemy models for governance notifications (M20.2)."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, utcnow

NOTIFICATION_STATUS_PENDING = "PENDING"
NOTIFICATION_STATUS_SENT = "SENT"
NOTIFICATION_STATUS_FAILED = "FAILED"
NOTIFICATION_STATUSES = frozenset(
    {
        NOTIFICATION_STATUS_PENDING,
        NOTIFICATION_STATUS_SENT,
        NOTIFICATION_STATUS_FAILED,
    }
)

EVENT_CATEGORY_APPROVAL = "approval"
EVENT_CATEGORY_VIOLATION = "violation"
EVENT_CATEGORY_QUARANTINE = "quarantine"
EVENT_CATEGORY_REPLAY = "replay"
NOTIFICATION_EVENT_CATEGORIES = frozenset(
    {
        EVENT_CATEGORY_APPROVAL,
        EVENT_CATEGORY_VIOLATION,
        EVENT_CATEGORY_QUARANTINE,
        EVENT_CATEGORY_REPLAY,
    }
)

# Approval
EVENT_POLICY_SUBMITTED = "POLICY_SUBMITTED"
EVENT_POLICY_APPROVED = "POLICY_APPROVED"
EVENT_POLICY_REJECTED = "POLICY_REJECTED"
EVENT_POLICY_ACTIVATED = "POLICY_ACTIVATED"

# Violation
EVENT_VIOLATION_CREATED = "VIOLATION_CREATED"
EVENT_HIGH_SEVERITY_VIOLATION = "HIGH_SEVERITY_VIOLATION"

# Quarantine
EVENT_QUARANTINE_CREATED = "QUARANTINE_CREATED"
EVENT_QUARANTINE_RELEASED = "QUARANTINE_RELEASED"
EVENT_QUARANTINE_DISCARDED = "QUARANTINE_DISCARDED"

# Replay
EVENT_REPLAY_FAILED = "REPLAY_FAILED"
EVENT_REPLAY_COMPLETED = "REPLAY_COMPLETED"
EVENT_REPLAY_RETRIED = "REPLAY_RETRIED"

NOTIFICATION_EVENT_TYPES = frozenset(
    {
        EVENT_POLICY_SUBMITTED,
        EVENT_POLICY_APPROVED,
        EVENT_POLICY_REJECTED,
        EVENT_POLICY_ACTIVATED,
        EVENT_VIOLATION_CREATED,
        EVENT_HIGH_SEVERITY_VIOLATION,
        EVENT_QUARANTINE_CREATED,
        EVENT_QUARANTINE_RELEASED,
        EVENT_QUARANTINE_DISCARDED,
        EVENT_REPLAY_FAILED,
        EVENT_REPLAY_COMPLETED,
        EVENT_REPLAY_RETRIED,
    }
)

EVENT_TYPE_TO_CATEGORY: dict[str, str] = {
    EVENT_POLICY_SUBMITTED: EVENT_CATEGORY_APPROVAL,
    EVENT_POLICY_APPROVED: EVENT_CATEGORY_APPROVAL,
    EVENT_POLICY_REJECTED: EVENT_CATEGORY_APPROVAL,
    EVENT_POLICY_ACTIVATED: EVENT_CATEGORY_APPROVAL,
    EVENT_VIOLATION_CREATED: EVENT_CATEGORY_VIOLATION,
    EVENT_HIGH_SEVERITY_VIOLATION: EVENT_CATEGORY_VIOLATION,
    EVENT_QUARANTINE_CREATED: EVENT_CATEGORY_QUARANTINE,
    EVENT_QUARANTINE_RELEASED: EVENT_CATEGORY_QUARANTINE,
    EVENT_QUARANTINE_DISCARDED: EVENT_CATEGORY_QUARANTINE,
    EVENT_REPLAY_FAILED: EVENT_CATEGORY_REPLAY,
    EVENT_REPLAY_COMPLETED: EVENT_CATEGORY_REPLAY,
    EVENT_REPLAY_RETRIED: EVENT_CATEGORY_REPLAY,
}


class GovernanceNotificationConfig(Base):
    __tablename__ = "governance_notification_configs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    approval_events: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    violation_events: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    quarantine_events: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    replay_events: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    email_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    email_recipients_json: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    webhook_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    webhook_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class GovernanceNotificationEvent(Base):
    __tablename__ = "governance_notification_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    event_category: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    severity: Mapped[str] = mapped_column(String(16), nullable=False, default="INFO")
    payload_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=NOTIFICATION_STATUS_PENDING, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class GovernanceNotificationDeliveryJob(Base):
    """Durable per-channel outbox; no raw secrets or external payload snapshots."""

    __tablename__ = "governance_notification_delivery_jobs"
    __table_args__ = (
        UniqueConstraint("event_id", "channel", name="uq_gov_notification_job_event_channel"),
        CheckConstraint("channel IN ('email', 'webhook')", name="ck_gov_notification_job_channel"),
        CheckConstraint("status IN ('PENDING', 'LEASED', 'SENT', 'DEAD')", name="ck_gov_notification_job_status"),
        Index("ix_gov_notification_job_due", "status", "next_attempt_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_id: Mapped[int] = mapped_column(
        ForeignKey("governance_notification_events.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    channel: Mapped[str] = mapped_column(String(16), nullable=False)
    config_updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="PENDING")
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    lease_token: Mapped[str | None] = mapped_column(String(36), nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
