"""M20 Governance RBAC — role-based access for Governance APIs."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.auth.jwt_service import issue_access_token
from app.auth.role_guard import role_guard_middleware
from app.database import get_db, get_db_read_bounded


def _governance_app() -> FastAPI:
    from app.governance.router import router

    app = FastAPI()
    app.middleware("http")(role_guard_middleware)
    app.include_router(router, prefix="/api/v1/governance")
    return app


def _bearer(role: str, *, username: str | None = None) -> dict[str, str]:
    # One distinct principal per role: since F-187 a user cannot approve or activate the policy they
    # submitted, so roles in these workflows must not share a username.
    token, _ = issue_access_token(
        username=username or f"rbac-{role.lower()}", user_id=99, role=role, token_version=1
    )
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def governance_rbac_client(db_session: Session) -> TestClient:
    app = _governance_app()

    def _override_db():
        yield db_session

    app.dependency_overrides[get_db_read_bounded] = _override_db
    app.dependency_overrides[get_db] = _override_db
    return TestClient(app)


def _sample_policy_body(**overrides) -> dict:
    body = {
        "name": "M20 RBAC Policy",
        "description": "RBAC test",
        "category": "DATA_PROTECTION",
        "status": "DRAFT",
        "policy_json": {
            "conditions": [{"field": "classification", "operator": "equals", "value": "RESTRICTED"}],
            "actions": [{"type": "quarantine"}],
        },
    }
    body.update(overrides)
    return body


def _create_policy_as_admin(client: TestClient) -> int:
    response = client.post(
        "/api/v1/governance/policies",
        json=_sample_policy_body(),
        headers=_bearer("ADMINISTRATOR"),
    )
    assert response.status_code == 201, response.text
    return response.json()["policy"]["id"]


def test_administrator_full_governance_access(governance_rbac_client: TestClient) -> None:
    client = governance_rbac_client
    policy_id = _create_policy_as_admin(client)

    submit = client.post(
        f"/api/v1/governance/approvals/{policy_id}/submit",
        json={"comment": "go"},
        headers=_bearer("ADMINISTRATOR"),
    )
    assert submit.status_code == 200

    # The same administrator runs every step, so approve/activate need the explicit F-187 override.
    approve = client.post(
        f"/api/v1/governance/approvals/{policy_id}/approve",
        json={"comment": "ok", "allow_self_approval": True},
        headers=_bearer("ADMINISTRATOR"),
    )
    assert approve.status_code == 200

    activate = client.post(
        f"/api/v1/governance/approvals/{policy_id}/activate",
        json={"allow_self_approval": True},
        headers=_bearer("ADMINISTRATOR"),
    )
    assert activate.status_code == 200


def test_connector_operator_governance_write_blocked(governance_rbac_client: TestClient) -> None:
    client = governance_rbac_client
    admin_policy_id = _create_policy_as_admin(client)

    create = client.post(
        "/api/v1/governance/policies",
        json=_sample_policy_body(name="Blocked Create"),
        headers=_bearer("OPERATOR"),
    )
    assert create.status_code == 403
    assert create.json()["detail"]["error_code"] == "GOVERNANCE_WRITE_FORBIDDEN"

    submit = client.post(
        f"/api/v1/governance/approvals/{admin_policy_id}/submit",
        json={"comment": "blocked"},
        headers=_bearer("CONNECTOR_OPERATOR"),
    )
    assert submit.status_code == 403
    assert submit.json()["detail"]["error_code"] == "GOVERNANCE_WRITE_FORBIDDEN"


def test_connector_operator_governance_read_allowed(governance_rbac_client: TestClient) -> None:
    client = governance_rbac_client
    policy_id = _create_policy_as_admin(client)

    list_resp = client.get("/api/v1/governance/policies", headers=_bearer("OPERATOR"))
    assert list_resp.status_code == 200

    detail = client.get(f"/api/v1/governance/approvals/{policy_id}", headers=_bearer("OPERATOR"))
    assert detail.status_code == 200


def test_governance_operator_quarantine_action_allowed(governance_rbac_client: TestClient) -> None:
    client = governance_rbac_client
    response = client.post(
        "/api/v1/governance/quarantine/release",
        json={"ids": [999999]},
        headers=_bearer("GOVERNANCE_OPERATOR"),
    )
    assert response.status_code != 403


def test_governance_reviewer_approve_reject_allowed(governance_rbac_client: TestClient) -> None:
    client = governance_rbac_client
    policy_id = _create_policy_as_admin(client)
    client.post(
        f"/api/v1/governance/approvals/{policy_id}/submit",
        json={},
        headers=_bearer("ADMINISTRATOR"),
    )

    approve = client.post(
        f"/api/v1/governance/approvals/{policy_id}/approve",
        json={"comment": "reviewed"},
        headers=_bearer("GOVERNANCE_REVIEWER"),
    )
    assert approve.status_code == 200

    policy_id2 = _create_policy_as_admin(client)
    client.post(f"/api/v1/governance/approvals/{policy_id2}/submit", json={}, headers=_bearer("ADMINISTRATOR"))
    reject = client.post(
        f"/api/v1/governance/approvals/{policy_id2}/reject",
        json={"comment": "no"},
        headers=_bearer("GOVERNANCE_REVIEWER"),
    )
    assert reject.status_code == 200


def test_governance_approver_activate_allowed(governance_rbac_client: TestClient) -> None:
    client = governance_rbac_client
    policy_id = _create_policy_as_admin(client)
    client.post(f"/api/v1/governance/approvals/{policy_id}/submit", json={}, headers=_bearer("GOVERNANCE_OPERATOR"))
    client.post(f"/api/v1/governance/approvals/{policy_id}/approve", json={}, headers=_bearer("GOVERNANCE_REVIEWER"))

    activate = client.post(
        f"/api/v1/governance/approvals/{policy_id}/activate",
        json={},
        headers=_bearer("GOVERNANCE_APPROVER"),
    )
    assert activate.status_code == 200


def test_governance_reviewer_cannot_activate(governance_rbac_client: TestClient) -> None:
    client = governance_rbac_client
    policy_id = _create_policy_as_admin(client)
    client.post(f"/api/v1/governance/approvals/{policy_id}/submit", json={}, headers=_bearer("GOVERNANCE_OPERATOR"))
    client.post(f"/api/v1/governance/approvals/{policy_id}/approve", json={}, headers=_bearer("GOVERNANCE_REVIEWER"))

    activate = client.post(
        f"/api/v1/governance/approvals/{policy_id}/activate",
        json={},
        headers=_bearer("GOVERNANCE_REVIEWER"),
    )
    assert activate.status_code == 403
    assert activate.json()["detail"]["error_code"] == "GOVERNANCE_ACTIVATE_FORBIDDEN"


def test_governance_auditor_write_blocked_read_allowed(governance_rbac_client: TestClient) -> None:
    client = governance_rbac_client
    _create_policy_as_admin(client)

    write = client.post(
        "/api/v1/governance/policies",
        json=_sample_policy_body(name="Auditor Blocked"),
        headers=_bearer("GOVERNANCE_AUDITOR"),
    )
    assert write.status_code == 403

    audit = client.get("/api/v1/governance/audit?window=24h", headers=_bearer("GOVERNANCE_AUDITOR"))
    assert audit.status_code == 200


def test_viewer_governance_blocked(governance_rbac_client: TestClient) -> None:
    client = governance_rbac_client

    read = client.get("/api/v1/governance/policies", headers=_bearer("VIEWER"))
    assert read.status_code == 403
    assert read.json()["detail"]["error_code"] == "GOVERNANCE_READ_FORBIDDEN"

    write = client.post(
        "/api/v1/governance/policies",
        json=_sample_policy_body(),
        headers=_bearer("VIEWER"),
    )
    assert write.status_code == 403


def test_persona_header_ignored(governance_rbac_client: TestClient) -> None:
    """X-Governance-Persona must not grant or deny access — JWT role only."""

    client = governance_rbac_client
    policy_id = _create_policy_as_admin(client)

    blocked = client.post(
        f"/api/v1/governance/approvals/{policy_id}/submit",
        json={"comment": "blocked"},
        headers={**_bearer("OPERATOR"), "X-Governance-Persona": "governance"},
    )
    assert blocked.status_code == 403

    allowed = client.post(
        f"/api/v1/governance/approvals/{policy_id}/submit",
        json={"comment": "allowed"},
        headers={**_bearer("GOVERNANCE_OPERATOR"), "X-Governance-Persona": "connector"},
    )
    assert allowed.status_code == 200
    assert allowed.json()["policy_status"] == "REVIEW"


def test_governance_operator_policy_draft_and_submit(governance_rbac_client: TestClient) -> None:
    client = governance_rbac_client
    create = client.post(
        "/api/v1/governance/policies",
        json=_sample_policy_body(name="Gov Op Draft"),
        headers=_bearer("GOVERNANCE_OPERATOR"),
    )
    assert create.status_code == 201
    policy_id = create.json()["policy"]["id"]

    submit = client.post(
        f"/api/v1/governance/approvals/{policy_id}/submit",
        json={"comment": "please review"},
        headers=_bearer("GOVERNANCE_OPERATOR"),
    )
    assert submit.status_code == 200
