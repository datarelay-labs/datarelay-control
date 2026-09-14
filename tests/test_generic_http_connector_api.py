from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from tests.config_mutation_test_helpers import put_connector
from sqlalchemy.orm import Session

from app.connectors.models import Connector
from app.database import get_db, get_db_read_bounded
from app.main import app
from app.sources.models import Source
from app.streams.models import Stream


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_db_read_bounded] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_db_read_bounded, None)


def test_create_generic_http_connector_no_auth(client: TestClient) -> None:
    res = client.post("/api/v1/connectors/", json=_create_payload("no_auth"))
    assert res.status_code == 201
    data = res.json()
    assert data["auth_type"] == "no_auth"
    assert data["base_url"] == "https://api.example.com"


def test_create_basic_auth_connector(client: TestClient) -> None:
    res = client.post("/api/v1/connectors/", json=_create_payload("basic"))
    assert res.status_code == 201
    assert res.json()["auth"]["basic_password"] == "********"


def test_create_bearer_auth_connector(client: TestClient) -> None:
    res = client.post("/api/v1/connectors/", json=_create_payload("bearer"))
    assert res.status_code == 201
    assert res.json()["auth"]["bearer_token"] == "********"


def test_create_api_key_auth_connector(client: TestClient) -> None:
    res = client.post("/api/v1/connectors/", json=_create_payload("api_key"))
    assert res.status_code == 201
    assert res.json()["auth"]["api_key_value"] == "********"


def test_create_oauth2_client_credentials_connector(client: TestClient) -> None:
    res = client.post("/api/v1/connectors/", json=_create_payload("oauth2_client_credentials"))
    assert res.status_code == 201
    assert res.json()["auth"]["oauth2_client_secret"] == "********"


def test_create_session_login_connector(client: TestClient) -> None:
    res = client.post("/api/v1/connectors/", json=_create_payload("session_login"))
    assert res.status_code == 201
    body = res.json()
    assert body["auth"]["login_password"] == "********"
    assert body["auth"]["login_body_mode"] == "json"


def test_create_session_login_rejects_path_in_login_url_when_login_path_set(client: TestClient) -> None:
    payload = _create_payload("session_login")
    payload["login_url"] = "https://host.example/existing/path"
    res = client.post("/api/v1/connectors/", json=payload)
    assert res.status_code == 422
    detail = res.json().get("detail")
    msg = detail.get("message", "") if isinstance(detail, dict) else str(detail)
    assert "login_url" in msg.lower()


def test_create_session_login_persists_form_urlencoded_fields(client: TestClient, db_session: Session) -> None:
    payload = _create_payload("session_login")
    payload["login_body_mode"] = "form_urlencoded"
    payload["login_body_raw"] = "username={{username}}&password={{password}}"
    payload["login_allow_redirects"] = False
    payload["session_cookie_name"] = "JSESSIONID"
    res = client.post("/api/v1/connectors/", json=payload)
    assert res.status_code == 201
    body = res.json()
    assert body["auth"]["login_body_mode"] == "form_urlencoded"
    assert body["auth"]["login_body_raw"] == "username={{username}}&password={{password}}"
    assert body["auth"]["login_allow_redirects"] is False
    assert body["auth"]["session_cookie_name"] == "JSESSIONID"
    db_session.expire_all()
    src = db_session.query(Source).filter(Source.connector_id == body["id"]).first()
    assert src is not None
    assert src.auth_json.get("login_body_mode") == "form_urlencoded"


def test_update_partial_preserves_session_login_body_mode_and_raw(client: TestClient, db_session: Session) -> None:
    payload = _create_payload("session_login")
    payload["login_body_mode"] = "form_urlencoded"
    payload["login_body_raw"] = "username={{username}}&password={{password}}"
    created = client.post("/api/v1/connectors/", json=payload).json()
    cid = created["id"]
    res = put_connector(client, cid, {"name": "renamed"})
    assert res.status_code == 200
    db_session.expire_all()
    src = db_session.query(Source).filter(Source.connector_id == cid).first()
    assert src is not None
    assert src.auth_json.get("login_body_mode") == "form_urlencoded"
    assert src.auth_json.get("login_body_raw") == "username={{username}}&password={{password}}"


def test_create_jwt_refresh_token_connector(client: TestClient) -> None:
    res = client.post("/api/v1/connectors/", json=_create_payload("jwt_refresh_token"))
    assert res.status_code == 201
    assert res.json()["auth"]["refresh_token"] == "********"


def test_create_vendor_jwt_exchange_connector(client: TestClient) -> None:
    res = client.post("/api/v1/connectors/", json=_create_payload("vendor_jwt_exchange"))
    assert res.status_code == 201
    body = res.json()
    assert body["auth_type"] == "vendor_jwt_exchange"
    assert body["auth"]["api_key"] == "********"
    assert body["auth"]["user_id"] == "vendor-user"


def test_validation_failure_for_missing_required_auth_fields(client: TestClient) -> None:
    res = client.post(
        "/api/v1/connectors/",
        json={"name": "x", "base_url": "https://api.example.com", "auth_type": "basic"},
    )
    assert res.status_code == 422


def test_secret_masking_on_get_list_detail(client: TestClient) -> None:
    created = client.post("/api/v1/connectors/", json=_create_payload("bearer")).json()
    cid = created["id"]
    listed = client.get("/api/v1/connectors/").json()
    detail = client.get(f"/api/v1/connectors/{cid}").json()
    listed_row = next(c for c in listed if c["id"] == cid)
    assert listed_row["auth"]["bearer_token"] == "********"
    assert detail["auth"]["bearer_token"] == "********"


def test_update_without_secret_preserves_existing_secret(client: TestClient, db_session: Session) -> None:
    created = client.post("/api/v1/connectors/", json=_create_payload("bearer")).json()
    cid = created["id"]
    res = put_connector(client, cid, {"name": "updated"})
    assert res.status_code == 200
    db_session.expire_all()
    src = db_session.query(Source).filter(Source.connector_id == cid).first()
    assert src is not None
    assert src.auth_json.get("bearer_token") == "token-abc"


def test_update_with_secret_replaces_existing_secret(client: TestClient, db_session: Session) -> None:
    created = client.post("/api/v1/connectors/", json=_create_payload("bearer")).json()
    cid = created["id"]
    res = put_connector(client, cid, {"bearer_token": "new-token", "auth_type": "bearer"})
    assert res.status_code == 200
    db_session.expire_all()
    src = db_session.query(Source).filter(Source.connector_id == cid).first()
    assert src is not None
    assert src.auth_json.get("bearer_token") == "new-token"


def test_delete_connector_removes_source_link(client: TestClient, db_session: Session) -> None:
    created = client.post("/api/v1/connectors/", json=_create_payload("no_auth")).json()
    cid = created["id"]
    assert client.delete(f"/api/v1/connectors/{cid}").status_code == 204
    db_session.expire_all()
    assert db_session.query(Connector).filter(Connector.id == cid).first() is None
    assert db_session.query(Source).filter(Source.connector_id == cid).first() is None


def test_delete_connector_with_streams_returns_conflict(client: TestClient, db_session: Session) -> None:
    created = client.post("/api/v1/connectors/", json=_create_payload("no_auth")).json()
    cid = created["id"]
    src = db_session.query(Source).filter(Source.connector_id == cid).first()
    assert src is not None
    db_session.add(
        Stream(
            connector_id=cid,
            source_id=src.id,
            name="s1",
            stream_type="HTTP_API_POLLING",
            config_json={},
            polling_interval=60,
            enabled=True,
            status="STOPPED",
            rate_limit_json={},
        )
    )
    db_session.commit()
    res = client.delete(f"/api/v1/connectors/{cid}")
    assert res.status_code == 409


def _create_payload(auth_type: str) -> dict:
    base = {
        "name": f"connector-{auth_type}",
        "description": "desc",
        "base_url": "https://api.example.com",
        "verify_ssl": True,
        "auth_type": auth_type,
    }
    if auth_type == "basic":
        base.update({"basic_username": "user", "basic_password": "pw"})
    elif auth_type == "bearer":
        base.update({"bearer_token": "token-abc"})
    elif auth_type == "api_key":
        base.update({"api_key_name": "X-API-KEY", "api_key_value": "secret", "api_key_location": "headers"})
    elif auth_type == "oauth2_client_credentials":
        base.update(
            {
                "oauth2_client_id": "cid",
                "oauth2_client_secret": "csecret",
                "oauth2_token_url": "https://auth.example.com/token",
                "oauth2_scope": "read",
            }
        )
    elif auth_type == "session_login":
        base.update(
            {
                "login_path": "/login",
                "login_method": "POST",
                "login_username": "user",
                "login_password": "pw",
            }
        )
    elif auth_type == "jwt_refresh_token":
        base.update(
            {
                "refresh_token": "refresh-secret",
                "token_path": "/token",
            }
        )
    elif auth_type == "vendor_jwt_exchange":
        base.update(
            {
                "user_id": "vendor-user",
                "api_key": "vendor-secret",
                "token_url": "https://auth.example.com/token",
                "token_method": "POST",
                "token_auth_mode": "basic_user_id_api_key",
                "token_path": "$.access_token",
            }
        )
    return base
