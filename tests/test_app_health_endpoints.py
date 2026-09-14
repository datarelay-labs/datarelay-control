"""Liveness vs readiness semantics for /health* probes."""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def test_health_live_ok_without_db(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom() -> Any:
        raise RuntimeError("db down")

    monkeypatch.setattr("app.main.engine.connect", _boom)
    res = client.get("/health/live")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_health_and_ready_fail_closed_when_db_unavailable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _boom() -> Any:
        raise RuntimeError("connection refused secret-detail")

    monkeypatch.setattr("app.main.engine.connect", _boom)
    for path in ("/health", "/health/ready"):
        res = client.get(path)
        assert res.status_code == 503, path
        body = res.json()
        assert body["status"] == "not_ready"
        assert body["delivery_logs_indexes"]["ok"] is False
        assert body["delivery_logs_indexes"]["error"] == "database_unavailable"
        raw = res.text.lower()
        assert "connection refused" not in raw
        assert "secret-detail" not in raw
        assert "runtimeerror" not in raw


def test_health_ready_ok_when_db_reachable(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    conn = MagicMock()
    ctx = MagicMock()
    ctx.__enter__.return_value = conn
    ctx.__exit__.return_value = False
    monkeypatch.setattr("app.main.engine.connect", lambda: ctx)
    monkeypatch.setattr(
        "app.main.probe_delivery_logs_indexes",
        lambda _conn: {
            "error": None,
            "checked": True,
            "invalid_indexes": [],
            "reindex_suggested": False,
        },
    )
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"
    assert res.json()["delivery_logs_indexes"]["ok"] is True
    assert res.json()["delivery_logs_indexes"]["error"] is None
