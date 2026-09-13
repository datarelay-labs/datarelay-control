"""ORM bootstrap for non-FastAPI entrypoints (standalone retention scheduler)."""

from __future__ import annotations

from sqlalchemy.orm import configure_mappers

from app.db.orm_bootstrap import ensure_orm_models_registered


def test_ensure_orm_models_registered_configures_stream_connector_graph() -> None:
    ensure_orm_models_registered()
    configure_mappers()

    from app.backfill.models import BackfillJob
    from app.connectors.models import Connector
    from app.streams.models import Stream

    assert Connector.__tablename__ == "connectors"
    assert Stream.__tablename__ == "streams"
    assert BackfillJob.__tablename__ == "backfill_jobs"
    assert "connector" in Stream.__mapper__.relationships
    assert "stream" in BackfillJob.__mapper__.relationships


def test_retention_scheduler_start_registers_orm_models() -> None:
    from app.retention.scheduler import OperationalRetentionScheduler

    sched = OperationalRetentionScheduler(tick_seconds=3600.0)
    sched.start()
    try:
        configure_mappers()
        from app.connectors.models import Connector
        from app.streams.models import Stream

        assert Connector.__mapper__ is not None
        assert Stream.__mapper__ is not None
    finally:
        sched.stop()
