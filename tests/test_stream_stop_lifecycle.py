"""Confirmed stream-stop lifecycle and deletion ownership guards."""

from __future__ import annotations

import threading
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database import get_db
from app.main import app
from app.runners.stream_runner import StreamRunner
from app.runtime import control_service
from app.runtime.state import StreamStatus
from app.scheduler.scheduler import Scheduler
from app.streams.models import Stream
from tests.test_runtime_logs_page_endpoint import _seed_stream_two_routes


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def _running_stream(db: Session) -> int:
    stream_id = _seed_stream_two_routes(db)["stream_id"]
    db.query(Stream).filter(Stream.id == stream_id).update({"enabled": True, "status": "RUNNING"})
    db.commit()
    return stream_id


def test_status_contract_includes_stop_lifecycle() -> None:
    assert StreamStatus.STOPPING == "STOPPING"
    assert StreamStatus.STOP_FAILED == "STOP_FAILED"


def test_stop_200_is_terminal_only(client: TestClient, db_session: Session) -> None:
    stream_id = _running_stream(db_session)
    response = client.post(f"/api/v1/runtime/streams/{stream_id}/stop")
    assert response.status_code == 200
    assert response.json()["terminal"] is True
    assert response.json()["status"] == "STOPPED"


def test_stop_stays_stopping_while_lock_owned(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, db_session: Session
) -> None:
    stream_id = _running_stream(db_session)
    lock = StreamRunner._get_lock(stream_id)
    assert lock.acquire(blocking=False)
    monkeypatch.setenv("GDC_STREAM_STOP_WAIT_SEC", "0")
    try:
        response = client.post(f"/api/v1/runtime/streams/{stream_id}/stop")
        assert response.status_code == 202
        assert response.json()["status"] == "STOPPING"
    finally:
        lock.release()


def test_stop_signals_scheduler(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, db_session: Session
) -> None:
    stream_id = _running_stream(db_session)
    requested: list[int] = []
    monkeypatch.setattr(
        "app.runtime.control_service.scheduler_runtime_state.request_stream_stop",
        lambda sid: requested.append(sid),
    )
    response = client.post(f"/api/v1/runtime/streams/{stream_id}/stop")
    assert response.status_code == 200
    assert requested == [stream_id]


def test_stop_signal_failure_sets_stop_failed(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, db_session: Session
) -> None:
    stream_id = _running_stream(db_session)

    def _fail(_stream_id: int) -> None:
        raise RuntimeError("scheduler signal failed")

    monkeypatch.setattr("app.runtime.control_service.scheduler_runtime_state.request_stream_stop", _fail)
    response = client.post(f"/api/v1/runtime/streams/{stream_id}/stop")
    assert response.status_code == 409
    db_session.expire_all()
    assert db_session.query(Stream).filter(Stream.id == stream_id).one().status == "STOP_FAILED"


def test_runner_lock_release_and_orphan_detection() -> None:
    stream_id = 987654
    lock = StreamRunner._get_lock(stream_id)
    assert lock.acquire(blocking=False)
    try:
        assert StreamRunner.is_lock_held(stream_id)
        assert stream_id in StreamRunner.active_lock_stream_ids()
    finally:
        lock.release()
    assert not StreamRunner.is_lock_held(stream_id)
    assert stream_id not in StreamRunner.active_lock_stream_ids()


def test_scheduler_stop_event_releases_worker_ownership() -> None:
    scheduler = Scheduler()
    stream_id = 765432
    event = threading.Event()
    worker = threading.Thread(target=event.wait, daemon=True)
    with scheduler._workers_lock:
        scheduler._stream_stop_events[stream_id] = event
        scheduler._workers[stream_id] = worker
    worker.start()
    assert scheduler.is_stream_worker_alive(stream_id)
    scheduler.request_stream_stop(stream_id)
    assert scheduler.join_stream_worker(stream_id, 1.0)


def test_cross_process_run_lock_is_observable(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GDC_STREAM_RUN_LOCK_DIR", str(tmp_path))
    stream_id = 424242
    assert StreamRunner.try_acquire_worker_ownership(stream_id)
    try:
        assert StreamRunner.is_worker_ownership_held(stream_id)
        # Simulate sibling-process observation via lock file.
        from app.runners import stream_runtime_lock

        assert stream_runtime_lock.is_held("worker", stream_id)
        assert not stream_runtime_lock.try_acquire("worker", stream_id)
    finally:
        StreamRunner.release_worker_ownership(stream_id)
    assert not StreamRunner.is_worker_ownership_held(stream_id)


def test_stop_waits_for_worker_ownership(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, db_session: Session, tmp_path
) -> None:
    monkeypatch.setenv("GDC_STREAM_RUN_LOCK_DIR", str(tmp_path))
    monkeypatch.setenv("GDC_STREAM_STOP_WAIT_SEC", "0")
    stream_id = _running_stream(db_session)
    assert StreamRunner.try_acquire_worker_ownership(stream_id)
    try:
        response = client.post(f"/api/v1/runtime/streams/{stream_id}/stop")
        assert response.status_code == 202
        assert response.json()["status"] == "STOPPING"
        assert client.delete(f"/api/v1/streams/{stream_id}").status_code == 409
    finally:
        StreamRunner.release_worker_ownership(stream_id)
    # After ownership release, reconcile + delete succeed.
    assert client.delete(f"/api/v1/streams/{stream_id}").status_code == 204

    stream_id = _running_stream(db_session)
    assert client.post(f"/api/v1/runtime/streams/{stream_id}/stop").status_code == 200
    assert client.delete(f"/api/v1/streams/{stream_id}").status_code == 204
    assert db_session.query(Stream).filter(Stream.id == stream_id).first() is None


def test_delete_blocked_while_running(client: TestClient, db_session: Session) -> None:
    stream_id = _running_stream(db_session)
    response = client.delete(f"/api/v1/streams/{stream_id}")
    assert response.status_code == 409
    assert response.json()["detail"]["error_code"] == "STREAM_DELETE_BLOCKED_RUNNING"


def test_stale_disabled_running_reconciles_before_delete(client: TestClient, db_session: Session) -> None:
    stream_id = _running_stream(db_session)
    db_session.query(Stream).filter(Stream.id == stream_id).update({"enabled": False, "status": "RUNNING"})
    db_session.commit()
    assert client.delete(f"/api/v1/streams/{stream_id}").status_code == 204


def test_reconcile_never_clears_owned_lock(db_session: Session) -> None:
    stream_id = _running_stream(db_session)
    db_session.query(Stream).filter(Stream.id == stream_id).update({"enabled": False, "status": "STOPPING"})
    db_session.commit()
    lock = StreamRunner._get_lock(stream_id)
    assert lock.acquire(blocking=False)
    try:
        assert control_service.reconcile_stale_stream_runtime(db_session, stream_id) is False
        assert db_session.query(Stream).filter(Stream.id == stream_id).one().status == "STOPPING"
    finally:
        lock.release()


# F-176: Start was accepted while the previous run was still STOPPING, so two runs overlapped and
# the old run kept re-sending events.
def test_start_is_refused_while_stop_is_still_in_flight(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, db_session: Session
) -> None:
    stream_id = _running_stream(db_session)
    lock = StreamRunner._get_lock(stream_id)
    assert lock.acquire(blocking=False)
    monkeypatch.setenv("GDC_STREAM_STOP_WAIT_SEC", "0")
    try:
        stop = client.post(f"/api/v1/runtime/streams/{stream_id}/stop")
        assert stop.status_code == 202 and stop.json()["status"] == "STOPPING"

        for path in (
            f"/api/v1/runtime/streams/{stream_id}/start",
            f"/api/v1/streams/{stream_id}/start",
        ):
            refused = client.post(path)
            assert refused.status_code == 409, path
            assert refused.json()["detail"]["error_code"] == "STREAM_STOP_IN_PROGRESS"

        db_session.expire_all()
        row = db_session.query(Stream).filter(Stream.id == stream_id).one()
        assert row.status == "STOPPING" and row.enabled is False
    finally:
        lock.release()

    started = client.post(f"/api/v1/runtime/streams/{stream_id}/start")
    assert started.status_code == 200
    assert started.json()["status"] == "RUNNING"


def test_start_after_a_confirmed_stop_is_accepted(client: TestClient, db_session: Session) -> None:
    stream_id = _running_stream(db_session)
    assert client.post(f"/api/v1/runtime/streams/{stream_id}/stop").status_code == 200
    assert client.post(f"/api/v1/runtime/streams/{stream_id}/start").status_code == 200
