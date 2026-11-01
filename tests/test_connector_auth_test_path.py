"""F-116: the Test Auth path entered on the connector page is persisted and used by list-level Test Auth."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.connectors.operations_service import _resolve_connector_auth_check_path
from app.database import get_db, get_db_read_bounded
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


def _body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {"name": "Auth Path Connector", "auth_type": "no_auth", "base_url": "https://api.example.com"}
    body.update(overrides)
    return body


def test_auth_test_path_is_normalised_stored_and_returned(client: TestClient) -> None:
    created = client.post("/api/v1/connectors/", json=_body(auth_test_path="v1/me"))
    assert created.status_code == 201, created.text
    assert created.json()["auth_test_path"] == "/v1/me"

    fetched = client.get(f"/api/v1/connectors/{created.json()['id']}")
    assert fetched.status_code == 200
    assert fetched.json()["auth_test_path"] == "/v1/me"


def test_default_root_path_is_not_stored(client: TestClient) -> None:
    created = client.post("/api/v1/connectors/", json=_body(auth_test_path="/"))
    assert created.status_code == 201, created.text
    assert created.json()["auth_test_path"] is None


def test_update_changes_and_clears_the_path(client: TestClient) -> None:
    created = client.post("/api/v1/connectors/", json=_body(auth_test_path="/health")).json()
    changed = put_connector(client, created["id"], {"auth_test_path": "/v2/ping"})
    assert changed.status_code == 200, changed.text
    assert changed.json()["auth_test_path"] == "/v2/ping"

    cleared = put_connector(client, created["id"], {"auth_test_path": ""})
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["auth_test_path"] is None


@pytest.mark.parametrize("bad", ["https://evil.example/x", "//evil.example/x", "/a b", "/a\nb"])
def test_auth_test_path_must_be_a_plain_path(client: TestClient, bad: str) -> None:
    response = client.post("/api/v1/connectors/", json=_body(auth_test_path=bad))
    assert response.status_code == 422, response.text
    assert response.json()["detail"][0]["loc"][-1] == "auth_test_path"


def test_list_level_auth_check_uses_the_saved_path_instead_of_root(client: TestClient, db_session: Session) -> None:
    created = client.post("/api/v1/connectors/", json=_body(auth_test_path="/v1/me")).json()
    from app.connectors.operations_service import _load_source_config_for_connector

    source_config = _load_source_config_for_connector(db_session, created["id"])
    assert _resolve_connector_auth_check_path(
        db_session, created["id"], source_config=source_config, requested_path="/"
    ) == "/v1/me"
