"""F-209 / F-210: the product's own export must be importable again and restore faithfully."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.connectors.models import Connector
from app.database import get_db
from app.destinations.models import Destination
from app.main import app
from app.route_transform.models import RouteMapping
from app.routes.models import Route
from app.sources.models import Source
from app.streams.models import Stream

SHARED_SECRET = "RT-WEBHOOK-SECRET-literal-4d5e6f708192"
BEARER = "RT-WEBHOOK-BEARER-literal-aa11bb22cc33"


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def _seed_webhook_workspace(db: Session, *, auth_mode: str = "shared_secret_header", enabled: bool = True) -> dict[str, int]:
    """A webhook receiver stream exactly as the wizard creates it: routes but no mapping row."""

    c = Connector(name="rt-webhook-connector", description=None, status="STOPPED")
    db.add(c)
    db.flush()
    auth_json: dict[str, Any] = {"auth_mode": auth_mode}
    if auth_mode == "shared_secret_header":
        auth_json.update(shared_secret=SHARED_SECRET, header_name="X-GDC-Webhook-Secret")
    elif auth_mode == "bearer_token":
        auth_json.update(bearer_token=BEARER)
    s = Source(
        connector_id=c.id,
        source_type="WEBHOOK_RECEIVER",
        config_json={"connector_type": "webhook_receiver", "receiver_key": "rt-receiver-key", "max_request_bytes": 4096},
        auth_json=auth_json,
        enabled=enabled,
    )
    db.add(s)
    db.flush()
    st = Stream(
        connector_id=c.id,
        source_id=s.id,
        name="rt-webhook-stream",
        stream_type="WEBHOOK_RECEIVER",
        config_json={},
        polling_interval=60,
        enabled=False,
        status="STOPPED",
        rate_limit_json={},
    )
    db.add(st)
    d = Destination(
        name="rt-dest",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://receiver.example/hook", "headers": {"Authorization": "Bearer dest-literal-9988"}},
        rate_limit_json={},
        enabled=True,
    )
    db.add(d)
    db.flush()
    db.add(
        Route(
            stream_id=st.id,
            destination_id=d.id,
            enabled=True,
            failure_policy="LOG_AND_CONTINUE",
            formatter_config_json={},
            rate_limit_json={},
            status="ENABLED",
        )
    )
    db.commit()
    return {"connector_id": int(c.id), "source_id": int(s.id), "stream_id": int(st.id), "destination_id": int(d.id)}


def _preview(client: TestClient, bundle: dict[str, Any], mode: str = "additive") -> dict[str, Any]:
    res = client.post("/api/v1/backup/import/preview", json={"bundle": bundle, "mode": mode})
    assert res.status_code == 200, res.text
    return res.json()


def _apply(client: TestClient, bundle: dict[str, Any], token: str, mode: str = "additive") -> dict[str, Any]:
    res = client.post(
        "/api/v1/backup/import/apply",
        # The bundle comes from this same database, so every name collides; E-124 requires an explicit choice.
        json={"bundle": bundle, "mode": mode, "confirm": True, "preview_token": token, "on_name_conflict": "rename"},
    )
    assert res.status_code == 200, res.text
    return res.json()


def test_unmodified_workspace_export_with_webhook_stream_previews_ok(client: TestClient, db_session: Session) -> None:
    _seed_webhook_workspace(db_session)
    bundle = client.get("/api/v1/backup/workspace/export").json()
    assert bundle["mappings"] == []  # the product really emits no mapping row for a webhook stream
    assert bundle["routes"]
    prev = _preview(client, bundle)
    assert prev["ok"] is True, prev["conflicts"]
    assert not [c for c in prev["conflicts"] if "MAPPING" in c["code"]]


def test_restore_keeps_source_enabled_and_auth_shape_and_names_the_secrets_to_reenter(
    client: TestClient, db_session: Session
) -> None:
    ids = _seed_webhook_workspace(db_session)
    bundle = client.get("/api/v1/backup/workspace/export").json()
    prev = _preview(client, bundle)

    warning_text = " ".join(w["message"] for w in prev["warnings"])
    assert "rt-webhook-connector" in warning_text
    assert "Shared secret" in warning_text
    assert "401" in warning_text  # tells the user what happens until the secret is re-entered

    applied = _apply(client, bundle, prev["preview_token"])
    new_source = db_session.get(Source, applied["created"]["source_ids"][0])
    assert new_source is not None and new_source.id != ids["source_id"]
    assert new_source.enabled is True  # F-210: restored receiver is not disabled
    assert new_source.auth_json["auth_mode"] == "shared_secret_header"
    assert new_source.auth_json["header_name"] == "X-GDC-Webhook-Secret"
    assert "auth_type" not in new_source.auth_json  # no invented "no_auth"
    assert "shared_secret" not in new_source.auth_json
    new_stream = db_session.get(Stream, applied["created"]["stream_ids"][0])
    assert new_stream.enabled is False and new_stream.status == "STOPPED"  # streams stay the safety gate

    reentry = applied["secrets_to_reenter"]
    assert len(reentry) >= 1
    conn_item = next(i for i in reentry if i["entity_type"] == "connector")
    assert conn_item["entity_id"] == applied["created"]["connector_ids"][0]
    assert conn_item["fields"] == ["Shared secret"]
    assert conn_item["blocks_operation"] is True
    assert conn_item["edit_path"] == f"/connectors/{conn_item['entity_id']}"
    assert SHARED_SECRET not in str(applied)

    # The user can re-enter the secret in the browser flow (PUT /connectors/{id}) and the receiver then works.
    connector = client.get(f"/api/v1/connectors/{conn_item['entity_id']}").json()
    assert connector["webhook_shared_secret_configured"] is False
    res = client.put(
        f"/api/v1/connectors/{conn_item['entity_id']}",
        json={
            "expected_updated_at": connector["updated_at"],
            "expected_source_updated_at": connector["source_updated_at"],
            "source_type": "WEBHOOK_RECEIVER",
            "webhook_auth_mode": "shared_secret_header",
            "webhook_shared_secret": "re-entered-secret-value-77",
        },
    )
    assert res.status_code == 200, res.text
    db_session.expire_all()
    assert db_session.get(Source, new_source.id).auth_json["shared_secret"] == "re-entered-secret-value-77"


def test_disabled_source_stays_disabled_after_restore(client: TestClient, db_session: Session) -> None:
    _seed_webhook_workspace(db_session, auth_mode="no_auth", enabled=False)
    bundle = client.get("/api/v1/backup/workspace/export").json()
    prev = _preview(client, bundle)
    assert not [w for w in prev["warnings"] if w["code"] == "MASKED_AUTH_IN_BUNDLE"]
    applied = _apply(client, bundle, prev["preview_token"])
    assert db_session.get(Source, applied["created"]["source_ids"][0]).enabled is False
    # Only the destination header (Authorization) is masked here; the no_auth receiver needs no secret.
    assert [i for i in applied["secrets_to_reenter"] if i["entity_type"] == "connector"] == []


def test_bearer_receiver_restore_names_the_bearer_token(client: TestClient, db_session: Session) -> None:
    _seed_webhook_workspace(db_session, auth_mode="bearer_token")
    bundle = client.get("/api/v1/backup/workspace/export").json()
    prev = _preview(client, bundle)
    applied = _apply(client, bundle, prev["preview_token"])
    item = next(i for i in applied["secrets_to_reenter"] if i["entity_type"] == "connector")
    assert item["fields"] == ["Bearer token"]
    new_source = db_session.get(Source, applied["created"]["source_ids"][0])
    assert new_source.auth_json == {"auth_mode": "bearer_token"}


def test_http_stream_without_any_mapping_is_still_blocked(client: TestClient, db_session: Session) -> None:
    c = Connector(name="rt-http", description=None, status="STOPPED")
    db_session.add(c)
    db_session.flush()
    s = Source(connector_id=c.id, source_type="HTTP_API_POLLING", config_json={"base_url": "https://v.example"}, auth_json={"auth_type": "no_auth"}, enabled=True)
    db_session.add(s)
    db_session.flush()
    st = Stream(connector_id=c.id, source_id=s.id, name="rt-http-stream", stream_type="HTTP_API_POLLING", config_json={}, polling_interval=60, enabled=False, status="STOPPED", rate_limit_json={})
    db_session.add(st)
    d = Destination(name="rt-http-dest", destination_type="WEBHOOK_POST", config_json={"url": "https://r.example/h"}, rate_limit_json={}, enabled=True)
    db_session.add(d)
    db_session.flush()
    route = Route(stream_id=st.id, destination_id=d.id, enabled=True, failure_policy="LOG_AND_CONTINUE", formatter_config_json={}, rate_limit_json={}, status="ENABLED")
    db_session.add(route)
    db_session.commit()
    bundle = client.get("/api/v1/backup/workspace/export").json()
    prev = _preview(client, bundle)
    assert prev["ok"] is False
    assert any(c["code"] in {"ROUTES_WITHOUT_MAPPINGS", "ROUTE_WITHOUT_MAPPING"} for c in prev["conflicts"])

    # Route Processing: a route that carries its own route_mapping needs no stream-level mapping row.
    db_session.add(RouteMapping(route_id=route.id, field_mappings_json={}, raw_payload_mode=None))
    db_session.commit()
    bundle2 = client.get("/api/v1/backup/workspace/export").json()
    assert bundle2["mappings"] == []
    prev2 = _preview(client, bundle2)
    assert prev2["ok"] is True, prev2["conflicts"]
