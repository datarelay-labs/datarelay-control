"""Durable channel-specific Governance notification delivery jobs.

Revision ID: 20261012_0068_gov_outbox
Revises: 20261009_0067_mfa_lockout
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261012_0068_gov_outbox"
down_revision = "20261009_0067_mfa_lockout"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "governance_notification_delivery_jobs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "event_id", sa.Integer(),
            sa.ForeignKey("governance_notification_events.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("channel", sa.String(16), nullable=False),
        sa.Column("config_updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="PENDING"),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lease_token", sa.String(36), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error_type", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "channel IN ('email', 'webhook')", name="ck_gov_notification_job_channel"
        ),
        sa.CheckConstraint(
            "status IN ('PENDING', 'LEASED', 'SENT', 'DEAD')",
            name="ck_gov_notification_job_status",
        ),
        sa.UniqueConstraint(
            "event_id", "channel", name="uq_gov_notification_job_event_channel"
        ),
    )
    op.create_index(
        "ix_governance_notification_delivery_jobs_event_id",
        "governance_notification_delivery_jobs", ["event_id"],
    )
    op.create_index(
        "ix_gov_notification_job_due",
        "governance_notification_delivery_jobs", ["status", "next_attempt_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_gov_notification_job_due", table_name="governance_notification_delivery_jobs")
    op.drop_index("ix_governance_notification_delivery_jobs_event_id", table_name="governance_notification_delivery_jobs")
    op.drop_table("governance_notification_delivery_jobs")
