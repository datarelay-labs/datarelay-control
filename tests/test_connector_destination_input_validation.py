"""F-118, F-139, F-221: field-level validation on connector and destination writes."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database import get_db, get_db_read_bounded
from app.destinations.config_validation import is_valid_network_host, validate_destination_config
from app.main import app
from tests.config_mutation_test_helpers import put_connector


@pytest.fixture
def client(db_session: Session) -> Iterator[TestClient]:
    def _override_db() -> Iterator[Session]:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_db_read_bounded] = _override_db
    try:
        yield TestClient(app, raise_server_exceptions=False)
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_db_read_bounded, None)


def _connector(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {"name": "Valid Connector", "auth_type": "no_auth", "base_url": "https://api.example.com"}
    body.update(overrides)
    return body


@pytest.mark.parametrize("length", [120, 129, 200, 255])
def test_connector_name_up_to_255_chars_is_accepted_without_a_server_error(client: TestClient, length: int) -> None:
    # The inferred product group is VARCHAR(128); a long name used to fail with a bare 500.
    response = client.post("/api/v1/connectors/", json=_connector(name="C" * length))
    assert response.status_code == 201, response.text
    assert len(response.json()["product_group"]) <= 128


@pytest.mark.parametrize("length", [256, 300, 5000])
def test_connector_name_over_255_chars_is_a_field_error_not_a_500(client: TestClient, length: int) -> None:
    response = client.post("/api/v1/connectors/", json=_connector(name="C" * length))
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail[0]["loc"] == ["body", "name"]
    assert "255" in detail[0]["msg"]


@pytest.mark.parametrize("host", ["not a url", "http://", "ftp://example.com", "http://exa mple.com", "bad host!", "https://:8080"])
def test_connector_rejects_a_host_that_is_not_a_url_or_host_name(client: TestClient, host: str) -> None:
    response = client.post("/api/v1/connectors/", json=_connector(base_url=host))
    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert detail["error_code"] == "CONNECTOR_HOST_INVALID"
    assert detail["field"] == "host"


@pytest.mark.parametrize(
    "host",
    ["https://api.example.com", "http://127.0.0.1:19963", "api.example.com", "localhost:8080", "https://api.example.com/v1/", "http://[::1]:9000"],
)
def test_connector_accepts_urls_and_bare_hosts(client: TestClient, host: str) -> None:
    response = client.post("/api/v1/connectors/", json=_connector(base_url=host))
    assert response.status_code == 201, response.text


def test_connector_update_rejects_an_invalid_host(client: TestClient) -> None:
    created = client.post("/api/v1/connectors/", json=_connector()).json()
    response = put_connector(client, created["id"], {"base_url": "not a url"})
    assert response.status_code == 422, response.text
    assert response.json()["detail"]["field"] == "host"


def _destination(name: str = "dest-a", **cfg: Any) -> dict[str, Any]:
    config = {"host": "syslog.example.com", "port": 514}
    config.update(cfg)
    return {"name": name, "destination_type": "SYSLOG_UDP", "config_json": config}


@pytest.mark.parametrize("host", ["bad host!", "a b", "-leading.example", "x" * 300, "exa$mple.com"])
def test_destination_rejects_an_invalid_syslog_host(client: TestClient, host: str) -> None:
    response = client.post("/api/v1/destinations/", json=_destination(host=host))
    assert response.status_code == 422, response.text
    assert "not a valid host name or IP address" in response.json()["detail"]["message"]


@pytest.mark.parametrize("port", [0, 70000, -5, "abc"])
def test_destination_rejects_an_out_of_range_syslog_port(client: TestClient, port: Any) -> None:
    response = client.post("/api/v1/destinations/", json=_destination(port=port))
    assert response.status_code == 422, response.text
    assert "port" in response.json()["detail"]["message"]


def test_destination_name_must_be_unique_case_insensitively(client: TestClient) -> None:
    first = client.post("/api/v1/destinations/", json=_destination("Prod Syslog"))
    assert first.status_code == 201, first.text
    duplicate = client.post("/api/v1/destinations/", json=_destination("  prod syslog "))
    assert duplicate.status_code == 409
    detail = duplicate.json()["detail"]
    assert detail["error_code"] == "DESTINATION_NAME_EXISTS"
    assert detail["field"] == "name"


def test_destination_rename_to_an_existing_name_conflicts_but_keeping_the_name_is_fine(client: TestClient) -> None:
    a = client.post("/api/v1/destinations/", json=_destination("dest-one")).json()
    b = client.post("/api/v1/destinations/", json=_destination("dest-two")).json()

    clash = client.put(
        f"/api/v1/destinations/{b['id']}",
        json={"name": "DEST-ONE", "expected_updated_at": b["updated_at"]},
    )
    assert clash.status_code == 409

    same = client.put(
        f"/api/v1/destinations/{a['id']}",
        json={"name": "dest-one", "enabled": False, "expected_updated_at": a["updated_at"]},
    )
    assert same.status_code == 200, same.text


def test_destination_name_over_255_chars_is_a_field_error(client: TestClient) -> None:
    response = client.post("/api/v1/destinations/", json=_destination("D" * 300))
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "name"]


def test_network_host_helper() -> None:
    assert is_valid_network_host("10.0.0.1")
    assert is_valid_network_host("siem-01.corp.example.com")
    assert is_valid_network_host("[::1]")
    assert not is_valid_network_host("")
    assert not is_valid_network_host("bad host!")
    validate_destination_config("SYSLOG_TCP", {"host": "h", "port": 514})
