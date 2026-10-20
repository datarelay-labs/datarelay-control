"""Shared fixtures for runtime read-path tests (snapshot / bucket / legacy isolation)."""

from __future__ import annotations

from collections.abc import Generator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db, get_db_read_bounded
from app.main import app

_RUNTIME_SNAPSHOT_DISABLE_TARGETS = (
    "app.runtime.runtime_snapshot_analytics_repository.snapshot_analytics_available",
    "app.runtime.health_snapshot_read.snapshot_health_available",
    "app.runtime.stream_runtime_snapshot_read.stream_runtime_snapshot_read_enabled",
    "app.runtime.runtime_snapshot_repository.read_model_is_populated",
)

_RUNTIME_BUCKET_DISABLE_TARGET = (
    "app.runtime.runtime_analytics_bucket_read_repository.historical_analytics_available"
)


def _always_false(_db: Session) -> bool:
    return False


def _always_true(_db: Session) -> bool:
    return True


def install_runtime_test_db_overrides(db_session: Session) -> None:
    """Route both write and bounded-read FastAPI deps through the pytest session."""

    def _override_db() -> Generator[Session, None, None]:
        yield db_session

    def _override_read_bounded() -> Generator[Session, None, None]:
        # Shared pytest sessions cannot safely use SET TRANSACTION READ ONLY — it poisons
        # later writes on the same connection (streams CRUD, preview, etc.). Keep timeout only.
        db_session.execute(text("SET LOCAL statement_timeout = '8000ms'"))
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_db_read_bounded] = _override_read_bounded


def clear_runtime_test_db_overrides() -> None:
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_db_read_bounded, None)


def disable_runtime_snapshot_read(monkeypatch: pytest.MonkeyPatch) -> None:
    for target in _RUNTIME_SNAPSHOT_DISABLE_TARGETS:
        monkeypatch.setattr(target, _always_false)
    monkeypatch.setattr(settings, "GDC_RUNTIME_OPERATIONAL_SNAPSHOT_READ_MODEL_ENABLED", False)


def enable_runtime_snapshot_read(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "GDC_RUNTIME_OPERATIONAL_SNAPSHOT_READ_MODEL_ENABLED", True)
    monkeypatch.setattr(
        "app.runtime.runtime_snapshot_repository.read_model_is_populated",
        _always_true,
    )


def disable_runtime_analytics_buckets(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_RUNTIME_BUCKET_DISABLE_TARGET, _always_false)


def enable_runtime_analytics_buckets(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_RUNTIME_BUCKET_DISABLE_TARGET, _always_true)


@pytest.fixture(autouse=True)
def _bind_runtime_test_db_for_session(request: pytest.FixtureRequest) -> Generator[None, None, None]:
    """When a test uses ``db_session``, wire bounded-read deps to the same session."""

    if "db_session" not in request.fixturenames:
        yield
        return
    db_session = request.getfixturevalue("db_session")
    install_runtime_test_db_overrides(db_session)
    try:
        yield
    finally:
        clear_runtime_test_db_overrides()


@pytest.fixture
def runtime_snapshot_read_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    """Legacy delivery_logs tests: never read operational snapshot tables."""

    disable_runtime_snapshot_read(monkeypatch)
    disable_runtime_analytics_buckets(monkeypatch)


@pytest.fixture
def runtime_snapshot_read_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    """Snapshot-path tests: allow snapshot reads when rows are seeded."""

    enable_runtime_snapshot_read(monkeypatch)


@pytest.fixture
def runtime_analytics_bucket_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    disable_runtime_analytics_buckets(monkeypatch)


@pytest.fixture
def runtime_analytics_bucket_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    enable_runtime_analytics_buckets(monkeypatch)


@pytest.fixture
def runtime_api_client(db_session: Session) -> Generator[TestClient, None, None]:
    """TestClient with pytest DB session wired to both get_db and get_db_read_bounded."""

    install_runtime_test_db_overrides(db_session)
    try:
        yield TestClient(app)
    finally:
        clear_runtime_test_db_overrides()


@pytest.fixture
def bind_runtime_test_db(db_session: Session) -> Generator[Session, None, None]:
    """Install DB overrides for tests that define a custom TestClient fixture."""

    install_runtime_test_db_overrides(db_session)
    try:
        yield db_session
    finally:
        clear_runtime_test_db_overrides()


def seed_minimal_operational_snapshot(
    db: Session,
    *,
    stream_id: int,
    route_id: int,
    destination_id: int,
    health_status: str = "HEALTHY",
) -> None:
    """Insert minimal ``runtime_*_snapshot`` rows aligned with a seeded stream/route."""

    from datetime import datetime, timezone

    from app.runtime.models import RuntimeDestinationSnapshot, RuntimeRouteSnapshot, RuntimeStreamSnapshot

    now = datetime.now(timezone.utc)
    db.merge(
        RuntimeStreamSnapshot(
            stream_id=int(stream_id),
            enabled=True,
            health_status=health_status,
            eps_1m=1.0,
            eps_5m=5.0,
            success_rate_5m=100.0,
            failure_rate_5m=0.0,
            retry_rate_5m=0.0,
            avg_latency_ms=10.0,
            route_count=1,
            healthy_route_count=1,
            failed_route_count=0,
            last_success_at=now,
            updated_at=now,
        )
    )
    db.merge(
        RuntimeRouteSnapshot(
            route_id=int(route_id),
            stream_id=int(stream_id),
            destination_id=int(destination_id),
            enabled=True,
            health_status=health_status,
            delivered_eps_1m=1.0,
            failed_eps_1m=0.0,
            success_rate_5m=100.0,
            retry_rate_5m=0.0,
            avg_latency_ms=10.0,
            last_success_at=now,
            updated_at=now,
        )
    )
    db.merge(
        RuntimeDestinationSnapshot(
            destination_id=int(destination_id),
            enabled=True,
            health_status=health_status,
            inbound_eps_1m=1.0,
            failed_eps_1m=0.0,
            avg_latency_ms=10.0,
            route_count=1,
            last_success_at=now,
            updated_at=now,
        )
    )
    db.flush()
