"""F-187: a user must not approve or activate the policy they submitted for review.

* self-approve / self-activate -> 403 ``GOVERNANCE_SELF_APPROVAL_FORBIDDEN``
* rejecting your own submission in REVIEW stays allowed
* only an explicit JSON ``allow_self_approval: true`` permits it, and the override is visible in the
  approval history
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.auth.jwt_service import issue_access_token
from app.auth.role_guard import role_guard_middleware
from app.database import get_db, get_db_read_bounded
from app.governance_approval.models import (
    APPROVAL_EVENT_APPROVED,
    APPROVAL_EVENT_REJECTED,
    GovernancePolicyApprovalEvent,
)
from app.governance_approval.service import SELF_APPROVAL_OVERRIDE_MARKER
from app.governance_policies.models import (
    POLICY_STATUS_ACTIVE,
    POLICY_STATUS_DRAFT,
    POLICY_STATUS_REVIEW,
    GovernancePolicy,
)

GOV = "/api/v1/governance"
FORBIDDEN = "GOVERNANCE_SELF_APPROVAL_FORBIDDEN"

AUTHOR = ("alice-author", "GOVERNANCE_OPERATOR")
REVIEWER = ("bob-reviewer", "GOVERNANCE_REVIEWER")
APPROVER = ("carol-approver", "GOVERNANCE_APPROVER")
ADMIN = ("dave-admin", "ADMINISTRATOR")
ADMIN_2 = ("erin-admin", "ADMINISTRATOR")


def _as(who: tuple[str, str]) -> dict[str, str]:
    username, role = who
    token, _ = issue_access_token(username=username, user_id=7, role=role, token_version=1)
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def client(db_session: Session) -> TestClient:
    from app.governance.router import router

    app = FastAPI()
    app.middleware("http")(role_guard_middleware)
    app.include_router(router, prefix=GOV)

    def _override_db():
        yield db_session

    app.dependency_overrides[get_db_read_bounded] = _override_db
    app.dependency_overrides[get_db] = _override_db
    return TestClient(app)


@pytest.fixture
def anonymous_client(db_session: Session) -> TestClient:
    """No middleware and no bearer: every request is the anonymous ``system`` principal."""

    from app.governance.router import router

    app = FastAPI()
    app.include_router(router, prefix=GOV)

    def _override_db():
        yield db_session

    app.dependency_overrides[get_db_read_bounded] = _override_db
    app.dependency_overrides[get_db] = _override_db
    return TestClient(app)


def _create_policy(client: TestClient, name: str = "SoD policy") -> int:
    resp = client.post(
        f"{GOV}/policies",
        json={
            "name": name,
            "description": "F-187",
            "category": "DATA_PROTECTION",
            "status": "DRAFT",
            "policy_json": {
                "conditions": [{"field": "classification", "operator": "equals", "value": "RESTRICTED"}],
                "actions": [{"type": "quarantine"}],
            },
        },
        headers=_as(ADMIN),
    )
    assert resp.status_code == 201, resp.text
    return int(resp.json()["policy"]["id"])


def _act(client: TestClient, policy_id: int, action: str, who, **body):
    return client.post(f"{GOV}/approvals/{policy_id}/{action}", json=body, headers=_as(who))


def _submitted_by(client: TestClient, who, name: str = "SoD policy") -> int:
    policy_id = _create_policy(client, name)
    resp = _act(client, policy_id, "submit", who, comment="please review")
    assert resp.status_code == 200, resp.text
    return policy_id


def _status(db: Session, policy_id: int) -> str:
    db.expire_all()
    row = db.get(GovernancePolicy, policy_id)
    assert row is not None
    return row.status


def _events(db: Session, policy_id: int, event_type: str) -> list[GovernancePolicyApprovalEvent]:
    db.expire_all()
    return (
        db.query(GovernancePolicyApprovalEvent)
        .filter(
            GovernancePolicyApprovalEvent.policy_id == policy_id,
            GovernancePolicyApprovalEvent.event_type == event_type,
        )
        .all()
    )


# --- approve -----------------------------------------------------------------------------------


def test_author_cannot_approve_their_own_submission(client: TestClient, db_session: Session) -> None:
    policy_id = _submitted_by(client, ADMIN)

    resp = _act(client, policy_id, "approve", ADMIN, comment="self")

    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"]["error_code"] == FORBIDDEN
    assert _status(db_session, policy_id) == POLICY_STATUS_REVIEW
    assert _events(db_session, policy_id, APPROVAL_EVENT_APPROVED) == []


def test_a_different_user_can_approve(client: TestClient, db_session: Session) -> None:
    policy_id = _submitted_by(client, AUTHOR)

    resp = _act(client, policy_id, "approve", REVIEWER, comment="looks good")

    assert resp.status_code == 200, resp.text
    approved = _events(db_session, policy_id, APPROVAL_EVENT_APPROVED)
    assert [e.actor for e in approved] == [REVIEWER[0]]
    assert SELF_APPROVAL_OVERRIDE_MARKER not in (approved[0].comment or "")


@pytest.mark.parametrize("flag", [False, None])
def test_explicit_false_or_missing_flag_does_not_permit_self_approval(
    client: TestClient, db_session: Session, flag: bool | None
) -> None:
    policy_id = _submitted_by(client, ADMIN)
    body = {} if flag is None else {"allow_self_approval": flag}

    resp = _act(client, policy_id, "approve", ADMIN, **body)

    assert resp.status_code == 403
    assert resp.json()["detail"]["error_code"] == FORBIDDEN
    assert _events(db_session, policy_id, APPROVAL_EVENT_APPROVED) == []


@pytest.mark.parametrize("value", ["true", "yes", 1, "1"])
def test_only_json_true_counts_as_an_explicit_override(
    client: TestClient, db_session: Session, value: object
) -> None:
    policy_id = _submitted_by(client, ADMIN)

    resp = _act(client, policy_id, "approve", ADMIN, allow_self_approval=value)

    assert resp.status_code == 422, resp.text
    assert _events(db_session, policy_id, APPROVAL_EVENT_APPROVED) == []
    assert _status(db_session, policy_id) == POLICY_STATUS_REVIEW


def test_explicit_override_permits_self_approval_and_is_visible_in_history(
    client: TestClient, db_session: Session
) -> None:
    policy_id = _submitted_by(client, ADMIN)

    resp = _act(client, policy_id, "approve", ADMIN, comment="urgent fix", allow_self_approval=True)

    assert resp.status_code == 200, resp.text
    approved = _events(db_session, policy_id, APPROVAL_EVENT_APPROVED)
    assert len(approved) == 1
    assert approved[0].actor == ADMIN[0]
    assert approved[0].comment == f"{SELF_APPROVAL_OVERRIDE_MARKER} urgent fix"
    detail = client.get(f"{GOV}/approvals/{policy_id}", headers=_as(ADMIN)).json()
    assert detail["is_approved"] is True
    assert SELF_APPROVAL_OVERRIDE_MARKER in detail["history"][-1]["comment"]


def test_override_without_a_comment_is_still_marked(client: TestClient, db_session: Session) -> None:
    policy_id = _submitted_by(client, ADMIN)

    resp = _act(client, policy_id, "approve", ADMIN, allow_self_approval=True)

    assert resp.status_code == 200, resp.text
    assert _events(db_session, policy_id, APPROVAL_EVENT_APPROVED)[0].comment == SELF_APPROVAL_OVERRIDE_MARKER


def test_override_flag_does_not_grant_a_role_the_user_lacks(client: TestClient, db_session: Session) -> None:
    policy_id = _submitted_by(client, ADMIN)

    resp = _act(client, policy_id, "approve", AUTHOR, allow_self_approval=True)

    assert resp.status_code == 403
    assert resp.json()["detail"]["error_code"] == "GOVERNANCE_APPROVAL_FORBIDDEN"
    assert _events(db_session, policy_id, APPROVAL_EVENT_APPROVED) == []


def test_username_comparison_ignores_case_and_surrounding_space(client: TestClient) -> None:
    policy_id = _submitted_by(client, ("Frank-Mixed", "ADMINISTRATOR"))

    resp = _act(client, policy_id, "approve", ("frank-mixed", "ADMINISTRATOR"))

    assert resp.status_code == 403
    assert resp.json()["detail"]["error_code"] == FORBIDDEN


# --- activate ----------------------------------------------------------------------------------


def test_author_cannot_activate_their_own_policy_even_after_someone_else_approved(
    client: TestClient, db_session: Session
) -> None:
    policy_id = _submitted_by(client, ADMIN)
    assert _act(client, policy_id, "approve", ADMIN_2).status_code == 200

    resp = _act(client, policy_id, "activate", ADMIN)

    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"]["error_code"] == FORBIDDEN
    assert _status(db_session, policy_id) == POLICY_STATUS_REVIEW


def test_a_different_approver_can_activate(client: TestClient, db_session: Session) -> None:
    policy_id = _submitted_by(client, AUTHOR)
    assert _act(client, policy_id, "approve", REVIEWER).status_code == 200

    resp = _act(client, policy_id, "activate", APPROVER)

    assert resp.status_code == 200, resp.text
    assert _status(db_session, policy_id) == POLICY_STATUS_ACTIVE


def test_explicit_override_permits_self_activation(client: TestClient, db_session: Session) -> None:
    policy_id = _submitted_by(client, ADMIN)
    assert _act(client, policy_id, "approve", ADMIN_2).status_code == 200

    resp = _act(client, policy_id, "activate", ADMIN, comment="go", allow_self_approval=True)

    assert resp.status_code == 200, resp.text
    assert _status(db_session, policy_id) == POLICY_STATUS_ACTIVE
    detail = client.get(f"{GOV}/approvals/{policy_id}", headers=_as(ADMIN)).json()
    assert detail["history"][-1]["event_type"] == "ACTIVATED"
    assert detail["history"][-1]["comment"] == f"{SELF_APPROVAL_OVERRIDE_MARKER} go"


def test_a_full_self_approved_flow_needs_the_override_at_both_steps(
    client: TestClient, db_session: Session
) -> None:
    policy_id = _submitted_by(client, ADMIN)

    assert _act(client, policy_id, "approve", ADMIN, allow_self_approval=True).status_code == 200
    assert _act(client, policy_id, "activate", ADMIN).status_code == 403
    assert _status(db_session, policy_id) == POLICY_STATUS_REVIEW
    assert _act(client, policy_id, "activate", ADMIN, allow_self_approval=True).status_code == 200
    assert _status(db_session, policy_id) == POLICY_STATUS_ACTIVE


def test_role_guard_still_decides_who_may_activate(client: TestClient) -> None:
    policy_id = _submitted_by(client, AUTHOR)
    assert _act(client, policy_id, "approve", REVIEWER).status_code == 200

    resp = _act(client, policy_id, "activate", REVIEWER, allow_self_approval=True)

    assert resp.status_code == 403
    assert resp.json()["detail"]["error_code"] == "GOVERNANCE_ACTIVATE_FORBIDDEN"


# --- reject stays allowed ----------------------------------------------------------------------


def test_author_can_reject_their_own_submission_in_review(client: TestClient, db_session: Session) -> None:
    policy_id = _submitted_by(client, ADMIN)

    resp = _act(client, policy_id, "reject", ADMIN, comment="withdrawing")

    assert resp.status_code == 200, resp.text
    assert resp.json()["event_type"] == "REJECTED"
    assert _status(db_session, policy_id) == POLICY_STATUS_DRAFT
    assert [e.actor for e in _events(db_session, policy_id, APPROVAL_EVENT_REJECTED)] == [ADMIN[0]]


def test_author_can_reject_after_someone_else_approved(client: TestClient, db_session: Session) -> None:
    policy_id = _submitted_by(client, ADMIN)
    assert _act(client, policy_id, "approve", ADMIN_2).status_code == 200

    resp = _act(client, policy_id, "reject", ADMIN)

    assert resp.status_code == 200, resp.text
    assert _status(db_session, policy_id) == POLICY_STATUS_DRAFT


# --- what counts as "own" ----------------------------------------------------------------------


def test_ownership_follows_the_latest_submission(client: TestClient, db_session: Session) -> None:
    policy_id = _submitted_by(client, ADMIN)
    assert _act(client, policy_id, "reject", ADMIN_2).status_code == 200

    # ADMIN_2 resubmits: the previous author (ADMIN) is no longer the requester of the open cycle.
    assert _act(client, policy_id, "submit", ADMIN_2).status_code == 200
    own = _act(client, policy_id, "approve", ADMIN_2)
    assert own.status_code == 403
    assert own.json()["detail"]["error_code"] == FORBIDDEN
    assert _act(client, policy_id, "approve", ADMIN).status_code == 200
    assert _status(db_session, policy_id) == POLICY_STATUS_REVIEW


def test_invalid_transition_errors_take_precedence_over_the_self_approval_check(client: TestClient) -> None:
    policy_id = _submitted_by(client, ADMIN)
    assert _act(client, policy_id, "reject", ADMIN).status_code == 200  # back to DRAFT

    resp = _act(client, policy_id, "approve", ADMIN)

    assert resp.status_code == 409
    assert resp.json()["detail"]["error_code"] == "GOVERNANCE_APPROVAL"


def test_activating_before_approval_is_still_a_409_not_a_403(client: TestClient) -> None:
    policy_id = _submitted_by(client, ADMIN)

    resp = _act(client, policy_id, "activate", ADMIN)

    assert resp.status_code == 409
    assert resp.json()["detail"]["error_code"] == "GOVERNANCE_APPROVAL"


def test_unknown_policy_is_still_a_404(client: TestClient) -> None:
    assert _act(client, 999999, "approve", ADMIN).status_code == 404


# --- anonymous principal (REQUIRE_AUTH=false development mode) ----------------------------------


def test_anonymous_principal_is_also_subject_to_the_rule(anonymous_client: TestClient) -> None:
    created = anonymous_client.post(
        f"{GOV}/policies",
        json={
            "name": "Anonymous SoD",
            "category": "DATA_PROTECTION",
            "status": "DRAFT",
            "policy_json": {
                "conditions": [{"field": "classification", "operator": "equals", "value": "RESTRICTED"}],
                "actions": [{"type": "quarantine"}],
            },
        },
    )
    policy_id = created.json()["policy"]["id"]
    assert anonymous_client.post(f"{GOV}/approvals/{policy_id}/submit", json={}).status_code == 200

    denied = anonymous_client.post(f"{GOV}/approvals/{policy_id}/approve", json={})
    allowed = anonymous_client.post(
        f"{GOV}/approvals/{policy_id}/approve", json={"allow_self_approval": True}
    )

    assert denied.status_code == 403
    assert denied.json()["detail"]["error_code"] == FORBIDDEN
    assert allowed.status_code == 200


# --- direct policy lifecycle endpoint ----------------------------------------------------------


def test_direct_policy_activate_endpoint_enforces_the_same_rule(
    client: TestClient, db_session: Session
) -> None:
    policy_id = _submitted_by(client, ADMIN)

    denied = client.post(f"{GOV}/policies/{policy_id}/activate", headers=_as(ADMIN))
    assert denied.status_code == 403, denied.text
    assert denied.json()["detail"]["error_code"] == FORBIDDEN
    assert _status(db_session, policy_id) == POLICY_STATUS_REVIEW

    string_flag = client.post(
        f"{GOV}/policies/{policy_id}/activate", json={"allow_self_approval": "true"}, headers=_as(ADMIN)
    )
    assert string_flag.status_code == 422
    assert _status(db_session, policy_id) == POLICY_STATUS_REVIEW

    allowed = client.post(
        f"{GOV}/policies/{policy_id}/activate", json={"allow_self_approval": True}, headers=_as(ADMIN)
    )
    assert allowed.status_code == 200, allowed.text
    assert _status(db_session, policy_id) == POLICY_STATUS_ACTIVE


def test_direct_policy_activate_by_another_user_is_allowed(client: TestClient, db_session: Session) -> None:
    policy_id = _submitted_by(client, AUTHOR)

    resp = client.post(f"{GOV}/policies/{policy_id}/activate", headers=_as(APPROVER))

    assert resp.status_code == 200, resp.text
    assert _status(db_session, policy_id) == POLICY_STATUS_ACTIVE


def test_direct_policy_activate_without_approval_history_is_unchanged(
    client: TestClient, db_session: Session
) -> None:
    """submit-review records no approval event, so there is no requester to compare against."""

    policy_id = _create_policy(client, "Direct lifecycle")
    submit = client.post(f"{GOV}/policies/{policy_id}/submit-review", headers=_as(ADMIN))
    assert submit.status_code == 200, submit.text

    resp = client.post(f"{GOV}/policies/{policy_id}/activate", headers=_as(ADMIN))

    assert resp.status_code == 200, resp.text
    assert _status(db_session, policy_id) == POLICY_STATUS_ACTIVE
