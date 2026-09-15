from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.backup.curl_parser import build_curl_import_draft, parse_curl_command
from app.database import get_db
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


def test_parse_curl_get_with_query() -> None:
    raw = "curl -X GET 'https://api.vendor.example/v1/events?limit=10&page=1' -H 'Accept: application/json'"
    parsed = parse_curl_command(raw)
    assert not parsed.parse_errors
    assert parsed.method == "GET"
    assert parsed.base_url == "https://api.vendor.example"
    assert parsed.endpoint == "/v1/events"
    assert parsed.query_params == {"limit": "10", "page": "1"}
    assert "Accept" in parsed.headers


def test_parse_curl_post_json_body() -> None:
    raw = """curl -X POST https://api.vendor.example/v1/search \\
      -H 'Content-Type: application/json' \\
      -H 'Authorization: Bearer secret-token-xyz' \\
      -d '{"q":"alerts"}'"""
    parsed = parse_curl_command(raw)
    assert not parsed.parse_errors
    assert parsed.method == "POST"
    assert parsed.json_body == {"q": "alerts"}
    assert parsed.headers.get("Authorization", "").startswith("Bearer ")


def test_curl_draft_masks_bearer_secret() -> None:
    raw = "curl https://api.example.com/data -H 'Authorization: Bearer my-secret'"
    draft = build_curl_import_draft(parse_curl_command(raw))
    assert draft["connector"]["auth_type"] == "bearer"
    assert draft["connector"].get("bearer_token") == ""
    assert draft["secrets_included"] is False
    dumped = str(draft)
    assert "my-secret" not in dumped


def test_parse_curl_basic_user_flag() -> None:
    raw = "curl -u alice:sekret https://api.example.com/ping"
    parsed = parse_curl_command(raw)
    assert parsed.method == "GET"
    assert "Authorization" in parsed.headers
    draft = build_curl_import_draft(parsed)
    assert draft["connector"]["auth_type"] == "basic"
    assert "sekret" not in str(draft)


def test_api_curl_parse_endpoint(client: TestClient) -> None:
    res = client.post(
        "/api/v1/backup/curl/parse",
        json={"curl_command": "curl https://logs.example.com/api/v1/logs -H 'X-Api-Key: abc123'"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["draft"]["connector"]["base_url"] == "https://logs.example.com"
    assert body["draft"]["stream"]["config_json"]["endpoint"] == "/api/v1/logs"
    assert "abc123" not in res.text


def test_api_curl_parse_rejects_empty(client: TestClient) -> None:
    res = client.post("/api/v1/backup/curl/parse", json={"curl_command": "curl"})
    assert res.status_code == 422
    assert res.json()["detail"]["error_code"] == "CURL_PARSE_FAILED"


def test_curl_draft_masks_query_and_body_secrets() -> None:
    raw = (
        "curl -X POST 'https://api.vendor.example/v1/token?api_key=qk-literal-secret&limit=1' "
        "-H 'Content-Type: application/json' "
        "-d '{\"password\":\"body-pass-secret\",\"client_secret\":\"cs-secret\",\"q\":\"ok\"}'"
    )
    draft = build_curl_import_draft(parse_curl_command(raw))
    dumped = str(draft)
    assert "qk-literal-secret" not in dumped
    assert "body-pass-secret" not in dumped
    assert "cs-secret" not in dumped
    params = draft["stream"]["config_json"]["params"]
    assert params["api_key"] == "********"
    assert params["limit"] == "1"
    body = draft["stream"]["config_json"]["body"]
    assert body["password"] == "********"
    assert body["client_secret"] == "********"
    assert body["q"] == "ok"
    assert "qk-literal-secret" not in draft["parsed"]["url"]
    assert draft["secrets_included"] is False
