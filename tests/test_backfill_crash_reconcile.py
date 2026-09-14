"""Backfill restart/crash reconciliation: orphan ownership fail-closed recovery."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.backfill.models import BackfillJob
from app.backfill.schemas import BackfillJobCreate
from app.backfill import service
from app.backfill.worker import BackfillWorker
from app.database import get_db
from app.main import app
from tests.test_backfill_foundation import _seed_stream_with_checkpoint


@pytest.fixture(autouse=True)
def _reset_coordinator() -> None:
    service.get_coordinator().reset_ephemeral_for_tests()
    yield
    service.get_coordinator().reset_ephemeral_for_tests()


@pytest.fixture
def client(db_session: Session):
    def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def _insert_orphaned_job(db: Session, stream_id: int, *, status: str) -> BackfillJob:
    job = BackfillJob(
        stream_id=int(stream_id),
        source_type="HTTP_API_POLLING",
        status=status,
        backfill_mode="TIME_RANGE_REPLAY",
        requested_by="crash-test",
        source_config_snapshot_json={},
        checkpoint_snapshot_json=None,
        runtime_options_json={},
        progress_json={"phase": "running", "chunks_done": 0},
        delivery_summary_json=None,
        error_summary=None,
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


def test_reconcile_orphaned_running_marks_failed_fail_closed(db_session: Session) -> None:
    stream = _seed_stream_with_checkpoint(db_session)
    orphan = _insert_orphaned_job(db_session, stream.id, status="RUNNING")
    coord = service.get_coordinator()
    assert coord.is_job_owned(orphan.id) is False

    summary = service.reconcile_orphaned_backfill_jobs(db_session)
    assert summary["orphaned_failed"] == 1
    assert summary["orphaned_cancelled"] == 0

    db_session.expire_all()
    row = db_session.get(BackfillJob, orphan.id)
    assert row is not None
    assert row.status == "FAILED"
    assert row.failed_at is not None
    assert "fail-closed" in (row.error_summary or "")
    assert "OWNERSHIP_LOST" in (row.error_summary or "") or "ownership lost" in (row.error_summary or "").lower()

    events = service.list_progress_events(db_session, int(orphan.id))
    assert any(e.error_code == "OWNERSHIP_LOST_ON_RESTART" for e in events)


def test_reconcile_orphaned_cancelling_marks_cancelled(db_session: Session) -> None:
    stream = _seed_stream_with_checkpoint(db_session)
    orphan = _insert_orphaned_job(db_session, stream.id, status="CANCELLING")

    summary = service.reconcile_orphaned_backfill_jobs(db_session)
    assert summary["orphaned_cancelled"] == 1
    assert summary["orphaned_failed"] == 0

    db_session.expire_all()
    row = db_session.get(BackfillJob, orphan.id)
    assert row is not None
    assert row.status == "CANCELLED"
    assert row.completed_at is not None


def test_reconcile_skips_jobs_with_live_owner(db_session: Session) -> None:
    stream = _seed_stream_with_checkpoint(db_session)
    owned = _insert_orphaned_job(db_session, stream.id, status="RUNNING")
    coord = service.get_coordinator()
    assert coord.claim_job_owner(int(owned.id)) is True

    summary = service.reconcile_orphaned_backfill_jobs(db_session)
    assert summary["orphaned_failed"] == 0
    assert summary["orphaned_cancelled"] == 0

    db_session.expire_all()
    row = db_session.get(BackfillJob, owned.id)
    assert row is not None
    assert row.status == "RUNNING"
    coord.release_job_owner(int(owned.id))


def test_reconcile_unblocks_concurrent_start_after_crash(client: TestClient, db_session: Session) -> None:
    stream = _seed_stream_with_checkpoint(db_session)
    orphan = _insert_orphaned_job(db_session, stream.id, status="RUNNING")

    pending = client.post(
        "/api/v1/backfill/jobs",
        json={"stream_id": stream.id, "backfill_mode": "FILE_REPLAY", "requested_by": "after-crash"},
    ).json()["id"]
    blocked = client.post(f"/api/v1/backfill/jobs/{pending}/start")
    assert blocked.status_code == 409

    service.reconcile_orphaned_backfill_jobs(db_session)
    db_session.expire_all()
    assert db_session.get(BackfillJob, orphan.id).status == "FAILED"  # type: ignore[union-attr]

    started = client.post(f"/api/v1/backfill/jobs/{pending}/start")
    assert started.status_code == 200, started.text
    assert started.json()["status"] == "RUNNING"


def test_cancel_with_live_owner_waits_for_worker_ack(db_session: Session) -> None:
    stream = _seed_stream_with_checkpoint(db_session)
    job = service.create_backfill_job(
        db_session,
        BackfillJobCreate(stream_id=stream.id, backfill_mode="INITIAL_FILL", requested_by="ack"),
    )
    job.status = "RUNNING"
    db_session.commit()
    db_session.refresh(job)

    coord = service.get_coordinator()
    assert coord.claim_job_owner(int(job.id)) is True

    cancelling = service.cancel_backfill_job(db_session, int(job.id))
    assert cancelling.status == "CANCELLING"
    assert coord.is_cancel_requested(int(job.id)) is True

    worker = BackfillWorker(db_session, coord)
    worker._cancel_terminal(int(job.id), int(stream.id))  # noqa: SLF001 — ack path under test

    db_session.expire_all()
    terminal = db_session.get(BackfillJob, job.id)
    assert terminal is not None
    assert terminal.status == "CANCELLED"
    assert coord.is_job_owned(int(job.id)) is False


def test_cancel_without_owner_finalizes_cancelled(client: TestClient, db_session: Session) -> None:
    stream = _seed_stream_with_checkpoint(db_session)
    job_id = client.post(
        "/api/v1/backfill/jobs",
        json={"stream_id": stream.id, "backfill_mode": "CHECKPOINT_REWIND", "requested_by": "no-owner"},
    ).json()["id"]
    assert client.post(f"/api/v1/backfill/jobs/{job_id}/start").status_code == 200
    assert service.get_coordinator().is_job_owned(int(job_id)) is False

    x = client.post(f"/api/v1/backfill/jobs/{job_id}/cancel")
    assert x.status_code == 200
    assert x.json()["status"] == "CANCELLED"


def test_reconcile_does_not_resume_delivery(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    stream = _seed_stream_with_checkpoint(db_session)
    orphan = _insert_orphaned_job(db_session, stream.id, status="RUNNING")
    orphan.runtime_options_json = {
        "start_time": "2020-01-01T00:00:00+00:00",
        "end_time": "2020-01-02T00:00:00+00:00",
        "dry_run": False,
    }
    db_session.commit()

    calls: list[int] = []

    def _forbid_start(self: BackfillWorker, job_id: int) -> None:  # noqa: ANN001
        calls.append(int(job_id))
        raise AssertionError("must not resume external delivery after crash")

    monkeypatch.setattr(BackfillWorker, "start_job", _forbid_start)
    service.reconcile_orphaned_backfill_jobs(db_session)
    assert calls == []
    db_session.expire_all()
    assert db_session.get(BackfillJob, orphan.id).status == "FAILED"  # type: ignore[union-attr]
