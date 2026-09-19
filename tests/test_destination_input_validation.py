"""ULC-001: reject blank destination names and invalid WEBHOOK_POST URLs."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database import get_db
from app.destinations.config_validation import validate_destination_config
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


def _create_payload(*, name: str, url: str) -> dict[str, Any]:
    return {
        "name": name,
        "destination_type": "WEBHOOK_POST",
        "config_json": {"url": url},
        "rate_limit_json": {},
        "enabled": True,
    }


def test_config_validation_rejects_invalid_webhook_urls() -> None:
    with pytest.raises(ValueError, match="http:// or https://"):
        validate_destination_config("WEBHOOK_POST", {"url": "not-a-url"})
    with pytest.raises(ValueError, match="http:// or https://"):
        validate_destination_config("WEBHOOK_POST", {"url": "ftp://example.com/x"})
    with pytest.raises(ValueError, match="requires url"):
        validate_destination_config("WEBHOOK_POST", {"url": ""})
    with pytest.raises(ValueError, match="requires url"):
        validate_destination_config("WEBHOOK_POST", {})
    validate_destination_config("WEBHOOK_POST", {"url": "http://example.com/hook"})
    validate_destination_config("WEBHOOK_POST", {"url": "https://example.com/hook"})


def test_config_validation_does_not_force_url_on_syslog() -> None:
    validate_destination_config("SYSLOG_UDP", {"host": "127.0.0.1", "port": 514})
    validate_destination_config("SYSLOG_TCP", {"host": "127.0.0.1", "port": 514})


def test_create_rejects_empty_name(client: TestClient) -> None:
    res = client.post("/api/v1/destinations/", json=_create_payload(name="", url="https://example.com/ok"))
    assert 400 <= res.status_code < 500, res.text
    assert "traceback" not in res.text.lower()


def test_create_rejects_blank_name(client: TestClient) -> None:
    res = client.post("/api/v1/destinations/", json=_create_payload(name="   ", url="https://example.com/ok"))
    assert 400 <= res.status_code < 500, res.text
    assert "traceback" not in res.text.lower()


def test_create_rejects_invalid_url(client: TestClient) -> None:
    res = client.post("/api/v1/destinations/", json=_create_payload(name="valid-name", url="not-a-url"))
    assert res.status_code == 422, res.text
    detail = res.json().get("detail")
    assert isinstance(detail, dict)
    assert detail.get("error_code") == "INVALID_DESTINATION_CONFIG"
    assert "http" in str(detail.get("message", "")).lower()
    assert "traceback" not in res.text.lower()


def test_create_rejects_ftp_url_for_webhook(client: TestClient) -> None:
    res = client.post(
        "/api/v1/destinations/",
        json=_create_payload(name="valid-name", url="ftp://files.example.com/drop"),
    )
    assert res.status_code == 422, res.text
    assert res.json()["detail"]["error_code"] == "INVALID_DESTINATION_CONFIG"


def test_create_accepts_http_and_https(client: TestClient, db_session: Session) -> None:
    http_res = client.post(
        "/api/v1/destinations/",
        json=_create_payload(name="http-ok", url="http://example.com/hook"),
    )
    assert http_res.status_code == 201, http_res.text
    https_res = client.post(
        "/api/v1/destinations/",
        json=_create_payload(name="https-ok", url="https://example.com/hook"),
    )
    assert https_res.status_code == 201, https_res.text
    assert db_session.query(Destination).filter(Destination.name == "http-ok").count() == 1
    assert db_session.query(Destination).filter(Destination.name == "https-ok").count() == 1


def test_update_rejects_invalid_url(client: TestClient, db_session: Session) -> None:
    row = Destination(
        name="upd-dest",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://example.com/ok"},
        rate_limit_json={},
        enabled=True,
    )
    db_session.add(row)
    db_session.commit()
    db_session.refresh(row)

    got = client.get(f"/api/v1/destinations/{row.id}")
    assert got.status_code == 200
    upd = client.put(
        f"/api/v1/destinations/{row.id}",
        json={
            "config_json": {"url": "not-a-url"},
            "expected_updated_at": got.json()["updated_at"],
        },
    )
    assert upd.status_code == 422, upd.text
    assert upd.json()["detail"]["error_code"] == "INVALID_DESTINATION_CONFIG"
    db_session.refresh(row)
    assert row.config_json["url"] == "https://example.com/ok"


def test_update_rejects_blank_name(client: TestClient, db_session: Session) -> None:
    row = Destination(
        name="upd-name-dest",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://example.com/ok"},
        rate_limit_json={},
        enabled=True,
    )
    db_session.add(row)
    db_session.commit()
    db_session.refresh(row)

    got = client.get(f"/api/v1/destinations/{row.id}")
    assert got.status_code == 200
    upd = client.put(
        f"/api/v1/destinations/{row.id}",
        json={
            "name": "   ",
            "expected_updated_at": got.json()["updated_at"],
        },
    )
    assert 400 <= upd.status_code < 500, upd.text
    db_session.refresh(row)
    assert row.name == "upd-name-dest"


def test_ulc001_combined_invalid_create(client: TestClient) -> None:
    """Exact lifecycle reproduction: empty name + not-a-url must not return 201."""

    res = client.post(
        "/api/v1/destinations/",
        json={"name": "", "destination_type": "WEBHOOK_POST", "config_json": {"url": "not-a-url"}},
    )
    assert 400 <= res.status_code < 500, res.text
    assert res.status_code != 201
