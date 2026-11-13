"""GET /api/v1/runtime/streams/{stream_id}/metrics — committed delivery_logs aggregates."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.connectors.models import Connector
from app.destinations.models import Destination
from app.logs.models import DeliveryLog
from app.routes.models import Route
from app.sources.models import Source
from app.streams.models import Stream
from tests.runtime_read_fixtures import (
    clear_runtime_test_db_overrides,
    install_runtime_test_db_overrides,
)

UTC = timezone.utc

pytestmark = pytest.mark.usefixtures("runtime_snapshot_read_disabled")


def _seed(db: Session) -> dict[str, int]:
    connector = Connector(name="m-connector", description=None, status="RUNNING")
    db.add(connector)
    db.flush()
    source = Source(
        connector_id=connector.id,
        source_type="HTTP_API_POLLING",
        config_json={},
        auth_json={},
        enabled=True,
    )
    db.add(source)
    db.flush()
    stream = Stream(
        connector_id=connector.id,
        source_id=source.id,
        name="Metrics Stream",
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=60,
        enabled=True,
        status="RUNNING",
        rate_limit_json={},
    )
    db.add(stream)
    db.flush()

    dest = Destination(
        name="mds-tcp",
        destination_type="SYSLOG_TCP",
        config_json={"host": "10.0.0.2", "port": 601},
        rate_limit_json={},
        enabled=True,
    )
    db.add(dest)
    db.flush()

    route = Route(
        stream_id=stream.id,
        destination_id=dest.id,
        enabled=True,
        failure_policy="LOG_AND_CONTINUE",
        formatter_config_json={},
        rate_limit_json={},
        status="ENABLED",
    )
    db.add(route)
    db.flush()

    cp = Checkpoint(
        stream_id=stream.id,
        checkpoint_type="CUSTOM_FIELD",
        checkpoint_value_json={"cursor": "2026-05-10T12:00:00Z"},
    )
    db.add(cp)
    db.commit()
    db.refresh(stream)
    db.refresh(route)
    db.refresh(dest)
    return {"stream_id": stream.id, "route_id": route.id, "destination_id": dest.id, "connector_id": connector.id}


@pytest.fixture
def metrics_client(db_session: Session) -> TestClient:
    install_runtime_test_db_overrides(db_session)
    try:
        from app.main import app

        yield TestClient(app)
    finally:
        clear_runtime_test_db_overrides()


def test_metrics_not_found(metrics_client: TestClient) -> None:
    r = metrics_client.get("/api/v1/runtime/streams/999999/metrics")
    assert r.status_code == 404


def test_metrics_shape_and_kpis(metrics_client: TestClient, db_session: Session) -> None:
    seeded = _seed(db_session)
    now = datetime.now(UTC)
    log_ts = now - timedelta(minutes=15)

    db_session.add(
        DeliveryLog(
            connector_id=seeded["connector_id"],
            stream_id=seeded["stream_id"],
            route_id=seeded["route_id"],
            destination_id=seeded["destination_id"],
            stage="route_send_success",
            level="INFO",
            status="OK",
            message="ok",
            payload_sample={"event_count": 50},
            retry_count=0,
            http_status=None,
            latency_ms=120,
            error_code=None,
            created_at=log_ts,
        )
    )
    db_session.add(
        DeliveryLog(
            connector_id=seeded["connector_id"],
            stream_id=seeded["stream_id"],
            route_id=None,
            destination_id=None,
            stage="run_complete",
            level="INFO",
            status="COMPLETED",
            message="run_complete",
            payload_sample={"input_events": 100, "success_events": 50},
            retry_count=0,
            http_status=None,
            latency_ms=None,
            error_code=None,
            created_at=log_ts,
        )
    )
    db_session.commit()

    r = metrics_client.get(f"/api/v1/runtime/streams/{seeded['stream_id']}/metrics")
    assert r.status_code == 200
    body = r.json()

    assert body["stream"]["id"] == seeded["stream_id"]
    assert body["stream"]["name"] == "Metrics Stream"
    assert body["stream"]["status"] == "RUNNING"
    assert body["stream"]["last_checkpoint"]["type"] == "CUSTOM_FIELD"

    assert body["kpis"]["events_last_hour"] == 100
    assert body["kpis"]["delivered_last_hour"] == 50
    assert body["kpis"]["failed_last_hour"] == 0
    assert body["kpis"]["delivery_success_rate"] == 100.0

    assert len(body["events_over_time"]) == 24
    assert isinstance(body["route_health"], list)
    assert len(body["route_health"]) == 1
    assert body["route_health"][0]["destination_name"] == "mds-tcp"
    assert body["route_health"][0]["destination_type"] == "SYSLOG_TCP"
    assert body["route_health"][0]["failure_policy"] == "LOG_AND_CONTINUE"
    assert body["route_health"][0]["success_count"] == 1

    assert len(body["checkpoint_history"]) == 1
    assert "recent_runs" in body and isinstance(body["recent_runs"], list)

    assert isinstance(body.get("route_runtime"), list)
    assert len(body["route_runtime"]) == 1
    rr = body["route_runtime"][0]
    assert rr["route_id"] == seeded["route_id"]
    assert rr["destination_type"] == "SYSLOG_TCP"
    assert rr["success_rate"] == 100.0
    assert rr["delivered_last_hour"] == 50
    assert rr["failed_last_hour"] == 0
    assert rr["avg_latency_ms"] == 120.0
    assert rr["p95_latency_ms"] == 120.0
    assert rr["retry_count_last_hour"] == 0
    assert rr["connectivity_state"] == "HEALTHY"
    assert len(rr["latency_trend"]) == 12
    assert len(rr["success_rate_trend"]) == 12

    assert isinstance(body.get("recent_route_errors"), list)
    assert body["recent_route_errors"] == []


def test_metrics_empty_stream(metrics_client: TestClient, db_session: Session) -> None:
    seeded = _seed(db_session)
    r = metrics_client.get(f"/api/v1/runtime/streams/{seeded['stream_id']}/metrics")
    assert r.status_code == 200
    body = r.json()
    assert body["kpis"]["events_last_hour"] == 0
    assert body["kpis"]["delivered_last_hour"] == 0
    assert body["kpis"]["delivery_success_rate"] is None
    assert len(body["events_over_time"]) == 24
    assert body["recent_runs"] == []
    assert len(body["route_runtime"]) == 1
    assert body["route_runtime"][0]["events_last_hour"] == 0
    # Owner decision (runtime health semantics): zero deliveries and zero failures
    # is "not observed" (IDLE), not HEALTHY; the old HEALTHY assertion was stale.
    assert body["route_runtime"][0]["connectivity_state"] == "IDLE"
    # Zero attempts -> success rate None (never 100.0 or 0.0 without evidence).
    assert body["route_runtime"][0]["success_rate"] is None
    assert all(p["success_rate"] is None for p in body["route_runtime"][0]["success_rate_trend"])
    assert body["recent_route_errors"] == []
