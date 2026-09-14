"""Destination GET/List must not return raw secret-bearing config_json."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database import get_db
from app.destinations.models import Destination
from app.main import app


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def test_destination_get_and_list_mask_webhook_secrets(client: TestClient, db_session: Session) -> None:
    row = Destination(
        name="mask-dest",
        destination_type="WEBHOOK_POST",
        config_json={
            "url": "https://hooks.example/in",
            "api_key": "dest-get-api-key-secret",
            "headers": {
                "Authorization": "Bearer dest-get-auth-secret",
                "X-Api-Key": "dest-get-x-api-key",
                "Accept": "application/json",
            },
        },
        rate_limit_json={},
        enabled=True,
    )
    db_session.add(row)
    db_session.commit()
    db_session.refresh(row)

    listed = client.get("/api/v1/destinations/")
    assert listed.status_code == 200
    assert "dest-get-api-key-secret" not in listed.text
    assert "dest-get-auth-secret" not in listed.text
    assert "dest-get-x-api-key" not in listed.text
    item = next(x for x in listed.json() if x["id"] == row.id)
    assert item["config_json"]["api_key"] == "********"
    assert item["config_json"]["headers"]["Authorization"] == "********"
    assert item["config_json"]["headers"]["X-Api-Key"] == "********"
    assert item["config_json"]["headers"]["Accept"] == "********"
    assert item["config_json"]["url"] == "https://hooks.example/in"

    got = client.get(f"/api/v1/destinations/{row.id}")
    assert got.status_code == 200
    assert "dest-get-api-key-secret" not in got.text
    assert got.json()["config_json"]["api_key"] == "********"

    # Round-trip update with masked headers must preserve stored secrets.
    upd = client.put(
        f"/api/v1/destinations/{row.id}",
        json={
            "name": "mask-dest",
            "destination_type": "WEBHOOK_POST",
            "enabled": True,
            "config_json": got.json()["config_json"],
            "rate_limit_json": {},
            "expected_updated_at": got.json()["updated_at"],
        },
    )
    assert upd.status_code == 200, upd.text
    db_session.refresh(row)
    assert row.config_json["api_key"] == "dest-get-api-key-secret"
    assert row.config_json["headers"]["Authorization"] == "Bearer dest-get-auth-secret"
