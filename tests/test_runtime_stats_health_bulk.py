"""Bulk stream stats-health API — one aggregate read replaces N+1 per-stream calls."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event
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
def _clear_bulk_stats_health_cache() -> None:
    from app.runtime.stats_health_bulk_cache import clear_stats_health_bulk_cache

    clear_stats_health_bulk_cache()
    yield


@pytest.fixture(autouse=True)
def _bulk_stats_health_use_test_db(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.logs.incremental_aggregates import clear_incremental_delivery_log_aggregate_cache

    clear_incremental_delivery_log_aggregate_cache()
    monkeypatch.setattr(
        "app.runtime.runtime_snapshot_analytics_repository.snapshot_analytics_available",
        lambda _db: False,
    )

    def _fetch(stream_ids, limit, window, snapshot_id, *, cache_hit_miss):  # type: ignore[no-untyped-def]
        from app.runtime.stats_health_bulk_service import get_bulk_stream_stats_health

        return get_bulk_stream_stats_health(
            db_session,
            stream_ids,
            limit,
            window=window,
            snapshot_id=snapshot_id,
        )

    monkeypatch.setattr("app.runtime.stats_health_bulk_cache._fetch_bulk", _fetch)


def _seed_streams(db: Session, count: int) -> list[int]:
    connector = Connector(name="bulk-stats-connector", description=None, status="RUNNING")
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

    stream_ids: list[int] = []
    for i in range(count):
        stream = Stream(
            connector_id=connector.id,
            source_id=source.id,
            name=f"bulk-stats-stream-{i}",
            stream_type="HTTP_API_POLLING",
            config_json={},
            polling_interval=60,
            enabled=True,
            status="RUNNING",
            rate_limit_json={},
        )
        db.add(stream)
        db.flush()
        stream_ids.append(int(stream.id))

        dest = Destination(
            name=f"bulk-dest-{i}",
            destination_type="WEBHOOK_POST",
            config_json={"url": f"https://example-{i}.test/hook"},
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

        db.add(
            Checkpoint(
                stream_id=stream.id,
                checkpoint_type="offset",
                checkpoint_value_json={"offset": i},
            )
        )
        now = datetime.now(UTC)
        db.add(
            DeliveryLog(
                connector_id=connector.id,
                stream_id=stream.id,
                route_id=route.id,
                destination_id=dest.id,
                stage="run_complete",
                level="INFO",
                status="success",
                message="run complete",
                payload_sample={"input_events": 10 + i},
                created_at=now,
            )
        )
        db.add(
            DeliveryLog(
                connector_id=connector.id,
                stream_id=stream.id,
                route_id=route.id,
                destination_id=dest.id,
                stage="route_send_success",
                level="INFO",
                status="success",
                message="delivered",
                created_at=now,
            )
        )
    db.commit()
    return stream_ids


@pytest.fixture()
def bulk_stats_client(db_session: Session) -> TestClient:
    def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_db_read_bounded] = _override_db
    client = TestClient(app)
    yield client
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_db_read_bounded, None)


def test_bulk_stats_health_returns_all_requested_streams(bulk_stats_client: TestClient, db_session: Session) -> None:
    stream_ids = _seed_streams(db_session, 3)
    ids_param = ",".join(str(sid) for sid in stream_ids)
    resp = bulk_stats_client.get(
        "/api/v1/runtime/streams/stats-health/bulk",
        params={"ids": ids_param, "window": "1h", "limit": 24},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["window"] == "1h"
    assert set(body["streams"].keys()) == {str(sid) for sid in stream_ids}
    for sid in stream_ids:
        entry = body["streams"][str(sid)]
        assert entry["events_1h"] >= 0
        assert entry["health"] in {"healthy", "degraded", "unhealthy", "idle"}
        assert entry["stats"]["stream_id"] == sid
        assert entry["health_detail"]["stream_id"] == sid


def test_degraded_read_fallback_entry_has_no_health_verdict() -> None:
    """A failed bulk read is not evidence: health IDLE (not DEGRADED), issue still set."""

    from types import SimpleNamespace

    from app.runtime.stats_health_bulk_service import _build_degraded_bulk_entry

    entry = _build_degraded_bulk_entry(
        sid=7,
        stream=SimpleNamespace(status="RUNNING"),  # type: ignore[arg-type]
        routes=[],
        checkpoints={},
        limit=10,
    )
    # Old code: "degraded" / DEGRADED invented for every stream.
    assert entry.health == "idle"
    assert entry.health_detail.health == "IDLE"
    assert entry.issue  # fallback remains visible to callers


def test_bulk_stats_health_uses_few_queries_not_n_plus_one(bulk_stats_client: TestClient, db_session: Session) -> None:
    stream_ids = _seed_streams(db_session, 25)
    ids_param = ",".join(str(sid) for sid in stream_ids)
    query_count = 0

    def _count_queries(_conn, _cursor, statement, _parameters, _context, _executemany) -> None:
        nonlocal query_count
        sql = str(statement).strip().upper()
        if sql.startswith("SELECT") or sql.startswith("WITH"):
            query_count += 1

    event.listen(db_session.bind, "before_cursor_execute", _count_queries)  # type: ignore[arg-type]
    try:
        resp = bulk_stats_client.get(
            "/api/v1/runtime/streams/stats-health/bulk",
            params={"ids": ids_param, "window": "1h", "limit": 24},
        )
    finally:
        event.remove(db_session.bind, "before_cursor_execute", _count_queries)  # type: ignore[arg-type]

    assert resp.status_code == 200
    assert len(resp.json()["streams"]) == 25
    assert query_count < 25, f"expected bounded bulk queries, got {query_count}"


def test_bulk_stats_health_accepts_stream_ids_alias(bulk_stats_client: TestClient, db_session: Session) -> None:
    stream_ids = _seed_streams(db_session, 2)
    resp = bulk_stats_client.get(
        "/api/v1/runtime/streams/stats-health/bulk",
        params={"stream_ids": ",".join(str(sid) for sid in stream_ids), "window": "1h", "limit": 24},
    )
    assert resp.status_code == 200
    assert set(resp.json()["streams"].keys()) == {str(sid) for sid in stream_ids}


def test_bulk_stats_health_recent_logs_capped_at_20(bulk_stats_client: TestClient, db_session: Session) -> None:
    stream_ids = _seed_streams(db_session, 1)
    sid = stream_ids[0]
    connector_id = (
        db_session.query(DeliveryLog.connector_id)
        .filter(DeliveryLog.stream_id == sid)
        .limit(1)
        .scalar()
    )
    route_id = db_session.query(Route.id).filter(Route.stream_id == sid).limit(1).scalar()
    dest_id = db_session.query(Route.destination_id).filter(Route.stream_id == sid).limit(1).scalar()
    now = datetime.now(UTC)
    for i in range(30):
        db_session.add(
            DeliveryLog(
                connector_id=connector_id,
                stream_id=sid,
                route_id=route_id,
                destination_id=dest_id,
                stage="route_send_success",
                level="INFO",
                status="success",
                message=f"ok-{i}",
                created_at=now + timedelta(seconds=i),
            )
        )
    db_session.commit()
    resp = bulk_stats_client.get(
        "/api/v1/runtime/streams/stats-health/bulk",
        params={"ids": str(sid), "window": "1h", "limit": 100},
    )
    assert resp.status_code == 200
    recent = resp.json()["streams"][str(sid)]["stats"]["recent_logs"]
    assert len(recent) <= 20


def test_bulk_stats_health_replaces_per_stream_calls(bulk_stats_client: TestClient, db_session: Session) -> None:
    stream_ids = _seed_streams(db_session, 5)
    ids_param = ",".join(str(sid) for sid in stream_ids)

    bulk = bulk_stats_client.get(
        "/api/v1/runtime/streams/stats-health/bulk",
        params={"ids": ids_param, "window": "1h", "limit": 24},
    ).json()

    for sid in stream_ids:
        single = bulk_stats_client.get(
            f"/api/v1/runtime/streams/{sid}/stats-health",
            params={"window": "1h", "limit": 24},
        ).json()
        bulk_entry = bulk["streams"][str(sid)]
        assert bulk_entry["stats"]["summary"]["processed_events"] == single["stats"]["summary"]["processed_events"]
        assert bulk_entry["health_detail"]["health"] == single["health"]["health"]
