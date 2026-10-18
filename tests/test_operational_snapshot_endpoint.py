"""GET /api/v1/runtime/operational-snapshot — virtual bulk operational snapshot."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.connectors.models import Connector
from app.database import get_db, get_db_read_bounded
from app.destinations.models import Destination
from app.logs.models import DeliveryLog
from app.main import app
from app.routes.models import Route
from app.runtime.operational_snapshot_service import (
    classify_route_health,
    classify_stream_health,
    should_flag_checkpoint_stale,
)
from app.runtime.operational_snapshot_schemas import OperationalStreamSnapshot
from app.sources.models import Source
from app.streams.models import Stream

UTC = timezone.utc
ENDPOINT = "/api/v1/runtime/operational-snapshot"


@pytest.fixture(autouse=True)
def _clear_incremental_aggregate_cache() -> None:
    from app.logs.incremental_aggregates import clear_incremental_delivery_log_aggregate_cache

    clear_incremental_delivery_log_aggregate_cache()
    yield
    clear_incremental_delivery_log_aggregate_cache()


def _mk_hierarchy(
    db: Session,
    *,
    stream_name: str = "ops-stream",
    stream_enabled: bool = True,
    stream_status: str = "RUNNING",
    route_enabled: bool = True,
    destination_enabled: bool = True,
) -> dict[str, Any]:
    connector = Connector(name=f"conn-{stream_name}", description=None, status="RUNNING")
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
        name=stream_name,
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=60,
        enabled=stream_enabled,
        status=stream_status,
        rate_limit_json={},
    )
    db.add(stream)
    db.flush()
    destination = Destination(
        name=f"dest-{stream_name}",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://example.test/hook"},
        rate_limit_json={},
        enabled=destination_enabled,
    )
    db.add(destination)
    db.flush()
    route = Route(
        stream_id=stream.id,
        destination_id=destination.id,
        enabled=route_enabled,
        failure_policy="LOG_AND_CONTINUE",
        formatter_config_json={},
        rate_limit_json={},
        status="ENABLED",
    )
    db.add(route)
    db.flush()
    db.add(
        Checkpoint(
            stream_id=stream.id,
            checkpoint_type="CUSTOM_FIELD",
            checkpoint_value_json={},
        )
    )
    db.commit()
    db.refresh(stream)
    db.refresh(route)
    db.refresh(destination)
    return {
        "connector_id": connector.id,
        "stream_id": stream.id,
        "route_id": route.id,
        "destination_id": destination.id,
    }


def _log(
    db: Session,
    *,
    connector_id: int,
    stream_id: int,
    route_id: int,
    destination_id: int,
    stage: str,
    created_at: datetime,
    latency_ms: int | None = None,
    message: str = "delivery",
) -> None:
    db.add(
        DeliveryLog(
            connector_id=connector_id,
            stream_id=stream_id,
            route_id=route_id,
            destination_id=destination_id,
            stage=stage,
            level="INFO",
            status="OK",
            message=message,
            payload_sample={"input_events": 1} if stage == "run_complete" else {"event_count": 1},
            retry_count=0,
            latency_ms=latency_ms,
            created_at=created_at,
        )
    )


@pytest.fixture
def snapshot_client(db_session: Session) -> TestClient:
    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_db_read_bounded] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_db_read_bounded, None)


def test_operational_snapshot_empty_shape(snapshot_client: TestClient) -> None:
    resp = snapshot_client.get(ENDPOINT)
    assert resp.status_code == 200
    body = resp.json()
    assert "global" in body
    assert "streams" in body
    assert "routes" in body
    assert "destinations" in body
    assert "problems" in body
    assert "updated_at" in body
    assert body["global"]["health_status"] in ("HEALTHY", "DEGRADED", "ERROR", "IDLE")


def test_operational_snapshot_entities_appear_once(
    snapshot_client: TestClient, db_session: Session
) -> None:
    h = _mk_hierarchy(db_session)
    resp = snapshot_client.get(ENDPOINT)
    assert resp.status_code == 200
    body = resp.json()
    stream_ids = [s["stream_id"] for s in body["streams"]]
    route_ids = [r["route_id"] for r in body["routes"]]
    destination_ids = [d["destination_id"] for d in body["destinations"]]
    assert stream_ids.count(h["stream_id"]) == 1
    assert route_ids.count(h["route_id"]) == 1
    assert destination_ids.count(h["destination_id"]) == 1


def test_operational_snapshot_delivery_log_aggregates(
    snapshot_client: TestClient, db_session: Session
) -> None:
    h = _mk_hierarchy(db_session)
    now = datetime.now(UTC)
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_id"],
        destination_id=h["destination_id"],
        stage="route_send_success",
        created_at=now - timedelta(seconds=30),
        latency_ms=100,
    )
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_id"],
        destination_id=h["destination_id"],
        stage="route_send_success",
        created_at=now - timedelta(minutes=3),
        latency_ms=200,
    )
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_id"],
        destination_id=h["destination_id"],
        stage="route_send_failed",
        created_at=now - timedelta(minutes=2),
        message="send failed",
    )
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_id"],
        destination_id=h["destination_id"],
        stage="run_complete",
        created_at=now - timedelta(seconds=30),
    )
    db_session.commit()

    resp = snapshot_client.get(ENDPOINT)
    assert resp.status_code == 200
    stream = next(s for s in resp.json()["streams"] if s["stream_id"] == h["stream_id"])
    route = next(r for r in resp.json()["routes"] if r["route_id"] == h["route_id"])

    assert stream["eps_1m"] > 0.0
    assert stream["eps_5m"] > 0.0
    assert stream["failure_rate_5m"] > 0.0
    assert stream["avg_latency_ms"] is not None
    assert stream["avg_latency_ms"] == pytest.approx(150.0, rel=0.01)
    assert route["delivered_eps_1m"] > 0.0
    assert route["failed_eps_1m"] >= 0.0


def test_operational_snapshot_health_rules(
    snapshot_client: TestClient, db_session: Session
) -> None:
    disabled = _mk_hierarchy(
        db_session,
        stream_name="disabled-stream",
        stream_enabled=False,
        stream_status="STOPPED",
    )
    err_h = _mk_hierarchy(db_session, stream_name="error-stream", stream_status="RUNNING")
    now = datetime.now(UTC)
    _log(
        db_session,
        connector_id=err_h["connector_id"],
        stream_id=err_h["stream_id"],
        route_id=err_h["route_id"],
        destination_id=err_h["destination_id"],
        stage="route_send_failed",
        created_at=now - timedelta(seconds=10),
        message="newer failure",
    )
    _log(
        db_session,
        connector_id=err_h["connector_id"],
        stream_id=err_h["stream_id"],
        route_id=err_h["route_id"],
        destination_id=err_h["destination_id"],
        stage="route_send_success",
        created_at=now - timedelta(minutes=5),
    )
    db_session.commit()

    resp = snapshot_client.get(ENDPOINT)
    assert resp.status_code == 200
    streams = {s["stream_id"]: s for s in resp.json()["streams"]}
    routes = {r["route_id"]: r for r in resp.json()["routes"]}

    assert streams[disabled["stream_id"]]["health_status"] == "IDLE"
    assert streams[err_h["stream_id"]]["health_status"] in ("DEGRADED", "ERROR")
    assert routes[err_h["route_id"]]["health_status"] == "ERROR"


def test_stream_health_unit_rules() -> None:
    assert (
        classify_stream_health(
            enabled=False,
            status="RUNNING",
            last_success_at=None,
            last_error_at=None,
            failure_rate_5m=0.0,
        )
        == "IDLE"
    )
    assert (
        classify_route_health(
            enabled=True,
            last_success_at=datetime(2026, 1, 1, tzinfo=UTC),
            last_error_at=datetime(2026, 1, 2, tzinfo=UTC),
            failed_eps_1m=0.0,
            retry_rate_5m=0.0,
        )
        == "ERROR"
    )


def test_should_flag_checkpoint_stale_only_for_active_delivery_lag() -> None:
    now = datetime(2026, 6, 26, 12, 0, 0, tzinfo=UTC)
    idle = OperationalStreamSnapshot(
        stream_id=1,
        stream_name="idle",
        connector_id=1,
        source_id=1,
        enabled=True,
        status="RUNNING",
        health_status="HEALTHY",
        eps_1m=0.0,
        eps_5m=0.0,
        success_rate_5m=100.0,
        failure_rate_5m=0.0,
        avg_latency_ms=None,
        route_count=1,
        healthy_route_count=1,
        failed_route_count=0,
        last_success_at=now - timedelta(days=6),
        last_error_at=None,
        last_error_message=None,
        checkpoint_updated_at=now - timedelta(days=6),
        checkpoint_lag_seconds=6 * 24 * 3600,
    )
    assert should_flag_checkpoint_stale(idle) is False

    active_behind = idle.model_copy(
        update={
            "eps_1m": 1.5,
            "last_success_at": now - timedelta(minutes=2),
            "checkpoint_updated_at": now - timedelta(hours=2),
            "checkpoint_lag_seconds": 7200,
        }
    )
    assert should_flag_checkpoint_stale(active_behind) is True
    """N+1 protection: repository exposes bulk loaders, not per-entity fetch helpers.

    ``load_operational_snapshot_bulk_data`` issues a bounded number of GROUP BY /
    entity-list queries regardless of stream/route/destination count. UI pages
    should call this single endpoint instead of per-stream metrics APIs.
    """

    from app.runtime import operational_snapshot_repository as repo

    bulk_loaders = (
        "load_all_streams",
        "load_all_routes",
        "load_all_destinations",
        "fetch_stream_window_aggregates",
        "fetch_route_window_aggregates",
        "fetch_destination_window_aggregates",
        "fetch_stream_last_outcomes",
        "fetch_route_last_outcomes",
        "fetch_destination_last_outcomes",
        "load_operational_snapshot_bulk_data",
    )
    for name in bulk_loaders:
        assert hasattr(repo, name), name
    assert not hasattr(repo, "fetch_stream_window_aggregate_for_id")
