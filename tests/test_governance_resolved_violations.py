"""F-181 / F-182: resolved quarantine items are not open violations; Replay states its availability."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database import get_db, get_db_read_bounded
from app.quarantine.models import (
    QUARANTINE_SOURCE_POLICY,
    QUARANTINE_STATUS_DISCARDED,
    QUARANTINE_STATUS_QUARANTINED,
    StreamQuarantineEvent,
)
from app.replay.models import REPLAY_STATUS_PENDING, StreamReplayEvent
from tests.test_stream_runner_e2e import _seed_stream_runtime


@pytest.fixture
def governance_client(db_session: Session) -> TestClient:
    from app.governance.router import router

    app = FastAPI()
    app.include_router(router, prefix="/api/v1/governance")

    def _override_db():
        yield db_session

    app.dependency_overrides[get_db_read_bounded] = _override_db
    app.dependency_overrides[get_db] = _override_db
    return TestClient(app)


def _quarantine(db: Session, stream_id: int, status: str) -> StreamQuarantineEvent:
    now = datetime.now(timezone.utc)
    row = StreamQuarantineEvent(
        stream_id=stream_id,
        quarantine_reason="policy:Rule",
        quarantine_source=QUARANTINE_SOURCE_POLICY,
        status=status,
        protected_payload_json={"events": [{"a": 1}]},
        metadata_json={"event_count": 1, "policy_names": ["Rule"]},
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.commit()
    return row


def test_discarded_quarantine_is_discarded_not_open(governance_client: TestClient, db_session: Session) -> None:
    stream_id = int(_seed_stream_runtime(db_session)["stream_id"])
    discarded = _quarantine(db_session, stream_id, QUARANTINE_STATUS_DISCARDED)
    held = _quarantine(db_session, stream_id, QUARANTINE_STATUS_QUARANTINED)

    body = governance_client.get("/api/v1/governance/violations?window=24h").json()
    by_id = {v["id"]: v["status"] for v in body["violations"]}
    assert by_id[f"q-{discarded.id}"] == "DISCARDED"
    assert by_id[f"q-{held.id}"] == "QUARANTINED"
    assert governance_client.get("/api/v1/governance/violations?status=OPEN").json()["total"] == 0
    assert governance_client.get("/api/v1/governance/violations?status=DISCARDED").json()["total"] == 1


def test_open_violation_counts_exclude_discarded(governance_client: TestClient, db_session: Session) -> None:
    stream_id = int(_seed_stream_runtime(db_session)["stream_id"])
    _quarantine(db_session, stream_id, QUARANTINE_STATUS_DISCARDED)
    summary = governance_client.get("/api/v1/governance/operations/summary").json()
    assert summary["open_violations"] == 0

    _quarantine(db_session, stream_id, QUARANTINE_STATUS_QUARANTINED)
    summary = governance_client.get("/api/v1/governance/operations/summary").json()
    assert summary["open_violations"] == 1


def test_quarantine_detail_reports_replay_unavailable(governance_client: TestClient, db_session: Session) -> None:
    stream_id = int(_seed_stream_runtime(db_session)["stream_id"])
    held = _quarantine(db_session, stream_id, QUARANTINE_STATUS_QUARANTINED)
    detail = governance_client.get(f"/api/v1/governance/quarantine/{held.id}").json()
    assert detail["replay_available"] is False
    assert "Release" in detail["replay_unavailable_reason"]

    discarded = _quarantine(db_session, stream_id, QUARANTINE_STATUS_DISCARDED)
    detail = governance_client.get(f"/api/v1/governance/quarantine/{discarded.id}").json()
    assert detail["replay_available"] is False
    assert "Discarded" in detail["replay_unavailable_reason"]


def test_quarantine_detail_reports_replay_available_with_pending_job(
    governance_client: TestClient, db_session: Session
) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    held = _quarantine(db_session, stream_id, QUARANTINE_STATUS_QUARANTINED)
    now = datetime.now(timezone.utc)
    db_session.add(
        StreamReplayEvent(
            stream_id=stream_id,
            destination_id=int(seeded["destination_ids"][0]),
            route_id=int(seeded["route_ids"][0]),
            delivery_kind="base_route",
            status=REPLAY_STATUS_PENDING,
            protected_payload_json={"events": [{"id": 1}]},
            delivery_context_json={"destination_type": "WEBHOOK"},
            event_count=1,
            created_at=now,
            updated_at=now,
        )
    )
    db_session.commit()
    detail = governance_client.get(f"/api/v1/governance/quarantine/{held.id}").json()
    assert detail["replay_available"] is True
    assert detail["replay_unavailable_reason"] is None
