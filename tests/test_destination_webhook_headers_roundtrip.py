"""F-137: a browser round-trip of masked webhook headers must not delete the stored values."""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database import get_db
from app.destinations.models import Destination
from app.main import app

import pytest


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def _create_hook(db_session: Session) -> Destination:
    row = Destination(
        name="hook-with-headers",
        destination_type="WEBHOOK_POST",
        config_json={
            "url": "https://hook.example/ingest",
            "payload_mode": "SINGLE_EVENT_OBJECT",
            "headers": {"Authorization": "Bearer real-secret-token", "X-BFS-Dest": "ops-team"},
        },
        rate_limit_json={},
        enabled=True,
    )
    db_session.add(row)
    db_session.commit()
    db_session.refresh(row)
    return row


def test_masked_headers_round_trip_keeps_stored_values(client: TestClient, db_session: Session) -> None:
    row = _create_hook(db_session)
    read = client.get(f"/api/v1/destinations/{row.id}").json()
    assert read["config_json"]["headers"] == {"Authorization": "********", "X-BFS-Dest": "********"}

    res = client.put(
        f"/api/v1/destinations/{row.id}",
        json={
            "expected_updated_at": read["updated_at"],
            # Exactly what the browser form sends back after editing an unrelated field.
            "config_json": {
                "url": "https://hook.example/ingest",
                "payload_mode": "SINGLE_EVENT_OBJECT",
                "headers": read["config_json"]["headers"],
            },
        },
    )
    assert res.status_code == 200, res.text
    db_session.expire_all()
    stored = db_session.get(Destination, row.id).config_json
    assert stored["headers"] == {"Authorization": "Bearer real-secret-token", "X-BFS-Dest": "ops-team"}


def test_explicitly_removed_header_is_deleted_others_kept(client: TestClient, db_session: Session) -> None:
    row = _create_hook(db_session)
    read = client.get(f"/api/v1/destinations/{row.id}").json()

    res = client.put(
        f"/api/v1/destinations/{row.id}",
        json={
            "expected_updated_at": read["updated_at"],
            "config_json": {
                "url": "https://hook.example/ingest",
                "payload_mode": "SINGLE_EVENT_OBJECT",
                "headers": {"Authorization": "********"},
            },
        },
    )
    assert res.status_code == 200, res.text
    db_session.expire_all()
    stored = db_session.get(Destination, row.id).config_json
    assert stored["headers"] == {"Authorization": "Bearer real-secret-token"}
