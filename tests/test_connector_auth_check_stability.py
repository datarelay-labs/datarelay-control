"""Auth-check stability: stale cache preservation, DB session release, list API isolation."""

from __future__ import annotations

import concurrent.futures
import threading
import time
from datetime import UTC, datetime
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.connectors.models import Connector
from app.connectors.operations_service import run_connector_auth_check_and_persist
from app.connectors.read_cache import (
    clear_connectors_read_cache,
    get_connectors_list_cached,
    invalidate_connectors_read_cache_after_auth_check,
    peek_connectors_list_cache,
    peek_connectors_list_stale_cache,
    resolve_connectors_list_catalog,
)
from app.connectors.router import _list_connectors_rows
from app.connectors.schemas import ConnectorRead
from app.database import SessionLocal, engine
from app.main import app
from app.runtime.schemas import ConnectorAuthTestResponse
from app.sources.models import Source


def _sample_connector(connector_id: int = 1, name: str = "Alpha") -> ConnectorRead:
    return ConnectorRead(
        id=connector_id,
        name=name,
        description=None,
        status="STOPPED",
        connector_type="generic_http",
        source_type="HTTP_API_POLLING",
        source_id=1,
        stream_count=0,
        auth_type="no_auth",
        auth={"auth_type": "no_auth"},
        verify_ssl=True,
        common_headers={},
    )


@pytest.fixture
def client(db_session: Session) -> TestClient:
    from app.database import get_db

    def _override_get_db():
        try:
            yield db_session
        finally:
            pass

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _seed_http_connector(db: Session, *, name: str = "AuthCheck Fixture") -> tuple[int, int]:
    connector = Connector(name=name, status="STOPPED")
    db.add(connector)
    db.flush()
    source = Source(
        connector_id=connector.id,
        source_type="HTTP_API_POLLING",
        config_json={
            "connector_type": "generic_http",
            "base_url": "http://127.0.0.1:28080",
            "verify_ssl": False,
            "common_headers": {},
        },
        auth_json={"auth_type": "no_auth"},
        enabled=True,
    )
    db.add(source)
    db.commit()
    db.refresh(connector)
    db.refresh(source)
    return int(connector.id), int(source.id)


def test_auth_check_cache_invalidation_preserves_stale() -> None:
    clear_connectors_read_cache()
    get_connectors_list_cached(MagicMock(), lambda _db: [_sample_connector()])

    finished = datetime(2026, 6, 21, 12, 0, 0, tzinfo=UTC)
    invalidate_connectors_read_cache_after_auth_check(
        1,
        last_auth_check_at=finished,
        last_auth_check_status="success",
        last_auth_error=None,
    )

    assert peek_connectors_list_cache() is None
    stale = peek_connectors_list_stale_cache()
    assert stale is not None
    assert stale[0].last_auth_check_status == "success"
    assert stale[0].last_auth_check_at == finished
    clear_connectors_read_cache()


def test_auth_check_after_invalidation_stale_fallback_on_catalog_fail(monkeypatch: pytest.MonkeyPatch) -> None:
    clear_connectors_read_cache()
    monkeypatch.setattr("app.connectors.read_cache._LIST_FRESH_TTL_SEC", 0.0)
    get_connectors_list_cached(MagicMock(), lambda _db: [_sample_connector(name="Cached")])

    invalidate_connectors_read_cache_after_auth_check(
        1,
        last_auth_check_at=datetime(2026, 6, 21, 12, 0, 0, tzinfo=UTC),
        last_auth_check_status="failed",
        last_auth_error="401 Unauthorized",
    )

    def failing_loader() -> tuple[list[ConnectorRead], float, float]:
        raise TimeoutError("catalog pool exhausted")

    rows, metrics = resolve_connectors_list_catalog(failing_loader)
    assert len(rows) == 1
    assert rows[0].name == "Cached"
    assert rows[0].last_auth_check_status == "failed"
    assert metrics.stale_fallback is True
    clear_connectors_read_cache()


def test_auth_check_releases_db_session_during_probe(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    connector_id, _source_id = _seed_http_connector(db_session)
    held = threading.Event()
    release = threading.Event()
    observed: list[bool] = []

    def slow_probe(*_args, **_kwargs):
        db = SessionLocal()
        try:
            observed.append(db.bind is engine)
        finally:
            db.close()
        held.set()
        assert release.wait(timeout=5.0)
        return ConnectorAuthTestResponse(ok=True, auth_type="NO_AUTH", message="ok")

    monkeypatch.setattr("app.connectors.operations_service.run_connector_auth_test", slow_probe)

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
        fut = ex.submit(run_connector_auth_check_and_persist, connector_id)
        assert held.wait(timeout=5.0)
        # While probe runs, a new session can still be acquired from the main pool.
        probe_db = SessionLocal()
        try:
            probe_db.execute(__import__("sqlalchemy").text("SELECT 1"))
            observed.append(True)
        finally:
            probe_db.close()
        release.set()
        result = fut.result(timeout=10.0)

    assert result.success is True
    assert observed == [True, True]


def test_list_connectors_responds_during_auth_check(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    clear_connectors_read_cache()
    connector_id, _source_id = _seed_http_connector(db_session, name="List During Auth")
    held = threading.Event()
    release = threading.Event()

    def slow_probe(*_args, **_kwargs):
        held.set()
        assert release.wait(timeout=5.0)
        return ConnectorAuthTestResponse(ok=True, auth_type="NO_AUTH", message="ok")

    monkeypatch.setattr("app.connectors.operations_service.run_connector_auth_test", slow_probe)

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
        auth_future = ex.submit(run_connector_auth_check_and_persist, connector_id)
        assert held.wait(timeout=5.0)
        list_started = time.perf_counter()
        rows = _list_connectors_rows(db_session)
        list_elapsed_ms = (time.perf_counter() - list_started) * 1000.0
        release.set()
        auth_result = auth_future.result(timeout=10.0)

    assert auth_result.success is True
    assert any(row.name == "List During Auth" for row in rows)
    assert list_elapsed_ms < 5000.0
    clear_connectors_read_cache()


def test_auth_check_endpoint_uses_stale_preserving_invalidation(
    client: TestClient,
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clear_connectors_read_cache()
    connector_id, _source_id = _seed_http_connector(db_session, name="Endpoint Auth")
    get_connectors_list_cached(db_session, _list_connectors_rows)

    monkeypatch.setattr(
        "app.connectors.operations_service.run_connector_auth_test",
        lambda *_a, **_k: ConnectorAuthTestResponse(ok=True, auth_type="NO_AUTH", message="ok"),
    )

    response = client.post(f"/api/v1/connectors/{connector_id}/auth-check")
    assert response.status_code == 200
    assert response.json()["last_auth_check_status"] == "success"

    assert peek_connectors_list_cache() is None
    stale = peek_connectors_list_stale_cache()
    assert stale is not None
    patched = next(row for row in stale if row.id == connector_id)
    assert patched.last_auth_check_status == "success"
    clear_connectors_read_cache()


def test_auth_check_uses_stream_endpoint_not_root_403(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """CASE A: root / → 403 must not mark auth failed when stream endpoint is 200."""
    from app.streams.models import Stream

    connector_id, source_id = _seed_http_connector(db_session, name="Root Forbidden")
    stream = Stream(
        connector_id=connector_id,
        source_id=source_id,
        name="alerts",
        stream_type="HTTP_API_POLLING",
        config_json={"endpoint": "/api/v1/alerts", "method": "GET"},
        enabled=True,
        status="STOPPED",
    )
    db_session.add(stream)
    db_session.commit()

    seen_paths: list[str] = []

    def probe(payload, _db):
        path = str(getattr(payload, "test_path", None) or "/")
        seen_paths.append(path)
        if path in {"/", ""}:
            return ConnectorAuthTestResponse(
                ok=False,
                auth_type="NO_AUTH",
                message="Forbidden",
                response_status_code=403,
            )
        return ConnectorAuthTestResponse(
            ok=True,
            auth_type="NO_AUTH",
            message="ok",
            response_status_code=200,
        )

    monkeypatch.setattr("app.connectors.operations_service.run_connector_auth_test", probe)
    result = run_connector_auth_check_and_persist(connector_id)
    assert seen_paths == ["/api/v1/alerts"]
    assert result.success is True
    assert result.last_auth_check_status == "success"


def test_auth_check_fails_when_stream_endpoint_unauthorized(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """CASE B: configured usable endpoint → 401/403 remains auth failure."""
    from app.streams.models import Stream

    connector_id, source_id = _seed_http_connector(db_session, name="Endpoint Unauthorized")
    stream = Stream(
        connector_id=connector_id,
        source_id=source_id,
        name="alerts",
        stream_type="HTTP_API_POLLING",
        config_json={"endpoint": "/api/v1/alerts", "method": "GET"},
        enabled=True,
        status="STOPPED",
    )
    db_session.add(stream)
    db_session.commit()

    def probe(payload, _db):
        path = str(getattr(payload, "test_path", None) or "/")
        assert path == "/api/v1/alerts"
        return ConnectorAuthTestResponse(
            ok=False,
            auth_type="BEARER_TOKEN",
            message="Unauthorized",
            response_status_code=401,
            error_type="http_error",
        )

    monkeypatch.setattr("app.connectors.operations_service.run_connector_auth_test", probe)
    result = run_connector_auth_check_and_persist(connector_id)
    assert result.success is False
    assert result.last_auth_check_status == "failed"
    assert result.status_code == 401
