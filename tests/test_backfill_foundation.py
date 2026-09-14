"""Backfill subsystem foundation: model, API, checkpoint snapshot, coordinator isolation."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.backfill.models import BackfillJob
from app.backfill.schemas import BackfillJobCreate
from app.backfill import service
from app.checkpoints.models import Checkpoint
from app.connectors.models import Connector
from app.database import get_db
from app.main import app
from app.sources.models import Source
from app.streams.models import Stream


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


def _seed_stream_with_checkpoint(db: Session) -> Stream:
    connector = Connector(name="c-bf", description="d", status="RUNNING")
    db.add(connector)
    db.flush()
    source = Source(
        connector_id=connector.id,
        source_type="HTTP_API_POLLING",
        config_json={"u": "https://ex.example", "api_key": "source-cfg-api-key-secret"},
        auth_json={"bearer_token": "auth-should-not-be-snapshotted"},
        enabled=True,
    )
    db.add(source)
    db.flush()
    stream = Stream(
        connector_id=connector.id,
        source_id=source.id,
        name="stream-bf",
        stream_type="HTTP_API_POLLING",
        config_json={"path": "/x", "token": "stream-cfg-token-secret"},
        polling_interval=60,
        enabled=True,
        status="RUNNING",
        rate_limit_json={},
    )
    db.add(stream)
    db.flush()
    db.add(
        Checkpoint(
            id=stream.id,
            stream_id=stream.id,
            checkpoint_type="CUSTOM_FIELD",
            checkpoint_value_json={"cursor": "abc"},
        )
    )
    db.commit()
    db.refresh(stream)
    return stream


def test_backfill_job_model_roundtrip(db_session: Session) -> None:
    stream = _seed_stream_with_checkpoint(db_session)
    job = BackfillJob(
        stream_id=stream.id,
        source_type=stream.stream_type,
        status="PENDING",
        backfill_mode="INITIAL_FILL",
        requested_by="pytest",
        source_config_snapshot_json={"ok": True},
        checkpoint_snapshot_json={"checkpoint_type": "CUSTOM_FIELD", "checkpoint_value_json": {"cursor": "abc"}},
        runtime_options_json={},
        progress_json={"phase": "queued"},
    )
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    assert job.id >= 1
    loaded = db_session.get(BackfillJob, job.id)
    assert loaded is not None
    assert loaded.stream_id == stream.id
    assert loaded.checkpoint_snapshot_json["checkpoint_value_json"]["cursor"] == "abc"


def test_checkpoint_snapshot_persistence_and_protection(client: TestClient, db_session: Session) -> None:
    stream = _seed_stream_with_checkpoint(db_session)
    before = db_session.get(Checkpoint, stream.id)
    assert before is not None
    before_val = dict(before.checkpoint_value_json)

    res = client.post(
        "/api/v1/backfill/jobs",
        json={"stream_id": stream.id, "backfill_mode": "TIME_RANGE_REPLAY", "requested_by": "pytest"},
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["checkpoint_snapshot_json"]["checkpoint_value_json"] == before_val
    snap = body["source_config_snapshot_json"]
    assert "source-cfg-api-key-secret" not in str(snap)
    assert "stream-cfg-token-secret" not in str(snap)
    assert "auth-should-not-be-snapshotted" not in str(snap)
    assert "auth_json" not in (snap.get("source") or {})
    assert snap["source"]["config_json"]["api_key"] == "********"
    assert snap["stream"]["config_json"]["token"] == "********"
    assert snap["stream"]["config_json"]["path"] == "/x"

    after = db_session.get(Checkpoint, stream.id)
    assert after is not None
    assert after.checkpoint_value_json == before_val


def test_backfill_api_list_and_detail(client: TestClient, db_session: Session) -> None:
    stream = _seed_stream_with_checkpoint(db_session)
    c1 = client.post(
        "/api/v1/backfill/jobs",
        json={"stream_id": stream.id, "backfill_mode": "OBJECT_REPLAY", "requested_by": "a"},
    )
    assert c1.status_code == 201
    job_id = c1.json()["id"]

    listed = client.get("/api/v1/backfill/jobs")
    assert listed.status_code == 200
    arr = listed.json()
    assert any(j["id"] == job_id for j in arr)

    one = client.get(f"/api/v1/backfill/jobs/{job_id}")
    assert one.status_code == 200
    assert one.json()["backfill_mode"] == "OBJECT_REPLAY"

    missing = client.get("/api/v1/backfill/jobs/999999")
    assert missing.status_code == 404


def test_runtime_isolation_ephemeral_state(db_session: Session) -> None:
    stream = _seed_stream_with_checkpoint(db_session)
    job = service.create_backfill_job(
        db_session, BackfillJobCreate(stream_id=stream.id, backfill_mode="CHECKPOINT_REWIND", requested_by="t")
    )
    coord = service.get_coordinator()
    st = coord.get_ephemeral_state(job.id)
    assert st is not None
    assert st["ephemeral_checkpoint"]["checkpoint_value_json"]["cursor"] == "abc"
    st["ephemeral_checkpoint"]["checkpoint_value_json"]["cursor"] = "mutated"
    st2 = coord.get_ephemeral_state(job.id)
    assert st2 is not None
    assert st2["ephemeral_checkpoint"]["checkpoint_value_json"]["cursor"] == "abc"
    assert db_session.get(Checkpoint, stream.id).checkpoint_value_json["cursor"] == "abc"


def test_backfill_table_in_sqlalchemy_metadata(reset_db: None) -> None:
    """Model import registers ``backfill_jobs`` for Alembic / SQLAlchemy metadata."""

    from app.database import Base

    import app.backfill.models  # noqa: F401

    assert "backfill_jobs" in Base.metadata.tables
    assert "backfill_progress_events" in Base.metadata.tables
