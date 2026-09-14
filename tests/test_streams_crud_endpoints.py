from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from tests.config_mutation_test_helpers import put_stream
from sqlalchemy.orm import Session

from app.connectors.models import Connector
from app.database import get_db
from app.main import app
from app.sources.models import Source
from app.streams.models import Stream


def _seed_connector_source(db: Session) -> tuple[Connector, Source]:
    connector = Connector(name="streams-crud-connector", description=None, status="RUNNING")
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
    db.commit()
    db.refresh(connector)
    db.refresh(source)
    return connector, source


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def test_stream_create_list_get_update(client: TestClient, db_session: Session) -> None:
    connector, source = _seed_connector_source(db_session)
    create_payload = {
        "name": "streams-crud-stream",
        "connector_id": connector.id,
        "source_id": source.id,
        "polling_interval": 30,
        "enabled": True,
        "status": "STOPPED",
        "stream_type": "HTTP_API_POLLING",
        "config_json": {"endpoint": "/events"},
        "rate_limit_json": {"max_requests": 60, "per_seconds": 60},
    }
    create_res = client.post("/api/v1/streams/", json=create_payload)
    assert create_res.status_code == 201
    created = create_res.json()
    stream_id = int(created["id"])
    assert created["connector_id"] == connector.id
    assert created["source_id"] == source.id
    assert created["name"] == "streams-crud-stream"

    list_res = client.get("/api/v1/streams/")
    assert list_res.status_code == 200
    assert any(int(row["id"]) == stream_id for row in list_res.json())

    get_res = client.get(f"/api/v1/streams/{stream_id}")
    assert get_res.status_code == 200
    assert get_res.json()["id"] == stream_id

    update_res = put_stream(
        client,
        stream_id,
        {"name": "streams-crud-stream-updated", "polling_interval": 45, "enabled": False},
    )
    assert update_res.status_code == 200
    body = update_res.json()
    assert body["name"] == "streams-crud-stream-updated"
    assert body["enabled"] is False

    row = db_session.query(Stream).filter(Stream.id == stream_id).one()
    assert row.name == "streams-crud-stream-updated"
    assert int(row.polling_interval) == 45
    assert bool(row.enabled) is False


def test_stream_update_preserves_http_config_when_merging_schema_drift_policy(
    client: TestClient,
    db_session: Session,
) -> None:
    """Wizard deploy must merge governance into config_json without wiping HTTP fields."""

    connector, source = _seed_connector_source(db_session)
    http_config = {
        "endpoint": "/rest/visualsearch/query/simple",
        "method": "POST",
        "body": {"queryPath": []},
        "headers": {"Accept": "application/json"},
        "timeout_seconds": 60,
    }
    create_res = client.post(
        "/api/v1/streams/",
        json={
            "name": "wizard-http-stream",
            "connector_id": connector.id,
            "source_id": source.id,
            "polling_interval": 300,
            "enabled": True,
            "status": "STOPPED",
            "stream_type": "HTTP_API_POLLING",
            "config_json": http_config,
            "rate_limit_json": {},
        },
    )
    assert create_res.status_code == 201
    stream_id = int(create_res.json()["id"])

    merged_config = {
        **http_config,
        "governance": {
            "schema_drift_policy": {
                "unknown_normal_field_policy": "pass_through",
                "unknown_sensitive_field_policy": "auto_protect",
            },
        },
        "union_schema": {
            "total_events": 2,
            "fields": [{"path": "$.id", "types": ["string"]}],
            "snapshot_at": "2026-06-22T00:00:00Z",
        },
    }
    update_res = put_stream(
        client,
        stream_id,
        {"config_json": merged_config},
    )
    assert update_res.status_code == 200
    body = update_res.json()
    assert body["config_json"]["endpoint"] == http_config["endpoint"]
    assert body["config_json"]["method"] == "POST"
    assert body["config_json"]["body"] == http_config["body"]
    assert body["config_json"]["headers"] == http_config["headers"]
    assert body["config_json"]["governance"]["schema_drift_policy"]["unknown_normal_field_policy"] == "pass_through"
    assert body["config_json"]["union_schema"]["total_events"] == 2

    row = db_session.query(Stream).filter(Stream.id == stream_id).one()
    assert row.config_json["endpoint"] == http_config["endpoint"]
    assert "governance" in row.config_json
    assert "union_schema" in row.config_json

