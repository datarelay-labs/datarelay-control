"""Template instantiate + run-once E2E against WireMock (opt-in; see specs/014-wiremock-template-e2e/spec.md)."""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database import get_db
from app.logs.models import DeliveryLog
from app.main import app
from app.mappings.models import Mapping
from app.templates.registry import clear_template_cache
from tests.e2e_wiremock_helpers import (
    DEFAULT_WIREMOCK,
    assert_run_observability_core,
    create_webhook_destination,
    delivery_log_stages,
    enable_stream_for_run,
    ensure_template_wiremock_mappings,
    reset_wiremock_journal,
    reset_wiremock_scenarios,
    wiremock_received_json_bodies,
    wiremock_reachable,
)

pytestmark = [pytest.mark.wiremock_integration, pytest.mark.e2e_regression]
skip_no_wiremock = pytest.mark.skipif(
    not wiremock_reachable(DEFAULT_WIREMOCK),
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


def _assert_checkpoint_last_success(db: Session, stream_id: int) -> dict[str, Any]:
    from app.checkpoints.models import Checkpoint

    db.expire_all()
    cp = db.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).first()
    assert cp is not None
    data = cp.checkpoint_value_json or {}
    assert isinstance(data, dict)
    assert "last_success_event" in data
    ev = data["last_success_event"]
    assert isinstance(ev, dict)
    return ev


def _put_route_with_token(client, route_id, payload):
    get_res = client.get(f"/api/v1/routes/{route_id}")
    assert get_res.status_code == 200, get_res.text
    body = dict(payload)
    body["expected_updated_at"] = get_res.json()["updated_at"]
    return client.put(f"/api/v1/routes/{route_id}", json=body)

@skip_no_wiremock
@pytest.mark.e2e_smoke
@pytest.mark.e2e_delivery
@pytest.mark.e2e_checkpoint

def test_template_generic_rest_polling_run_once_delivery_logs_checkpoint(
    client: TestClient, db_session: Session
) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_webhook_destination(client, base, path="/receiver/webhook")
    ins = client.post(
        "/api/v1/templates/generic_rest_polling/instantiate",
        json={
            "connector_name": "WireMock tpl generic",
            "host": base,
            "credentials": {"bearer_token": "template-e2e-generic-bearer"},
            "destination_id": dest_id,
            "create_route": True,
        },
    )
    assert ins.status_code == 201, ins.text
    out = ins.json()
    for key in ("connector_id", "source_id", "stream_id", "mapping_id", "enrichment_id", "checkpoint_id", "route_id"):
        assert out.get(key) is not None
    stream_id = int(out["stream_id"])

    st_row = client.get(f"/api/v1/streams/{stream_id}").json()
    assert st_row["enabled"] is False
    assert st_row["status"] == "STOPPED"

    enable_stream_for_run(client, stream_id)

    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    body = run.json()
    assert body.get("checkpoint_updated") is True
    assert int(body.get("extracted_event_count") or 0) >= 1

    db_session.expire_all()
    stages = delivery_log_stages(db_session, stream_id)
    assert "run_started" in stages
    assert "route_send_success" in stages
    assert "checkpoint_update" in stages
    assert "run_complete" in stages

    rows = (
        db_session.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == stream_id)
        .filter(DeliveryLog.stage == "run_complete")
        .all()
    )
    assert rows
    run_ids = {r.run_id for r in rows if r.run_id}
    assert len(run_ids) == 1

    assert_run_observability_core(db_session, stream_id, expect_checkpoint_update=True)

    ev = _assert_checkpoint_last_success(db_session, stream_id)
    assert ev.get("vendor") == "GENERIC_REST"
    assert ev.get("event_id") == "gen-evt-1"
    assert ev.get("message") == "template generic event"

    payloads = wiremock_received_json_bodies(base, path_contains="/receiver/webhook")
    assert payloads, "expected WireMock to record webhook POST body"
    posted = payloads[-1]
    assert posted.get("vendor") == "GENERIC_REST"
    assert posted.get("event_id") == "gen-evt-1"

    hist = client.get(f"/api/v1/runtime/checkpoints/streams/{stream_id}/history", params={"limit": 5})
    assert hist.status_code == 200
    assert hist.json().get("items")


@skip_no_wiremock
@pytest.mark.e2e_auth
@pytest.mark.e2e_delivery
def test_template_stellar_malop_vendor_jwt_bearer_on_search(
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
            "connector_name": "WireMock tpl stellar malop",
            "host": base,
            "credentials": {
                "user_id": "wiremock-user",
                "api_key": "wiremock-secret",
                "token_url": f"{base}/connect/api/v1/access_token",
            },
            "destination_id": dest_id,
            "create_route": True,
        },
    )
    assert ins.status_code == 201, ins.text
    stream_id = int(ins.json()["stream_id"])
    enable_stream_for_run(client, stream_id)

    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    assert run.json().get("checkpoint_updated") is True

    ev = _assert_checkpoint_last_success(db_session, stream_id)
    assert ev.get("vendor") == "StellarCyber"
    assert ev.get("malop_id") == "MALOP-E2E-1"
    assert ev.get("event_id") == "malop-row-1"

    r = httpx.get(f"{base}/__admin/requests", timeout=10.0)
    r.raise_for_status()
    saw_auth = False
    for entry in r.json().get("requests", []):
        req = entry.get("request") or {}
        url = str(req.get("absoluteUrl") or req.get("url") or "")
        if "/connect/api/dataexport/anomalies/malop/_search" not in url:
            continue
        auth: str | None = None
        for hk, hv in (req.get("headers") or {}).items():
            if str(hk).lower() != "authorization":
                continue
            if isinstance(hv, list):
                auth = str(hv[0]) if hv else None
            else:
                auth = str(hv)
            break
        assert auth == "Bearer wiremock-test-token"
        saw_auth = True
    assert saw_auth

    posted = wiremock_received_json_bodies(base, path_contains="/receiver/webhook")[-1]
    assert posted.get("vendor") == "StellarCyber"
    assert posted.get("malop_id") == "MALOP-E2E-1"


@skip_no_wiremock
@pytest.mark.e2e_auth
@pytest.mark.e2e_delivery
def test_template_okta_system_log_oauth2_root_array_mapping(
    client: TestClient, db_session: Session
) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_webhook_destination(client, base, path="/receiver/webhook")
    ins = client.post(
        "/api/v1/templates/okta_system_log/instantiate",
        json={
            "connector_name": "WireMock tpl okta",
            "host": base,
            "credentials": {
                "oauth2_client_id": "okta-e2e-client",
                "oauth2_client_secret": "okta-e2e-secret",
                "oauth2_token_url": f"{base}/oauth2/default/v1/token",
                "oauth2_scope": "okta.logs.read",
            },
            "destination_id": dest_id,
            "create_route": True,
        },
    )
    assert ins.status_code == 201, ins.text
    stream_id = int(ins.json()["stream_id"])

    mapping_row = db_session.query(Mapping).filter(Mapping.stream_id == stream_id).first()
    assert mapping_row is not None
    assert mapping_row.event_array_path is None

    enable_stream_for_run(client, stream_id)

    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    assert run.json().get("checkpoint_updated") is True

    ev = _assert_checkpoint_last_success(db_session, stream_id)
    assert ev.get("vendor") == "Okta"
    assert ev.get("event_id") == "11111111-2222-3333-4444-555555555555"
    assert ev.get("event_type") == "user.session.start"

    posted = wiremock_received_json_bodies(base, path_contains="/receiver/webhook")[-1]
    assert posted.get("vendor") == "Okta"
    assert posted.get("event_id") == "11111111-2222-3333-4444-555555555555"


@skip_no_wiremock
@pytest.mark.e2e_checkpoint
@pytest.mark.e2e_delivery
def test_template_destination_failure_blocks_checkpoint_analytics_health(
    client: TestClient, db_session: Session
) -> None:
    from app.checkpoints.models import Checkpoint

    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_webhook_destination(client, base, path="/wiremock-integration/receiver-fail", retry_count=0)
    ins = client.post(
        "/api/v1/templates/generic_rest_polling/instantiate",
        json={
            "connector_name": "WireMock tpl fail path",
            "host": base,
            "credentials": {"bearer_token": "template-e2e-generic-bearer"},
            "destination_id": dest_id,
            "create_route": True,
        },
    )
    assert ins.status_code == 201, ins.text
    stream_id = int(ins.json()["stream_id"])
    route_id = int(ins.json()["route_id"])

    cp_before = dict(db_session.get(Checkpoint, int(ins.json()["checkpoint_id"])).checkpoint_value_json or {})

    rput = _put_route_with_token(
        client,
        route_id,
        {"failure_policy": "PAUSE_STREAM_ON_FAILURE"},
    )
    assert rput.status_code == 200, rput.text

    enable_stream_for_run(client, stream_id)

    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    assert run.json().get("checkpoint_updated") is False

    db_session.expire_all()
    stages = delivery_log_stages(db_session, stream_id)
    assert "route_send_failed" in stages
    assert "checkpoint_update" not in stages

    cp_after = dict(db_session.get(Checkpoint, int(ins.json()["checkpoint_id"])).checkpoint_value_json or {})
    assert cp_after == cp_before

    af = client.get(
        "/api/v1/runtime/analytics/routes/failures",
        params={"stream_id": stream_id, "window": "24h"},
    )
    assert af.status_code == 200
    totals = af.json().get("totals") or {}
    assert int(totals.get("failure_events") or 0) >= 1

    hs = client.get(f"/api/v1/runtime/health/streams/{stream_id}")
    assert hs.status_code == 200
    body = hs.json()
    score = body.get("score") or {}
    assert int(score.get("score") or 0) < 100


@skip_no_wiremock
@pytest.mark.e2e_retry
@pytest.mark.e2e_checkpoint
def test_template_route_retry_then_success_checkpoint_and_retry_analytics(
    client: TestClient, db_session: Session
) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_webhook_destination(
        client,
        base,
        path="/wiremock-integration/receiver-retry-once",
        retry_count=0,
    )
    ins = client.post(
        "/api/v1/templates/generic_rest_polling/instantiate",
        json={
            "connector_name": "WireMock tpl retry path",
            "host": base,
            "credentials": {"bearer_token": "template-e2e-generic-bearer"},
            "destination_id": dest_id,
            "create_route": True,
        },
    )
    assert ins.status_code == 201, ins.text
    stream_id = int(ins.json()["stream_id"])
    route_id = int(ins.json()["route_id"])

    rput = _put_route_with_token(
        client,
        route_id,
        {"failure_policy": "RETRY_AND_BACKOFF"},
    )
    assert rput.status_code == 200, rput.text

    enable_stream_for_run(client, stream_id)

    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    assert run.json().get("checkpoint_updated") is True

    db_session.expire_all()
    stages = delivery_log_stages(db_session, stream_id)
    assert "route_send_failed" in stages
    assert "route_retry_success" in stages
    assert "checkpoint_update" in stages

    rs = client.get(
        "/api/v1/runtime/analytics/retries/summary",
        params={"stream_id": stream_id, "window": "24h"},
    )
    assert rs.status_code == 200
    summary = rs.json()
    assert int(summary.get("retry_success_events") or 0) >= 1


@skip_no_wiremock
@pytest.mark.e2e_auth
@pytest.mark.e2e_checkpoint
def test_template_generic_source_http_401_no_checkpoint_no_delivery_logs(
    client: TestClient, db_session: Session
) -> None:
    from app.checkpoints.models import Checkpoint

    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_webhook_destination(client, base, path="/receiver/webhook")
    ins = client.post(
        "/api/v1/templates/generic_rest_polling/instantiate",
        json={
            "connector_name": "WireMock tpl auth fail",
            "host": base,
            "credentials": {"bearer_token": "template-e2e-generic-bearer"},
            "destination_id": dest_id,
            "create_route": True,
        },
    )
    assert ins.status_code == 201, ins.text
    stream_id = int(ins.json()["stream_id"])
    ck_id = int(ins.json()["checkpoint_id"])

    st = client.get(f"/api/v1/streams/{stream_id}").json()
    cfg = dict(st.get("config_json") or {})
    cfg["endpoint"] = "/api/v1/events-auth-fail"
    up = client.put(f"/api/v1/streams/{stream_id}", json={"config_json": cfg})
    assert up.status_code == 200, up.text

    cp_before = dict(db_session.get(Checkpoint, ck_id).checkpoint_value_json or {})
    log_count_before = db_session.query(DeliveryLog).filter(DeliveryLog.stream_id == stream_id).count()

    enable_stream_for_run(client, stream_id)

    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 502, run.text
    err = run.json().get("detail") or {}
    assert err.get("error_code") == "SOURCE_HTTP_ERROR"
    assert int(err.get("response_status") or 0) == 401
    masked = err.get("outbound_headers_masked") or {}
    auth_hdr = masked.get("Authorization") or masked.get("authorization")
    assert auth_hdr == "********"

    db_session.expire_all()
    rows_after = (
        db_session.query(DeliveryLog).filter(DeliveryLog.stream_id == stream_id).all()
    )
    stages = {row.stage for row in rows_after}
    # HTTP 401 still records run_started / run_failed; forbid delivery and checkpoint stages.
    assert stages <= {"run_started", "run_failed"}
    assert len(rows_after) >= log_count_before
    cp_after = dict(db_session.get(Checkpoint, ck_id).checkpoint_value_json or {})
    assert cp_after == cp_before
