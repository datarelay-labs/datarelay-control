"""Unit tests for stream runtime metrics aggregation helpers."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.connectors.models import Connector
from app.destinations.models import Destination
from app.logs.models import DeliveryLog
from app.routes.models import Route
from app.runtime.metrics_service import _p95_int, _route_connectivity_state, build_stream_runtime_metrics
from app.runtime.metric_contract import METRIC_CONTRACT
from app.sources.models import Source
from app.streams.models import Stream

UTC = timezone.utc


def test_metric_contract_definitions_are_ontology_complete() -> None:
    required_meta_fields = {
        "metric_id",
        "semantic_type",
        "aggregation_type",
        "window_policy",
        "includes_lifecycle_rows",
        "includes_retry_success",
        "includes_retry_failed",
        "source_tables",
        "display_unit",
        "frontend_label",
        "frontend_description",
    }
    seen_labels_by_semantic: dict[str, str] = {}
    for metric_id, definition in METRIC_CONTRACT.items():
        meta = definition.to_meta()
        assert required_meta_fields.issubset(meta.keys()), metric_id
        label_key = str(meta["frontend_label"]).lower()
        semantic = str(meta["semantic_type"])
        if label_key in seen_labels_by_semantic:
            assert seen_labels_by_semantic[label_key] == semantic
        seen_labels_by_semantic[label_key] = semantic

    assert METRIC_CONTRACT["runtime_telemetry_rows.window"].semantic_type.value == "telemetry_rows"
    assert METRIC_CONTRACT["processed_events.window"].semantic_type.value == "source_input_events"
    assert METRIC_CONTRACT["delivery_outcomes.window"].semantic_type.value == "delivery_outcome_events"
    assert METRIC_CONTRACT["processed_events.window"].includes_retry_success is False
    assert METRIC_CONTRACT["delivery_outcomes.window"].includes_retry_success is True
    assert METRIC_CONTRACT["delivery_outcomes.success"].includes_retry_success is True
    assert METRIC_CONTRACT["delivery_outcomes.failure"].includes_retry_success is False
    assert METRIC_CONTRACT["runtime_telemetry_rows.window"].includes_retry_success is True


def _seed_stream_metrics(db: Session) -> dict[str, int]:
    connector = Connector(name="rtm-conn", description=None, status="RUNNING")
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
        name="rtm-stream",
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=60,
        enabled=True,
        status="RUNNING",
        rate_limit_json={},
    )
    db.add(stream)
    db.flush()
    destinations: list[Destination] = []
    routes: list[Route] = []
    for i in range(2):
        d = Destination(
            name=f"rtm-d{i}",
            destination_type="WEBHOOK_POST",
            config_json={"url": f"https://rtm{i}.example.invalid/h"},
            rate_limit_json={},
            enabled=True,
        )
        db.add(d)
        db.flush()
        destinations.append(d)
        r = Route(
            stream_id=stream.id,
            destination_id=d.id,
            enabled=True,
            failure_policy="LOG_AND_CONTINUE",
            formatter_config_json={},
            rate_limit_json={},
            status="ENABLED",
        )
        db.add(r)
        db.flush()
        routes.append(r)
    db.add(Checkpoint(stream_id=stream.id, checkpoint_type="CUSTOM_FIELD", checkpoint_value_json={"x": 1}))
    db.commit()
    return {
        "stream_id": int(stream.id),
        "connector_id": int(connector.id),
        "route_a": int(routes[0].id),
        "route_b": int(routes[1].id),
        "dest_a": int(destinations[0].id),
        "dest_b": int(destinations[1].id),
    }


def test_build_stream_runtime_metrics_route_aggregation_two_routes(db_session: Session) -> None:
    """Route-level delivered counts stay isolated per route (fan-out preservation in metrics)."""

    h = _seed_stream_metrics(db_session)
    sid = h["stream_id"]
    t0 = datetime.now(UTC) - timedelta(minutes=20)
    for rid, did, n in ((h["route_a"], h["dest_a"], 4), (h["route_b"], h["dest_b"], 7)):
        for i in range(n):
            db_session.add(
                DeliveryLog(
                    connector_id=h["connector_id"],
                    stream_id=sid,
                    route_id=rid,
                    destination_id=did,
                    stage="route_send_success",
                    level="INFO",
                    status="OK",
                    message="ok",
                    payload_sample={"event_count": 1},
                    retry_count=0,
                    http_status=200,
                    latency_ms=10 + i,
                    error_code=None,
                    created_at=t0 + timedelta(seconds=i),
                )
            )
    db_session.commit()

    body = build_stream_runtime_metrics(db_session, sid, window="1h")
    by_route = {r.route_id: r for r in body.route_runtime}
    assert by_route[h["route_a"]].delivered_last_hour == 4
    assert by_route[h["route_b"]].delivered_last_hour == 7
    assert body.kpis.delivered_last_hour == 11


def test_stream_runtime_metrics_exclude_lifecycle_rows_from_delivery_outcomes(db_session: Session) -> None:
    h = _seed_stream_metrics(db_session)
    sid = h["stream_id"]
    t0 = datetime.now(UTC) - timedelta(minutes=10)
    db_session.add(
        DeliveryLog(
            connector_id=h["connector_id"],
            stream_id=sid,
            route_id=None,
            destination_id=None,
            stage="run_complete",
            level="INFO",
            status="OK",
            message="done",
            payload_sample={"input_events": 9, "event_count": 99},
            retry_count=0,
            created_at=t0,
        )
    )
    db_session.add(
        DeliveryLog(
            connector_id=h["connector_id"],
            stream_id=sid,
            route_id=h["route_a"],
            destination_id=h["dest_a"],
            stage="route_send_success",
            level="INFO",
            status="OK",
            message="ok",
            payload_sample={"event_count": 4},
            retry_count=0,
            created_at=t0 + timedelta(seconds=1),
        )
    )
    db_session.commit()

    body = build_stream_runtime_metrics(db_session, sid, window="1h")
    assert body.kpis.events_last_hour == 9
    assert body.kpis.delivered_last_hour == 4
    assert body.kpis.delivered_last_hour + body.kpis.failed_last_hour == 4
    assert body.kpis.metric_meta["processed_events.window"]["semantic_type"] == "source_input_events"
    assert body.kpis.metric_meta["delivery_outcomes.window"]["semantic_type"] == "delivery_outcome_events"
    assert body.kpis.metric_meta["processed_events.window"]["window_start"] == body.metric_meta["processed_events.window"]["window_start"]


def test_build_stream_runtime_metrics_recent_runs_cap_at_25(db_session: Session) -> None:
    """recent_runs stays bounded when many run_complete rows exist (005 scalability)."""

    h = _seed_stream_metrics(db_session)
    sid = h["stream_id"]
    base = datetime.now(UTC) - timedelta(minutes=30)
    for i in range(32):
        db_session.add(
            DeliveryLog(
                connector_id=h["connector_id"],
                stream_id=sid,
                route_id=h["route_a"],
                destination_id=h["dest_a"],
                stage="run_complete",
                level="INFO",
                status="OK",
                message="done",
                payload_sample={"input_events": 1, "success_events": 1},
                retry_count=0,
                http_status=None,
                latency_ms=None,
                error_code=None,
                created_at=base + timedelta(seconds=i),
            )
        )
    db_session.commit()

    body = build_stream_runtime_metrics(db_session, sid, window="1h")
    assert len(body.recent_runs) == 25


def test_build_stream_runtime_metrics_clamps_wide_window(db_session: Session) -> None:
    """Operational metrics cap delivery_logs scans at 24h even when window token is wider."""

    h = _seed_stream_metrics(db_session)
    sid = h["stream_id"]
    body = build_stream_runtime_metrics(db_session, sid, window="7d")
    assert body.metrics_window_seconds <= 24 * 3600
    assert (body.window_end - body.window_start).total_seconds() <= 24 * 3600


def test_p95_empty() -> None:
    assert _p95_int([]) == 0.0


def test_p95_single() -> None:
    assert _p95_int([42]) == 42.0


def test_p95_percentile() -> None:
    vals = list(range(1, 101))
    assert _p95_int(vals) == 95.0


def test_connectivity_disabled_route() -> None:
    assert (
        _route_connectivity_state(
            route_enabled=False,
            destination_enabled=True,
            route_status="ENABLED",
            delivered_ev=10,
            failed_ev=0,
        )
        == "DISABLED"
    )


def test_connectivity_healthy() -> None:
    assert (
        _route_connectivity_state(
            route_enabled=True,
            destination_enabled=True,
            route_status="ENABLED",
            delivered_ev=10,
            failed_ev=0,
        )
        == "HEALTHY"
    )


def test_connectivity_error_all_failed() -> None:
    assert (
        _route_connectivity_state(
            route_enabled=True,
            destination_enabled=True,
            route_status="ENABLED",
            delivered_ev=0,
            failed_ev=5,
        )
        == "ERROR"
    )


def test_connectivity_idle_when_no_deliveries_and_no_failures() -> None:
    """Zero traffic is not a failure and not a HEALTHY verdict."""

    assert (
        _route_connectivity_state(
            route_enabled=True,
            destination_enabled=True,
            route_status="ENABLED",
            delivered_ev=0,
            failed_ev=0,
        )
        == "IDLE"
    )


def test_connectivity_degraded() -> None:
    assert (
        _route_connectivity_state(
            route_enabled=True,
            destination_enabled=True,
            route_status="ENABLED",
            delivered_ev=8,
            failed_ev=2,
        )
        == "DEGRADED"
    )
