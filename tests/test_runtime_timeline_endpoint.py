"""Runtime stream timeline API — chronological delivery_logs (read-only)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.connectors.models import Connector
from app.database import get_db
from app.destinations.models import Destination
from app.logs.models import DeliveryLog
from app.main import app
from app.routes.models import Route
from app.sources.models import Source
from app.streams.models import Stream

UTC = timezone.utc


def _seed_stream_two_routes(db: Session) -> dict[str, int]:
    connector = Connector(name="timeline-connector", description=None, status="RUNNING")
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
        name="timeline-stream",
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=60,
        enabled=True,
        status="RUNNING",
        rate_limit_json={},
    )
    db.add(stream)
    db.flush()
    d1 = Destination(
        name="tl-d1",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://a.example/h"},
        rate_limit_json={},
        enabled=True,
    )
    d2 = Destination(
        name="tl-d2",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://b.example/h"},
        rate_limit_json={},
        enabled=True,
    )
    db.add_all([d1, d2])
    db.flush()
    r1 = Route(
        stream_id=stream.id,
        destination_id=d1.id,
        enabled=True,
        failure_policy="LOG_AND_CONTINUE",
        formatter_config_json={},
        rate_limit_json={},
        status="ENABLED",
    )
    r2 = Route(
        stream_id=stream.id,
        destination_id=d2.id,
        enabled=True,
        failure_policy="LOG_AND_CONTINUE",
        formatter_config_json={},
        rate_limit_json={},
        status="ENABLED",
    )
    db.add_all([r1, r2])
    db.add(Checkpoint(stream_id=stream.id, checkpoint_type="CUSTOM_FIELD", checkpoint_value_json={}))
    db.commit()
    db.refresh(stream)
    db.refresh(r1)
    db.refresh(r2)
    return {
        "connector_id": connector.id,
        "stream_id": stream.id,
        "route_a_id": r1.id,
        "route_b_id": r2.id,
        "dest_a_id": d1.id,
        "dest_b_id": d2.id,
    }


def _log(
    db: Session,
    *,
    connector_id: int,
    stream_id: int,
    route_id: int | None,
    destination_id: int | None,
    stage: str,
    level: str = "INFO",
    status: str | None = "OK",
    message: str = "m",
    error_code: str | None = None,
    created_at: datetime | None = None,
    payload_sample: dict[str, Any] | None = None,
    retry_count: int = 0,
    http_status: int | None = None,
    latency_ms: int | None = None,
) -> None:
    db.add(
        DeliveryLog(
            connector_id=connector_id,
            stream_id=stream_id,
            route_id=route_id,
            destination_id=destination_id,
            stage=stage,
            level=level,
            status=status,
            message=message,
            payload_sample=payload_sample or {"secret": "x"},
            retry_count=retry_count,
            http_status=http_status,
            latency_ms=latency_ms,
            error_code=error_code,
            created_at=created_at or datetime(2026, 5, 6, 10, 0, 0, tzinfo=UTC),
        )
    )


@pytest.fixture
def timeline_client(db_session: Session) -> TestClient:
    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def test_timeline_success(timeline_client: TestClient, db_session: Session) -> None:
    h = _seed_stream_two_routes(db_session)
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_a_id"],
        destination_id=h["dest_a_id"],
        stage="run_complete",
        message="first",
        retry_count=1,
        http_status=200,
        latency_ms=42,
        created_at=datetime(2026, 5, 10, 8, 0, 0, tzinfo=UTC),
    )
    db_session.commit()

    r = timeline_client.get(f"/api/v1/runtime/timeline/stream/{h['stream_id']}")
    assert r.status_code == 200
    body = r.json()
    assert body["stream_id"] == h["stream_id"]
    assert body["total"] == 1
    assert len(body["items"]) == 1
    item = body["items"][0]
    assert item["message"] == "first"
    assert item["retry_count"] == 1
    assert item["http_status"] == 200
    assert item["latency_ms"] == 42
    assert item["route_id"] == h["route_a_id"]
    assert item["destination_id"] == h["dest_a_id"]


def test_timeline_order_created_at_then_id_asc(timeline_client: TestClient, db_session: Session) -> None:
    h = _seed_stream_two_routes(db_session)
    t0 = datetime(2026, 5, 11, 12, 0, 0, tzinfo=UTC)
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_a_id"],
        destination_id=h["dest_a_id"],
        stage="run_complete",
        message="older_ts",
        created_at=t0,
    )
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_a_id"],
        destination_id=h["dest_a_id"],
        stage="run_complete",
        message="newer_ts",
        created_at=datetime(2026, 5, 11, 13, 0, 0, tzinfo=UTC),
    )
    db_session.commit()

    items = timeline_client.get(f"/api/v1/runtime/timeline/stream/{h['stream_id']}").json()["items"]
    assert [row["message"] for row in items] == ["older_ts", "newer_ts"]

    db_session.query(DeliveryLog).filter(DeliveryLog.stream_id == h["stream_id"]).delete(synchronize_session=False)
    db_session.commit()

    ts_same = datetime(2026, 5, 12, 1, 0, 0, tzinfo=UTC)
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_a_id"],
        destination_id=h["dest_a_id"],
        stage="run_complete",
        message="lower_id",
        created_at=ts_same,
    )
    db_session.flush()
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_a_id"],
        destination_id=h["dest_a_id"],
        stage="run_complete",
        message="higher_id",
        created_at=ts_same,
    )
    db_session.commit()

    items2 = timeline_client.get(f"/api/v1/runtime/timeline/stream/{h['stream_id']}").json()["items"]
    assert len(items2) == 2
    assert items2[0]["message"] == "lower_id"
    assert items2[1]["message"] == "higher_id"
    assert items2[0]["id"] < items2[1]["id"]


def test_timeline_limit_applied(timeline_client: TestClient, db_session: Session) -> None:
    h = _seed_stream_two_routes(db_session)
    for i in range(5):
        _log(
            db_session,
            connector_id=h["connector_id"],
            stream_id=h["stream_id"],
            route_id=h["route_a_id"],
            destination_id=h["dest_a_id"],
            stage="run_complete",
            message=f"m{i}",
            created_at=datetime(2026, 5, 13, 8, i, 0, tzinfo=UTC),
        )
    db_session.commit()

    body = timeline_client.get(
        f"/api/v1/runtime/timeline/stream/{h['stream_id']}",
        params={"limit": 2},
    ).json()
    assert body["total"] == 2
    assert len(body["items"]) == 2
    assert [row["message"] for row in body["items"]] == ["m3", "m4"]


def test_timeline_filter_stage(timeline_client: TestClient, db_session: Session) -> None:
    h = _seed_stream_two_routes(db_session)
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_a_id"],
        destination_id=h["dest_a_id"],
        stage="route_send_failed",
        message="fail",
    )
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_a_id"],
        destination_id=h["dest_a_id"],
        stage="route_send_success",
        message="ok",
    )
    db_session.commit()

    items = timeline_client.get(
        f"/api/v1/runtime/timeline/stream/{h['stream_id']}",
        params={"stage": "route_send_failed"},
    ).json()["items"]
    assert len(items) == 1
    assert items[0]["stage"] == "route_send_failed"


def test_timeline_filter_route_id(timeline_client: TestClient, db_session: Session) -> None:
    h = _seed_stream_two_routes(db_session)
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_a_id"],
        destination_id=h["dest_a_id"],
        stage="run_complete",
        message="ra",
    )
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_b_id"],
        destination_id=h["dest_b_id"],
        stage="run_complete",
        message="rb",
    )
    db_session.commit()

    items = timeline_client.get(
        f"/api/v1/runtime/timeline/stream/{h['stream_id']}",
        params={"route_id": h["route_a_id"]},
    ).json()["items"]
    assert len(items) == 1
    assert items[0]["message"] == "ra"


def test_timeline_filter_destination_id(timeline_client: TestClient, db_session: Session) -> None:
    h = _seed_stream_two_routes(db_session)
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_a_id"],
        destination_id=h["dest_a_id"],
        stage="run_complete",
        message="da",
    )
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_b_id"],
        destination_id=h["dest_b_id"],
        stage="run_complete",
        message="db",
    )
    db_session.commit()

    items = timeline_client.get(
        f"/api/v1/runtime/timeline/stream/{h['stream_id']}",
        params={"destination_id": h["dest_b_id"]},
    ).json()["items"]
    assert len(items) == 1
    assert items[0]["message"] == "db"


def test_timeline_payload_sample_not_in_response(timeline_client: TestClient, db_session: Session) -> None:
    h = _seed_stream_two_routes(db_session)
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_a_id"],
        destination_id=h["dest_a_id"],
        stage="run_complete",
        payload_sample={"x": "y"},
    )
    db_session.commit()

    raw = timeline_client.get(f"/api/v1/runtime/timeline/stream/{h['stream_id']}").text
    assert "payload_sample" not in raw
    assert "secret" not in raw


def test_timeline_stream_not_found(timeline_client: TestClient, db_session: Session) -> None:
    _seed_stream_two_routes(db_session)
    db_session.commit()

    r = timeline_client.get("/api/v1/runtime/timeline/stream/999999999")
    assert r.status_code == 404
    assert r.json()["detail"]["error_code"] == "STREAM_NOT_FOUND"


def test_timeline_no_commit_or_rollback(
    monkeypatch: pytest.MonkeyPatch,
    timeline_client: TestClient,
    db_session: Session,
) -> None:
    h = _seed_stream_two_routes(db_session)
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

    assert timeline_client.get(f"/api/v1/runtime/timeline/stream/{h['stream_id']}").status_code == 200
    assert commit_calls["n"] == 0
    assert rollback_calls["n"] == 0


def test_timeline_limit_validation_422(timeline_client: TestClient, db_session: Session) -> None:
    h = _seed_stream_two_routes(db_session)
    db_session.commit()
    sid = h["stream_id"]
    assert timeline_client.get(f"/api/v1/runtime/timeline/stream/{sid}", params={"limit": 0}).status_code == 422
    assert timeline_client.get(f"/api/v1/runtime/timeline/stream/{sid}", params={"limit": 501}).status_code == 422
