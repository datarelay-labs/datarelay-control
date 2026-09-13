"""E2E Syslog TCP/UDP delivery via StreamRunner (WireMock HTTP source + local receivers)."""

from __future__ import annotations

import socket
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.database import get_db
from app.main import app
from app.templates.registry import clear_template_cache
from tests.e2e_syslog_helpers import (
    assert_syslog_contains_mapped_and_enrichment,
    create_syslog_tcp_destination,
    create_syslog_udp_destination,
    wait_for_syslog_message,
)
from tests.e2e_wiremock_helpers import (
    DEFAULT_WIREMOCK,
    assert_run_observability_core,
    create_webhook_destination,
    delivery_log_stages,
    delivery_logs_by_stage,
    enable_stream_for_run,
    ensure_template_wiremock_mappings,
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


def _unused_local_tcp_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = int(s.getsockname()[1])
    s.close()
    return port


def _instantiate_generic_syslog(
    client: TestClient,
    base: str,
    dest_id: int,
    *,
    connector_name: str,
) -> dict[str, Any]:
    ins = client.post(
        "/api/v1/templates/generic_rest_polling/instantiate",
        json={
            "connector_name": connector_name,
            "host": base,
            "credentials": {"bearer_token": "template-e2e-generic-bearer"},
            "destination_id": dest_id,
            "create_route": True,
        },
    )
    assert ins.status_code == 201, ins.text
    return ins.json()


def _apply_single_object_mapping_and_endpoint(client: TestClient, stream_id: int) -> None:
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


def _assert_destination_and_route_rows(client: TestClient, destination_id: int, route_id: int) -> None:
    d = client.get(f"/api/v1/destinations/{destination_id}")
    assert d.status_code == 200, d.text
    assert d.json().get("id") == destination_id
    r = client.get(f"/api/v1/routes/{route_id}")
    assert r.status_code == 200, r.text
    assert r.json().get("id") == route_id


def _assert_run_id_on_stages(db: Session, stream_id: int, stages: tuple[str, ...]) -> str:
    db.expire_all()
    started = delivery_logs_by_stage(db, stream_id, "run_started")
    assert started, "expected run_started delivery_log"
    run_id = str(started[-1].run_id or "")
    assert len(run_id) >= 8
    for st in stages:
        rows = delivery_logs_by_stage(db, stream_id, st)
        assert rows, f"expected delivery_logs stage {st}"
        for r in rows:
            assert r.run_id is not None, f"missing run_id on stage {st}"
            assert str(r.run_id) == run_id, f"run_id mismatch for {st}"
    return run_id


@skip_no_wiremock
@pytest.mark.e2e_smoke
@pytest.mark.e2e_delivery
@pytest.mark.e2e_checkpoint

def _put_route_with_token(client, route_id, payload):
    get_res = client.get(f"/api/v1/routes/{route_id}")
    assert get_res.status_code == 200, get_res.text
    body = dict(payload)
    body["expected_updated_at"] = get_res.json()["updated_at"]
    return client.put(f"/api/v1/routes/{route_id}", json=body)

def test_e2e_syslog_udp_http_mapping_enrichment_delivery(
    client: TestClient,
    db_session: Session,
    syslog_udp_receiver: Any,
) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_syslog_udp_destination(client, syslog_udp_receiver.host, syslog_udp_receiver.port)
    out = _instantiate_generic_syslog(
        client,
        base,
        dest_id,
        connector_name=f"E2E syslog udp {uuid.uuid4().hex[:8]}",
    )
    stream_id = int(out["stream_id"])
    route_id = int(out["route_id"])
    _assert_destination_and_route_rows(client, dest_id, route_id)
    _apply_single_object_mapping_and_endpoint(client, stream_id)

    enable_stream_for_run(client, stream_id)
    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    body = run.json()
    assert body.get("checkpoint_updated") is True
    assert body.get("transaction_committed") is True
    assert int(body.get("extracted_event_count") or 0) >= 1

    assert_run_observability_core(db_session, stream_id, expect_checkpoint_update=True)
    assert "route_send_success" in delivery_log_stages(db_session, stream_id)
    _assert_run_id_on_stages(db_session, stream_id, ("route_send_success", "checkpoint_update", "run_complete"))

    ev = wait_for_syslog_message(syslog_udp_receiver, lambda j: j.get("event_id") == "single-root-1")
    assert_syslog_contains_mapped_and_enrichment(ev)


@skip_no_wiremock
@pytest.mark.e2e_delivery
@pytest.mark.e2e_checkpoint
def test_e2e_syslog_tcp_http_mapping_enrichment_delivery(
    client: TestClient,
    db_session: Session,
    syslog_tcp_receiver: Any,
) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_syslog_tcp_destination(client, syslog_tcp_receiver.host, syslog_tcp_receiver.port)
    out = _instantiate_generic_syslog(
        client,
        base,
        dest_id,
        connector_name=f"E2E syslog tcp {uuid.uuid4().hex[:8]}",
    )
    stream_id = int(out["stream_id"])
    route_id = int(out["route_id"])
    _assert_destination_and_route_rows(client, dest_id, route_id)
    _apply_single_object_mapping_and_endpoint(client, stream_id)

    enable_stream_for_run(client, stream_id)
    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    assert run.json().get("checkpoint_updated") is True
    assert run.json().get("transaction_committed") is True

    assert_run_observability_core(db_session, stream_id, expect_checkpoint_update=True)
    assert "route_send_success" in delivery_log_stages(db_session, stream_id)

    ev = wait_for_syslog_message(syslog_tcp_receiver, lambda j: j.get("event_id") == "single-root-1")
    assert_syslog_contains_mapped_and_enrichment(ev)


@skip_no_wiremock
@pytest.mark.e2e_delivery
@pytest.mark.e2e_checkpoint
def test_e2e_syslog_fanout_webhook_and_syslog_tcp(
    client: TestClient,
    db_session: Session,
    syslog_tcp_receiver: Any,
) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_webhook = create_webhook_destination(client, base, path="/receiver/webhook")
    out = _instantiate_generic_syslog(
        client,
        base,
        dest_webhook,
        connector_name=f"E2E fanout {uuid.uuid4().hex[:8]}",
    )
    stream_id = int(out["stream_id"])
    route_wh = int(out["route_id"])
    _assert_destination_and_route_rows(client, dest_webhook, route_wh)

    dest_syslog = create_syslog_tcp_destination(client, syslog_tcp_receiver.host, syslog_tcp_receiver.port)
    r2 = client.post(
        "/api/v1/routes/",
        json={
            "stream_id": stream_id,
            "destination_id": dest_syslog,
            "enabled": True,
            "failure_policy": "LOG_AND_CONTINUE",
            "formatter_config_json": {"message_format": "json"},
            "rate_limit_json": {"max_events": 500, "per_seconds": 1},
            "status": "ENABLED",
        },
    )
    assert r2.status_code == 201, r2.text
    route_sys = int(r2.json()["id"])
    _assert_destination_and_route_rows(client, dest_syslog, route_sys)

    _apply_single_object_mapping_and_endpoint(client, stream_id)

    enable_stream_for_run(client, stream_id)
    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    assert run.json().get("checkpoint_updated") is True
    assert run.json().get("transaction_committed") is True

    assert_run_observability_core(db_session, stream_id, expect_checkpoint_update=True)
    assert len(delivery_logs_by_stage(db_session, stream_id, "route_send_success")) >= 2

    posted = wiremock_received_json_bodies(base, path_contains="/receiver/webhook")[-1]
    assert posted.get("event_id") == "single-root-1"
    assert posted.get("vendor") == "GENERIC_REST"
    assert posted.get("message") == "single object root"

    ev = wait_for_syslog_message(syslog_tcp_receiver, lambda j: j.get("event_id") == "single-root-1")
    assert_syslog_contains_mapped_and_enrichment(ev)


@skip_no_wiremock
@pytest.mark.e2e_delivery
@pytest.mark.e2e_checkpoint
def test_e2e_syslog_pause_on_unreachable_tcp_no_checkpoint(
    client: TestClient,
    db_session: Session,
) -> None:
    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    bad_port = _unused_local_tcp_port()
    dest_id = create_syslog_tcp_destination(client, "127.0.0.1", bad_port)
    out = _instantiate_generic_syslog(
        client,
        base,
        dest_id,
        connector_name=f"E2E syslog pause {uuid.uuid4().hex[:8]}",
    )
    stream_id = int(out["stream_id"])
    route_id = int(out["route_id"])
    ck_id = int(out["checkpoint_id"])
    cp_before = dict(db_session.get(Checkpoint, ck_id).checkpoint_value_json or {})  # type: ignore[union-attr]

    assert (
        _put_route_with_token(client, route_id, {"failure_policy": "PAUSE_STREAM_ON_FAILURE"}).status_code == 200
    )

    _apply_single_object_mapping_and_endpoint(client, stream_id)

    enable_stream_for_run(client, stream_id)
    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    body = run.json()
    assert body.get("checkpoint_updated") is False
    assert body.get("transaction_committed") is True
    assert int(body.get("extracted_event_count") or 0) >= 1

    assert_run_observability_core(db_session, stream_id, expect_checkpoint_update=False)
    stages = delivery_log_stages(db_session, stream_id)
    assert "route_send_failed" in stages
    assert "checkpoint_update" not in stages

    db_session.expire_all()
    cp_after = dict(db_session.get(Checkpoint, ck_id).checkpoint_value_json or {})  # type: ignore[union-attr]
    assert cp_after == cp_before

    _assert_run_id_on_stages(db_session, stream_id, ("route_send_failed", "run_complete"))


@skip_no_wiremock
@pytest.mark.e2e_delivery
@pytest.mark.e2e_checkpoint
@pytest.mark.e2e_retry
def test_e2e_syslog_tcp_retry_success_advances_checkpoint(
    client: TestClient,
    db_session: Session,
    syslog_tcp_receiver: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """First TCP connect to the syslog destination fails once (transport); retry uses real SyslogSender."""

    import app.delivery.syslog_sender as syslog_sender_mod

    base = DEFAULT_WIREMOCK.rstrip("/")
    ensure_template_wiremock_mappings(base)
    reset_wiremock_scenarios(base)
    reset_wiremock_journal(base)

    dest_id = create_syslog_tcp_destination(
        client,
        syslog_tcp_receiver.host,
        syslog_tcp_receiver.port,
    )

    expect_host = str(syslog_tcp_receiver.host)
    expect_port = int(syslog_tcp_receiver.port)
    orig_create_connection = syslog_sender_mod.socket.create_connection
    attempts = {"n": 0}

    def _create_connection_fail_first_syslog_dest(*args: Any, **kwargs: Any) -> Any:
        addr = args[0] if args else kwargs.get("address")
        if isinstance(addr, tuple) and len(addr) >= 2:
            host, port = str(addr[0]), int(addr[1])
            if port == expect_port and host in {expect_host, "127.0.0.1", "localhost", "::1"}:
                attempts["n"] += 1
                if attempts["n"] == 1:
                    raise OSError(111, "Connection refused (injected first TCP attempt for E2E)")
        return orig_create_connection(*args, **kwargs)

    monkeypatch.setattr(syslog_sender_mod.socket, "create_connection", _create_connection_fail_first_syslog_dest)
    out = _instantiate_generic_syslog(
        client,
        base,
        dest_id,
        connector_name=f"E2E syslog retry {uuid.uuid4().hex[:8]}",
    )
    stream_id = int(out["stream_id"])
    route_id = int(out["route_id"])
    assert _put_route_with_token(client, route_id, {"failure_policy": "RETRY_AND_BACKOFF"}).status_code == 200

    _apply_single_object_mapping_and_endpoint(client, stream_id)

    enable_stream_for_run(client, stream_id)
    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    assert run.json().get("checkpoint_updated") is True
    assert run.json().get("transaction_committed") is True

    assert_run_observability_core(db_session, stream_id, expect_checkpoint_update=True)
    stages = delivery_log_stages(db_session, stream_id)
    assert "route_send_failed" in stages
    assert "route_retry_success" in stages

    retry_rows = delivery_logs_by_stage(db_session, stream_id, "route_retry_success")
    assert retry_rows
    _assert_run_id_on_stages(
        db_session,
        stream_id,
        ("route_send_failed", "route_retry_success", "checkpoint_update", "run_complete"),
    )

    ev = wait_for_syslog_message(syslog_tcp_receiver, lambda j: j.get("event_id") == "single-root-1")
    assert_syslog_contains_mapped_and_enrichment(ev)
