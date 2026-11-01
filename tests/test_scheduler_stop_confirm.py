"""DB-backed regression tests for Scheduler._confirm_stopped_if_disabled.

The confirm step writes ``status = "STOPPED"``; it must run in a writable session
(``run_with_db(..., commit=True)``). A read-only session rejects the UPDATE and the
failure is swallowed, leaving the stream stuck in STOPPING.
"""

from __future__ import annotations

import logging
import uuid

import pytest
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.connectors.models import Connector
from app.scheduler.scheduler import Scheduler
from app.sources.models import Source
from app.streams.models import Stream


def _seed_stream(db: Session, *, enabled: bool, status: str) -> int:
    suffix = uuid.uuid4().hex[:10]
    connector = Connector(name=f"pytest-stopconfirm-{suffix}", description="", status="RUNNING")
    db.add(connector)
    db.flush()
    source = Source(
        connector_id=connector.id,
        source_type="HTTP_API_POLLING",
        config_json={},
        auth_json={},
        enabled=True,
    )
    db.add(source)
    db.flush()
    stream = Stream(
        connector_id=connector.id,
        source_id=source.id,
        name=f"pytest-stopconfirm-stream-{suffix}",
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=60,
        enabled=enabled,
        status=status,
        rate_limit_json={},
    )
    db.add(stream)
    db.commit()
    return int(stream.id)


def _read_status(db_engine: Engine, stream_id: int) -> str:
    fresh = sessionmaker(bind=db_engine, autocommit=False, autoflush=False)()
    try:
        row = fresh.get(Stream, stream_id)
        assert row is not None
        return str(row.status)
    finally:
        fresh.close()


def test_disabled_stopping_stream_is_confirmed_stopped(
    db_session: Session, db_engine: Engine, caplog: pytest.LogCaptureFixture
) -> None:
    stream_id = _seed_stream(db_session, enabled=False, status="STOPPING")

    with caplog.at_level(logging.INFO):
        Scheduler._confirm_stopped_if_disabled(stream_id)

    assert "scheduler_stream_stop_confirm_failed" not in caplog.text
    assert _read_status(db_engine, stream_id) == "STOPPED"
    db_session.expire_all()
    assert db_session.get(Stream, stream_id).status == "STOPPED"


def test_enabled_running_stream_is_left_unchanged(db_session: Session, db_engine: Engine) -> None:
    stream_id = _seed_stream(db_session, enabled=True, status="RUNNING")

    Scheduler._confirm_stopped_if_disabled(stream_id)

    assert _read_status(db_engine, stream_id) == "RUNNING"
