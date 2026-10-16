"""Physical runtime operational snapshot read model (Phase 4)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database import get_db, get_db_read_bounded
from app.main import app

from app.checkpoints.models import Checkpoint
from app.config import settings
from app.connectors.models import Connector
from app.destinations.models import Destination
from app.logs.models import DeliveryLog
from app.routes.models import Route
from app.runtime.models import (
    RuntimeDestinationSnapshot,
    RuntimeRouteSnapshot,
    RuntimeStreamSnapshot,
)
from app.runtime.runtime_snapshot_repository import read_model_is_populated, recompute_and_upsert_snapshots
from app.runtime.runtime_snapshot_updater import (
    reset_updater_overlap_guard_for_tests,
    run_runtime_snapshot_update,
)
from app.sources.models import Source
from app.streams.models import Stream

UTC = timezone.utc


def _mk_hierarchy(
    db: Session,
    *,
    stream_name: str = "snap-stream",
    stream_enabled: bool = True,
    stream_status: str = "RUNNING",
    route_enabled: bool = True,
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
        enabled=True,
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
            message="delivery",
            payload_sample={"input_events": 1} if stage == "run_complete" else {"event_count": 1},
            retry_count=0,
            latency_ms=50,
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


@pytest.fixture(autouse=True)
def _reset_overlap_guard() -> None:
    reset_updater_overlap_guard_for_tests()
    yield
    reset_updater_overlap_guard_for_tests()


def test_recompute_upserts_stream_route_destination_snapshots(db_session: Session) -> None:
    h = _mk_hierarchy(db_session)
    now = datetime.now(UTC)
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_id"],
        destination_id=h["destination_id"],
        stage="route_send_success",
        created_at=now - timedelta(seconds=20),
    )
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_id"],
        destination_id=h["destination_id"],
        stage="run_complete",
        created_at=now - timedelta(seconds=20),
    )
    db_session.commit()

    result = recompute_and_upsert_snapshots(db_session, bootstrap_last_outcomes=True)
    db_session.commit()

    assert result.stream_rows >= 1
    assert result.route_rows >= 1
    assert result.destination_rows >= 1
    assert read_model_is_populated(db_session)

    stream_row = db_session.get(RuntimeStreamSnapshot, h["stream_id"])
    route_row = db_session.get(RuntimeRouteSnapshot, h["route_id"])
    dest_row = db_session.get(RuntimeDestinationSnapshot, h["destination_id"])
    assert stream_row is not None
    assert route_row is not None
    assert dest_row is not None
    assert stream_row.eps_1m > 0.0
    assert route_row.delivered_eps_1m > 0.0
    assert dest_row.inbound_eps_1m > 0.0


def test_updater_reflects_delivery_logs(db_session: Session) -> None:
    h = _mk_hierarchy(db_session, stream_name="updater-logs")
    now = datetime.now(UTC)
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_id"],
        destination_id=h["destination_id"],
        stage="route_send_failed",
        created_at=now - timedelta(seconds=5),
    )
    db_session.commit()

    outcome = run_runtime_snapshot_update(db_session, bootstrap_last_outcomes=True)
    assert outcome.error is None
    assert outcome.result is not None
    stream_row = db_session.get(RuntimeStreamSnapshot, h["stream_id"])
    assert stream_row is not None
    assert stream_row.last_error_at is not None


def test_updater_overlap_guard(db_session: Session) -> None:
    import app.runtime.runtime_snapshot_updater as updater_mod

    updater_mod._process_lock.acquire()
    try:
        outcome = run_runtime_snapshot_update(db_session)
        assert outcome.skipped_overlap is True
        assert outcome.result is None
    finally:
        updater_mod._process_lock.release()


def test_cleanup_removes_deleted_route_snapshot(db_session: Session) -> None:
    h = _mk_hierarchy(db_session, stream_name="cleanup-route")
    recompute_and_upsert_snapshots(db_session, bootstrap_last_outcomes=True)
    db_session.commit()
    assert db_session.get(RuntimeRouteSnapshot, h["route_id"]) is not None

    route = db_session.get(Route, h["route_id"])
    db_session.delete(route)
    db_session.commit()

    recompute_and_upsert_snapshots(db_session)
    db_session.commit()
    assert db_session.get(RuntimeRouteSnapshot, h["route_id"]) is None


def test_disabled_stream_idle_health(db_session: Session) -> None:
    h = _mk_hierarchy(
        db_session,
        stream_name="disabled-idle",
        stream_enabled=False,
        stream_status="STOPPED",
        route_enabled=False,
    )
    recompute_and_upsert_snapshots(db_session, bootstrap_last_outcomes=True)
    db_session.commit()
    row = db_session.get(RuntimeStreamSnapshot, h["stream_id"])
    assert row is not None
    assert row.health_status == "IDLE"


def test_updater_failure_does_not_raise(db_session: Session) -> None:
    with patch(
        "app.runtime.runtime_snapshot_updater.recompute_and_upsert_snapshots",
        side_effect=RuntimeError("simulated failure"),
    ):
        outcome = run_runtime_snapshot_update(db_session)
    assert outcome.error == "simulated failure"
    assert outcome.result is None


def test_api_reads_physical_read_model_when_populated(
    snapshot_client,
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from tests.test_operational_snapshot_endpoint import ENDPOINT, _mk_hierarchy as endpoint_hierarchy

    monkeypatch.setattr(settings, "GDC_RUNTIME_OPERATIONAL_SNAPSHOT_READ_MODEL_ENABLED", True)
    h = endpoint_hierarchy(db_session)
    now = datetime.now(UTC)
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_id"],
        destination_id=h["destination_id"],
        stage="route_send_success",
        created_at=now - timedelta(seconds=30),
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
    run_runtime_snapshot_update(db_session, bootstrap_last_outcomes=True)
    assert read_model_is_populated(db_session)

    with patch(
        "app.runtime.operational_snapshot_service.load_operational_snapshot_bulk_data",
    ) as virtual_loader:
        resp = snapshot_client.get(ENDPOINT)
        assert resp.status_code == 200
        virtual_loader.assert_not_called()
        stream = next(s for s in resp.json()["streams"] if s["stream_id"] == h["stream_id"])
        assert stream["eps_1m"] > 0.0
