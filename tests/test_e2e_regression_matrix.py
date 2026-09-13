"""WireMock-backed E2E regression matrix (auth, data shapes, routes, checkpoints, observability).

Requires PostgreSQL (``TEST_DATABASE_URL`` / ``DATABASE_URL``) and WireMock
(``docker compose --profile test up -d wiremock``).
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.database import get_db
from app.logs.models import DeliveryLog
from app.main import app
from app.templates.registry import clear_template_cache
from tests.e2e_wiremock_helpers import (
    DEFAULT_WIREMOCK,
    assert_connector_api_masks_common_secrets,
    assert_run_observability_core,
    create_webhook_destination,
    delivery_log_stages,
    enable_stream_for_run,
    ensure_template_wiremock_mappings,
    json_blob_excludes_secrets,
    reset_wiremock_journal,
    reset_wiremock_scenarios,
    wiremock_received_json_bodies,
    wiremock_reachable,
)

pytestmark = [pytest.mark.wiremock_integration, pytest.mark.e2e_regression]
skip_no_wiremock = pytest.mark.skipif(
    not wiremock_reachable(),
    reason=f"WireMock not reachable at {DEFAULT_WIREMOCK} (start: docker compose --profile test up -d wiremock)",
)


@pytest.fixture
def client(db_session: Session) -> TestClient:
    clear_template_cache()

    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)
        clear_template_cache()


def _instantiate_generic(
    client: TestClient,
    base: str,
    dest_id: int,
    *,
    connector_name: str,
    credentials: dict[str, Any],
) -> dict[str, Any]:
    ins = client.post(
        "/api/v1/templates/generic_rest_polling/instantiate",
        json={
            "connector_name": connector_name,
            "host": base,
            "credentials": credentials,
            "destination_id": dest_id,
            "create_route": True,
        },
    )
    assert ins.status_code == 201, ins.text
    return ins.json()


def _assert_logs_mask_secrets(db: Session, stream_id: int, secrets: tuple[str, ...]) -> None:
    rows = db.query(DeliveryLog).filter(DeliveryLog.stream_id == stream_id).all()
    for r in rows:
        json_blob_excludes_secrets(r.payload_sample, secrets)
        json_blob_excludes_secrets(r.message, secrets)


@skip_no_wiremock
@pytest.mark.e2e_auth

def _put_route_with_token(client, route_id, payload):
    get_res = client.get(f"/api/v1/routes/{route_id}")
    assert get_res.status_code == 200, get_res.text
    body = dict(payload)
    body["expected_updated_at"] = get_res.json()["updated_at"]
    return client.put(f"/api/v1/routes/{route_id}", json=body)

def test_e2e_auth_no_auth_fetch_delivery_masked_connector_response(
    client: TestClient, db_session: Session
) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_webhook_destination(client, base, path="/receiver/webhook")
    out = _instantiate_generic(
        client,
        base,
        dest_id,
        connector_name="E2E no auth",
        credentials={"auth_type": "no_auth"},
    )
    stream_id = int(out["stream_id"])
    connector_id = int(out["connector_id"])

    cr = client.get(f"/api/v1/connectors/{connector_id}")
    assert cr.status_code == 200
    assert_connector_api_masks_common_secrets(cr.json())

    st = client.get(f"/api/v1/streams/{stream_id}").json()
    cfg = dict(st.get("config_json") or {})
    cfg["endpoint"] = "/api/v1/e2e-auth/no-auth-events"
    assert client.put(f"/api/v1/streams/{stream_id}", json={"config_json": cfg}).status_code == 200

    enable_stream_for_run(client, stream_id)
    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    body = run.json()
    assert body.get("checkpoint_updated") is True
    assert int(body.get("extracted_event_count") or 0) >= 1

    assert_run_observability_core(db_session, stream_id, expect_checkpoint_update=True)
    posted = wiremock_received_json_bodies(base, path_contains="/receiver/webhook")[-1]
    assert posted.get("event_id") == "no-auth-1"
    assert posted.get("vendor") == "GENERIC_REST"
    _assert_logs_mask_secrets(db_session, stream_id, ("e2e-basic-pass", "matrix-api-key-secret-value"))


@skip_no_wiremock
@pytest.mark.e2e_auth
def test_e2e_auth_basic_fetch_delivery_and_masking(
    client: TestClient, db_session: Session
) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_webhook_destination(client, base, path="/receiver/webhook")
    secret = "e2e-basic-pass"
    out = _instantiate_generic(
        client,
        base,
        dest_id,
        connector_name="E2E basic",
        credentials={
            "auth_type": "basic",
            "basic_username": "e2e-basic-user",
            "basic_password": secret,
        },
    )
    stream_id = int(out["stream_id"])
    connector_id = int(out["connector_id"])

    cr = client.get(f"/api/v1/connectors/{connector_id}")
    assert cr.status_code == 200
    cj = cr.json()
    assert_connector_api_masks_common_secrets(cj)
    assert cj.get("auth", {}).get("basic_password") == "********"
    json_blob_excludes_secrets(cj, (secret,))

    st = client.get(f"/api/v1/streams/{stream_id}").json()
    cfg = dict(st.get("config_json") or {})
    cfg["endpoint"] = "/api/v1/e2e-auth/basic-events"
    assert client.put(f"/api/v1/streams/{stream_id}", json={"config_json": cfg}).status_code == 200

    enable_stream_for_run(client, stream_id)
    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    assert run.json().get("checkpoint_updated") is True

    posted = wiremock_received_json_bodies(base, path_contains="/receiver/webhook")[-1]
    assert posted.get("event_id") == "basic-evt-1"
    _assert_logs_mask_secrets(db_session, stream_id, (secret,))


@skip_no_wiremock
@pytest.mark.e2e_auth
def test_e2e_auth_api_key_header_success_and_masked_key_on_source_http_error(
    client: TestClient, db_session: Session
) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_webhook_destination(client, base, path="/receiver/webhook")
    api_secret = "matrix-api-key-secret-value"
    out = _instantiate_generic(
        client,
        base,
        dest_id,
        connector_name="E2E api key header",
        credentials={
            "auth_type": "api_key",
            "api_key_name": "X-E2E-Api-Key",
            "api_key_value": api_secret,
            "api_key_location": "headers",
        },
    )
    stream_id = int(out["stream_id"])
    connector_id = int(out["connector_id"])

    cr = client.get(f"/api/v1/connectors/{connector_id}")
    assert cr.status_code == 200
    assert_connector_api_masks_common_secrets(cr.json())
    json_blob_excludes_secrets(cr.json(), (api_secret,))

    st = client.get(f"/api/v1/streams/{stream_id}").json()
    cfg = dict(st.get("config_json") or {})
    cfg["endpoint"] = "/api/v1/e2e-auth/apikey-header-events"
    assert client.put(f"/api/v1/streams/{stream_id}", json={"config_json": cfg}).status_code == 200

    enable_stream_for_run(client, stream_id)
    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    posted = wiremock_received_json_bodies(base, path_contains="/receiver/webhook")[-1]
    assert posted.get("event_id") == "apikey-evt-1"

    st2 = client.get(f"/api/v1/streams/{stream_id}").json()
    cfg2 = dict(st2.get("config_json") or {})
    cfg2["endpoint"] = "/api/v1/events-auth-fail"
    assert client.put(f"/api/v1/streams/{stream_id}", json={"config_json": cfg2}).status_code == 200

    run2 = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run2.status_code == 502, run2.text
    err = run2.json().get("detail") or {}
    assert err.get("error_code") == "SOURCE_HTTP_ERROR"
    masked = err.get("outbound_headers_masked") or {}
    assert masked.get("X-E2E-Api-Key") == "********" or masked.get("x-e2e-api-key") == "********"
    json_blob_excludes_secrets(err, (api_secret,))


@skip_no_wiremock
@pytest.mark.e2e_auth
def test_e2e_auth_api_key_query_params_fetch(
    client: TestClient, db_session: Session
) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_webhook_destination(client, base, path="/receiver/webhook")
    qsecret = "matrix-query-secret"
    out = _instantiate_generic(
        client,
        base,
        dest_id,
        connector_name="E2E api key query",
        credentials={
            "auth_type": "api_key",
            "api_key_name": "api_token",
            "api_key_value": qsecret,
            "api_key_location": "query_params",
        },
    )
    stream_id = int(out["stream_id"])

    st = client.get(f"/api/v1/streams/{stream_id}").json()
    cfg = dict(st.get("config_json") or {})
    cfg["endpoint"] = "/api/v1/e2e-auth/apikey-query-events"
    assert client.put(f"/api/v1/streams/{stream_id}", json={"config_json": cfg}).status_code == 200

    enable_stream_for_run(client, stream_id)
    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    posted = wiremock_received_json_bodies(base, path_contains="/receiver/webhook")[-1]
    assert posted.get("event_id") == "apikey-q-1"
    json_blob_excludes_secrets(client.get(f"/api/v1/connectors/{out['connector_id']}").json(), (qsecret,))


@skip_no_wiremock
@pytest.mark.e2e_auth
@pytest.mark.e2e_checkpoint
def test_e2e_auth_vendor_jwt_token_http_error_no_checkpoint_no_logs(
    client: TestClient, db_session: Session
) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_webhook_destination(client, base, path="/receiver/webhook")
    ins = client.post(
        "/api/v1/templates/stellar_cyber_malop_api/instantiate",
        json={
            "connector_name": "E2E vendor jwt bad token url",
            "host": base,
            "credentials": {
                "user_id": "wiremock-user",
                "api_key": "wiremock-secret",
                "token_url": f"{base}/connect/api/v1/access_token-unauthorized",
            },
            "destination_id": dest_id,
            "create_route": True,
        },
    )
    assert ins.status_code == 201, ins.text
    stream_id = int(ins.json()["stream_id"])
    ck_id = int(ins.json()["checkpoint_id"])
    cp_row = db_session.get(Checkpoint, ck_id)
    assert cp_row is not None
    cp_before = dict(cp_row.checkpoint_value_json or {})
    log_before = db_session.query(DeliveryLog).filter(DeliveryLog.stream_id == stream_id).count()

    enable_stream_for_run(client, stream_id)
    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 502, run.text
    json_blob_excludes_secrets(run.json(), ("wiremock-secret",))

    db_session.expire_all()
    rows_after = (
        db_session.query(DeliveryLog).filter(DeliveryLog.stream_id == stream_id).all()
    )
    stages = {row.stage for row in rows_after}
    # Auth failure still emits lifecycle entry/failure telemetry; no delivery outcomes.
    assert stages <= {"run_started", "run_failed"}
    assert len(rows_after) >= log_before
    cp_after = dict((db_session.get(Checkpoint, ck_id) or cp_row).checkpoint_value_json or {})
    assert cp_after == cp_before


@skip_no_wiremock
@pytest.mark.e2e_auth
@pytest.mark.e2e_checkpoint
def test_e2e_auth_oauth2_token_reject_no_checkpoint(
    client: TestClient, db_session: Session
) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_webhook_destination(client, base, path="/receiver/webhook")
    bad_secret = "definitely-not-okta-e2e-secret"
    ins = client.post(
        "/api/v1/templates/okta_system_log/instantiate",
        json={
            "connector_name": "E2E okta bad oauth",
            "host": base,
            "credentials": {
                "oauth2_client_id": "okta-e2e-client",
                "oauth2_client_secret": bad_secret,
                "oauth2_token_url": f"{base}/oauth2/default/v1/token-reject",
                "oauth2_scope": "okta.logs.read",
            },
            "destination_id": dest_id,
            "create_route": True,
        },
    )
    assert ins.status_code == 201, ins.text
    stream_id = int(ins.json()["stream_id"])
    ck_id = int(ins.json()["checkpoint_id"])
    cp_row = db_session.get(Checkpoint, ck_id)
    assert cp_row is not None
    cp_before = dict(cp_row.checkpoint_value_json or {})
    log_before = db_session.query(DeliveryLog).filter(DeliveryLog.stream_id == stream_id).count()

    enable_stream_for_run(client, stream_id)
    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 502, run.text
    json_blob_excludes_secrets(run.json(), (bad_secret,))

    db_session.expire_all()
    rows_after = (
        db_session.query(DeliveryLog).filter(DeliveryLog.stream_id == stream_id).all()
    )
    stages = {row.stage for row in rows_after}
    assert stages <= {"run_started", "run_failed"}
    assert len(rows_after) >= log_before
    cp_after = dict(db_session.get(Checkpoint, ck_id).checkpoint_value_json or {})  # type: ignore[union-attr]
    assert cp_after == cp_before


@skip_no_wiremock
@pytest.mark.e2e_delivery
def test_e2e_data_single_object_root_event_mapping_delivery_logs(
    client: TestClient, db_session: Session
) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_webhook_destination(client, base, path="/receiver/webhook")
    out = _instantiate_generic(
        client,
        base,
        dest_id,
        connector_name="E2E single object",
        credentials={"bearer_token": "template-e2e-generic-bearer"},
    )
    stream_id = int(out["stream_id"])

    mp = client.post(
        f"/api/v1/runtime/mappings/stream/{stream_id}/save",
        json={
            "event_array_path": None,
            "event_root_path": None,
            "field_mappings": {
                "event_id": "$.id",
                "message": "$.message",
                "severity": "$.severity",
            },
        },
    )
    assert mp.status_code == 200, mp.text

    st = client.get(f"/api/v1/streams/{stream_id}").json()
    cfg = dict(st.get("config_json") or {})
    cfg["endpoint"] = "/api/v1/e2e-data/single-object"
    assert client.put(f"/api/v1/streams/{stream_id}", json={"config_json": cfg}).status_code == 200

    enable_stream_for_run(client, stream_id)
    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    assert run.json().get("checkpoint_updated") is True
    assert_run_observability_core(db_session, stream_id, expect_checkpoint_update=True)

    posted = wiremock_received_json_bodies(base, path_contains="/receiver/webhook")[-1]
    assert posted.get("event_id") == "single-root-1"
    assert posted.get("vendor") == "GENERIC_REST"
    assert "route_send_success" in delivery_log_stages(db_session, stream_id)


@skip_no_wiremock
@pytest.mark.e2e_delivery
def test_e2e_data_nested_array_extraction_mapping_delivery(
    client: TestClient, db_session: Session
) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_webhook_destination(client, base, path="/receiver/webhook")
    out = _instantiate_generic(
        client,
        base,
        dest_id,
        connector_name="E2E nested array",
        credentials={"bearer_token": "template-e2e-generic-bearer"},
    )
    stream_id = int(out["stream_id"])

    mp = client.post(
        f"/api/v1/runtime/mappings/stream/{stream_id}/save",
        json={
            "event_array_path": "$.outer.inner.records",
            "event_root_path": None,
            "field_mappings": {
                "event_id": "$.id",
                "message": "$.message",
                "severity": "$.severity",
            },
        },
    )
    assert mp.status_code == 200, mp.text

    st = client.get(f"/api/v1/streams/{stream_id}").json()
    cfg = dict(st.get("config_json") or {})
    cfg["endpoint"] = "/api/v1/e2e-data/nested-array"
    assert client.put(f"/api/v1/streams/{stream_id}", json={"config_json": cfg}).status_code == 200

    enable_stream_for_run(client, stream_id)
    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    posted = wiremock_received_json_bodies(base, path_contains="/receiver/webhook")[-1]
    assert posted.get("event_id") == "nested-1"


@skip_no_wiremock
@pytest.mark.e2e_delivery
@pytest.mark.e2e_checkpoint
def test_e2e_data_empty_array_no_checkpoint_update_delivery_logs_minimal(
    client: TestClient, db_session: Session
) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_webhook_destination(client, base, path="/receiver/webhook")
    out = _instantiate_generic(
        client,
        base,
        dest_id,
        connector_name="E2E empty data",
        credentials={"bearer_token": "template-e2e-generic-bearer"},
    )
    stream_id = int(out["stream_id"])

    st = client.get(f"/api/v1/streams/{stream_id}").json()
    cfg = dict(st.get("config_json") or {})
    cfg["endpoint"] = "/api/v1/e2e-data/empty-array"
    assert client.put(f"/api/v1/streams/{stream_id}", json={"config_json": cfg}).status_code == 200

    enable_stream_for_run(client, stream_id)
    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    body = run.json()
    assert body.get("outcome") == "no_events"
    assert body.get("checkpoint_updated") is False
    assert_run_observability_core(db_session, stream_id, expect_checkpoint_update=False)
    assert not wiremock_received_json_bodies(base, path_contains="/receiver/webhook")


@skip_no_wiremock
@pytest.mark.e2e_delivery
def test_e2e_data_get_with_query_params_mapping_delivery(
    client: TestClient, db_session: Session
) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_webhook_destination(client, base, path="/receiver/webhook")
    out = _instantiate_generic(
        client,
        base,
        dest_id,
        connector_name="E2E query params",
        credentials={"bearer_token": "template-e2e-generic-bearer"},
    )
    stream_id = int(out["stream_id"])

    st = client.get(f"/api/v1/streams/{stream_id}").json()
    cfg = dict(st.get("config_json") or {})
    cfg["endpoint"] = "/api/v1/e2e-data/filtered"
    cfg["params"] = {"filter": "e2e-matrix", "tenant": "acme"}
    assert client.put(f"/api/v1/streams/{stream_id}", json={"config_json": cfg}).status_code == 200

    enable_stream_for_run(client, stream_id)
    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    posted = wiremock_received_json_bodies(base, path_contains="/receiver/webhook")[-1]
    assert posted.get("event_id") == "query-1"


@skip_no_wiremock
@pytest.mark.e2e_delivery
def test_e2e_data_post_json_body_mapping_delivery(
    client: TestClient, db_session: Session
) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_webhook_destination(client, base, path="/receiver/webhook")
    out = _instantiate_generic(
        client,
        base,
        dest_id,
        connector_name="E2E post json",
        credentials={"bearer_token": "template-e2e-generic-bearer"},
    )
    stream_id = int(out["stream_id"])

    st = client.get(f"/api/v1/streams/{stream_id}").json()
    cfg = dict(st.get("config_json") or {})
    cfg["method"] = "POST"
    cfg["endpoint"] = "/api/v1/e2e-data/search"
    cfg["body"] = {"q": "malware", "size": 10}
    assert client.put(f"/api/v1/streams/{stream_id}", json={"config_json": cfg}).status_code == 200

    enable_stream_for_run(client, stream_id)
    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    posted = wiremock_received_json_bodies(base, path_contains="/receiver/webhook")[-1]
    assert posted.get("event_id") == "post-body-1"


@skip_no_wiremock
@pytest.mark.e2e_delivery
def test_e2e_data_static_pagination_response_shape(
    client: TestClient, db_session: Session
) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_webhook_destination(client, base, path="/receiver/webhook")
    out = _instantiate_generic(
        client,
        base,
        dest_id,
        connector_name="E2E paged static",
        credentials={"bearer_token": "template-e2e-generic-bearer"},
    )
    stream_id = int(out["stream_id"])

    st = client.get(f"/api/v1/streams/{stream_id}").json()
    cfg = dict(st.get("config_json") or {})
    cfg["endpoint"] = "/api/v1/e2e-data/paged"
    cfg["params"] = {"page": "1"}
    assert client.put(f"/api/v1/streams/{stream_id}", json={"config_json": cfg}).status_code == 200

    enable_stream_for_run(client, stream_id)
    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    posted = wiremock_received_json_bodies(base, path_contains="/receiver/webhook")[-1]
    assert posted.get("event_id") == "paged-1"


@skip_no_wiremock
@pytest.mark.e2e_checkpoint
def test_e2e_checkpoint_source_ok_but_destination_disabled_skips_delivery(
    client: TestClient, db_session: Session
) -> None:
    """When all routes resolve to a disabled destination, fetch succeeds but checkpoint must not advance."""

    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_webhook_destination(client, base, path="/receiver/webhook")
    out = _instantiate_generic(
        client,
        base,
        dest_id,
        connector_name="E2E dest disabled",
        credentials={"bearer_token": "template-e2e-generic-bearer"},
    )
    stream_id = int(out["stream_id"])
    ck_id = int(out["checkpoint_id"])
    cp_before = dict(db_session.get(Checkpoint, ck_id).checkpoint_value_json or {})  # type: ignore[union-attr]

    assert client.put(f"/api/v1/destinations/{dest_id}", json={"enabled": False}).status_code == 200

    enable_stream_for_run(client, stream_id)
    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    body = run.json()
    assert int(body.get("extracted_event_count") or 0) >= 1
    assert body.get("checkpoint_updated") is False
    assert body.get("delivered_batch_event_count") in (0, None)

    db_session.expire_all()
    cp_after = dict(db_session.get(Checkpoint, ck_id).checkpoint_value_json or {})  # type: ignore[union-attr]
    assert cp_after == cp_before
    assert "checkpoint_update" not in delivery_log_stages(db_session, stream_id)
    assert "route_skip" in delivery_log_stages(db_session, stream_id)


@skip_no_wiremock
@pytest.mark.e2e_checkpoint
def test_e2e_checkpoint_pause_on_failure_keeps_checkpoint_extracts_events(
    client: TestClient, db_session: Session
) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_webhook_destination(client, base, path="/wiremock-integration/receiver-fail", retry_count=0)
    out = _instantiate_generic(
        client,
        base,
        dest_id,
        connector_name="E2E pause preserves cp",
        credentials={"bearer_token": "template-e2e-generic-bearer"},
    )
    stream_id = int(out["stream_id"])
    route_id = int(out["route_id"])
    ck_id = int(out["checkpoint_id"])

    assert (
        _put_route_with_token(client, route_id, {"failure_policy": "PAUSE_STREAM_ON_FAILURE"}).status_code
        == 200
    )

    cp_before = dict(db_session.get(Checkpoint, ck_id).checkpoint_value_json or {})  # type: ignore[union-attr]

    enable_stream_for_run(client, stream_id)
    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    body = run.json()
    assert int(body.get("extracted_event_count") or 0) >= 1
    assert body.get("checkpoint_updated") is False

    db_session.expire_all()
    cp_after = dict(db_session.get(Checkpoint, ck_id).checkpoint_value_json or {})  # type: ignore[union-attr]
    assert cp_after == cp_before
    assert "route_send_failed" in delivery_log_stages(db_session, stream_id)


@skip_no_wiremock
@pytest.mark.e2e_delivery
def test_e2e_route_fanout_one_log_continue_fail_one_success_checkpoint_advances(
    client: TestClient, db_session: Session
) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_ok = create_webhook_destination(client, base, path="/receiver/webhook")
    dest_fail = create_webhook_destination(client, base, path="/wiremock-integration/receiver-fail", retry_count=0)

    out = _instantiate_generic(
        client,
        base,
        dest_ok,
        connector_name="E2E fanout mixed",
        credentials={"bearer_token": "template-e2e-generic-bearer"},
    )
    stream_id = int(out["stream_id"])
    route_ok = int(out["route_id"])

    assert (
        _put_route_with_token(
            client,
            route_ok,
            {"failure_policy": "LOG_AND_CONTINUE"},
        ).status_code
        == 200
    )

    r2 = client.post(
        "/api/v1/routes/",
        json={
            "stream_id": stream_id,
            "destination_id": dest_fail,
            "enabled": True,
            "failure_policy": "LOG_AND_CONTINUE",
            "formatter_config_json": {"message_format": "json"},
            "rate_limit_json": {"max_events": 500, "per_seconds": 1},
            "status": "ENABLED",
        },
    )
    assert r2.status_code == 201, r2.text

    enable_stream_for_run(client, stream_id)
    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    assert run.json().get("checkpoint_updated") is True

    stages = delivery_log_stages(db_session, stream_id)
    assert "route_send_success" in stages
    assert "route_send_failed" in stages

    ok_payloads = wiremock_received_json_bodies(base, path_contains="/receiver/webhook")
    assert ok_payloads, "expected success webhook delivery"


@skip_no_wiremock
@pytest.mark.e2e_delivery
def test_e2e_route_db_disabled_excluded_other_route_delivers(
    client: TestClient, db_session: Session
) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_a = create_webhook_destination(client, base, path="/receiver/webhook")
    dest_b = create_webhook_destination(client, base, path="/receiver/webhook")

    out = _instantiate_generic(
        client,
        base,
        dest_a,
        connector_name="E2E route disabled",
        credentials={"bearer_token": "template-e2e-generic-bearer"},
    )
    stream_id = int(out["stream_id"])
    route_a = int(out["route_id"])

    r2 = client.post(
        "/api/v1/routes/",
        json={
            "stream_id": stream_id,
            "destination_id": dest_b,
            "enabled": True,
            "failure_policy": "LOG_AND_CONTINUE",
            "formatter_config_json": {"message_format": "json"},
            "rate_limit_json": {"max_events": 500, "per_seconds": 1},
            "status": "ENABLED",
        },
    )
    assert r2.status_code == 201, r2.text
    route_b = int(r2.json()["id"])

    assert _put_route_with_token(client, route_b, {"enabled": False}).status_code == 200

    enable_stream_for_run(client, stream_id)
    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text

    bodies = wiremock_received_json_bodies(base, path_contains="/receiver/webhook")
    assert len(bodies) == 1
    assert bodies[0].get("event_id") == "gen-evt-1"


@skip_no_wiremock
@pytest.mark.e2e_auth
@pytest.mark.e2e_delivery
def test_e2e_session_login_fetch_delivery_logs(
    client: TestClient, db_session: Session
) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    conn = client.post(
        "/api/v1/connectors/",
        json={
            "name": f"e2e-session-{uuid.uuid4().hex[:8]}",
            "auth_type": "session_login",
            "base_url": base,
            "verify_ssl": False,
            "login_url": base,
            "login_path": "/e2e-session/login",
            "login_method": "POST",
            "login_username": "session-user",
            "login_password": "session-pass-unique-9231",
            "session_cookie_name": "GDCSESS",
        },
    )
    assert conn.status_code == 201, conn.text
    connector_id = int(conn.json()["id"])
    source_id = int(conn.json()["source_id"])

    st = client.post(
        "/api/v1/streams/",
        json={
            "name": "session-login-stream",
            "connector_id": connector_id,
            "source_id": source_id,
            "stream_type": "HTTP_API_POLLING",
            "config_json": {
                "method": "GET",
                "endpoint": "/e2e-session/events",
            },
            "polling_interval": 60,
            "enabled": True,
            "status": "RUNNING",
            "rate_limit_json": {"max_requests": 100, "per_seconds": 60},
        },
    )
    assert st.status_code == 201, st.text
    stream_id = int(st.json()["id"])

    mp = client.post(
        f"/api/v1/runtime/mappings/stream/{stream_id}/save",
        json={
            "event_array_path": "$.data",
            "event_root_path": None,
            "field_mappings": {
                "event_id": "$.id",
                "message": "$.message",
                "severity": "$.severity",
            },
        },
    )
    assert mp.status_code == 200, mp.text

    en = client.post(
        f"/api/v1/runtime/enrichments/stream/{stream_id}/save",
        json={
            "enrichment": {"vendor": "SESSION_LOGIN_E2E", "product": "WireMock"},
            "override_policy": "fill_missing",
            "enabled": True,
        },
    )
    assert en.status_code == 200, en.text

    dest_id = create_webhook_destination(client, base, path="/receiver/webhook")
    rt = client.post(
        "/api/v1/routes/",
        json={
            "stream_id": stream_id,
            "destination_id": dest_id,
            "enabled": True,
            "failure_policy": "LOG_AND_CONTINUE",
            "formatter_config_json": {"message_format": "json"},
            "rate_limit_json": {"max_events": 500, "per_seconds": 1},
            "status": "ENABLED",
        },
    )
    assert rt.status_code == 201, rt.text

    cread = client.get(f"/api/v1/connectors/{connector_id}")
    assert cread.status_code == 200
    assert_connector_api_masks_common_secrets(cread.json())
    json_blob_excludes_secrets(cread.json(), ("session-pass-unique-9231",))

    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    assert run.json().get("checkpoint_updated") is True

    posted = wiremock_received_json_bodies(base, path_contains="/receiver/webhook")[-1]
    assert posted.get("event_id") == "session-evt-1"
    assert posted.get("vendor") == "SESSION_LOGIN_E2E"
    assert_run_observability_core(db_session, stream_id, expect_checkpoint_update=True)
    _assert_logs_mask_secrets(db_session, stream_id, ("session-pass-unique-9231",))


@skip_no_wiremock
@pytest.mark.e2e_delivery
def test_e2e_analytics_and_health_after_route_failure(
    client: TestClient, db_session: Session
) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_webhook_destination(client, base, path="/wiremock-integration/receiver-fail", retry_count=0)
    out = _instantiate_generic(
        client,
        base,
        dest_id,
        connector_name="E2E analytics health",
        credentials={"bearer_token": "template-e2e-generic-bearer"},
    )
    stream_id = int(out["stream_id"])
    route_id = int(out["route_id"])

    assert (
        _put_route_with_token(client, route_id, {"failure_policy": "PAUSE_STREAM_ON_FAILURE"}).status_code
        == 200
    )

    h0 = client.get(f"/api/v1/runtime/health/streams/{stream_id}")
    assert h0.status_code == 200
    score0 = int((h0.json().get("score") or {}).get("score") or 0)

    enable_stream_for_run(client, stream_id)
    assert client.post(f"/api/v1/runtime/streams/{stream_id}/run-once").status_code == 200

    af = client.get("/api/v1/runtime/analytics/routes/failures", params={"stream_id": stream_id, "window": "24h"})
    assert af.status_code == 200
    assert int((af.json().get("totals") or {}).get("failure_events") or 0) >= 1

    h1 = client.get(f"/api/v1/runtime/health/streams/{stream_id}")
    assert h1.status_code == 200
    score1 = int((h1.json().get("score") or {}).get("score") or 0)
    assert score1 <= score0
