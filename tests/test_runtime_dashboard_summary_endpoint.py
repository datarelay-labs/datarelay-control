"""Runtime dashboard summary API — read-only global aggregates + recent delivery_logs."""

from __future__ import annotations

from datetime import datetime, timezone
from datetime import timedelta
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
from app.sources.models import Source
from app.streams.models import Stream

UTC = timezone.utc


@pytest.fixture(autouse=True)
def _clear_runtime_dashboard_read_cache() -> None:
    from app.runtime.dashboard_read_cache import clear_dashboard_read_cache

    clear_dashboard_read_cache()
    yield


@pytest.fixture(autouse=True)
def _legacy_dashboard_delivery_logs_aggregate(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """These tests assert exact delivery_logs window semantics (pre-Phase-5 path)."""

    from app.logs.incremental_aggregates import clear_incremental_delivery_log_aggregate_cache

    clear_incremental_delivery_log_aggregate_cache()
    monkeypatch.setattr(
        "app.runtime.runtime_snapshot_analytics_repository.snapshot_analytics_available",
        lambda _db: False,
    )

    def _run_with_test_session(fn, **kwargs):  # type: ignore[no-untyped-def]
        return fn(db_session)

    monkeypatch.setattr("app.runtime.dashboard_read_cache._run_with_session", _run_with_test_session)


def _mk_stream_hierarchy(
    db: Session,
    *,
    stream_status: str,
    route_enabled: bool = True,
    destination_enabled: bool = True,
) -> dict[str, Any]:
    connector = Connector(name="dash-connector", description=None, status="RUNNING")
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
        name=f"dash-{stream_status}",
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=60,
        enabled=True,
        status=stream_status,
        rate_limit_json={},
    )
    db.add(stream)
    db.flush()
    destination = Destination(
        name="dash-dest",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://x.example/hook"},
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
    checkpoint = Checkpoint(stream_id=stream.id, checkpoint_type="CUSTOM_FIELD", checkpoint_value_json={})
    db.add(checkpoint)
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
    route_id: int | None,
    destination_id: int | None,
    stage: str,
    created_at: datetime,
    message: str = "msg",
    error_code: str | None = None,
    level: str = "INFO",
    payload_sample: dict[str, Any] | None = None,
) -> None:
    db.add(
        DeliveryLog(
            connector_id=connector_id,
            stream_id=stream_id,
            route_id=route_id,
            destination_id=destination_id,
            stage=stage,
            level=level,
            status="OK",
            message=message,
            payload_sample=payload_sample or {},
            retry_count=0,
            error_code=error_code,
            created_at=created_at,
        )
    )


@pytest.fixture
def dashboard_client(db_session: Session) -> TestClient:
    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_db_read_bounded] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_db_read_bounded, None)


def test_dashboard_summary_success(dashboard_client: TestClient, db_session: Session) -> None:
    h = _mk_stream_hierarchy(db_session, stream_status="RUNNING")
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_id"],
        destination_id=h["destination_id"],
        stage="route_send_success",
        created_at=datetime.now(UTC) - timedelta(minutes=5),
    )
    db_session.commit()

    response = dashboard_client.get("/api/v1/runtime/dashboard/summary")
    assert response.status_code == 200
    body = response.json()
    assert "summary" in body
    assert body["summary"]["total_streams"] >= 1


def test_stream_status_counts(dashboard_client: TestClient, db_session: Session) -> None:
    _mk_stream_hierarchy(db_session, stream_status="RUNNING")
    _mk_stream_hierarchy(db_session, stream_status="PAUSED")
    _mk_stream_hierarchy(db_session, stream_status="ERROR")
    _mk_stream_hierarchy(db_session, stream_status="STOPPED")
    _mk_stream_hierarchy(db_session, stream_status="RATE_LIMITED_SOURCE")
    _mk_stream_hierarchy(db_session, stream_status="RATE_LIMITED_DESTINATION")
    _mk_stream_hierarchy(db_session, stream_status="CUSTOM_UNKNOWN")

    db_session.commit()

    s = dashboard_client.get("/api/v1/runtime/dashboard/summary").json()["summary"]
    assert s["total_streams"] >= 7
    assert s["running_streams"] >= 1
    assert s["paused_streams"] >= 1
    assert s["error_streams"] >= 1
    assert s["stopped_streams"] >= 1
    assert s["rate_limited_source_streams"] >= 1
    assert s["rate_limited_destination_streams"] >= 1


def test_route_enabled_disabled_counts(dashboard_client: TestClient, db_session: Session) -> None:
    _mk_stream_hierarchy(db_session, stream_status="RUNNING", route_enabled=True)
    _mk_stream_hierarchy(db_session, stream_status="RUNNING", route_enabled=False)
    db_session.commit()

    s = dashboard_client.get("/api/v1/runtime/dashboard/summary").json()["summary"]
    assert s["total_routes"] >= 2
    assert s["enabled_routes"] >= 1
    assert s["disabled_routes"] >= 1
    assert s["enabled_routes"] + s["disabled_routes"] == s["total_routes"]


def test_destination_enabled_disabled_counts(dashboard_client: TestClient, db_session: Session) -> None:
    _mk_stream_hierarchy(db_session, stream_status="RUNNING", destination_enabled=True)
    _mk_stream_hierarchy(db_session, stream_status="RUNNING", destination_enabled=False)
    db_session.commit()

    s = dashboard_client.get("/api/v1/runtime/dashboard/summary").json()["summary"]
    assert s["total_destinations"] >= 2
    assert s["enabled_destinations"] >= 1
    assert s["disabled_destinations"] >= 1
    assert s["enabled_destinations"] + s["disabled_destinations"] == s["total_destinations"]


def test_recent_category_counts(dashboard_client: TestClient, db_session: Session) -> None:
    h = _mk_stream_hierarchy(db_session, stream_status="RUNNING")
    cid = h["connector_id"]
    sid = h["stream_id"]
    rid = h["route_id"]
    did = h["destination_id"]
    base = datetime.now(UTC) - timedelta(minutes=5)
    _log(db_session, connector_id=cid, stream_id=sid, route_id=rid, destination_id=did, stage="route_send_success", created_at=base)
    _log(db_session, connector_id=cid, stream_id=sid, route_id=rid, destination_id=did, stage="route_retry_success", created_at=base)
    _log(db_session, connector_id=cid, stream_id=sid, route_id=rid, destination_id=did, stage="route_send_failed", created_at=base)
    _log(db_session, connector_id=cid, stream_id=sid, route_id=rid, destination_id=did, stage="route_retry_failed", created_at=base)
    _log(db_session, connector_id=cid, stream_id=sid, route_id=rid, destination_id=did, stage="route_unknown_failure_policy", created_at=base)
    _log(db_session, connector_id=cid, stream_id=sid, route_id=None, destination_id=None, stage="source_rate_limited", created_at=base)
    _log(db_session, connector_id=cid, stream_id=sid, route_id=rid, destination_id=did, stage="destination_rate_limited", created_at=base)
    db_session.commit()
    assert db_session.query(DeliveryLog).count() == 7

    s = dashboard_client.get("/api/v1/runtime/dashboard/summary", params={"limit": 100}).json()["summary"]
    assert s["recent_logs"] == 7
    assert s["recent_successes"] == 2
    assert s["recent_failures"] == 3
    assert s["recent_rate_limited"] == 2


def test_dashboard_shared_summaries_separate_rows_processed_and_delivery_events(
    dashboard_client: TestClient,
    db_session: Session,
) -> None:
    h = _mk_stream_hierarchy(db_session, stream_status="RUNNING")
    cid = h["connector_id"]
    sid = h["stream_id"]
    rid = h["route_id"]
    did = h["destination_id"]
    base = datetime.now(UTC) - timedelta(minutes=5)
    _log(
        db_session,
        connector_id=cid,
        stream_id=sid,
        route_id=None,
        destination_id=None,
        stage="run_complete",
        created_at=base,
        payload_sample={"input_events": 10},
    )
    _log(
        db_session,
        connector_id=cid,
        stream_id=sid,
        route_id=rid,
        destination_id=did,
        stage="route_retry_success",
        created_at=base + timedelta(seconds=1),
        payload_sample={"event_count": 4},
    )
    _log(
        db_session,
        connector_id=cid,
        stream_id=sid,
        route_id=rid,
        destination_id=did,
        stage="route_send_failed",
        created_at=base + timedelta(seconds=2),
        payload_sample={"event_count": 3},
    )
    _log(
        db_session,
        connector_id=cid,
        stream_id=sid,
        route_id=None,
        destination_id=None,
        stage="run_complete",
        level="DEBUG",
        created_at=base + timedelta(seconds=3),
        payload_sample={"input_events": 99},
    )
    _log(
        db_session,
        connector_id=cid,
        stream_id=sid,
        route_id=None,
        destination_id=None,
        stage="checkpoint_update",
        created_at=base + timedelta(seconds=4),
    )
    db_session.commit()

    body = dashboard_client.get("/api/v1/runtime/dashboard/summary", params={"window": "1h", "limit": 100}).json()
    s = body["summary"]
    assert s["recent_logs"] == 5
    assert s["processed_events"] == 10
    assert s["delivery_success_events"] == 4
    assert s["delivery_failure_events"] == 3
    assert s["delivery_outcome_events"] == 7
    assert s["delivery_outcome_events"] == s["delivery_success_events"] + s["delivery_failure_events"]
    assert s["recent_logs"] != s["processed_events"]
    assert s["recent_logs"] != s["delivery_outcome_events"]
    assert s["processed_events"] != s["delivery_outcome_events"]

    meta = body["metric_meta"]
    assert meta["runtime_telemetry_rows.window"]["semantic_type"] == "telemetry_rows"
    assert meta["processed_events.window"]["semantic_type"] == "source_input_events"
    assert meta["delivery_outcomes.window"]["semantic_type"] == "delivery_outcome_events"
    assert meta["processed_events.window"]["window_start"] == meta["delivery_outcomes.window"]["window_start"]
    assert meta["processed_events.window"]["window_end"] == meta["delivery_outcomes.window"]["window_end"]


def test_dashboard_snapshot_reused_across_widgets_and_stream_metrics(
    dashboard_client: TestClient,
    db_session: Session,
) -> None:
    h = _mk_stream_hierarchy(db_session, stream_status="RUNNING")
    cid = h["connector_id"]
    sid = h["stream_id"]
    rid = h["route_id"]
    did = h["destination_id"]
    snapshot_at = datetime.now(UTC).replace(microsecond=0)
    base = snapshot_at - timedelta(minutes=5)
    _log(
        db_session,
        connector_id=cid,
        stream_id=sid,
        route_id=None,
        destination_id=None,
        stage="run_complete",
        created_at=base,
        payload_sample={"input_events": 10},
    )
    _log(
        db_session,
        connector_id=cid,
        stream_id=sid,
        route_id=rid,
        destination_id=did,
        stage="route_send_success",
        created_at=base + timedelta(seconds=1),
        payload_sample={"event_count": 4},
    )
    _log(
        db_session,
        connector_id=cid,
        stream_id=sid,
        route_id=rid,
        destination_id=did,
        stage="route_send_failed",
        created_at=base + timedelta(seconds=2),
        payload_sample={"event_count": 3},
    )
    db_session.commit()

    params = {"window": "1h", "snapshot_id": snapshot_at.isoformat()}
    summary_body = dashboard_client.get("/api/v1/runtime/dashboard/summary", params=params).json()
    stream_body = dashboard_client.get(f"/api/v1/runtime/streams/{sid}/metrics", params=params).json()
    outcome_body = dashboard_client.get("/api/v1/runtime/dashboard/outcome-timeseries", params=params).json()

    assert summary_body["snapshot_id"] == stream_body["snapshot_id"] == outcome_body["snapshot_id"]
    assert summary_body["generated_at"] == stream_body["generated_at"] == outcome_body["generated_at"]
    assert summary_body["window_start"] == stream_body["window_start"] == outcome_body["window_start"]
    assert summary_body["window_end"] == stream_body["window_end"] == outcome_body["window_end"]

    assert summary_body["summary"]["processed_events"] == stream_body["kpis"]["events_last_hour"] == 10
    assert summary_body["summary"]["delivery_success_events"] == stream_body["kpis"]["delivered_last_hour"] == 4
    assert summary_body["summary"]["delivery_failure_events"] == stream_body["kpis"]["failed_last_hour"] == 3
    assert summary_body["summary"]["delivery_outcome_events"] == 7

    summary_meta = summary_body["metric_meta"]["processed_events.window"]
    stream_meta = stream_body["metric_meta"]["processed_events.window"]
    assert summary_meta["metric_id"] == stream_meta["metric_id"] == "processed_events.window"
    assert summary_meta["window_start"] == stream_meta["window_start"]
    assert summary_meta["window_end"] == stream_meta["window_end"]


def test_recent_problem_routes_dedupe_by_route_id(dashboard_client: TestClient, db_session: Session) -> None:
    h = _mk_stream_hierarchy(db_session, stream_status="RUNNING")
    rid = h["route_id"]
    base = datetime.now(UTC) - timedelta(minutes=5)
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=rid,
        destination_id=h["destination_id"],
        stage="route_send_failed",
        created_at=base,
        message="older",
        error_code="OLD",
    )
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=rid,
        destination_id=h["destination_id"],
        stage="route_send_failed",
        created_at=base + timedelta(seconds=1),
        message="newer",
        error_code="NEW",
    )
    db_session.commit()

    routes = dashboard_client.get("/api/v1/runtime/dashboard/summary").json()["recent_problem_routes"]
    matching = [r for r in routes if r["route_id"] == rid]
    assert len(matching) == 1
    assert matching[0]["message"] == "newer"
    assert matching[0]["error_code"] == "NEW"


def test_recent_rate_limited_routes_dedupe_by_route_id(dashboard_client: TestClient, db_session: Session) -> None:
    h = _mk_stream_hierarchy(db_session, stream_status="RUNNING")
    rid = h["route_id"]
    base = datetime.now(UTC) - timedelta(minutes=5)
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=rid,
        destination_id=h["destination_id"],
        stage="destination_rate_limited",
        created_at=base,
        message="older-rl",
    )
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=rid,
        destination_id=h["destination_id"],
        stage="destination_rate_limited",
        created_at=base + timedelta(seconds=1),
        message="newer-rl",
    )
    db_session.commit()

    routes = dashboard_client.get("/api/v1/runtime/dashboard/summary").json()["recent_rate_limited_routes"]
    matching = [r for r in routes if r["route_id"] == rid]
    assert len(matching) == 1
    assert matching[0]["message"] == "newer-rl"


def test_recent_unhealthy_streams_dedupe_by_stream_id(dashboard_client: TestClient, db_session: Session) -> None:
    h = _mk_stream_hierarchy(db_session, stream_status="RUNNING")
    sid = h["stream_id"]
    base = datetime.now(UTC) - timedelta(minutes=5)
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=sid,
        route_id=h["route_id"],
        destination_id=h["destination_id"],
        stage="route_send_failed",
        created_at=base,
        message="first",
    )
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=sid,
        route_id=None,
        destination_id=None,
        stage="source_rate_limited",
        created_at=base + timedelta(seconds=1),
        message="second",
    )
    db_session.commit()

    unhealthy = dashboard_client.get("/api/v1/runtime/dashboard/summary").json()["recent_unhealthy_streams"]
    matching = [u for u in unhealthy if u["stream_id"] == sid]
    assert len(matching) == 1
    assert matching[0]["last_problem_stage"] == "source_rate_limited"
    assert matching[0]["last_error_message"] == "second"


def test_limit_validation_422(dashboard_client: TestClient, db_session: Session) -> None:
    _mk_stream_hierarchy(db_session, stream_status="RUNNING")
    db_session.commit()
    assert dashboard_client.get("/api/v1/runtime/dashboard/summary", params={"limit": 0}).status_code == 422
    assert dashboard_client.get("/api/v1/runtime/dashboard/summary", params={"limit": 5000}).status_code == 422


def test_no_commit_or_rollback(
    monkeypatch: pytest.MonkeyPatch,
    dashboard_client: TestClient,
    db_session: Session,
) -> None:
    _mk_stream_hierarchy(db_session, stream_status="RUNNING")
    db_session.commit()

    commit_calls = {"n": 0}
    rollback_calls = {"n": 0}
    real_commit = Session.commit
    real_rollback = Session.rollback

    def _counting_commit(self: Any, *args: Any, **kwargs: Any) -> None:
        commit_calls["n"] += 1
        return real_commit(self, *args, **kwargs)

    def _counting_rollback(self: Any, *args: Any, **kwargs: Any) -> None:
        rollback_calls["n"] += 1
        return real_rollback(self, *args, **kwargs)

    monkeypatch.setattr("sqlalchemy.orm.session.Session.commit", _counting_commit)
    monkeypatch.setattr("sqlalchemy.orm.session.Session.rollback", _counting_rollback)

    assert dashboard_client.get("/api/v1/runtime/dashboard/summary").status_code == 200
    assert commit_calls["n"] == 0
    assert rollback_calls["n"] == 0


def test_dashboard_summary_200_after_destination_send_failed(
    dashboard_client: TestClient, db_session: Session
) -> None:
    """Route delivery failure must degrade status, not break dashboard summary."""
    h = _mk_stream_hierarchy(db_session, stream_status="RUNNING")
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_id"],
        destination_id=h["destination_id"],
        stage="route_send_failed",
        created_at=datetime.now(UTC) - timedelta(minutes=5),
        message="destination unreachable",
        error_code="DESTINATION_UNREACHABLE",
    )
    db_session.commit()

    response = dashboard_client.get("/api/v1/runtime/dashboard/summary")
    assert response.status_code == 200
    body = response.json()
    assert body["summary"]["total_streams"] >= 1
    assert body["summary"]["recent_failures"] >= 1


def test_no_extra_delivery_logs(dashboard_client: TestClient, db_session: Session) -> None:
    h = _mk_stream_hierarchy(db_session, stream_status="RUNNING")
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_id"],
        destination_id=h["destination_id"],
        stage="run_complete",
        created_at=datetime.now(UTC) - timedelta(minutes=5),
    )
    db_session.commit()
    before = db_session.query(DeliveryLog).count()
    dashboard_client.get("/api/v1/runtime/dashboard/summary")
    assert db_session.query(DeliveryLog).count() == before


def test_dashboard_open_schema_field_drift_count_open_only(
    dashboard_client: TestClient,
    db_session: Session,
) -> None:
    """Schema Drift aggregate counts OPEN findings only; excludes ack/resolved."""

    from app.schema_observation.models import (
        DRIFT_CATEGORY_FIELD_ADDED,
        DRIFT_STATUS_ACKNOWLEDGED,
        DRIFT_STATUS_OPEN,
        DRIFT_STATUS_RESOLVED,
        StreamSchemaFieldDrift,
    )

    h1 = _mk_stream_hierarchy(db_session, stream_status="RUNNING")
    h2 = _mk_stream_hierarchy(db_session, stream_status="RUNNING")
    now = datetime.now(UTC)
    db_session.add_all(
        [
            StreamSchemaFieldDrift(
                stream_id=h1["stream_id"],
                field_path="$.a",
                category=DRIFT_CATEGORY_FIELD_ADDED,
                status=DRIFT_STATUS_OPEN,
                first_detected_at=now,
                last_confirmed_at=now,
            ),
            StreamSchemaFieldDrift(
                stream_id=h1["stream_id"],
                field_path="$.b",
                category=DRIFT_CATEGORY_FIELD_ADDED,
                status=DRIFT_STATUS_OPEN,
                first_detected_at=now,
                last_confirmed_at=now,
            ),
            StreamSchemaFieldDrift(
                stream_id=h2["stream_id"],
                field_path="$.c",
                category=DRIFT_CATEGORY_FIELD_ADDED,
                status=DRIFT_STATUS_ACKNOWLEDGED,
                first_detected_at=now,
                last_confirmed_at=now,
                acknowledged_at=now,
                acknowledged_by="tester",
            ),
            StreamSchemaFieldDrift(
                stream_id=h2["stream_id"],
                field_path="$.d",
                category=DRIFT_CATEGORY_FIELD_ADDED,
                status=DRIFT_STATUS_RESOLVED,
                first_detected_at=now,
                last_confirmed_at=now,
                resolved_at=now,
                resolved_by="tester",
            ),
        ]
    )
    db_session.commit()

    body = dashboard_client.get("/api/v1/runtime/dashboard/summary").json()
    assert body["open_schema_field_drift_count"] == 2
