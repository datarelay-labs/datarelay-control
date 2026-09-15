"""Create ≠ Start: scheduler must not deliver until explicit Start."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database import get_db
from app.main import app
from app.streams.repository import get_enabled_stream_ids
from app.streams.runtime_eligibility import is_stream_scheduler_runnable
from tests.test_stream_runner_e2e import _seed_stream_runtime


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override_db() -> Any:
        try:
            yield db_session
        finally:
            pass

    app.dependency_overrides[get_db] = _override_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def test_create_defaults_to_disabled_stopped(client: TestClient, db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    from app.streams.models import Stream

    seeded = db_session.query(Stream).filter(Stream.id == int(fixture["stream_id"])).one()
    connector_id = int(seeded.connector_id)
    source_id = int(seeded.source_id)
    res = client.post(
        "/api/v1/streams/",
        json={
            "name": "create-only-no-start",
            "connector_id": connector_id,
            "source_id": source_id,
            "stream_type": "HTTP_API_POLLING",
            "config_json": {},
            "polling_interval": 60,
        },
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["enabled"] is False
    assert body["status"] == "STOPPED"
    assert int(body["id"]) not in get_enabled_stream_ids(db_session)


def test_create_and_start_is_scheduler_runnable(client: TestClient, db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    from app.streams.models import Stream

    seeded = db_session.query(Stream).filter(Stream.id == int(fixture["stream_id"])).one()
    connector_id = int(seeded.connector_id)
    source_id = int(seeded.source_id)
    created = client.post(
        "/api/v1/streams/",
        json={
            "name": "create-then-start",
            "connector_id": connector_id,
            "source_id": source_id,
            "stream_type": "HTTP_API_POLLING",
            "config_json": {},
            "polling_interval": 60,
        },
    )
    assert created.status_code == 201, created.text
    stream_id = int(created.json()["id"])
    started = client.post(f"/api/v1/streams/{stream_id}/start")
    assert started.status_code == 200, started.text
    assert started.json()["enabled"] is True
    assert started.json()["status"] == "RUNNING"
    assert stream_id in get_enabled_stream_ids(db_session)


def test_enabled_true_stopped_is_not_scheduler_runnable(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    from app.streams.models import Stream

    stream = db_session.query(Stream).filter(Stream.id == int(fixture["stream_id"])).one()
    stream.enabled = True
    stream.status = "STOPPED"
    db_session.commit()
    assert is_stream_scheduler_runnable(enabled=True, status="STOPPED") is False
    assert int(stream.id) not in get_enabled_stream_ids(db_session)


def test_running_but_disabled_is_not_scheduler_runnable(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    from app.streams.models import Stream

    stream = db_session.query(Stream).filter(Stream.id == int(fixture["stream_id"])).one()
    stream.enabled = False
    stream.status = "RUNNING"
    db_session.commit()
    assert is_stream_scheduler_runnable(enabled=False, status="RUNNING") is False
    assert int(stream.id) not in get_enabled_stream_ids(db_session)


def test_explicit_start_makes_stream_runnable(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    from app.streams.models import Stream

    stream = db_session.query(Stream).filter(Stream.id == int(fixture["stream_id"])).one()
    stream.enabled = True
    stream.status = "RUNNING"
    db_session.commit()
    assert is_stream_scheduler_runnable(enabled=True, status="RUNNING") is True
    assert int(stream.id) in get_enabled_stream_ids(db_session)
