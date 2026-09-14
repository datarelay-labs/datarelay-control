from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from tests.config_mutation_test_helpers import put_connector
from app.connectors.product_group import infer_product_group_from_connector_name
from app.database import get_db, get_db_read_bounded
from app.main import app


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


def test_infer_product_group_from_connector_name() -> None:
    assert infer_product_group_from_connector_name("CrowdStrike Falcon API") == "CrowdStrike"
    assert infer_product_group_from_connector_name("Okta System Log") == "Okta"
    assert infer_product_group_from_connector_name("") is None
    assert infer_product_group_from_connector_name("Custom Vendor X") == "Custom Vendor X"


def test_create_connector_infers_product_group(client: TestClient) -> None:
    res = client.post(
        "/api/v1/connectors/",
        json={
            "name": "Okta Production",
            "auth_type": "no_auth",
            "base_url": "https://api.example.com",
        },
    )
    assert res.status_code == 201
    data = res.json()
    assert data["product_group"] == "Okta"


def test_create_connector_explicit_product_group(client: TestClient) -> None:
    res = client.post(
        "/api/v1/connectors/",
        json={
            "name": "Anything",
            "product_group": "Google Workspace",
            "auth_type": "no_auth",
            "base_url": "https://api.example.com",
        },
    )
    assert res.status_code == 201
    assert res.json()["product_group"] == "Google Workspace"


def test_update_connector_product_group(client: TestClient) -> None:
    created = client.post(
        "/api/v1/connectors/",
        json={
            "name": "legacy Okta",
            "product_group": "Okta",
            "auth_type": "no_auth",
            "base_url": "https://api.example.com",
        },
    ).json()
    cid = created["id"]

    res = put_connector(client, cid, {"product_group": "Microsoft 365"})
    assert res.status_code == 200
    assert res.json()["product_group"] == "Microsoft 365"

    detail = client.get(f"/api/v1/connectors/{cid}").json()
    assert detail["product_group"] == "Microsoft 365"
