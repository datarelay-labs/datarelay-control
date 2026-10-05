"""M19.2 Quarantine Operations — governance quarantine feed and bulk actions."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database import get_db, get_db_read_bounded
from app.governance_policies.models import (
    POLICY_STATUS_ACTIVE,
    GovernancePolicy,
    StreamPolicyAssignment,
)
from app.protection.models import PROTECTION_MODE_TOKENIZATION, StreamProtectionRule
from app.quarantine.models import (
    QUARANTINE_SOURCE_POLICY,
    QUARANTINE_STATUS_QUARANTINED,
    QUARANTINE_STATUS_RELEASED,
    StreamQuarantineEvent,
)
from app.replay.models import (
    REPLAY_CONTEXT_ORIGIN_KEY,
    REPLAY_CONTEXT_ORIGIN_QUARANTINE,
    REPLAY_CONTEXT_QUARANTINE_EVENT_ID_KEY,
    REPLAY_STATUS_PENDING,
    REPLAY_STATUS_REPLAYED,
    StreamReplayEvent,
)
from app.sensitive_detection.models import (
    FINDING_STATUS_OPEN,
    SENSITIVITY_CLASS_PII,
    StreamSensitiveFinding,
)
from tests.test_stream_runner_e2e import _seed_stream_runtime


def _governance_app() -> FastAPI:
    from app.governance.router import router

    app = FastAPI()
    app.include_router(router, prefix="/api/v1/governance")
    return app


@pytest.fixture
def governance_read_client(db_session: Session) -> TestClient:
    app = _governance_app()

    def _override_db():
        yield db_session

    app.dependency_overrides[get_db_read_bounded] = _override_db
    return TestClient(app)


@pytest.fixture
def governance_write_client(db_session: Session) -> TestClient:
    app = _governance_app()

    def _override_db():
        yield db_session

    app.dependency_overrides[get_db_read_bounded] = _override_db
    app.dependency_overrides[get_db] = _override_db
    return TestClient(app)


def _create_policy(db_session: Session, *, name: str, stream_id: int) -> GovernancePolicy:
    now = datetime.now(timezone.utc)
    row = GovernancePolicy(
        name=name,
        description=None,
        category="DATA_PROTECTION",
        status=POLICY_STATUS_ACTIVE,
        policy_json={
            "conditions": [{"field": "classification", "operator": "equals", "value": "RESTRICTED"}],
            "actions": [{"type": "quarantine"}],
        },
        version=1,
        activated_at=now,
        created_at=now,
        updated_at=now,
    )
    db_session.add(row)
    db_session.flush()
    db_session.add(StreamPolicyAssignment(stream_id=stream_id, policy_id=row.id, enabled=True))
    db_session.commit()
    return row


def _create_quarantine(
    db_session: Session,
    *,
    stream_id: int,
    status: str = QUARANTINE_STATUS_QUARANTINED,
    policy_names: list[str] | None = None,
    reason: str = "policy:Customer PII Policy",
    created_at: datetime | None = None,
) -> StreamQuarantineEvent:
    now = created_at or datetime.now(timezone.utc)
    row = StreamQuarantineEvent(
        stream_id=int(stream_id),
        quarantine_reason=reason,
        quarantine_source=QUARANTINE_SOURCE_POLICY,
        status=status,
        protected_payload_json={
            "events": [{"classification_level": "RESTRICTED", "user": {"email": "tok_abc123"}}]
        },
        metadata_json={
            "event_count": 1,
            "policy_names": policy_names or ["Customer PII Policy"],
        },
        created_at=now,
        updated_at=now,
    )
    db_session.add(row)
    db_session.commit()
    return row


def test_list_quarantine_empty(governance_read_client: TestClient) -> None:
    resp = governance_read_client.get("/api/v1/governance/quarantine")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 0
    assert body["quarantine_events"] == []
    assert body["window"] == "24h"


def test_list_quarantine_events(governance_read_client: TestClient, db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    policy = _create_policy(db_session, name="Customer PII Policy", stream_id=stream_id)
    q_row = _create_quarantine(
        db_session,
        stream_id=stream_id,
        policy_names=["Customer PII Policy"],
    )

    resp = governance_read_client.get("/api/v1/governance/quarantine?window=24h")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    row = body["quarantine_events"][0]
    assert row["id"] == q_row.id
    assert row["policy_name"] == "Customer PII Policy"
    assert row["policy_id"] == policy.id
    assert row["classification"] == "RESTRICTED"
    assert row["status"] == "QUARANTINED"
    assert row["violation_id"] == f"q-{q_row.id}"


def test_list_quarantine_filter_classification(governance_read_client: TestClient, db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    _create_policy(db_session, name="Policy A", stream_id=stream_id)
    _create_quarantine(db_session, stream_id=stream_id)

    resp = governance_read_client.get("/api/v1/governance/quarantine?classification=RESTRICTED")
    assert resp.status_code == 200
    assert resp.json()["total"] == 1

    resp2 = governance_read_client.get("/api/v1/governance/quarantine?classification=PUBLIC")
    assert resp2.status_code == 200
    assert resp2.json()["total"] == 0


def test_quarantine_detail(governance_read_client: TestClient, db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    policy = _create_policy(db_session, name="Customer PII Policy", stream_id=stream_id)
    now = datetime.now(timezone.utc)
    db_session.add(
        StreamSensitiveFinding(
            stream_id=stream_id,
            field_path="$.user.email",
            sensitivity_class=SENSITIVITY_CLASS_PII,
            detection_method="path",
            status=FINDING_STATUS_OPEN,
            confirm_run_count=3,
            first_detected_at=now,
            last_confirmed_at=now,
        )
    )
    db_session.add(
        StreamProtectionRule(
            stream_id=stream_id,
            field_path="$.user.email",
            sensitivity_class=SENSITIVITY_CLASS_PII,
            protection_mode=PROTECTION_MODE_TOKENIZATION,
            enabled=True,
            created_by="test",
            created_at=now,
            updated_at=now,
        )
    )
    db_session.commit()
    q_row = _create_quarantine(db_session, stream_id=stream_id, policy_names=["Customer PII Policy"])

    resp = governance_read_client.get(f"/api/v1/governance/quarantine/{q_row.id}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["policy_summary"]["policy_id"] == policy.id
    assert body["classification"] == "RESTRICTED"
    assert len(body["sensitive_findings"]) >= 1
    assert body["sensitive_findings"][0]["sensitivity_class"] == "PII"
    assert len(body["protection_actions"]) >= 1
    assert body["protection_actions"][0]["protection_mode"] == "TOKENIZATION"
    assert body["policy_decision"]["action"] == "QUARANTINE"
    assert body["related_violation"]["violation_id"] == f"q-{q_row.id}"
    strip = body["root_cause_strip"]
    assert "PII" in strip["detected"] or strip["detected"] == "RESTRICTED"
    assert strip["action"] == "TOKENIZE"
    assert strip["policy"] == "Customer PII Policy"
    assert "Detected:" in strip["summary"]


def test_quarantine_detail_not_found(governance_read_client: TestClient) -> None:
    resp = governance_read_client.get("/api/v1/governance/quarantine/999999")
    assert resp.status_code == 404


def test_bulk_discard_quarantine(governance_write_client: TestClient, db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    _create_policy(db_session, name="Policy", stream_id=stream_id)
    q_row = _create_quarantine(db_session, stream_id=stream_id)

    resp = governance_write_client.post(
        "/api/v1/governance/quarantine/discard",
        json={"ids": [q_row.id]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["succeeded"] == 1
    assert body["results"][0]["outcome"] == "discarded"

    db_session.refresh(q_row)
    assert q_row.status == "discarded"


def test_bulk_replay_quarantine(governance_write_client: TestClient, db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    destination_id = int(seeded["destination_ids"][0])
    route_id = int(seeded["route_ids"][0])
    _create_policy(db_session, name="Policy", stream_id=stream_id)
    now = datetime.now(timezone.utc)
    q_row = _create_quarantine(
        db_session,
        stream_id=stream_id,
        status=QUARANTINE_STATUS_RELEASED,
        created_at=now - timedelta(hours=2),
    )
    replay_row = StreamReplayEvent(
        stream_id=stream_id,
        destination_id=destination_id,
        route_id=route_id,
        delivery_kind="base_route",
        status=REPLAY_STATUS_PENDING,
        protected_payload_json={"events": [{"id": 1}]},
        delivery_context_json={"destination_type": "WEBHOOK"},
        event_count=1,
        created_at=now - timedelta(hours=1),
        updated_at=now,
    )
    db_session.add(replay_row)
    db_session.commit()

    resp = governance_write_client.post(
        "/api/v1/governance/quarantine/replay",
        json={"ids": [q_row.id]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["results"][0]["replay_event_id"] == replay_row.id

    db_session.refresh(replay_row)
    assert replay_row.status in (REPLAY_STATUS_REPLAYED, REPLAY_STATUS_PENDING, "failed")
    assert replay_row.delivery_context_json[REPLAY_CONTEXT_ORIGIN_KEY] == REPLAY_CONTEXT_ORIGIN_QUARANTINE
    assert replay_row.delivery_context_json[REPLAY_CONTEXT_QUARANTINE_EVENT_ID_KEY] == q_row.id
