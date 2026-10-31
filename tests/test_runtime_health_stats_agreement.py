"""R3/R4: runtime health must reflect failing Routes and agree with runtime stats.

R3 — GET /runtime/health/stream/{id} reported a Route that the dashboard showed as
"Route N delivery failing" (operational snapshot health ERROR) as IDLE with zero
failure counts. The snapshot ERROR status fell through to IDLE because it is not in
the runtime health vocabulary, and counts were hard-coded to 0.

R4 — GET /runtime/health reported success_count 0 while GET /runtime/stats reported
route_send_success > 0 for the same stream and window. Health counts are now derived
from the stats ``routes[].counts`` for the same window
(read_service.route_health_counts_from_stats).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.connectors.models import Connector
from app.destinations.models import Destination
from app.logs.models import DeliveryLog
from app.routes.models import Route
from app.runtime import read_service
from app.runtime.models import RuntimeDestinationSnapshot, RuntimeRouteSnapshot, RuntimeStreamSnapshot
from app.sources.models import Source
from app.streams.models import Stream

UTC = timezone.utc

pytestmark = pytest.mark.usefixtures("runtime_analytics_bucket_disabled")


def _seed_two_routes(db: Session) -> dict[str, Any]:
    connector = Connector(name="r3r4-conn", description=None, status="RUNNING")
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
        name="r3r4-stream",
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=60,
        enabled=True,
        status="RUNNING",
        rate_limit_json={},
    )
    db.add(stream)
    db.flush()
    dest_ok = Destination(
        name="r3r4-dest-ok",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://ok.example.test/hook"},
        rate_limit_json={},
        enabled=True,
    )
    dest_down = Destination(
        name="r3r4-dest-receiver-down",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://down.example.test/hook"},
        rate_limit_json={},
        enabled=True,
    )
    db.add_all([dest_ok, dest_down])
    db.flush()
    route_ok = Route(
        stream_id=stream.id,
        destination_id=dest_ok.id,
        enabled=True,
        failure_policy="LOG_AND_CONTINUE",
        formatter_config_json={},
        rate_limit_json={},
        status="ENABLED",
    )
    route_down = Route(
        stream_id=stream.id,
        destination_id=dest_down.id,
        enabled=True,
        failure_policy="LOG_AND_CONTINUE",
        formatter_config_json={},
        rate_limit_json={},
        status="ENABLED",
    )
    db.add_all([route_ok, route_down])
    db.flush()
    return {
        "connector_id": int(connector.id),
        "stream_id": int(stream.id),
        "route_ok_id": int(route_ok.id),
        "route_down_id": int(route_down.id),
        "dest_ok_id": int(dest_ok.id),
        "dest_down_id": int(dest_down.id),
    }


def _seed_receiver_outage_snapshots(db: Session, s: dict[str, Any], now: datetime) -> None:
    """Route 1 delivering; Route 2 failing since its Receiver went down.

    Stored health_status values are what the snapshot updater writes
    (classify_route_health / classify_stream_health), i.e. ERROR for the failing Route.
    """

    db.add(
        RuntimeStreamSnapshot(
            stream_id=s["stream_id"],
            enabled=True,
            health_status="DEGRADED",
            eps_1m=2.0,
            eps_5m=2.0,
            success_rate_5m=50.0,
            failure_rate_5m=50.0,
            retry_rate_5m=0.0,
            avg_latency_ms=10.0,
            route_count=2,
            healthy_route_count=1,
            failed_route_count=1,
            last_success_at=now - timedelta(seconds=5),
            last_error_at=now - timedelta(seconds=2),
            last_error_message="connection refused",
            updated_at=now,
        )
    )
    db.add(
        RuntimeRouteSnapshot(
            route_id=s["route_ok_id"],
            stream_id=s["stream_id"],
            destination_id=s["dest_ok_id"],
            enabled=True,
            health_status="HEALTHY",
            delivered_eps_1m=1.0,
            failed_eps_1m=0.0,
            success_rate_5m=100.0,
            retry_rate_5m=0.0,
            avg_latency_ms=10.0,
            last_success_at=now - timedelta(seconds=5),
            updated_at=now,
        )
    )
    db.add(
        RuntimeRouteSnapshot(
            route_id=s["route_down_id"],
            stream_id=s["stream_id"],
            destination_id=s["dest_down_id"],
            enabled=True,
            health_status="ERROR",
            delivered_eps_1m=0.0,
            failed_eps_1m=1.0,
            success_rate_5m=0.0,
            retry_rate_5m=0.0,
            avg_latency_ms=None,
            last_success_at=now - timedelta(minutes=10),
            last_error_at=now - timedelta(seconds=2),
            last_error_message="connection refused",
            updated_at=now,
        )
    )
    # Every entity needs a fresh snapshot or read_model_is_current() falls back to delivery_logs.
    for dest_key in ("dest_ok_id", "dest_down_id"):
        db.add(
            RuntimeDestinationSnapshot(
                destination_id=s[dest_key],
                enabled=True,
                health_status="HEALTHY" if dest_key == "dest_ok_id" else "ERROR",
                inbound_eps_1m=1.0 if dest_key == "dest_ok_id" else 0.0,
                failed_eps_1m=0.0 if dest_key == "dest_ok_id" else 1.0,
                avg_latency_ms=10.0,
                route_count=1,
                updated_at=now,
            )
        )
    db.commit()


def _route(health: Any, route_id: int) -> Any:
    return next(r for r in health.routes if r.route_id == route_id)


def test_r3_failing_route_is_unhealthy_with_failure_counts_on_snapshot_path(
    db_session: Session,
    runtime_snapshot_read_enabled: None,
) -> None:
    s = _seed_two_routes(db_session)
    now = datetime.now(UTC)
    _seed_receiver_outage_snapshots(db_session, s, now)

    health = read_service.get_stream_runtime_health(db_session, s["stream_id"], 100, window="1h")

    down = _route(health, s["route_down_id"])
    # Old code: snapshot ERROR fell through to "IDLE" and failure_count was hard-coded 0.
    assert down.health == "UNHEALTHY"
    assert down.failure_count > 0
    assert down.success_count == 0
    assert down.last_error_message == "connection refused"
    # Old code: unhealthy_routes == 0 and idle_routes == 1.
    assert health.summary.unhealthy_routes == 1
    assert health.summary.idle_routes == 0

    # Routes with no recent failures keep their meaning.
    ok = _route(health, s["route_ok_id"])
    assert ok.health == "HEALTHY"
    assert ok.failure_count == 0
    assert health.summary.healthy_routes == 1
    assert health.health == "DEGRADED"


def test_r3_snapshot_stream_error_maps_to_unhealthy_not_idle(
    db_session: Session,
    runtime_snapshot_read_enabled: None,
) -> None:
    s = _seed_two_routes(db_session)
    now = datetime.now(UTC)
    _seed_receiver_outage_snapshots(db_session, s, now)
    snap = (
        db_session.query(RuntimeStreamSnapshot)
        .filter(RuntimeStreamSnapshot.stream_id == s["stream_id"])
        .one()
    )
    snap.health_status = "ERROR"
    db_session.commit()

    health = read_service.get_stream_runtime_health(db_session, s["stream_id"], 100, window="1h")

    # Old code: stream ERROR is not a StreamHealthState and fell through to "IDLE".
    assert health.health == "UNHEALTHY"


def test_r3_route_without_activity_stays_idle(
    db_session: Session,
    runtime_snapshot_read_enabled: None,
) -> None:
    s = _seed_two_routes(db_session)
    now = datetime.now(UTC)
    _seed_receiver_outage_snapshots(db_session, s, now)
    snap = (
        db_session.query(RuntimeRouteSnapshot)
        .filter(RuntimeRouteSnapshot.route_id == s["route_down_id"])
        .one()
    )
    snap.health_status = "IDLE"
    snap.failed_eps_1m = 0.0
    snap.last_success_at = None
    snap.last_error_at = None
    snap.last_error_message = None
    db_session.commit()

    health = read_service.get_stream_runtime_health(db_session, s["stream_id"], 100, window="1h")

    idle = _route(health, s["route_down_id"])
    assert idle.health == "IDLE"
    assert idle.success_count == 0
    assert idle.failure_count == 0


def test_route_with_only_old_success_is_idle_on_snapshot_path(
    db_session: Session,
    runtime_snapshot_read_enabled: None,
) -> None:
    """Route re-classified on read with ``now``: success older than 3600 s -> IDLE."""

    s = _seed_two_routes(db_session)
    now = datetime.now(UTC)
    _seed_receiver_outage_snapshots(db_session, s, now)
    snap = (
        db_session.query(RuntimeRouteSnapshot)
        .filter(RuntimeRouteSnapshot.route_id == s["route_ok_id"])
        .one()
    )
    snap.delivered_eps_1m = 0.0
    snap.success_rate_5m = 0.0
    snap.last_success_at = now - timedelta(hours=2)
    db_session.commit()

    health = read_service.get_stream_runtime_health(db_session, s["stream_id"], 100, window="1h")

    quiet = _route(health, s["route_ok_id"])
    # Old code: HEALTHY forever after a single historical success.
    assert quiet.health == "IDLE"
    assert health.summary.healthy_routes == 0
    # The failing route keeps its confirmed verdict.
    assert _route(health, s["route_down_id"]).health == "UNHEALTHY"


def test_snapshot_stream_scoring_excludes_disabled_paused_and_unobserved_rows(
    db_session: Session,
    runtime_snapshot_read_enabled: None,
) -> None:
    """Disabled / paused / no-outcome streams are excluded_no_outcome, not scored."""

    from app.runtime.health_snapshot_read import list_stream_health_from_snapshots

    s = _seed_two_routes(db_session)
    now = datetime.now(UTC)
    _seed_receiver_outage_snapshots(db_session, s, now)

    def _rows(*, explicit: bool = False) -> list[Any]:
        # Bulk listing (stream_id=None) applies the exclusion; an explicit
        # per-stream request keeps returning that stream's row (detail contract).
        return list_stream_health_from_snapshots(
            db_session,
            window="1h",
            since=None,
            stream_id=s["stream_id"] if explicit else None,
            route_id=None,
            destination_id=None,
        ).rows

    # Baseline: an enabled, delivering stream is scored.
    assert len(_rows()) == 1

    stream = db_session.get(Stream, s["stream_id"])
    snap = db_session.get(RuntimeStreamSnapshot, s["stream_id"])
    assert stream is not None and snap is not None

    # Disabled with a stale error newer than its last success: old code scored it
    # UNHEALTHY/CRITICAL (false alarm).
    stream.enabled = False
    db_session.commit()
    assert _rows() == []
    assert len(_rows(explicit=True)) == 1  # per-stream detail still answers

    stream.enabled = True
    stream.status = "PAUSED"
    db_session.commit()
    assert _rows() == []

    # Enabled and running but no observed outcome: old code scored 100 / HEALTHY.
    stream.status = "RUNNING"
    snap.eps_5m = 0.0
    snap.failure_rate_5m = 0.0
    snap.last_error_at = None
    snap.last_success_at = now - timedelta(hours=6)
    db_session.commit()
    assert _rows() == []


def test_snapshot_route_health_key_freshness_unit() -> None:
    from types import SimpleNamespace

    from app.runtime.stream_runtime_snapshot_read import snapshot_route_health_key

    now = datetime(2026, 10, 31, 12, 0, 0, tzinfo=UTC)
    snap = SimpleNamespace(
        last_success_at=now - timedelta(hours=2),
        last_error_at=None,
        failed_eps_1m=0.0,
        retry_rate_5m=0.0,
    )
    assert snapshot_route_health_key(snap, now=now) == "IDLE"
    snap.last_success_at = now - timedelta(minutes=5)
    assert snapshot_route_health_key(snap, now=now) == "HEALTHY"


def _assert_health_matches_stats(health: Any, stats: Any) -> None:
    stats_by_route = {r.route_id: r.counts for r in stats.routes}
    assert {r.route_id for r in health.routes} == set(stats_by_route)
    for item in health.routes:
        c = stats_by_route[item.route_id]
        assert item.success_count == c.route_send_success + c.route_retry_success
        assert item.failure_count == c.route_send_failed + c.route_retry_failed + c.route_unknown_failure_policy
        assert item.rate_limited_count == c.destination_rate_limited


def test_r4_health_and_stats_agree_on_snapshot_path(
    db_session: Session,
    runtime_snapshot_read_enabled: None,
) -> None:
    s = _seed_two_routes(db_session)
    now = datetime.now(UTC)
    _seed_receiver_outage_snapshots(db_session, s, now)
    snapshot_id = now.isoformat()

    stats = read_service.get_stream_runtime_stats(
        db_session, s["stream_id"], 100, window="1h", snapshot_id=snapshot_id
    )
    health = read_service.get_stream_runtime_health(
        db_session, s["stream_id"], 100, window="1h", snapshot_id=snapshot_id
    )

    assert stats.summary.route_send_success > 0
    # Old code: every health success_count/failure_count was hard-coded 0 on this path.
    assert sum(r.success_count for r in health.routes) == stats.summary.route_send_success
    assert sum(r.failure_count for r in health.routes) == stats.summary.route_send_failed
    _assert_health_matches_stats(health, stats)


def _log(db: Session, s: dict[str, Any], *, route_key: str, stage: str, created_at: datetime) -> None:
    dest_key = "dest_ok_id" if route_key == "route_ok_id" else "dest_down_id"
    db.add(
        DeliveryLog(
            connector_id=s["connector_id"],
            stream_id=s["stream_id"],
            route_id=s[route_key],
            destination_id=s[dest_key],
            stage=stage,
            level="INFO" if stage.endswith("success") else "ERROR",
            status="OK" if stage.endswith("success") else "FAILED",
            message=stage,
            payload_sample={},
            retry_count=0,
            created_at=created_at,
        )
    )


def test_r4_health_and_stats_agree_on_delivery_logs_path(
    db_session: Session,
    runtime_snapshot_read_disabled: None,
) -> None:
    s = _seed_two_routes(db_session)
    now = datetime.now(UTC)
    # Inside the 1h window.
    for i in range(3):
        _log(db_session, s, route_key="route_ok_id", stage="route_send_success", created_at=now - timedelta(minutes=5 + i))
    _log(db_session, s, route_key="route_ok_id", stage="route_retry_success", created_at=now - timedelta(minutes=9))
    for i in range(2):
        _log(db_session, s, route_key="route_down_id", stage="route_send_failed", created_at=now - timedelta(minutes=5 + i))
    _log(db_session, s, route_key="route_down_id", stage="route_retry_failed", created_at=now - timedelta(minutes=8))
    # Outside the 1h window: the standalone health endpoint used to count these
    # (it ignored the window for counts), stats never did.
    for i in range(4):
        _log(db_session, s, route_key="route_ok_id", stage="route_send_success", created_at=now - timedelta(hours=3, minutes=i))
    db_session.commit()
    snapshot_id = now.isoformat()

    stats = read_service.get_stream_runtime_stats(
        db_session, s["stream_id"], 100, window="1h", snapshot_id=snapshot_id
    )
    health = read_service.get_stream_runtime_health(
        db_session, s["stream_id"], 100, window="1h", snapshot_id=snapshot_id
    )

    assert stats.summary.route_send_success == 3
    ok = _route(health, s["route_ok_id"])
    # Old code: 8 (3 + 1 retry + 4 out-of-window sends from the last-N log sample).
    assert ok.success_count == 4
    down = _route(health, s["route_down_id"])
    assert down.failure_count == 3
    assert down.health == "UNHEALTHY"
    _assert_health_matches_stats(health, stats)

    bundle = read_service.get_stream_runtime_stats_and_health(
        db_session, s["stream_id"], 100, window="1h", snapshot_id=snapshot_id
    )
    _assert_health_matches_stats(bundle.health, bundle.stats)
    _assert_health_matches_stats(bundle.health, stats)
