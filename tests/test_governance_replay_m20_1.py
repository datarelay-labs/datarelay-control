"""M20.1 Governance Replay Operations Center — list, detail, execute, bulk, RBAC."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.auth.jwt_service import issue_access_token
from app.auth.role_guard import role_guard_middleware
from app.database import get_db, get_db_read_bounded
from app.governance_policies.models import (
    POLICY_STATUS_ACTIVE,
    GovernancePolicy,
    StreamPolicyAssignment,
)
from app.quarantine.models import (
    QUARANTINE_SOURCE_POLICY,
    QUARANTINE_STATUS_QUARANTINED,
    StreamQuarantineEvent,
)
from app.replay.models import REPLAY_STATUS_FAILED, REPLAY_STATUS_PENDING, REPLAY_STATUS_REPLAYED, StreamReplayEvent
from tests.test_stream_runner_e2e import _seed_stream_runtime


def _governance_app(*, with_rbac: bool = False) -> FastAPI:
    from app.governance.router import router

    app = FastAPI()
    if with_rbac:
        app.middleware("http")(role_guard_middleware)
    app.include_router(router, prefix="/api/v1/governance")
    return app


def _bearer(role: str) -> dict[str, str]:
    token, _ = issue_access_token(username="replay-test", user_id=42, role=role, token_version=1)
    return {"Authorization": f"Bearer {token}"}


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


@pytest.fixture
def governance_rbac_client(db_session: Session) -> TestClient:
    app = _governance_app(with_rbac=True)

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


def _create_replay_event(
    db_session: Session,
    *,
    stream_id: int,
    destination_id: int,
    status: str = REPLAY_STATUS_PENDING,
    route_id: int | None = None,
) -> StreamReplayEvent:
    now = datetime.now(timezone.utc)
    row = StreamReplayEvent(
        stream_id=int(stream_id),
        destination_id=int(destination_id),
        route_id=route_id,
        delivery_kind="base_route",
        status=status,
        protected_payload_json={"events": [{"id": 1, "message": "test"}]},
        delivery_context_json={"destination_type": "WEBHOOK"},
        error_type="delivery_error" if status == REPLAY_STATUS_FAILED else None,
        error_message="destination unreachable" if status == REPLAY_STATUS_FAILED else None,
        retry_count=1 if status == REPLAY_STATUS_FAILED else 0,
        event_count=1,
        created_at=now,
        updated_at=now,
        last_replay_at=now if status == REPLAY_STATUS_FAILED else None,
    )
    db_session.add(row)
    db_session.commit()
    return row


def _create_quarantine(db_session: Session, *, stream_id: int) -> StreamQuarantineEvent:
    now = datetime.now(timezone.utc)
    row = StreamQuarantineEvent(
        stream_id=int(stream_id),
        quarantine_reason="policy:Customer PII Policy",
        quarantine_source=QUARANTINE_SOURCE_POLICY,
        status=QUARANTINE_STATUS_QUARANTINED,
        protected_payload_json={"events": [{"classification_level": "RESTRICTED"}]},
        metadata_json={"event_count": 1, "policy_names": ["Customer PII Policy"]},
        created_at=now,
        updated_at=now,
    )
    db_session.add(row)
    db_session.commit()
    return row


def test_list_replay_empty(governance_read_client: TestClient) -> None:
    resp = governance_read_client.get("/api/v1/governance/replay")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 0
    assert body["replay_events"] == []
    assert body["window"] == "24h"


def test_list_replay_events(governance_read_client: TestClient, db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    destination_id = int(seeded["destination_ids"][0])
    policy = _create_policy(db_session, name="Customer PII Policy", stream_id=stream_id)
    replay_row = _create_replay_event(db_session, stream_id=stream_id, destination_id=destination_id)

    resp = governance_read_client.get("/api/v1/governance/replay?window=24h")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    row = body["replay_events"][0]
    assert row["id"] == replay_row.id
    assert row["policy_name"] == "Customer PII Policy"
    assert row["policy_id"] == policy.id
    assert row["status"] == "PENDING"
    assert row["correlation_id"] == f"r-{replay_row.id}"
    assert body["queue_count"] == 1


def test_list_replay_status_filter(governance_read_client: TestClient, db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    destination_id = int(seeded["destination_ids"][0])
    _create_policy(db_session, name="Policy", stream_id=stream_id)
    _create_replay_event(db_session, stream_id=stream_id, destination_id=destination_id, status=REPLAY_STATUS_PENDING)
    failed = _create_replay_event(
        db_session, stream_id=stream_id, destination_id=destination_id, status=REPLAY_STATUS_FAILED
    )

    resp = governance_read_client.get("/api/v1/governance/replay?status=FAILED")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["replay_events"][0]["id"] == failed.id
    assert body["replay_events"][0]["status"] == "FAILED"
    assert body["failed_count"] == 1


def test_replay_detail(governance_read_client: TestClient, db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    destination_id = int(seeded["destination_ids"][0])
    policy = _create_policy(db_session, name="Customer PII Policy", stream_id=stream_id)
    q_row = _create_quarantine(db_session, stream_id=stream_id)
    replay_row = _create_replay_event(db_session, stream_id=stream_id, destination_id=destination_id)

    resp = governance_read_client.get(f"/api/v1/governance/replay/{replay_row.id}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["entry"]["id"] == replay_row.id
    assert body["policy_summary"]["policy_id"] == policy.id
    assert body["correlation_id"] == f"q-{q_row.id}"
    assert body["source"]["violation"]["violation_id"] == f"q-{q_row.id}"
    assert body["can_execute"] is True
    assert len(body["timeline"]) >= 1


def test_execute_replay(governance_write_client: TestClient, db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    destination_id = int(seeded["destination_ids"][0])
    route_id = int(seeded["route_ids"][0])
    _create_policy(db_session, name="Policy", stream_id=stream_id)
    replay_row = _create_replay_event(
        db_session,
        stream_id=stream_id,
        destination_id=destination_id,
        route_id=route_id,
        status=REPLAY_STATUS_PENDING,
    )

    resp = governance_write_client.post(f"/api/v1/governance/replay/{replay_row.id}/execute")
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == replay_row.id
    assert body["outcome"] in ("replayed", "failed")

    db_session.refresh(replay_row)
    assert replay_row.status in (REPLAY_STATUS_REPLAYED, REPLAY_STATUS_FAILED, REPLAY_STATUS_PENDING)


def test_bulk_execute_replay(governance_write_client: TestClient, db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    destination_id = int(seeded["destination_ids"][0])
    route_id = int(seeded["route_ids"][0])
    _create_policy(db_session, name="Policy", stream_id=stream_id)
    r1 = _create_replay_event(
        db_session, stream_id=stream_id, destination_id=destination_id, route_id=route_id, status=REPLAY_STATUS_PENDING
    )
    r2 = _create_replay_event(
        db_session, stream_id=stream_id, destination_id=destination_id, route_id=route_id, status=REPLAY_STATUS_FAILED
    )

    resp = governance_write_client.post(
        "/api/v1/governance/replay/bulk-execute",
        json={"ids": [r1.id, r2.id]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert len(body["results"]) == 2


def test_replay_rbac_governance_operator_execute(governance_rbac_client: TestClient, db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    destination_id = int(seeded["destination_ids"][0])
    _create_policy(db_session, name="Policy", stream_id=stream_id)
    replay_row = _create_replay_event(db_session, stream_id=stream_id, destination_id=destination_id)

    read_resp = governance_rbac_client.get(
        "/api/v1/governance/replay",
        headers=_bearer("GOVERNANCE_OPERATOR"),
    )
    assert read_resp.status_code == 200

    exec_resp = governance_rbac_client.post(
        f"/api/v1/governance/replay/{replay_row.id}/execute",
        headers=_bearer("GOVERNANCE_OPERATOR"),
    )
    assert exec_resp.status_code == 200


def test_replay_rbac_reviewer_read_only(governance_rbac_client: TestClient, db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    destination_id = int(seeded["destination_ids"][0])
    _create_policy(db_session, name="Policy", stream_id=stream_id)
    replay_row = _create_replay_event(db_session, stream_id=stream_id, destination_id=destination_id)

    read_resp = governance_rbac_client.get(
        "/api/v1/governance/replay",
        headers=_bearer("GOVERNANCE_REVIEWER"),
    )
    assert read_resp.status_code == 200

    exec_resp = governance_rbac_client.post(
        f"/api/v1/governance/replay/{replay_row.id}/execute",
        headers=_bearer("GOVERNANCE_REVIEWER"),
    )
    assert exec_resp.status_code == 403


def test_replay_rbac_viewer_blocked(governance_rbac_client: TestClient) -> None:
    resp = governance_rbac_client.get(
        "/api/v1/governance/replay",
        headers=_bearer("VIEWER"),
    )
    assert resp.status_code == 403
