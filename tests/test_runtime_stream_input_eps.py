"""Stream ingestion EPS counts run input once despite multi-Route delivery."""

from datetime import datetime, timedelta, timezone

import pytest

from app.destinations.models import Destination
from app.logs.models import DeliveryLog
from app.routes.models import Route
from app.runtime.models import RuntimeRouteSnapshot, RuntimeStreamSnapshot
from app.runtime.operational_snapshot_repository import (
    fetch_stream_input_window_counts,
    load_operational_snapshot_bulk_data,
)
from app.runtime.operational_snapshot_service import _assemble_snapshot
from app.runtime.runtime_snapshot_repository import recompute_and_upsert_snapshots
from tests.test_operational_snapshot_endpoint import _mk_hierarchy

UTC = timezone.utc


def _add_log(db, h, *, stage: str, when: datetime, payload: dict, route_id=None, dest_id=None):
    db.add(
        DeliveryLog(
            connector_id=h["connector_id"],
            stream_id=h["stream_id"],
            route_id=route_id,
            destination_id=dest_id,
            stage=stage,
            level="INFO",
            status="OK",
            message="synthetic ingest EPS regression",
            payload_sample=payload,
            retry_count=0,
            created_at=when,
        )
    )


def test_multi_route_input_eps_uses_run_complete_not_delivery_fanout(db_session):
    h = _mk_hierarchy(db_session, stream_name="input-fanout")
    extra = Destination(
        name="dest-second-input-fanout",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://example.test/second"},
        rate_limit_json={},
        enabled=True,
    )
    db_session.add(extra)
    db_session.flush()
    second_route = Route(
        stream_id=h["stream_id"],
        destination_id=extra.id,
        enabled=True,
        failure_policy="LOG_AND_CONTINUE",
        formatter_config_json={},
        rate_limit_json={},
        status="ENABLED",
    )
    db_session.add(second_route)
    db_session.flush()
    second_route_id = second_route.id
    second_dest_id = extra.id
    now = datetime.now(UTC)
    recent = now - timedelta(seconds=14)
    older = now - timedelta(minutes=2)

    # One fetched batch produces two identical Route outputs, never two inputs.
    _add_log(db_session, h, stage="run_complete", when=recent, payload={"input_events": 24})
    _add_log(db_session, h, stage="run_complete", when=older, payload={"input_events": 12})
    for route_id, dest_id in (
        (h["route_id"], h["destination_id"]),
        (second_route_id, second_dest_id),
    ):
        _add_log(
            db_session, h, stage="route_send_success", when=recent,
            payload={"event_count": 24}, route_id=route_id, dest_id=dest_id,
        )

    # Corrupt or legacy telemetry must never cast or invent an input count.
    for invalid in ("not-a-number", "-7", "99999999999999999999999"):
        _add_log(db_session, h, stage="run_complete", when=recent, payload={"input_events": invalid})
    _add_log(db_session, h, stage="run_complete", when=recent, payload={"other": 900})
    db_session.commit()

    one_minute = fetch_stream_input_window_counts(
        db_session, since=now - timedelta(minutes=1), until=now + timedelta(seconds=1)
    )
    five_minutes = fetch_stream_input_window_counts(
        db_session, since=now - timedelta(minutes=5), until=now + timedelta(seconds=1)
    )
    assert one_minute[h["stream_id"]] == 24
    assert five_minutes[h["stream_id"]] == 36

    virtual = _assemble_snapshot(load_operational_snapshot_bulk_data(db_session))
    vstream = next(s for s in virtual.streams if s.stream_id == h["stream_id"])
    assert vstream.eps_1m == pytest.approx(24 / 60)
    assert vstream.eps_5m == pytest.approx(36 / 300)
    assert virtual.global_.total_eps_1m == pytest.approx(24 / 60)

    recompute_and_upsert_snapshots(db_session, bootstrap_last_outcomes=True)
    db_session.commit()
    physical = db_session.get(RuntimeStreamSnapshot, h["stream_id"])
    assert physical is not None
    assert physical.eps_1m == pytest.approx(24 / 60)
    assert physical.eps_5m == pytest.approx(36 / 300)
    for route_id in (h["route_id"], second_route_id):
        route = db_session.get(RuntimeRouteSnapshot, route_id)
        assert route is not None
        assert route.delivered_eps_1m == pytest.approx(24 / 60)


def test_route_only_delivery_does_not_invent_source_ingest(db_session):
    h = _mk_hierarchy(db_session, stream_name="route-without-source-input")
    now = datetime.now(UTC)
    _add_log(
        db_session, h, stage="route_send_success",
        when=now - timedelta(seconds=12), payload={"event_count": 30},
        route_id=h["route_id"], dest_id=h["destination_id"],
    )
    db_session.commit()
    actual = fetch_stream_input_window_counts(
        db_session, since=now - timedelta(minutes=1), until=now + timedelta(seconds=1)
    )
    assert actual.get(h["stream_id"], 0) == 0
    recompute_and_upsert_snapshots(db_session, bootstrap_last_outcomes=True)
    db_session.commit()
    stream = db_session.get(RuntimeStreamSnapshot, h["stream_id"])
    route = db_session.get(RuntimeRouteSnapshot, h["route_id"])
    assert stream is not None and route is not None
    assert stream.eps_1m == 0.0
    assert route.delivered_eps_1m == pytest.approx(30 / 60)
