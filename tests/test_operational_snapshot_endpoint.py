"""GET /api/v1/runtime/operational-snapshot — virtual bulk operational snapshot."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
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
from app.runtime.operational_snapshot_repository import (
    DestinationEntityRow,
    LastOutcomeRow,
    OperationalSnapshotBulkData,
    PhysicalOperationalRows,
    RouteEntityRow,
    StreamEntityRow,
    WindowAggregateRow,
)
from app.runtime.operational_snapshot_service import (
    _assemble_snapshot,
    _assemble_snapshot_from_physical,
    classify_global_health,
    classify_route_health,
    classify_stream_health,
    should_flag_checkpoint_stale,
)
from app.runtime.operational_snapshot_schemas import OperationalProblem, OperationalStreamSnapshot
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


def test_operational_snapshot_new_stream_without_observations_is_idle_with_null_rates(
    snapshot_client: TestClient, db_session: Session
) -> None:
    """Scenario 2 (endpoint): enabled RUNNING stream, zero logs -> IDLE, rates None."""

    h = _mk_hierarchy(db_session, stream_name="never-observed")
    resp = snapshot_client.get(ENDPOINT)
    assert resp.status_code == 200
    body = resp.json()
    stream = next(s for s in body["streams"] if s["stream_id"] == h["stream_id"])
    route = next(r for r in body["routes"] if r["route_id"] == h["route_id"])
    assert stream["health_status"] == "IDLE"
    assert stream["success_rate_5m"] is None
    assert stream["failure_rate_5m"] is None
    assert route["success_rate_5m"] is None
    assert not any(p.get("stream_id") == h["stream_id"] for p in body["problems"])


# --- Pure-unit assembly tests (runtime health semantics: no evidence != Healthy) ---

UNIT_NOW = datetime(2026, 10, 31, 12, 0, 0, tzinfo=UTC)


def _stream_row(sid: int, *, enabled: bool = True, status: str = "RUNNING") -> StreamEntityRow:
    return StreamEntityRow(id=sid, name=f"s{sid}", connector_id=1, source_id=1, enabled=enabled, status=status)


def _route_row(rid: int, *, stream_id: int, destination_id: int) -> RouteEntityRow:
    return RouteEntityRow(
        id=rid,
        stream_id=stream_id,
        stream_name=f"s{stream_id}",
        destination_id=destination_id,
        destination_name=f"d{destination_id}",
        destination_type="WEBHOOK_POST",
        enabled=True,
        failure_policy="LOG_AND_CONTINUE",
    )


def _last(gid: int, *, success: datetime | None = None, failure: datetime | None = None) -> LastOutcomeRow:
    return LastOutcomeRow(group_id=gid, last_success_at=success, last_failure_at=failure, last_error_message=None)


def _bulk(
    *,
    streams: list[StreamEntityRow],
    routes: list[RouteEntityRow] | None = None,
    destinations: list[DestinationEntityRow] | None = None,
    stream_last: dict[int, LastOutcomeRow] | None = None,
    route_last: dict[int, LastOutcomeRow] | None = None,
    destination_last: dict[int, LastOutcomeRow] | None = None,
    stream_agg_5m: dict[int, WindowAggregateRow] | None = None,
    route_agg_5m: dict[int, WindowAggregateRow] | None = None,
) -> OperationalSnapshotBulkData:
    return OperationalSnapshotBulkData(
        now=UNIT_NOW,
        since_1m=UNIT_NOW - timedelta(minutes=1),
        since_5m=UNIT_NOW - timedelta(minutes=5),
        streams=streams,
        routes=routes or [],
        destinations=destinations or [],
        checkpoints={},
        routes_per_stream={},
        routes_per_destination={},
        stream_agg_1m={},
        stream_agg_5m=stream_agg_5m or {},
        stream_input_1m={},
        stream_input_5m={},
        route_agg_1m={},
        route_agg_5m=route_agg_5m or {},
        destination_agg_1m={},
        destination_agg_5m={},
        stream_last=stream_last or {},
        route_last=route_last or {},
        destination_last=destination_last or {},
    )


def test_unit_missing_stored_snapshot_row_is_idle_never_healthy() -> None:
    """Scenario 1: stored snapshot row missing -> IDLE (no verdict), global IDLE, rates None."""

    rows = PhysicalOperationalRows(
        now=UNIT_NOW,
        streams=[_stream_row(1)],
        routes=[_route_row(10, stream_id=1, destination_id=100)],
        destinations=[DestinationEntityRow(id=100, name="d100", destination_type="WEBHOOK_POST", enabled=True)],
        stream_snapshots={},
        route_snapshots={},
        destination_snapshots={},
        checkpoints={},
        routes_per_stream={1: 1},
        routes_per_destination={100: 1},
    )
    snap = _assemble_snapshot_from_physical(rows)
    assert snap.streams[0].health_status == "IDLE"
    assert snap.streams[0].success_rate_5m is None
    assert snap.streams[0].failure_rate_5m is None
    assert snap.routes[0].success_rate_5m is None
    assert snap.destinations[0].health_status == "IDLE"
    assert snap.problems == []
    # Old code: no problems -> global HEALTHY without any observation.
    assert snap.global_.health_status == "IDLE"


def test_unit_stored_route_zero_rate_without_attempts_maps_to_none() -> None:
    """Scenario 5 (stored read model): non-null 0.0 column + no attempts -> None."""

    route_snap = SimpleNamespace(
        delivered_eps_1m=0.0,
        failed_eps_1m=0.0,
        success_rate_5m=0.0,
        retry_rate_5m=0.0,
        avg_latency_ms=None,
        last_success_at=UNIT_NOW - timedelta(minutes=10),
        last_error_at=None,
        last_error_message=None,
        updated_at=UNIT_NOW,
    )
    failing_snap = SimpleNamespace(
        **{**vars(route_snap), "failed_eps_1m": 0.05, "last_error_at": UNIT_NOW - timedelta(seconds=20)}
    )
    rows = PhysicalOperationalRows(
        now=UNIT_NOW,
        streams=[_stream_row(1)],
        routes=[_route_row(10, stream_id=1, destination_id=100), _route_row(11, stream_id=1, destination_id=100)],
        destinations=[],
        stream_snapshots={},
        route_snapshots={10: route_snap, 11: failing_snap},
        destination_snapshots={},
        checkpoints={},
        routes_per_stream={},
        routes_per_destination={},
    )
    snap = _assemble_snapshot_from_physical(rows)
    by_id = {r.route_id: r for r in snap.routes}
    assert by_id[10].success_rate_5m is None
    # Real failures in the window keep the measured 0.0.
    assert by_id[11].success_rate_5m == 0.0


def test_unit_new_enabled_stream_without_observations_global_idle() -> None:
    """Scenario 2: new enabled stream, zero observations -> stream IDLE and global IDLE."""

    snap = _assemble_snapshot(_bulk(streams=[_stream_row(1)]))
    assert snap.streams[0].health_status == "IDLE"
    assert snap.streams[0].success_rate_5m is None
    assert snap.problems == []
    assert snap.global_.health_status == "IDLE"


def test_unit_fresh_success_healthy_and_stale_success_degraded_with_warning() -> None:
    """Scenarios 3 and 4: freshness window reuses the existing 3600 s value."""

    fresh = _assemble_snapshot(
        _bulk(
            streams=[_stream_row(1)],
            routes=[_route_row(10, stream_id=1, destination_id=100)],
            destinations=[DestinationEntityRow(id=100, name="d100", destination_type="WEBHOOK_POST", enabled=True)],
            stream_last={1: _last(1, success=UNIT_NOW - timedelta(minutes=59))},
            route_last={10: _last(10, success=UNIT_NOW - timedelta(minutes=59))},
            destination_last={100: _last(100, success=UNIT_NOW - timedelta(minutes=59))},
            route_agg_5m={10: WindowAggregateRow(10, 4, 0, 0, None)},
        )
    )
    assert fresh.streams[0].health_status == "HEALTHY"
    assert fresh.routes[0].health_status == "HEALTHY"
    assert fresh.destinations[0].health_status == "HEALTHY"
    assert fresh.global_.health_status == "HEALTHY"
    assert fresh.problems == []

    stale = _assemble_snapshot(
        _bulk(
            streams=[_stream_row(1)],
            routes=[_route_row(10, stream_id=1, destination_id=100)],
            destinations=[DestinationEntityRow(id=100, name="d100", destination_type="WEBHOOK_POST", enabled=True)],
            stream_last={1: _last(1, success=UNIT_NOW - timedelta(hours=2))},
            route_last={10: _last(10, success=UNIT_NOW - timedelta(hours=2))},
            destination_last={100: _last(100, success=UNIT_NOW - timedelta(hours=2))},
        )
    )
    # Old code: a single past success kept everything HEALTHY forever.
    assert stale.streams[0].health_status == "DEGRADED"
    assert stale.routes[0].health_status == "IDLE"
    assert stale.destinations[0].health_status == "IDLE"
    warnings = [p for p in stale.problems if p.stream_id == 1]
    assert len(warnings) == 1
    assert warnings[0].severity == "warning"
    assert "no recent ingest/delivery observed" in warnings[0].title.lower()
    assert stale.global_.health_status == "DEGRADED"


def test_unit_paused_stopped_disabled_are_idle_without_problems() -> None:
    """Scenario 10: operator-stopped / disabled streams are never a failure alert."""

    recent_error = {
        "success": UNIT_NOW - timedelta(minutes=10),
        "failure": UNIT_NOW - timedelta(minutes=1),
    }
    snap = _assemble_snapshot(
        _bulk(
            streams=[
                _stream_row(1, status="PAUSED"),
                _stream_row(2, status="STOPPED"),
                _stream_row(3, status="STOPPING"),
                _stream_row(4, enabled=False, status="STOPPED"),
            ],
            stream_last={
                1: _last(1, **recent_error),
                2: _last(2, success=UNIT_NOW - timedelta(minutes=1)),
                3: _last(3, success=UNIT_NOW - timedelta(minutes=1)),
                4: _last(4, **recent_error),
            },
        )
    )
    # Old code: PAUSED -> DEGRADED (+ "is degraded" warning); STOPPED/STOPPING -> HEALTHY.
    assert {s.stream_id: s.health_status for s in snap.streams} == {1: "IDLE", 2: "IDLE", 3: "IDLE", 4: "IDLE"}
    assert snap.problems == []
    # Every enabled stream is operator-stopped: no verdict.
    assert snap.global_.health_status == "IDLE"


def test_unit_stop_failed_and_rate_limited_keep_existing_classification() -> None:
    assert (
        classify_stream_health(
            enabled=True,
            status="RATE_LIMITED_SOURCE",
            last_success_at=UNIT_NOW,
            last_error_at=None,
            failure_rate_5m=0.0,
            now=UNIT_NOW,
        )
        == "DEGRADED"
    )
    assert (
        classify_stream_health(
            enabled=True,
            status="STOP_FAILED",
            last_success_at=None,
            last_error_at=UNIT_NOW,
            failure_rate_5m=0.0,
            now=UNIT_NOW,
        )
        == "ERROR"
    )


def test_unit_global_partial_observation_never_healthy_and_never_masks_error() -> None:
    """Scenario 11: one HEALTHY + one IDLE -> IDLE; one ERROR + one IDLE -> ERROR."""

    healthy_plus_unobserved = _assemble_snapshot(
        _bulk(
            streams=[_stream_row(1), _stream_row(2)],
            stream_last={1: _last(1, success=UNIT_NOW - timedelta(seconds=30))},
        )
    )
    statuses = {s.stream_id: s.health_status for s in healthy_plus_unobserved.streams}
    assert statuses == {1: "HEALTHY", 2: "IDLE"}
    # Old code: HEALTHY (only problems were consulted).
    assert healthy_plus_unobserved.global_.health_status == "IDLE"

    error_plus_unobserved = _assemble_snapshot(
        _bulk(
            streams=[_stream_row(1), _stream_row(2)],
            stream_last={1: _last(1, failure=UNIT_NOW - timedelta(seconds=30))},
        )
    )
    assert {s.stream_id: s.health_status for s in error_plus_unobserved.streams} == {1: "ERROR", 2: "IDLE"}
    assert error_plus_unobserved.global_.health_status == "ERROR"


def test_unit_classify_global_health_streams_argument() -> None:
    def _s(sid: int, health: str, *, enabled: bool = True, status: str = "RUNNING") -> OperationalStreamSnapshot:
        return OperationalStreamSnapshot(
            stream_id=sid,
            stream_name=f"s{sid}",
            enabled=enabled,
            status=status,
            health_status=health,  # type: ignore[arg-type]
            eps_1m=0.0,
            eps_5m=0.0,
            success_rate_5m=None,
            failure_rate_5m=None,
            route_count=0,
            healthy_route_count=0,
            failed_route_count=0,
        )

    warning = OperationalProblem(severity="warning", scope="stream", stream_id=9, title="t", message="m")
    critical = OperationalProblem(severity="critical", scope="stream", stream_id=9, title="t", message="m")

    assert classify_global_health(enabled_streams=0, problems=[], streams=[]) == "IDLE"
    assert classify_global_health(enabled_streams=2, problems=[], streams=[_s(1, "HEALTHY"), _s(2, "IDLE")]) == "IDLE"
    assert (
        classify_global_health(enabled_streams=2, problems=[critical], streams=[_s(1, "IDLE"), _s(2, "IDLE")])
        == "ERROR"
    )
    assert (
        classify_global_health(enabled_streams=2, problems=[warning], streams=[_s(1, "IDLE"), _s(2, "IDLE")])
        == "DEGRADED"
    )
    # A paused stream is its own state; it does not block a HEALTHY roll-up of active streams.
    assert (
        classify_global_health(
            enabled_streams=2, problems=[], streams=[_s(1, "HEALTHY"), _s(2, "IDLE", status="PAUSED")]
        )
        == "HEALTHY"
    )
    # Disabled streams are ignored for the roll-up.
    assert (
        classify_global_health(
            enabled_streams=1, problems=[], streams=[_s(1, "HEALTHY"), _s(2, "IDLE", enabled=False)]
        )
        == "HEALTHY"
    )


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
