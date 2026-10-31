"""F-175: Run Now against a slow destination must not freeze the API.

The run-once endpoint used to be ``async def`` and executed the blocking StreamRunner cycle on the
event loop, so ``/health`` and every other request stalled until the destination answered. This test
runs the real ASGI app under uvicorn, parks the manual run on a gate (the "slow destination") and
asserts liveness and an unrelated endpoint stay responsive meanwhile.
"""

from __future__ import annotations

import socket
import threading
import time
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest
import uvicorn

from app.database import get_db
from app.main import app
from app.runtime import router as runtime_router


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest.fixture
def live_server(monkeypatch: pytest.MonkeyPatch):
    gate = threading.Event()
    entered = threading.Event()

    def _slow_run(self: Any, context: Any, db: Any = None, **_kwargs: Any) -> dict[str, Any]:
        entered.set()
        assert gate.wait(timeout=30), "test gate never released"
        return {
            "stream_id": 77,
            "outcome": "completed",
            "run_id": "run-gated",
            "transaction_committed": True,
            "checkpoint_updated": False,
            "delivered_batch_event_count": 0,
            "route_delivery_failure_count": 0,
        }

    monkeypatch.setattr("app.runners.stream_loader.load_stream_context", lambda *a, **k: SimpleNamespace())
    monkeypatch.setattr("app.runners.stream_runner.StreamRunner.run", _slow_run)
    monkeypatch.setattr(runtime_router.journal, "record_audit_event", lambda *a, **k: None)
    monkeypatch.setattr(
        "app.runtime.runtime_snapshot_updater.run_runtime_snapshot_update", lambda *a, **k: None, raising=False
    )

    def _override_db():
        yield MagicMock()

    app.dependency_overrides[get_db] = _override_db
    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="off"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 15
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.05)
    assert server.started, "uvicorn did not start"
    try:
        yield f"http://127.0.0.1:{port}", gate, entered
    finally:
        gate.set()
        server.should_exit = True
        thread.join(timeout=10)
        app.dependency_overrides.pop(get_db, None)


def test_run_now_on_slow_destination_keeps_api_responsive(live_server: Any) -> None:
    base, gate, entered = live_server
    result: dict[str, Any] = {}

    def _click_run_now() -> None:
        with httpx.Client(timeout=40) as client:
            result["response"] = client.post(f"{base}/api/v1/runtime/streams/77/run-once")

    clicker = threading.Thread(target=_click_run_now, daemon=True)
    clicker.start()
    assert entered.wait(timeout=10), "manual run never started"

    # While the run is parked on the slow destination the process must still answer promptly.
    with httpx.Client(timeout=5) as probe:
        for _ in range(5):
            started = time.monotonic()
            live = probe.get(f"{base}/health/live")
            assert live.status_code == 200
            assert time.monotonic() - started < 1.0, "API was blocked by the manual run"
    assert clicker.is_alive(), "run finished before the destination was released"

    gate.set()
    clicker.join(timeout=15)
    response = result["response"]
    assert response.status_code == 200, response.text
    assert response.json()["outcome"] == "completed"


def test_run_now_capacity_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi import HTTPException

    sem = threading.BoundedSemaphore(1)
    assert sem.acquire(blocking=False)
    monkeypatch.setattr(runtime_router, "_run_now_slots", sem)
    with pytest.raises(HTTPException) as excinfo:
        runtime_router.run_stream_once(1, MagicMock(), MagicMock())
    assert excinfo.value.status_code == 429
    assert excinfo.value.detail["error_code"] == "RUN_NOW_CAPACITY"
