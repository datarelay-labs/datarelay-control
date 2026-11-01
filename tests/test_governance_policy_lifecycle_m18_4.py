"""M18.4 Policy Lifecycle — status transitions, validation, delete rules."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database import get_db, get_db_read_bounded
from app.governance_policies.models import GovernancePolicy


def _governance_policies_app() -> FastAPI:
    from app.governance.router import router

    app = FastAPI()
    app.include_router(router, prefix="/api/v1/governance")
    return app


@pytest.fixture
def governance_lifecycle_client(db_session: Session) -> TestClient:
    app = _governance_policies_app()

    def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_db_read_bounded] = _override_db
    return TestClient(app)


def _sample_policy_body(**overrides) -> dict:
    body = {
        "name": "Lifecycle Test Policy",
        "description": "Lifecycle",
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


def _activate(client: TestClient, policy_id: int):
    """These tests drive the lifecycle as a single principal, so activation passes the explicit F-187 override."""

    return client.post(
        f"/api/v1/governance/policies/{policy_id}/activate", json={"allow_self_approval": True}
    )


def test_lifecycle_draft_to_review(governance_lifecycle_client: TestClient) -> None:
    policy_id = _create_policy(governance_lifecycle_client)
    response = governance_lifecycle_client.post(f"/api/v1/governance/policies/{policy_id}/submit-review")
    assert response.status_code == 200
    policy = response.json()["policy"]
    assert policy["status"] == "REVIEW"
    assert policy["activated_at"] is None
    assert policy["retired_at"] is None


def test_lifecycle_review_to_active(governance_lifecycle_client: TestClient) -> None:
    policy_id = _create_policy(governance_lifecycle_client)
    governance_lifecycle_client.post(f"/api/v1/governance/policies/{policy_id}/submit-review")
    response = _activate(governance_lifecycle_client, policy_id)
    assert response.status_code == 200
    policy = response.json()["policy"]
    assert policy["status"] == "ACTIVE"
    assert policy["activated_at"] is not None
    assert policy["retired_at"] is None


def test_lifecycle_active_to_retired(governance_lifecycle_client: TestClient) -> None:
    policy_id = _create_policy(governance_lifecycle_client)
    governance_lifecycle_client.post(f"/api/v1/governance/policies/{policy_id}/submit-review")
    _activate(governance_lifecycle_client, policy_id)
    response = governance_lifecycle_client.post(f"/api/v1/governance/policies/{policy_id}/retire")
    assert response.status_code == 200
    policy = response.json()["policy"]
    assert policy["status"] == "RETIRED"
    assert policy["activated_at"] is not None
    assert policy["retired_at"] is not None


def test_lifecycle_invalid_transition(governance_lifecycle_client: TestClient) -> None:
    policy_id = _create_policy(governance_lifecycle_client)
    governance_lifecycle_client.post(f"/api/v1/governance/policies/{policy_id}/submit-review")
    _activate(governance_lifecycle_client, policy_id)
    governance_lifecycle_client.post(f"/api/v1/governance/policies/{policy_id}/retire")

    reactivate = governance_lifecycle_client.post(f"/api/v1/governance/policies/{policy_id}/activate")
    assert reactivate.status_code == 409
    assert reactivate.json()["detail"]["error_code"] == "GOVERNANCE_POLICY_LIFECYCLE"

    draft_id = _create_policy(governance_lifecycle_client)
    direct_activate = governance_lifecycle_client.post(f"/api/v1/governance/policies/{draft_id}/activate")
    assert direct_activate.status_code == 409
    assert direct_activate.json()["detail"]["error_code"] == "GOVERNANCE_POLICY_LIFECYCLE"

    review_id = _create_policy(governance_lifecycle_client)
    governance_lifecycle_client.post(f"/api/v1/governance/policies/{review_id}/submit-review")
    retire_from_review = governance_lifecycle_client.post(f"/api/v1/governance/policies/{review_id}/retire")
    assert retire_from_review.status_code == 409


def test_delete_retired_policy(governance_lifecycle_client: TestClient, db_session: Session) -> None:
    policy_id = _create_policy(governance_lifecycle_client)
    governance_lifecycle_client.post(f"/api/v1/governance/policies/{policy_id}/submit-review")
    _activate(governance_lifecycle_client, policy_id)
    governance_lifecycle_client.post(f"/api/v1/governance/policies/{policy_id}/retire")

    deleted = governance_lifecycle_client.delete(f"/api/v1/governance/policies/{policy_id}")
    assert deleted.status_code == 204
    assert governance_lifecycle_client.get(f"/api/v1/governance/policies/{policy_id}").status_code == 404
    assert db_session.get(GovernancePolicy, policy_id) is None


def test_delete_active_policy_fails(governance_lifecycle_client: TestClient) -> None:
    policy_id = _create_policy(governance_lifecycle_client)
    governance_lifecycle_client.post(f"/api/v1/governance/policies/{policy_id}/submit-review")
    _activate(governance_lifecycle_client, policy_id)

    deleted = governance_lifecycle_client.delete(f"/api/v1/governance/policies/{policy_id}")
    assert deleted.status_code == 409
    assert deleted.json()["detail"]["error_code"] == "GOVERNANCE_POLICY_LIFECYCLE"


def test_delete_draft_policy_fails(governance_lifecycle_client: TestClient) -> None:
    policy_id = _create_policy(governance_lifecycle_client)
    deleted = governance_lifecycle_client.delete(f"/api/v1/governance/policies/{policy_id}")
    assert deleted.status_code == 409
    assert deleted.json()["detail"]["error_code"] == "GOVERNANCE_POLICY_LIFECYCLE"


def test_put_status_change_blocked(governance_lifecycle_client: TestClient) -> None:
    policy_id = _create_policy(governance_lifecycle_client)
    response = governance_lifecycle_client.put(
        f"/api/v1/governance/policies/{policy_id}",
        json={"status": "ACTIVE"},
    )
    assert response.status_code == 409
    assert response.json()["detail"]["error_code"] == "GOVERNANCE_POLICY_LIFECYCLE"
