"""Reconcile legacy development catalogs with the active schema line.

Revision ID: 20261006_0065_legacy_bridge
Revises: 20260826_0070_registries
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261006_0065_legacy_bridge"
down_revision = "20260826_0070_registries"
branch_labels = None
depends_on = None

_ROUTE_DISPOSITION_COLUMNS = (
    ("batch_id", sa.String(length=128)),
    ("policy_action", sa.String(length=64)),
    ("decision_reason", sa.Text()),
    ("delivery_disposition", sa.String(length=64)),
    ("skip_reason", sa.String(length=128)),
    ("quarantine_event_id", sa.Integer()),
)


def upgrade() -> None:
    """Add active-line fields absent from the legacy 0070 catalog.

    Fresh catalogs already received these columns in ``20260930_0063``; the
    checks make this bridge a no-op there.  Legacy catalogs retain their
    historical marketplace/credential tables and receive only missing active
    schema fields.
    """

    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "delivery_logs" not in tables:
        raise RuntimeError("legacy schema bridge requires delivery_logs")
    if "marketplace_package_installs" not in tables:
        raise RuntimeError("legacy schema bridge requires marketplace_package_installs")

    existing = {column["name"] for column in inspector.get_columns("delivery_logs")}
    for name, column_type in _ROUTE_DISPOSITION_COLUMNS:
        if name not in existing:
            op.add_column("delivery_logs", sa.Column(name, column_type, nullable=True))


def downgrade() -> None:
    # Compatibility bridge only.  The fields belong to the active migration
    # line and must not be removed when crossing the legacy marker backwards.
    pass
