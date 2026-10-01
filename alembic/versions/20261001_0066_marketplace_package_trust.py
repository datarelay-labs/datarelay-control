"""Marketplace package trust and signing keys (M29.5a).

Revision ID: 20261001_0066
Revises: 20261001_0065
Create Date: 2026-10-01
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261001_0066"
down_revision = "20261001_0065"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "marketplace_trusted_signing_keys",
        sa.Column("key_id", sa.String(length=128), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("public_key", sa.Text(), nullable=False),
        sa.Column("publisher", sa.String(length=255), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("key_id"),
    )
    op.create_index(
        op.f("ix_marketplace_trusted_signing_keys_enabled"),
        "marketplace_trusted_signing_keys",
        ["enabled"],
        unique=False,
    )
    op.add_column(
        "marketplace_package_installs",
        sa.Column("signature_status", sa.String(length=64), nullable=False, server_default="UNSIGNED"),
    )
    op.add_column(
        "marketplace_package_installs",
        sa.Column("signing_key_id", sa.String(length=128), nullable=True),
    )
    op.add_column(
        "marketplace_package_installs",
        sa.Column("previous_signature_status", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "marketplace_package_installs",
        sa.Column("previous_signing_key_id", sa.String(length=128), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("marketplace_package_installs", "previous_signing_key_id")
    op.drop_column("marketplace_package_installs", "previous_signature_status")
    op.drop_column("marketplace_package_installs", "signing_key_id")
    op.drop_column("marketplace_package_installs", "signature_status")
    op.drop_index(
        op.f("ix_marketplace_trusted_signing_keys_enabled"),
        table_name="marketplace_trusted_signing_keys",
    )
    op.drop_table("marketplace_trusted_signing_keys")
