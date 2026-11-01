"""Persist the Route name and description the Route editor already collects (F-145).

Revision ID: 20261101_0069_route_name
Revises: 20261012_0068_gov_outbox
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261101_0069_route_name"
down_revision = "20261012_0068_gov_outbox"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("routes", sa.Column("name", sa.String(255), nullable=True))
    op.add_column("routes", sa.Column("description", sa.String(1024), nullable=True))


def downgrade() -> None:
    op.drop_column("routes", "description")
    op.drop_column("routes", "name")
