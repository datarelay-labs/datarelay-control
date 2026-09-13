from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.connectors.models import Connector
from app.database import get_db
from app.destinations.models import Destination
from app.main import app
from app.routes.models import Route
from app.sources.models import Source
from app.streams.models import Stream


def _seed_stream_destination(db: Session) -> tuple[Stream, Destination]:
    connector = Connector(name="routes-crud-connector", description=None, status="RUNNING")
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
        name="routes-crud-stream",
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=60,
        enabled=True,
        status="STOPPED",
    )
    destination = Destination(
        name="routes-crud-destination",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://receiver.example.com/routes-crud"},
        rate_limit_json={},
        enabled=True,
    )
    db.add(stream)
    db.add(destination)
    db.commit()
    db.refresh(stream)
    db.refresh(destination)
    return stream, destination


def _route_token(client: TestClient, route_id: int) -> str:
    get_res = client.get(f"/api/v1/routes/{route_id}")
    assert get_res.status_code == 200
    token = get_res.json().get("updated_at")
    assert isinstance(token, str) and token
    return token


def _put_route(client: TestClient, route_id: int, payload: dict[str, Any], *, token: str | None = None):
    body = dict(payload)
    body["expected_updated_at"] = token if token is not None else _route_token(client, route_id)
    return client.put(f"/api/v1/routes/{route_id}", json=body)


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def test_route_create_list_get_update_and_persist_fields(client: TestClient, db_session: Session) -> None:
    stream, destination = _seed_stream_destination(db_session)
    create_payload = {
        "stream_id": stream.id,
        "destination_id": destination.id,
        "enabled": True,
        "failure_policy": "RETRY_AND_BACKOFF",
        "formatter_config_json": {"message_format": "json"},
        "rate_limit_json": {"max_events": 100, "per_seconds": 1},
        "status": "ENABLED",
    }
    create_res = client.post("/api/v1/routes/", json=create_payload)
    assert create_res.status_code == 201
    created = create_res.json()
    route_id = int(created["id"])
    assert created["stream_id"] == stream.id
    assert created["destination_id"] == destination.id
    assert created["enabled"] is True
    assert created["failure_policy"] == "RETRY_AND_BACKOFF"
    assert isinstance(created.get("updated_at"), str) and created["updated_at"]

    list_res = client.get("/api/v1/routes/")
    assert list_res.status_code == 200
    assert any(int(row["id"]) == route_id for row in list_res.json())

    get_res = client.get(f"/api/v1/routes/{route_id}")
    assert get_res.status_code == 200
    assert get_res.json()["id"] == route_id

    update_res = _put_route(
        client,
        route_id,
        {"enabled": False, "failure_policy": "DISABLE_ROUTE_ON_FAILURE"},
    )
    assert update_res.status_code == 200
    body = update_res.json()
    assert body["enabled"] is False
    assert body["failure_policy"] == "DISABLE_ROUTE_ON_FAILURE"

    row = db_session.query(Route).filter(Route.id == route_id).one()
    assert int(row.stream_id) == stream.id
    assert int(row.destination_id) == destination.id
    assert bool(row.enabled) is False
    assert str(row.failure_policy) == "DISABLE_ROUTE_ON_FAILURE"


def test_route_stale_write_rejected_side_effect_free(client: TestClient, db_session: Session) -> None:
    stream, destination = _seed_stream_destination(db_session)
    create_res = client.post(
        "/api/v1/routes/",
        json={
            "stream_id": stream.id,
            "destination_id": destination.id,
            "enabled": True,
            "failure_policy": "LOG_AND_CONTINUE",
            "status": "ENABLED",
        },
    )
    assert create_res.status_code == 201
    route_id = int(create_res.json()["id"])
    baseline_token = create_res.json()["updated_at"]

    # Client B wins with the current token.
    winner = _put_route(
        client,
        route_id,
        {"failure_policy": "RETRY_AND_BACKOFF"},
        token=baseline_token,
    )
    assert winner.status_code == 200
    assert winner.json()["failure_policy"] == "RETRY_AND_BACKOFF"
    winner_token = winner.json()["updated_at"]
    assert winner_token != baseline_token

    # Client A retries with the stale baseline token — must 409 with zero mutation.
    stale = _put_route(
        client,
        route_id,
        {"failure_policy": "DISABLE_ROUTE_ON_FAILURE", "enabled": False},
        token=baseline_token,
    )
    assert stale.status_code == 409
    detail = stale.json()["detail"]
    assert detail["error_code"] == "ROUTE_STALE_WRITE"
    assert detail["expected_updated_at"]
    assert detail["current_updated_at"]

    row = db_session.query(Route).filter(Route.id == route_id).one()
    assert str(row.failure_policy) == "RETRY_AND_BACKOFF"
    assert bool(row.enabled) is True
    fresh = client.get(f"/api/v1/routes/{route_id}")
    assert fresh.status_code == 200
    assert fresh.json()["updated_at"] == winner_token
    assert fresh.json()["failure_policy"] == "RETRY_AND_BACKOFF"
    assert fresh.json()["enabled"] is True


def test_route_concurrent_writers_second_stale_token_conflicts(client: TestClient, db_session: Session) -> None:
    stream, destination = _seed_stream_destination(db_session)
    create_res = client.post(
        "/api/v1/routes/",
        json={
            "stream_id": stream.id,
            "destination_id": destination.id,
            "enabled": True,
            "failure_policy": "LOG_AND_CONTINUE",
            "status": "ENABLED",
        },
    )
    assert create_res.status_code == 201
    route_id = int(create_res.json()["id"])
    shared_token = create_res.json()["updated_at"]

    first = _put_route(client, route_id, {"failure_policy": "PAUSE_STREAM_ON_FAILURE"}, token=shared_token)
    assert first.status_code == 200
    assert first.json()["failure_policy"] == "PAUSE_STREAM_ON_FAILURE"

    second = _put_route(client, route_id, {"failure_policy": "DISABLE_ROUTE_ON_FAILURE"}, token=shared_token)
    assert second.status_code == 409
    assert second.json()["detail"]["error_code"] == "ROUTE_STALE_WRITE"

    # Reload current token then save succeeds.
    reload_ok = _put_route(client, route_id, {"failure_policy": "RETRY_AND_BACKOFF"})
    assert reload_ok.status_code == 200
    assert reload_ok.json()["failure_policy"] == "RETRY_AND_BACKOFF"


def test_route_update_requires_expected_updated_at(client: TestClient, db_session: Session) -> None:
    stream, destination = _seed_stream_destination(db_session)
    create_res = client.post(
        "/api/v1/routes/",
        json={
            "stream_id": stream.id,
            "destination_id": destination.id,
            "enabled": True,
            "failure_policy": "LOG_AND_CONTINUE",
            "status": "ENABLED",
        },
    )
    assert create_res.status_code == 201
    route_id = int(create_res.json()["id"])
    missing = client.put(f"/api/v1/routes/{route_id}", json={"enabled": False})
    assert missing.status_code == 422


def test_route_delete_conflict_when_enabled(client: TestClient, db_session: Session) -> None:
    stream, destination = _seed_stream_destination(db_session)
    create_res = client.post(
        "/api/v1/routes/",
        json={
            "stream_id": stream.id,
            "destination_id": destination.id,
            "enabled": True,
            "failure_policy": "LOG_AND_CONTINUE",
            "status": "ENABLED",
        },
    )
    assert create_res.status_code == 201
    route_id = int(create_res.json()["id"])

    del_res = client.delete(f"/api/v1/routes/{route_id}")
    assert del_res.status_code == 409
    assert db_session.query(Route).filter(Route.id == route_id).first() is not None


def test_route_delete_ok_when_disabled(client: TestClient, db_session: Session) -> None:
    stream, destination = _seed_stream_destination(db_session)
    create_res = client.post(
        "/api/v1/routes/",
        json={
            "stream_id": stream.id,
            "destination_id": destination.id,
            "enabled": False,
            "failure_policy": "LOG_AND_CONTINUE",
            "status": "DISABLED",
        },
    )
    assert create_res.status_code == 201
    route_id = int(create_res.json()["id"])

    del_res = client.delete(f"/api/v1/routes/{route_id}")
    assert del_res.status_code == 204
    assert db_session.query(Route).filter(Route.id == route_id).first() is None
