"""Current runtime metrics must not reuse expired snapshots or override bucket zeros."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.config import settings
from app.logs.models import DeliveryLog
from app.runtime.health_snapshot_read import snapshot_health_available
from app.runtime.models import (
    RuntimeAnalyticsBucket1m,
    RuntimeAnalyticsBucket5m,
    RuntimeDestinationSnapshot,
    RuntimeRouteSnapshot,
    RuntimeStreamSnapshot,
)
from app.runtime.operational_snapshot_repository import load_physical_operational_rows
from app.runtime.read_service import get_stream_runtime_stats_and_health
from app.runtime.runtime_snapshot_analytics_repository import snapshot_analytics_available
from app.runtime.runtime_snapshot_repository import read_model_is_populated, recompute_and_upsert_snapshots
from app.runtime.stats_health_bulk_service import get_bulk_stream_stats_health
from app.runtime.stream_runtime_snapshot_read import try_build_stream_runtime_metrics
from tests.test_runtime_snapshot_updater import _log, _mk_hierarchy
from tests.test_runtime_stats_health_bulk import _seed_streams

UTC = timezone.utc
SNAPSHOT_MODELS = (RuntimeStreamSnapshot, RuntimeRouteSnapshot, RuntimeDestinationSnapshot)


@pytest.fixture(autouse=True)
def _real_snapshot_availability(monkeypatch: pytest.MonkeyPatch) -> None:
    # Exercise real availability gates, unlike fixtures that force a read path.
    monkeypatch.setattr(settings, "GDC_RUNTIME_OPERATIONAL_SNAPSHOT_READ_MODEL_ENABLED", True)
    monkeypatch.setattr(settings, "GDC_RUNTIME_OPERATIONAL_SNAPSHOT_UPDATER_INTERVAL_SECONDS", 30.0)
    monkeypatch.setattr(settings, "GDC_RUNTIME_ANALYTICS_BUCKET_READ_ENABLED", False)


def _seed_cached_activity(db: Session, *, hours_old: int = 3) -> tuple[dict[str, int], datetime]:
    hierarchy = _mk_hierarchy(db)
    as_of = datetime.now(UTC) - timedelta(hours=hours_old)
    last_success = as_of - timedelta(seconds=20)
    for stage in ("route_send_success", "run_complete"):
        _log(db, **hierarchy, stage=stage, created_at=last_success)
    db.commit()
    with (
        patch("app.runtime.runtime_snapshot_repository.snapshot_now", return_value=as_of),
        patch("app.runtime.operational_snapshot_repository.snapshot_now", return_value=as_of),
    ):
        recompute_and_upsert_snapshots(db, bootstrap_last_outcomes=True)
    db.commit()
    assert db.get(RuntimeRouteSnapshot, hierarchy["route_id"]).delivered_eps_1m > 0
    return hierarchy, last_success


def _add_current_failure(db: Session, hierarchy: dict[str, int]) -> datetime:
    at = datetime.now(UTC) - timedelta(seconds=5)
    db.add(
        DeliveryLog(
            **hierarchy,
            stage="route_send_failed",
            level="ERROR",
            status="FAILED",
            message="current receiver failure",
            payload_sample={"event_count": 1},
            retry_count=0,
            latency_ms=80,
            created_at=at,
        )
    )
    db.commit()
    return at


def _timestamp(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


@pytest.mark.parametrize("hours_old", [3, 48])
@pytest.mark.parametrize("new_failure", [False, True])
def test_stale_operational_metrics_use_current_logs_and_preserve_history(
    runtime_api_client: TestClient,
    db_session: Session,
    hours_old: int,
    new_failure: bool,
) -> None:
    hierarchy, last_success = _seed_cached_activity(db_session, hours_old=hours_old)
    last_failure = _add_current_failure(db_session, hierarchy) if new_failure else None

    response = runtime_api_client.get("/api/v1/runtime/operational-snapshot")
    assert response.status_code == 200
    body = response.json()
    route = next(row for row in body["routes"] if row["route_id"] == hierarchy["route_id"])
    stream = next(row for row in body["streams"] if row["stream_id"] == hierarchy["stream_id"])
    destination = next(row for row in body["destinations"] if row["destination_id"] == hierarchy["destination_id"])
    assert route["delivered_eps_1m"] == 0
    expected_failed_eps = 1 / 60 if new_failure else 0
    assert route["failed_eps_1m"] == pytest.approx(expected_failed_eps, abs=1e-6)
    assert route["avg_latency_ms"] == (80 if new_failure else None)
    assert stream["eps_1m"] == 0
    assert destination["inbound_eps_1m"] == 0
    for row in (route, stream, destination):
        assert _timestamp(row["last_success_at"]) == last_success
        assert _timestamp(row["last_error_at"]) == last_failure
        if new_failure:
            assert row["last_error_message"] == "current receiver failure"
    # A read fallback must not rewrite the updater's retained snapshot.
    assert db_session.get(RuntimeRouteSnapshot, hierarchy["route_id"]).delivered_eps_1m > 0


@pytest.mark.parametrize("model", SNAPSHOT_MODELS)
@pytest.mark.parametrize("condition", ["stale", "missing"])
def test_partial_read_model_is_not_current(
    db_session: Session, model: type, condition: str
) -> None:
    _mk_hierarchy(db_session, stream_name="first")
    _mk_hierarchy(db_session, stream_name="second")
    recompute_and_upsert_snapshots(db_session, bootstrap_last_outcomes=True)
    db_session.commit()
    assert load_physical_operational_rows(db_session) is not None
    assert snapshot_analytics_available(db_session)
    assert snapshot_health_available(db_session)

    row = db_session.query(model).first()
    if condition == "missing":
        db_session.delete(row)
    else:
        row.updated_at = datetime.now(UTC) - timedelta(seconds=61)
    db_session.commit()

    assert read_model_is_populated(db_session)  # Another fresh Stream row still exists.
    assert load_physical_operational_rows(db_session) is None
    assert not snapshot_analytics_available(db_session)
    assert not snapshot_health_available(db_session)


@pytest.mark.parametrize("new_failure", [False, True])
def test_stale_single_and_bulk_stats_keep_history_without_old_counts(
    db_session: Session, new_failure: bool
) -> None:
    hierarchy, last_success = _seed_cached_activity(db_session, hours_old=48)
    cached_failure = last_success - timedelta(seconds=30)
    for model in SNAPSHOT_MODELS:
        row = db_session.query(model).one()
        row.last_error_at = cached_failure
        row.last_error_message = "retained old receiver failure"
        row.updated_at = last_success
    db_session.commit()
    last_failure = _add_current_failure(db_session, hierarchy) if new_failure else cached_failure
    sid = hierarchy["stream_id"]
    single = get_stream_runtime_stats_and_health(db_session, sid, 20, window="1h")
    bulk = get_bulk_stream_stats_health(db_session, [sid], 20, window="1h").streams[str(sid)]

    for stats, health in ((single.stats, single.health), (bulk.stats, bulk.health_detail)):
        assert stats.summary.processed_events == 0
        assert stats.summary.route_send_success == 0
        assert stats.summary.route_send_failed == int(new_failure)
        assert stats.last_seen.success_at == last_success
        assert stats.last_seen.failure_at == last_failure
        assert stats.routes[0].last_success_at == last_success
        assert stats.routes[0].last_failure_at == last_failure
        assert health.routes[0].last_success_at == last_success
        assert health.routes[0].last_failure_at == last_failure
        if new_failure:
            assert health.routes[0].last_error_message == "current receiver failure"
            assert health.routes[0].health in ("DEGRADED", "UNHEALTHY")
        else:
            assert health.routes[0].last_error_message == "retained old receiver failure"
            assert health.routes[0].last_error_code is None
    assert bulk.events_1h == 0
    assert bulk.events_24h == 0
    assert bulk.last_event_at == max(last_failure, last_success)


@pytest.mark.parametrize("fresh_physical", [False, True])
def test_valid_zero_buckets_do_not_resurrect_snapshot_counts_or_latency(
    db_session: Session, monkeypatch: pytest.MonkeyPatch, fresh_physical: bool
) -> None:
    hierarchy, last_success = _seed_cached_activity(db_session, hours_old=48)
    if fresh_physical:
        for model in SNAPSHOT_MODELS:
            for row in db_session.query(model).all():
                row.updated_at = datetime.now(UTC)
    # Real populated bucket tables, with no rows in the requested 1h or 24h windows.
    for model in (RuntimeAnalyticsBucket1m, RuntimeAnalyticsBucket5m):
        db_session.add(
            model(
                bucket_start=datetime.now(UTC) - timedelta(days=2),
                stream_id=hierarchy["stream_id"],
                route_id=hierarchy["route_id"],
                destination_id=hierarchy["destination_id"],
                event_count=9,
                success_count=9,
            )
        )
    db_session.commit()
    monkeypatch.setattr(settings, "GDC_RUNTIME_ANALYTICS_BUCKET_READ_ENABLED", True)
    sid = hierarchy["stream_id"]

    single = get_stream_runtime_stats_and_health(db_session, sid, 20, window="1h")
    bulk = get_bulk_stream_stats_health(db_session, [sid], 20, window="1h").streams[str(sid)]
    metrics = try_build_stream_runtime_metrics(db_session, sid, window="1h")

    assert single.stats.summary.processed_events == 0
    assert bulk.stats.summary.processed_events == 0
    assert bulk.events_1h == 0
    assert bulk.events_24h == 0
    assert metrics is not None
    assert metrics.kpis.events_last_hour == 0
    assert metrics.kpis.avg_latency_ms == 0
    assert metrics.kpis.delivered_last_hour == 0
    assert metrics.route_runtime[0].last_success_at == last_success


@pytest.mark.parametrize("stale", [False, True])
def test_real_freshness_gate_keeps_bulk_queries_bounded(db_session: Session, stale: bool) -> None:
    stream_ids = _seed_streams(db_session, 25)
    recompute_and_upsert_snapshots(db_session, bootstrap_last_outcomes=True)
    if stale:
        for model in SNAPSHOT_MODELS:
            db_session.query(model).update({"updated_at": datetime.now(UTC) - timedelta(hours=3)})
    db_session.commit()
    query_count = 0

    def count_queries(_conn, _cursor, statement, _parameters, _context, _executemany) -> None:
        nonlocal query_count
        if statement.strip().upper().startswith(("SELECT", "WITH")):
            query_count += 1

    event.listen(db_session.bind, "before_cursor_execute", count_queries)
    try:
        response = get_bulk_stream_stats_health(db_session, stream_ids, 20, window="1h")
    finally:
        event.remove(db_session.bind, "before_cursor_execute", count_queries)
    assert len(response.streams) == 25
    assert query_count < 25, f"expected bounded bulk queries, got {query_count}"


@pytest.mark.parametrize("window,successes,failures", [("7d", 7, 3), ("30d", 12, 5)])
def test_historical_buckets_survive_stale_operational_snapshot(
    db_session: Session, monkeypatch: pytest.MonkeyPatch, window: str, successes: int, failures: int
) -> None:
    from app.runtime.read_service import get_runtime_dashboard_summary

    hierarchy, _ = _seed_cached_activity(db_session, hours_old=48)
    now = datetime.now(UTC)
    for days, success, failure in ((2, 7, 3), (10, 5, 2)):
        db_session.add(
            RuntimeAnalyticsBucket5m(
                bucket_start=now - timedelta(days=days),
                stream_id=hierarchy["stream_id"],
                route_id=hierarchy["route_id"],
                destination_id=hierarchy["destination_id"],
                event_count=success + failure,
                success_count=success,
                failure_count=failure,
            )
        )
    db_session.add(
        RuntimeAnalyticsBucket1m(
            bucket_start=now - timedelta(days=2),
            stream_id=hierarchy["stream_id"],
            route_id=hierarchy["route_id"],
            destination_id=hierarchy["destination_id"],
            event_count=10,
            success_count=7,
            failure_count=3,
        )
    )
    db_session.commit()
    monkeypatch.setattr(settings, "GDC_RUNTIME_ANALYTICS_BUCKET_READ_ENABLED", True)

    response = get_runtime_dashboard_summary(db_session, 20, window=window, snapshot_id=now.isoformat())
    assert response.read_status != "degraded"
    assert response.summary.total_streams == 1
    assert response.summary.delivery_success_events == successes
    assert response.summary.delivery_failure_events == failures
    assert response.summary.processed_events == 0
    assert response.window_end == now


@pytest.mark.parametrize(
    "interval,age,available",
    [(30, 59, True), (30, 60, True), (30, 61, False), (5, 11, False), (10, 19, True), (10, 21, False), (300, 61, False)],
)
def test_snapshot_freshness_tracks_tick_but_never_exceeds_one_minute(
    db_session: Session, monkeypatch: pytest.MonkeyPatch, interval: float, age: int, available: bool
) -> None:
    hierarchy, _ = _seed_cached_activity(db_session, hours_old=0)
    row = db_session.get(RuntimeStreamSnapshot, hierarchy["stream_id"])
    now = row.updated_at + timedelta(seconds=age)
    monkeypatch.setattr(settings, "GDC_RUNTIME_OPERATIONAL_SNAPSHOT_UPDATER_INTERVAL_SECONDS", interval)
    monkeypatch.setattr("app.runtime.operational_snapshot_repository.snapshot_now", lambda: now)
    monkeypatch.setattr("app.runtime.runtime_snapshot_repository.snapshot_now", lambda: now)

    assert (load_physical_operational_rows(db_session) is not None) is available
    assert snapshot_analytics_available(db_session) is available
    assert snapshot_health_available(db_session) is available


def test_bulk_current_issue_is_not_masked_by_another_routes_history(db_session: Session) -> None:
    from app.destinations.models import Destination
    from app.routes.models import Route

    hierarchy, last_success = _seed_cached_activity(db_session, hours_old=48)
    old_route = db_session.get(RuntimeRouteSnapshot, hierarchy["route_id"])
    old_route.last_error_at = last_success - timedelta(minutes=1)
    old_route.last_error_message = "historical route failure"
    old_route.updated_at = last_success
    destination = Destination(
        name="current-failure-destination",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://example.test/current-hook"},
        rate_limit_json={},
        enabled=True,
    )
    db_session.add(destination)
    db_session.flush()
    new_route = Route(
        stream_id=hierarchy["stream_id"],
        destination_id=destination.id,
        enabled=True,
        failure_policy="LOG_AND_CONTINUE",
        formatter_config_json={},
        rate_limit_json={},
        status="ENABLED",
    )
    db_session.add(new_route)
    db_session.flush()
    failing_hierarchy = {
        **hierarchy,
        "route_id": new_route.id,
        "destination_id": destination.id,
    }
    _add_current_failure(db_session, failing_hierarchy)

    entry = get_bulk_stream_stats_health(db_session, [hierarchy["stream_id"]], 20, window="1h").streams[str(hierarchy["stream_id"])]
    historical = next(row for row in entry.health_detail.routes if row.route_id == hierarchy["route_id"])
    assert historical.last_error_message == "historical route failure"
    assert historical.health in ("IDLE", "HEALTHY")
    assert entry.stats.summary.route_send_failed == 1
    assert entry.issue == "current receiver failure"


@pytest.mark.parametrize(
    "current_kind,cached_offset,current_message,expected_message,expected_code",
    [
        ("rate_limit", -60, "current throttle", "current throttle", "CURRENT_CODE"),
        ("failure", -60, None, None, "CURRENT_CODE"),
        ("failure", 60, "older live failure", "cached failure", None),
    ],
)
def test_history_merge_keeps_error_message_time_and_scoring(
    current_kind: str,
    cached_offset: int,
    current_message: str | None,
    expected_message: str | None,
    expected_code: str | None,
) -> None:
    from app.runtime.operational_snapshot_repository import LastOutcomeRow
    from app.runtime.read_service import _merge_health_outcome_metadata
    from app.runtime.schemas import RouteHealthItem, StreamHealthResponse, StreamHealthSummary

    now = datetime.now(UTC)
    original = StreamHealthResponse(
        stream_id=1,
        stream_status="RUNNING",
        health="DEGRADED",
        limit=20,
        summary=StreamHealthSummary(
            total_routes=1, healthy_routes=0, degraded_routes=1,
            unhealthy_routes=0, disabled_routes=0, idle_routes=0,
        ),
        routes=[RouteHealthItem(
            route_id=1,
            destination_id=1,
            destination_type="WEBHOOK_POST",
            route_enabled=True,
            destination_enabled=True,
            failure_policy="LOG_AND_CONTINUE",
            route_status="ENABLED",
            health="DEGRADED",
            success_count=2,
            failure_count=1,
            rate_limited_count=1,
            consecutive_failure_count=1,
            last_success_at=now - timedelta(minutes=5),
            last_failure_at=now if current_kind == "failure" else None,
            last_rate_limited_at=now if current_kind == "rate_limit" else None,
            last_error_message=current_message,
            last_error_code="CURRENT_CODE",
        )],
    )
    before = original.model_dump()
    cached = LastOutcomeRow(
        group_id=1,
        last_success_at=now - timedelta(days=2),
        last_failure_at=now + timedelta(seconds=cached_offset),
        last_error_message="cached failure",
    )
    merged = _merge_health_outcome_metadata(original, {1: cached})
    assert merged.routes[0].last_error_message == expected_message
    assert merged.routes[0].last_error_code == expected_code
    assert original.model_dump() == before
    assert merged.summary == original.summary
    assert merged.health == original.health
    metadata_fields = {"last_success_at", "last_failure_at", "last_error_message", "last_error_code"}
    assert merged.routes[0].model_dump(exclude=metadata_fields) == original.routes[0].model_dump(exclude=metadata_fields)


def test_destination_without_stream_does_not_make_physical_model_current(db_session: Session) -> None:
    from app.destinations.models import Destination

    destination = Destination(
        name="destination-without-stream",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://example.test/hook"},
        rate_limit_json={},
        enabled=True,
    )
    db_session.add(destination)
    db_session.flush()
    db_session.add(RuntimeDestinationSnapshot(destination_id=destination.id, updated_at=datetime.now(UTC)))
    db_session.commit()
    assert load_physical_operational_rows(db_session) is None
    assert not snapshot_analytics_available(db_session)
    assert not snapshot_health_available(db_session)
