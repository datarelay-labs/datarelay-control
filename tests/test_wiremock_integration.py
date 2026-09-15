"""End-to-end HTTP source + vendor JWT + delivery against WireMock (opt-in; see module docstring)."""

from __future__ import annotations

import json
import os
import socket
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.database import get_db
from app.logs.models import DeliveryLog
from app.main import app

# Isolated test DB: set TEST_DATABASE_URL (see tests/conftest.py). This test never touches dev data
# when TEST_DATABASE_URL points at a dedicated database.
_WIREMOCK_ENV = "WIREMOCK_BASE_URL"
# Align with scripts/testing/_env.sh — not the platform reverse-proxy on :18080.
_DEFAULT_WIREMOCK = os.getenv(_WIREMOCK_ENV, "http://127.0.0.1:28080")


def _wiremock_reachable(base: str) -> bool:
    try:
        p = urlparse(base)
        host = p.hostname or "127.0.0.1"
        port = p.port or (443 if p.scheme == "https" else 80)
        with socket.create_connection((host, port), timeout=0.5):
            return True
    except OSError:
        return False


def _reset_wiremock_journal(base: str) -> None:
    # WireMock 3 clears the received-requests journal (stub mappings stay loaded).
    r = httpx.delete(f"{base.rstrip('/')}/__admin/requests", timeout=5.0)
    r.raise_for_status()


def _assert_search_requests_no_cursor_or_limit(wiremock_base: str) -> None:
    r = httpx.get(f"{wiremock_base.rstrip('/')}/__admin/requests", timeout=10.0)
    r.raise_for_status()
    data = r.json()
    for entry in data.get("requests", []):
        req = entry.get("request") or {}
        method = str(req.get("method") or "").upper()
        raw_url = str(req.get("absoluteUrl") or req.get("url") or "")
        assert "cursor=0" not in raw_url, f"unexpected cursor=0 in {raw_url}"
        if method == "GET" and "_search" in raw_url:
            parsed = urlparse(raw_url)
            q = parse_qs(parsed.query)
            assert "cursor" not in q, f"cursor must not be sent: {raw_url}"
            assert "limit" not in q, f"limit must not be sent (not configured on stream): {raw_url}"

pytestmark = [pytest.mark.wiremock_integration, pytest.mark.e2e_regression]
skip_no_wiremock = pytest.mark.skipif(
    not _wiremock_reachable(_DEFAULT_WIREMOCK),
    reason=f"WireMock not reachable at {_DEFAULT_WIREMOCK} (start: docker compose --profile test up -d wiremock)",
)


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


@skip_no_wiremock
@pytest.mark.e2e_auth
def test_vendor_jwt_stream_run_once_against_wiremock(client: TestClient, db_session: Session) -> None:
    base = _DEFAULT_WIREMOCK.rstrip("/")
    _reset_wiremock_journal(base)

    # 1) Connector: vendor_jwt_exchange → token URL and base URL on WireMock
    token_url = f"{base}/connect/api/v1/access_token"
    conn = client.post(
        "/api/v1/connectors/",
        json={
            "name": "wiremock-itest-connector",
            "auth_type": "vendor_jwt_exchange",
            "base_url": base,
            "verify_ssl": False,
            "user_id": "wiremock-user",
            "api_key": "wiremock-secret",
            "token_url": token_url,
            "token_method": "POST",
            "token_auth_mode": "basic_user_id_api_key",
            "token_path": "$.access_token",
        },
    )
    assert conn.status_code == 201, conn.text
    connector_id = int(conn.json()["id"])
    source_id = int(conn.json()["source_id"])

    # 2) Stream: Stellar-style SER search (GET + JSON body, pagination off)
    stream_config = {
        "method": "GET",
        "endpoint": "/connect/api/data/aella-ser-integration/_search",
        "params": {},
        "body": {"size": 10, "query": {"bool": {"filter": []}}},
        "pagination": {"type": "none"},
    }
    st = client.post(
        "/api/v1/streams/",
        json={
            "name": "wiremock-itest-stream",
            "connector_id": connector_id,
            "source_id": source_id,
            "stream_type": "HTTP_API_POLLING",
            "config_json": stream_config,
            "polling_interval": 60,
            "enabled": True,
            "status": "RUNNING",
            "rate_limit_json": {"max_requests": 100, "per_seconds": 60},
        },
    )
    assert st.status_code == 201, st.text
    stream_id = int(st.json()["id"])

    # 3) Destination + route → webhook also served by WireMock
    dest = client.post(
        "/api/v1/destinations/",
        json={
            "name": "wiremock-itest-destination",
            "destination_type": "WEBHOOK_POST",
            "config_json": {"url": f"{base}/wiremock-integration/receiver"},
            "rate_limit_json": {"max_events": 1000, "per_seconds": 1},
        },
    )
    assert dest.status_code == 201, dest.text
    destination_id = int(dest.json()["id"])

    route = client.post(
        "/api/v1/routes/",
        json={
            "stream_id": stream_id,
            "destination_id": destination_id,
            "enabled": True,
            "failure_policy": "LOG_AND_CONTINUE",
            "formatter_config_json": {},
            "rate_limit_json": {},
            "status": "ENABLED",
        },
    )
    assert route.status_code == 201, route.text

    # 4) Mapping (hits.hits + _source), via runtime save — uses real DB rows only for this test schema
    mp = client.post(
        f"/api/v1/runtime/mappings/stream/{stream_id}/save",
        json={
            "event_array_path": "$.hits.hits",
            "event_root_path": "$._source",
            "field_mappings": {
                "event_id": "$.timestamp",
                "message": "$.event_name",
            },
        },
    )
    assert mp.status_code == 200, mp.text

    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    body = run.json()
    assert int(body.get("extracted_event_count") or 0) > 0
    assert body.get("checkpoint_updated") is True

    db_session.expire_all()
    logs = (
        db_session.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == stream_id)
        .filter(DeliveryLog.stage.in_(["route_send_success", "run_complete"]))
        .all()
    )
    assert len(logs) >= 1

    cp = db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).first()
    assert cp is not None
    assert isinstance(cp.checkpoint_value_json, dict)
    assert cp.checkpoint_value_json.get("last_success_event")

    _assert_search_requests_no_cursor_or_limit(base)


@skip_no_wiremock
@pytest.mark.e2e_auth
def test_vendor_jwt_stream_run_once_wiremock_body_stored_as_json_string(client: TestClient, db_session: Session) -> None:
    """Same as vendor JWT WireMock run-once, but stream body is persisted as a JSON text string (editor/wizard)."""

    base = _DEFAULT_WIREMOCK.rstrip("/")
    _reset_wiremock_journal(base)

    token_url = f"{base}/connect/api/v1/access_token"
    conn = client.post(
        "/api/v1/connectors/",
        json={
            "name": "wiremock-itest-connector-strbody",
            "auth_type": "vendor_jwt_exchange",
            "base_url": base,
            "verify_ssl": False,
            "user_id": "wiremock-user",
            "api_key": "wiremock-secret",
            "token_url": token_url,
            "token_method": "POST",
            "token_auth_mode": "basic_user_id_api_key",
            "token_path": "$.access_token",
        },
    )
    assert conn.status_code == 201, conn.text
    connector_id = int(conn.json()["id"])
    source_id = int(conn.json()["source_id"])

    body_obj = {"size": 10, "query": {"bool": {"filter": []}}}
    stream_config = {
        "method": "GET",
        "endpoint": "/connect/api/data/aella-ser-integration/_search",
        "params": {},
        "body": json.dumps(body_obj, indent=2),
        "pagination": {"type": "none"},
    }
    st = client.post(
        "/api/v1/streams/",
        json={
            "name": "wiremock-itest-stream-strbody",
            "connector_id": connector_id,
            "source_id": source_id,
            "stream_type": "HTTP_API_POLLING",
            "config_json": stream_config,
            "polling_interval": 60,
            "enabled": True,
            "status": "RUNNING",
            "rate_limit_json": {"max_requests": 100, "per_seconds": 60},
        },
    )
    assert st.status_code == 201, st.text
    stream_id = int(st.json()["id"])

    dest = client.post(
        "/api/v1/destinations/",
        json={
            "name": "wiremock-itest-destination-strbody",
            "destination_type": "WEBHOOK_POST",
            "config_json": {"url": f"{base}/wiremock-integration/receiver"},
            "rate_limit_json": {"max_events": 1000, "per_seconds": 1},
        },
    )
    assert dest.status_code == 201, dest.text
    destination_id = int(dest.json()["id"])

    route = client.post(
        "/api/v1/routes/",
        json={
            "stream_id": stream_id,
            "destination_id": destination_id,
            "enabled": True,
            "failure_policy": "LOG_AND_CONTINUE",
            "formatter_config_json": {},
            "rate_limit_json": {},
            "status": "ENABLED",
        },
    )
    assert route.status_code == 201, route.text

    mp = client.post(
        f"/api/v1/runtime/mappings/stream/{stream_id}/save",
        json={
            "event_array_path": "$.hits.hits",
            "event_root_path": "$._source",
            "field_mappings": {
                "event_id": "$.timestamp",
                "message": "$.event_name",
            },
        },
    )
    assert mp.status_code == 200, mp.text

    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    body = run.json()
    assert int(body.get("extracted_event_count") or 0) > 0

    _assert_search_requests_no_cursor_or_limit(base)
