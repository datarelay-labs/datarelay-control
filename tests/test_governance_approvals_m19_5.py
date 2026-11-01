"""M19.5 Governance Approval Workflow — submit, approve, reject, activate, validation."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database import get_db, get_db_read_bounded
from app.governance_approval.models import GovernancePolicyApprovalEvent
from app.governance_policies.models import GovernancePolicy, POLICY_STATUS_ACTIVE, POLICY_STATUS_DRAFT, POLICY_STATUS_REVIEW


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


def _sample_policy_body(**overrides) -> dict:
    body = {
        "name": "Approval Workflow Policy",
        "description": "M19.5 test",
        "category": "DATA_PROTECTION",
        "status": "DRAFT",
        "policy_json": {
            "conditions": [{"field": "classification", "operator": "equals", "value": "RESTRICTED"}],
            "actions": [{"type": "quarantine"}],
        },
    }
    body.update(overrides)
    return body


def _create_policy(client: TestClient) -> int:
    response = client.post("/api/v1/governance/policies", json=_sample_policy_body())
    assert response.status_code == 201
    return response.json()["policy"]["id"]


def _full_approval_flow(client: TestClient, policy_id: int) -> None:
    submit = client.post(
        f"/api/v1/governance/approvals/{policy_id}/submit",
        json={"comment": "Ready for review"},
    )
    assert submit.status_code == 200
    assert submit.json()["policy_status"] == "REVIEW"

    # These tests use one anonymous principal for every step, so each approve/activate is a
    # self-approval (F-187) and needs the explicit override. Separation of duties itself is covered
    # in tests/test_governance_separation_of_duties.py.
    approve = client.post(
        f"/api/v1/governance/approvals/{policy_id}/approve",
        json={"comment": "Looks good", "allow_self_approval": True},
    )
    assert approve.status_code == 200
    assert approve.json()["approval_status"] == "APPROVED"

    activate = client.post(
        f"/api/v1/governance/approvals/{policy_id}/activate",
        json={"comment": "Go live", "allow_self_approval": True},
    )
    assert activate.status_code == 200
    assert activate.json()["policy_status"] == "ACTIVE"


def test_submit_success(governance_write_client: TestClient) -> None:
    policy_id = _create_policy(governance_write_client)
    response = governance_write_client.post(
        f"/api/v1/governance/approvals/{policy_id}/submit",
        json={"comment": "Please review"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["policy_status"] == "REVIEW"
    assert body["event_type"] == "SUBMITTED_FOR_REVIEW"


def test_approve_success(governance_write_client: TestClient) -> None:
    policy_id = _create_policy(governance_write_client)
    governance_write_client.post(f"/api/v1/governance/approvals/{policy_id}/submit", json={})
    response = governance_write_client.post(
        f"/api/v1/governance/approvals/{policy_id}/approve",
        json={"comment": "Approved", "allow_self_approval": True},
    )
    assert response.status_code == 200
    assert response.json()["approval_status"] == "APPROVED"
    detail = governance_write_client.get(f"/api/v1/governance/approvals/{policy_id}")
    assert detail.status_code == 200
    assert detail.json()["is_approved"] is True
    assert detail.json()["current_status"] == "REVIEW"


def test_reject_success(governance_write_client: TestClient) -> None:
    policy_id = _create_policy(governance_write_client)
    governance_write_client.post(f"/api/v1/governance/approvals/{policy_id}/submit", json={})
    response = governance_write_client.post(
        f"/api/v1/governance/approvals/{policy_id}/reject",
        json={"comment": "Needs changes"},
    )
    assert response.status_code == 200
    assert response.json()["policy_status"] == "DRAFT"
    assert response.json()["event_type"] == "REJECTED"


def test_activate_success(governance_write_client: TestClient, db_session: Session) -> None:
    policy_id = _create_policy(governance_write_client)
    _full_approval_flow(governance_write_client, policy_id)
    row = db_session.get(GovernancePolicy, policy_id)
    assert row is not None
    assert row.status == POLICY_STATUS_ACTIVE
    assert row.activated_at is not None


def test_activate_without_approval_blocked(governance_write_client: TestClient) -> None:
    policy_id = _create_policy(governance_write_client)
    governance_write_client.post(f"/api/v1/governance/approvals/{policy_id}/submit", json={})
    response = governance_write_client.post(
        f"/api/v1/governance/approvals/{policy_id}/activate", json={"allow_self_approval": True}
    )
    assert response.status_code == 409
    assert response.json()["detail"]["error_code"] == "GOVERNANCE_APPROVAL"


def test_invalid_transitions_blocked(governance_write_client: TestClient) -> None:
    policy_id = _create_policy(governance_write_client)

    approve_draft = governance_write_client.post(
        f"/api/v1/governance/approvals/{policy_id}/approve", json={"allow_self_approval": True}
    )
    assert approve_draft.status_code == 409

    _full_approval_flow(governance_write_client, policy_id)

    submit_active = governance_write_client.post(f"/api/v1/governance/approvals/{policy_id}/submit", json={})
    assert submit_active.status_code == 409

    reject_active = governance_write_client.post(f"/api/v1/governance/approvals/{policy_id}/reject", json={})
    assert reject_active.status_code == 409


def test_retired_policy_actions_blocked(governance_write_client: TestClient) -> None:
    policy_id = _create_policy(governance_write_client)
    _full_approval_flow(governance_write_client, policy_id)
    governance_write_client.post(f"/api/v1/governance/policies/{policy_id}/retire")

    for path in ("submit", "approve", "activate"):
        resp = governance_write_client.post(
            f"/api/v1/governance/approvals/{policy_id}/{path}", json={"allow_self_approval": True}
        )
        assert resp.status_code == 409


def test_approval_list_filter(governance_write_client: TestClient) -> None:
    policy_id = _create_policy(governance_write_client)
    governance_write_client.post(
        f"/api/v1/governance/approvals/{policy_id}/submit",
        json={"comment": "submitted"},
    )

    all_rows = governance_write_client.get("/api/v1/governance/approvals?window=24h")
    assert all_rows.status_code == 200
    assert all_rows.json()["total"] >= 1

    by_policy = governance_write_client.get(f"/api/v1/governance/approvals?policy_id={policy_id}")
    assert by_policy.status_code == 200
    assert any(row["policy_id"] == policy_id for row in by_policy.json()["approvals"])

    by_status = governance_write_client.get("/api/v1/governance/approvals?status=REVIEW")
    assert by_status.status_code == 200
    assert any(row["policy_id"] == policy_id for row in by_status.json()["approvals"])


def test_approval_detail_history(governance_write_client: TestClient, db_session: Session) -> None:
    policy_id = _create_policy(governance_write_client)
    governance_write_client.post(f"/api/v1/governance/approvals/{policy_id}/submit", json={"comment": "v1"})
    governance_write_client.post(
        f"/api/v1/governance/approvals/{policy_id}/approve",
        json={"comment": "ok", "allow_self_approval": True},
    )

    response = governance_write_client.get(f"/api/v1/governance/approvals/{policy_id}")
    assert response.status_code == 200
    detail = response.json()
    assert detail["policy"]["id"] == policy_id
    assert len(detail["history"]) >= 2
    event_types = [entry["event_type"] for entry in detail["history"]]
    assert "SUBMITTED_FOR_REVIEW" in event_types
    assert "APPROVED" in event_types

    events = list(
        db_session.query(GovernancePolicyApprovalEvent)
        .filter(GovernancePolicyApprovalEvent.policy_id == policy_id)
        .all()
    )
    assert len(events) >= 2


def test_connector_operator_write_forbidden(governance_write_client: TestClient) -> None:
    from app.auth.jwt_service import issue_access_token

    policy_id = _create_policy(governance_write_client)
    token, _ = issue_access_token(username="connector-op", user_id=10, role="OPERATOR", token_version=1)
    headers = {"Authorization": f"Bearer {token}"}
    response = governance_write_client.post(
        f"/api/v1/governance/approvals/{policy_id}/submit",
        json={"comment": "blocked"},
        headers=headers,
    )
    assert response.status_code == 403
    assert response.json()["detail"]["error_code"] == "GOVERNANCE_WRITE_FORBIDDEN"


def test_connector_operator_read_allowed(governance_read_client: TestClient, governance_write_client: TestClient) -> None:
    policy_id = _create_policy(governance_write_client)
    governance_write_client.post(f"/api/v1/governance/approvals/{policy_id}/submit", json={})

    list_resp = governance_read_client.get("/api/v1/governance/approvals")
    assert list_resp.status_code == 200

    detail_resp = governance_read_client.get(f"/api/v1/governance/approvals/{policy_id}")
    assert detail_resp.status_code == 200
    assert detail_resp.json()["current_status"] == POLICY_STATUS_REVIEW


def test_reject_then_resubmit_flow(governance_write_client: TestClient) -> None:
    policy_id = _create_policy(governance_write_client)
    governance_write_client.post(f"/api/v1/governance/approvals/{policy_id}/submit", json={})
    governance_write_client.post(f"/api/v1/governance/approvals/{policy_id}/reject", json={"comment": "fix it"})

    row = governance_write_client.get(f"/api/v1/governance/policies/{policy_id}")
    assert row.json()["policy"]["status"] == POLICY_STATUS_DRAFT

    resubmit = governance_write_client.post(f"/api/v1/governance/approvals/{policy_id}/submit", json={})
    assert resubmit.status_code == 200
    assert resubmit.json()["policy_status"] == POLICY_STATUS_REVIEW
