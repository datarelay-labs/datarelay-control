"""Optional platform user TOTP MFA and single-use login challenges.

Revision ID: 20261009_0066_platform_mfa
Revises: 20261006_0065_legacy_bridge
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB
from alembic import op

revision = "20261009_0066_platform_mfa"
down_revision = "20261006_0065_legacy_bridge"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "platform_user_mfa",
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("platform_users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("required", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("secret_ciphertext", sa.Text(), nullable=True),
        sa.Column("pending_secret_ciphertext", sa.Text(), nullable=True),
        sa.Column("pending_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_counter", sa.BigInteger(), nullable=False, server_default=sa.text("-1")),
        sa.Column("recovery_hashes_json", JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_table(
        "platform_mfa_challenges",
        sa.Column("token_hash", sa.String(length=64), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("platform_users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("token_version", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(length=32), nullable=False),
        sa.Column("source_hash", sa.String(length=64), nullable=False),
        sa.Column("user_agent_hash", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_platform_mfa_challenges_user_id", "platform_mfa_challenges", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_platform_mfa_challenges_user_id", table_name="platform_mfa_challenges")
    op.drop_table("platform_mfa_challenges")
    op.drop_table("platform_user_mfa")
