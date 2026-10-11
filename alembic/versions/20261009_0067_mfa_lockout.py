"""Database-backed MFA factor attempt window across API workers.

Revision ID: 20261009_0067_mfa_lockout
Revises: 20261009_0066_platform_mfa
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261009_0067_mfa_lockout"
down_revision = "20261009_0066_platform_mfa"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "platform_user_mfa",
        sa.Column("failed_attempts", sa.Integer(), nullable=False, server_default=sa.text("0")),
    )
    op.add_column(
        "platform_user_mfa",
        sa.Column("failure_window_started_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "platform_user_mfa",
        sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("platform_user_mfa", "locked_until")
    op.drop_column("platform_user_mfa", "failure_window_started_at")
    op.drop_column("platform_user_mfa", "failed_attempts")
