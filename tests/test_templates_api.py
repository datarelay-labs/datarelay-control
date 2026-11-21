from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.connectors.models import Connector
from app.database import get_db
from app.destinations.models import Destination
from app.enrichments.models import Enrichment
from app.main import app
from app.mappings.models import Mapping
from app.routes.models import Route
from app.sources.models import Source
from app.streams.models import Stream
from app.templates.registry import clear_template_cache


def _seed_destination(db: Session) -> Destination:
    row = Destination(
        name="tpl-test-dest",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://example.com/hook", "method": "POST"},
        rate_limit_json={},
        enabled=True,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@pytest.fixture
def client(db_session: Session) -> Any:
    clear_template_cache()

    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)
        clear_template_cache()


def test_list_templates_ok(client: TestClient) -> None:
    res = client.get("/api/v1/templates/")
    assert res.status_code == 200
    body = res.json()
    assert isinstance(body, list)
    ids = {row["template_id"] for row in body}
    assert "generic_rest_polling" in ids
    assert "stellar_cyber_malop_api" in ids
    assert "stellar_cyber_hunting_api" in ids
    assert "crowdstrike_detections_api" in ids
    assert "okta_system_log" in ids


def test_get_template_detail_unknown(client: TestClient) -> None:
    res = client.get("/api/v1/templates/does_not_exist_zz")
    assert res.status_code == 404
    assert res.json()["detail"]["error_code"] == "TEMPLATE_NOT_FOUND"


def test_get_template_detail_ok(client: TestClient) -> None:
    res = client.get("/api/v1/templates/generic_rest_polling")
    assert res.status_code == 200
    data = res.json()
    assert data["template_id"] == "generic_rest_polling"
    assert "mapping_defaults" in data


def test_instantiate_unknown_template(client: TestClient) -> None:
    res = client.post(
        "/api/v1/templates/unknown_tpl_x/instantiate",
        json={
            "connector_name": "c1",
            "host": "https://api.example.com",
            "credentials": {"bearer_token": "t"},
        },
    )
    assert res.status_code == 404


def test_instantiate_creates_entities(client: TestClient, db_session: Session) -> None:
    dest = _seed_destination(db_session)
    res = client.post(
        "/api/v1/templates/generic_rest_polling/instantiate",
        json={
            "connector_name": "From Template REST",
            "host": "https://api.example.com",
            "credentials": {"bearer_token": "secret-token"},
            "destination_id": dest.id,
            "create_route": True,
            "redirect_to": "stream_runtime",
        },
    )
    assert res.status_code == 201, res.text
    out = res.json()
    cid = int(out["connector_id"])
    sid = int(out["source_id"])
    tid = int(out["stream_id"])
    mid = int(out["mapping_id"])
    eid = int(out["enrichment_id"])
    ckid = int(out["checkpoint_id"])
    assert out["route_id"] is not None
    assert out["redirect_path"] == f"/streams/{tid}/runtime"

    assert db_session.get(Connector, cid) is not None
    assert db_session.get(Source, sid) is not None
    stream = db_session.get(Stream, tid)
    assert stream is not None
    assert bool(stream.enabled) is False
    assert str(stream.status) == "STOPPED"
    assert db_session.get(Mapping, mid) is not None
    assert db_session.get(Enrichment, eid) is not None
    assert db_session.get(Checkpoint, ckid) is not None
    route = db_session.query(Route).filter(Route.id == int(out["route_id"])).one()
    assert int(route.stream_id) == tid
    assert int(route.destination_id) == int(dest.id)


def test_instantiate_invalid_destination(client: TestClient) -> None:
    res = client.post(
        "/api/v1/templates/generic_rest_polling/instantiate",
        json={
            "connector_name": "Bad dest",
            "host": "https://api.example.com",
            "credentials": {"bearer_token": "x"},
            "destination_id": 999999,
            "create_route": True,
        },
    )
    assert res.status_code == 404


def test_instantiate_request_empty_connector_name_unprocessable(client: TestClient) -> None:
    res = client.post(
        "/api/v1/templates/generic_rest_polling/instantiate",
        json={
            "connector_name": "",
            "host": "https://api.example.com",
            "credentials": {"bearer_token": "x"},
        },
    )
    assert res.status_code == 422


def test_instantiate_skip_route(client: TestClient, db_session: Session) -> None:
    res = client.post(
        "/api/v1/templates/generic_rest_polling/instantiate",
        json={
            "connector_name": "No route tpl",
            "host": "https://api.example.com",
            "credentials": {"bearer_token": "tok"},
            "destination_id": None,
            "create_route": False,
        },
    )
    assert res.status_code == 201
    out = res.json()
    assert out["route_id"] is None


def test_instantiate_redirect_connector_detail(client: TestClient, db_session: Session) -> None:
    res = client.post(
        "/api/v1/templates/generic_rest_polling/instantiate",
        json={
            "connector_name": "Redirect test",
            "host": "https://api.example.com",
            "credentials": {"bearer_token": "tok"},
            "redirect_to": "connector_detail",
        },
    )
    assert res.status_code == 201
    out = res.json()
    cid = int(out["connector_id"])
    assert out["redirect_path"] == f"/connectors/{cid}"


def test_instantiate_stellar_vendor_jwt(client: TestClient, db_session: Session) -> None:
    dest = _seed_destination(db_session)
    res = client.post(
        "/api/v1/templates/stellar_cyber_malop_api/instantiate",
        json={
            "connector_name": "Stellar from template",
            "host": "https://tenant.stellarcyber.cloud",
            "credentials": {
                "user_id": "u1",
                "api_key": "k1",
                "token_url": "https://tenant.stellarcyber.cloud/oauth/token",
            },
            "destination_id": dest.id,
            "create_route": True,
        },
    )
    assert res.status_code == 201, res.text
    out = res.json()
    stream = db_session.get(Stream, int(out["stream_id"]))
    assert stream is not None
    assert stream.enabled is False
    assert str(stream.status) == "STOPPED"
    src = db_session.get(Source, int(out["source_id"]))
    assert src is not None
    assert isinstance(src.auth_json, dict)
    assert src.auth_json.get("auth_type") == "vendor_jwt_exchange"


def test_instantiate_stellar_scoped_cases_requires_only_scoped_key(
    client: TestClient, db_session: Session
) -> None:
    res = client.post(
        "/api/v1/templates/stellar_cyber_scoped_cases_api/instantiate",
        json={
            "connector_name": "Stellar scoped cases fixture",
            "host": "https://dp.example.invalid",
            "credentials": {"refresh_token": "fixture-scoped-key"},
        },
    )
    assert res.status_code == 201, res.text
    out = res.json()
    src = db_session.get(Source, int(out["source_id"]))
    stream = db_session.get(Stream, int(out["stream_id"]))
    mapping = db_session.get(Mapping, int(out["mapping_id"]))
    assert src is not None and stream is not None and mapping is not None
    assert src.auth_json["auth_type"] == "jwt_refresh_token"
    assert src.auth_json["refresh_token"] == "fixture-scoped-key"
    assert src.auth_json["token_path"] == "/connect/api/v1/access_token"
    assert src.auth_json["refresh_token_header_prefix"] == "Bearer"
    assert src.auth_json["access_token_json_path"] == "$.access_token"
    assert stream.enabled is False
    assert stream.config_json["method"] == "GET"
    assert mapping.event_array_path == "$.data.cases"
    assert out["route_id"] is None


def test_instantiate_okta_oauth2(client: TestClient, db_session: Session) -> None:
    res = client.post(
        "/api/v1/templates/okta_system_log/instantiate",
        json={
            "connector_name": "Okta from template",
            "host": "https://example.okta.com",
            "credentials": {
                "oauth2_client_id": "cid",
                "oauth2_client_secret": "sec",
                "oauth2_token_url": "https://example.okta.com/oauth2/default/v1/token",
                "oauth2_scope": "okta.logs.read",
            },
        },
    )
    assert res.status_code == 201, res.text
    out = res.json()
    src = db_session.get(Source, int(out["source_id"]))
    assert src is not None
    assert src.auth_json.get("auth_type") == "oauth2_client_credentials"
    mapping = db_session.get(Mapping, int(out["mapping_id"]))
    assert mapping is not None
    assert mapping.event_array_path is None
