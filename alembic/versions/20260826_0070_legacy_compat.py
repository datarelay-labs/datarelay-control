"""Recognize the legacy DataRelay development schema head.

Revision ID: 20260826_0070_registries
Revises: 20261001_0064

The long-lived development database was created on the pre-rebase migration
line whose terminal revision is ``20260826_0070_registries``.  The active
main-v2 history later condensed that line into ``20261001_0064``.  Keep this
marker so Alembic can upgrade existing development databases without stamping
or discarding their data.  Schema reconciliation happens in the following
bridge revision.
"""

revision = "20260826_0070_registries"
down_revision = "20261001_0064"
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
