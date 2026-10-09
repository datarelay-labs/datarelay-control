"""Add opt-in Grant-protected replay effect reservation ledger (not yet wired).

Revision ID: 20261009_0071_grant_replay
Revises: 20261006_0065_legacy_bridge

Schema only. This does not change the existing replay route or send data.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261009_0071_grant_replay"
down_revision = "20261006_0065_legacy_bridge"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "grant_protected_replay_ledger",
        sa.Column("operation_key", sa.String(length=128), primary_key=True),
        sa.Column("grant_request_id", sa.String(length=36), nullable=False),
        sa.Column("execution_id", sa.String(length=128), nullable=False),
        sa.Column("action_hash", sa.String(length=64), nullable=False),
        sa.Column("delivery_log_id", sa.Integer(), nullable=False),
        sa.Column("route_id", sa.Integer(), nullable=False),
        sa.Column("destination_id", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(length=16), nullable=False),
        sa.Column("effect_attempts", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.UniqueConstraint("execution_id", name="uq_grant_replay_execution"),
        sa.CheckConstraint("delivery_log_id > 0", name="ck_grant_replay_log_positive"),
        sa.CheckConstraint("route_id > 0", name="ck_grant_replay_route_positive"),
        sa.CheckConstraint("destination_id > 0", name="ck_grant_replay_destination_positive"),
        sa.CheckConstraint("effect_attempts IN (0,1)", name="ck_grant_replay_attempt_bound"),
        sa.CheckConstraint(
            "state IN ('RESERVED','UNKNOWN','DELIVERED')",
            name="ck_grant_replay_state",
        ),
    )


def downgrade() -> None:
    op.drop_table("grant_protected_replay_ledger")
