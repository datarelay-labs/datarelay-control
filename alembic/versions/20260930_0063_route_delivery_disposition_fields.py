"""Add structured route-delivery disposition fields to partitioned delivery logs.

Revision ID: 20260930_0063
Revises: 20260804_0062
"""
from alembic import op
import sqlalchemy as sa

revision = '20260930_0063'
down_revision = '20260804_0062'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('delivery_logs', sa.Column('batch_id', sa.String(length=128), nullable=True))
    op.add_column('delivery_logs', sa.Column('policy_action', sa.String(length=64), nullable=True))
    op.add_column('delivery_logs', sa.Column('decision_reason', sa.Text(), nullable=True))
    op.add_column('delivery_logs', sa.Column('delivery_disposition', sa.String(length=64), nullable=True))
    op.add_column('delivery_logs', sa.Column('skip_reason', sa.String(length=128), nullable=True))
    op.add_column('delivery_logs', sa.Column('quarantine_event_id', sa.Integer(), nullable=True))


def downgrade() -> None:
    for name in ('quarantine_event_id','skip_reason','delivery_disposition','decision_reason','policy_action','batch_id'):
        op.drop_column('delivery_logs', name)
