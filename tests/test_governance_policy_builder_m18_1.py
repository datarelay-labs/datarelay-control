"""M18.1 Policy Builder — CRUD, assignment, validation, preview."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database import get_db, get_db_read_bounded
from sqlalchemy import func, select

from app.governance_policies.models import GovernancePolicy, StreamPolicyAssignment
from tests.test_stream_runner_e2e import _seed_stream_runtime


def _governance_policies_app() -> FastAPI:
    from app.governance.router import router

    app = FastAPI()
    app.include_router(router, prefix="/api/v1/governance")
    return app


@pytest.fixture
def governance_policies_client(db_session: Session) -> TestClient:
    app = _governance_policies_app()

    def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_db_read_bounded] = _override_db
    return TestClient(app)


def _sample_policy_body(**overrides) -> dict:
    body = {
        "name": "Customer Data Protection",
        "description": "Protect customer PII",
        "category": "DATA_PROTECTION",
        "status": "DRAFT",
        "policy_json": {
            "conditions": [{"field": "classification", "operator": "equals", "value": "RESTRICTED"}],
            "actions": [{"type": "quarantine"}],
        },
    }
    body.update(overrides)
    return body


def test_policy_crud_api(governance_policies_client: TestClient, db_session: Session) -> None:
    create = governance_policies_client.post("/api/v1/governance/policies", json=_sample_policy_body())
    assert create.status_code == 201
    policy = create.json()["policy"]
    assert policy["name"] == "Customer Data Protection"
    assert policy["category"] == "DATA_PROTECTION"
    assert policy["status"] == "DRAFT"
    assert policy["version"] == 1
    policy_id = policy["id"]

    listed = governance_policies_client.get("/api/v1/governance/policies")
    assert listed.status_code == 200
    assert any(p["id"] == policy_id for p in listed.json()["policies"])

    fetched = governance_policies_client.get(f"/api/v1/governance/policies/{policy_id}")
    assert fetched.status_code == 200
    assert fetched.json()["policy"]["id"] == policy_id

    updated = governance_policies_client.put(
        f"/api/v1/governance/policies/{policy_id}",
        json={
            "name": "Employee PII Protection",
            "policy_json": {
                "conditions": [{"field": "classification", "operator": "equals", "value": "CONFIDENTIAL"}],
                "actions": [{"type": "mask"}],
            },
        },
    )
    assert updated.status_code == 200
    updated_policy = updated.json()["policy"]
    assert updated_policy["name"] == "Employee PII Protection"
    assert updated_policy["status"] == "DRAFT"
    assert updated_policy["version"] == 2

    for endpoint in ("submit-review", "activate", "retire"):
        # One principal drives the whole lifecycle; activating what you submitted needs the explicit
        # F-187 override.
        body = {"allow_self_approval": True} if endpoint == "activate" else None
        step = governance_policies_client.post(f"/api/v1/governance/policies/{policy_id}/{endpoint}", json=body)
        assert step.status_code == 200

    deleted = governance_policies_client.delete(f"/api/v1/governance/policies/{policy_id}")
    assert deleted.status_code == 204
    assert governance_policies_client.get(f"/api/v1/governance/policies/{policy_id}").status_code == 404


def test_policy_validation_rejects_invalid_json(governance_policies_client: TestClient) -> None:
    bad = governance_policies_client.post(
        "/api/v1/governance/policies",
        json=_sample_policy_body(
            policy_json={
                "conditions": [{"field": "classification", "operator": "gt", "value": "RESTRICTED"}],
                "actions": [{"type": "quarantine"}],
            }
        ),
    )
    assert bad.status_code in (400, 422)

    missing_actions = governance_policies_client.post(
        "/api/v1/governance/policies",
        json=_sample_policy_body(policy_json={"conditions": [{"field": "classification", "operator": "equals", "value": "X"}], "actions": []}),
    )
    assert missing_actions.status_code == 400


def test_policy_assignment_api(
    governance_policies_client: TestClient,
    db_session: Session,
) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = seeded["stream_id"]
    db_session.commit()

    create = governance_policies_client.post("/api/v1/governance/policies", json=_sample_policy_body(name="PCI Data Protection"))
    policy_id = create.json()["policy"]["id"]

    put_assignments = governance_policies_client.put(
        f"/api/v1/governance/policies/{policy_id}/assignments",
        json={"assignments": [{"stream_id": stream_id, "enabled": True}]},
    )
    assert put_assignments.status_code == 200
    assignments = put_assignments.json()["assignments"]
    assert len(assignments) == 1
    assert assignments[0]["stream_id"] == stream_id

    listed = governance_policies_client.get(f"/api/v1/governance/policies/{policy_id}/assignments")
    assert listed.status_code == 200
    assert listed.json()["assignments"][0]["stream_id"] == stream_id

    detail = governance_policies_client.get(f"/api/v1/governance/policies/{policy_id}")
    assert detail.json()["policy"]["assigned_stream_count"] == 1
    assert detail.json()["policy"]["assigned_stream_ids"] == [stream_id]

    missing_stream = governance_policies_client.put(
        f"/api/v1/governance/policies/{policy_id}/assignments",
        json={"assignments": [{"stream_id": 999999, "enabled": True}]},
    )
    assert missing_stream.status_code == 404
    assert missing_stream.json()["detail"]["error_code"] == "STREAM_NOT_FOUND"


def test_policy_preview_api(governance_policies_client: TestClient) -> None:
    create = governance_policies_client.post(
        "/api/v1/governance/policies",
        json=_sample_policy_body(name="AI Data Sharing Policy", category="AI_GOVERNANCE"),
    )
    policy_id = create.json()["policy"]["id"]

    preview = governance_policies_client.get(f"/api/v1/governance/policies/{policy_id}/preview")
    assert preview.status_code == 200
    body = preview.json()
    assert body["policy_id"] == policy_id
    assert len(body["rules"]) == 1
    assert "IF classification = RESTRICTED THEN quarantine" in body["rules"][0]["combined"]
    assert "IF classification = RESTRICTED THEN quarantine" in body["summary"]

    draft_preview = governance_policies_client.post(
        "/api/v1/governance/policies/preview",
        json={
            "conditions": [{"field": "classification", "operator": "not_equals", "value": "PUBLIC"}],
            "actions": [{"type": "audit_only"}],
        },
    )
    assert draft_preview.status_code == 200
    assert "classification != PUBLIC" in draft_preview.json()["rules"][0]["condition_text"]


def test_delete_policy_cascades_assignments(
    governance_policies_client: TestClient,
    db_session: Session,
) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = seeded["stream_id"]
    db_session.commit()

    create = governance_policies_client.post("/api/v1/governance/policies", json=_sample_policy_body())
    policy_id = create.json()["policy"]["id"]
    put = governance_policies_client.put(
        f"/api/v1/governance/policies/{policy_id}/assignments",
        json={"assignments": [{"stream_id": stream_id, "enabled": True}]},
    )
    assert put.status_code == 200
    assignment_count = db_session.scalar(
        select(func.count())
        .select_from(StreamPolicyAssignment)
        .where(StreamPolicyAssignment.policy_id == policy_id)
    )
    assert assignment_count == 1

    for endpoint in ("submit-review", "activate", "retire"):
        # One principal drives the whole lifecycle; activating what you submitted needs the explicit
        # F-187 override.
        body = {"allow_self_approval": True} if endpoint == "activate" else None
        step = governance_policies_client.post(f"/api/v1/governance/policies/{policy_id}/{endpoint}", json=body)
        assert step.status_code == 200

    assert governance_policies_client.delete(f"/api/v1/governance/policies/{policy_id}").status_code == 204
    assert db_session.get(GovernancePolicy, policy_id) is None
    assert (
        db_session.scalar(
            select(func.count())
            .select_from(StreamPolicyAssignment)
            .where(StreamPolicyAssignment.policy_id == policy_id)
        )
        == 0
    )
    assert (
        db_session.scalar(
            select(func.count())
            .select_from(StreamPolicyAssignment)
            .where(StreamPolicyAssignment.stream_id == stream_id)
        )
        == 0
    )
    assert governance_policies_client.get(f"/api/v1/governance/policies/{policy_id}").status_code == 404
    assert governance_policies_client.get(f"/api/v1/governance/policies/{policy_id}/assignments").status_code == 404
