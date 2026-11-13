"""F-187: a user must not approve or activate the policy they submitted for review.

* self-approve / self-activate -> 403 ``GOVERNANCE_SELF_APPROVAL_FORBIDDEN``
* rejecting your own submission in REVIEW stays allowed
* only an explicit JSON ``allow_self_approval: true`` permits it, and the override is visible in the
  approval history

Follow-up: every way into REVIEW records the submitter (including ``POST /policies/{id}/submit-review``),
and a policy in REVIEW whose submitter is not recorded fails closed with
``GOVERNANCE_SUBMITTER_UNKNOWN`` unless the same explicit override is sent.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.auth.jwt_service import issue_access_token
from app.auth.role_guard import role_guard_middleware
from app.database import get_db, get_db_read_bounded
from app.governance_approval.models import (
    APPROVAL_EVENT_APPROVED,
    APPROVAL_EVENT_CANCELLED,
    APPROVAL_EVENT_REJECTED,
    APPROVAL_EVENT_REQUEST_CHANGES,
    APPROVAL_EVENT_SUBMITTED,
    GovernancePolicyApprovalEvent,
)
from app.governance_approval.service import (
    SELF_APPROVAL_OVERRIDE_MARKER,
    SUBMITTER_UNKNOWN_OVERRIDE_MARKER,
    open_cycle_requester,
)
from app.governance_policies.service import create_governance_policy, submit_policy_for_review
from app.governance_policies.models import (
    POLICY_STATUS_ACTIVE,
    POLICY_STATUS_DRAFT,
    POLICY_STATUS_REVIEW,
    GovernancePolicy,
)

GOV = "/api/v1/governance"
FORBIDDEN = "GOVERNANCE_SELF_APPROVAL_FORBIDDEN"
UNKNOWN = "GOVERNANCE_SUBMITTER_UNKNOWN"

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


# --- every way into REVIEW records the submitter ------------------------------------------------


def _direct_submit(client: TestClient, who, name: str = "Direct SoD policy") -> int:
    """Create a policy and move it to REVIEW through POST /policies/{id}/submit-review."""

    policy_id = _create_policy(client, name)
    resp = client.post(f"{GOV}/policies/{policy_id}/submit-review", headers=_as(who))
    assert resp.status_code == 200, resp.text
    return policy_id


def _submit_via(client: TestClient, path: str, who) -> int:
    return _submitted_by(client, who) if path == "approvals" else _direct_submit(client, who)


SUBMIT_PATHS = ["approvals", "policies"]


@pytest.mark.parametrize("path", SUBMIT_PATHS)
def test_each_submit_path_records_the_submitter(client: TestClient, db_session: Session, path: str) -> None:
    policy_id = _submit_via(client, path, AUTHOR)

    submitted = _events(db_session, policy_id, APPROVAL_EVENT_SUBMITTED)
    assert [e.actor for e in submitted] == [AUTHOR[0]]
    detail = client.get(f"{GOV}/approvals/{policy_id}", headers=_as(ADMIN)).json()
    assert detail["requester"] == AUTHOR[0]
    assert detail["submitter_unknown"] is False
    assert detail["history"][0]["event_type"] == "SUBMITTED_FOR_REVIEW"


@pytest.mark.parametrize("path", SUBMIT_PATHS)
def test_submitter_cannot_approve_or_activate_after_either_submit_path(
    client: TestClient, db_session: Session, path: str
) -> None:
    policy_id = _submit_via(client, path, ADMIN)

    approve = _act(client, policy_id, "approve", ADMIN)
    assert approve.status_code == 403, approve.text
    assert approve.json()["detail"]["error_code"] == FORBIDDEN

    direct_activate = client.post(f"{GOV}/policies/{policy_id}/activate", headers=_as(ADMIN))
    assert direct_activate.status_code == 403, direct_activate.text
    assert direct_activate.json()["detail"]["error_code"] == FORBIDDEN
    assert _status(db_session, policy_id) == POLICY_STATUS_REVIEW
    assert _events(db_session, policy_id, APPROVAL_EVENT_APPROVED) == []

    # A second administrator approves; the submitter still cannot activate through either endpoint.
    assert _act(client, policy_id, "approve", ADMIN_2).status_code == 200
    assert _act(client, policy_id, "activate", ADMIN).status_code == 403
    assert client.post(f"{GOV}/policies/{policy_id}/activate", headers=_as(ADMIN)).status_code == 403
    assert _status(db_session, policy_id) == POLICY_STATUS_REVIEW


@pytest.mark.parametrize("path", SUBMIT_PATHS)
def test_another_user_can_approve_and_activate_after_either_submit_path(
    client: TestClient, db_session: Session, path: str
) -> None:
    policy_id = _submit_via(client, path, AUTHOR)

    assert _act(client, policy_id, "approve", REVIEWER).status_code == 200
    assert _act(client, policy_id, "activate", APPROVER).status_code == 200
    assert _status(db_session, policy_id) == POLICY_STATUS_ACTIVE


def test_direct_submit_review_then_direct_activate_by_another_user_is_allowed(
    client: TestClient, db_session: Session
) -> None:
    policy_id = _direct_submit(client, AUTHOR)

    resp = client.post(f"{GOV}/policies/{policy_id}/activate", headers=_as(APPROVER))

    assert resp.status_code == 200, resp.text
    assert _status(db_session, policy_id) == POLICY_STATUS_ACTIVE


def test_explicit_override_still_works_after_direct_submit_review(client: TestClient, db_session: Session) -> None:
    policy_id = _direct_submit(client, ADMIN)

    approve = _act(client, policy_id, "approve", ADMIN, comment="urgent", allow_self_approval=True)
    activate = client.post(
        f"{GOV}/policies/{policy_id}/activate", json={"allow_self_approval": True}, headers=_as(ADMIN)
    )

    assert approve.status_code == 200, approve.text
    assert _events(db_session, policy_id, APPROVAL_EVENT_APPROVED)[0].comment == (
        f"{SELF_APPROVAL_OVERRIDE_MARKER} urgent"
    )
    assert activate.status_code == 200, activate.text
    assert _status(db_session, policy_id) == POLICY_STATUS_ACTIVE


def test_author_can_reject_after_direct_submit_review(client: TestClient, db_session: Session) -> None:
    policy_id = _direct_submit(client, ADMIN)

    resp = _act(client, policy_id, "reject", ADMIN, comment="withdrawing")

    assert resp.status_code == 200, resp.text
    assert _status(db_session, policy_id) == POLICY_STATUS_DRAFT


def test_resubmitting_directly_after_a_rejection_records_the_new_submitter(
    client: TestClient, db_session: Session
) -> None:
    policy_id = _submitted_by(client, ADMIN)
    assert _act(client, policy_id, "reject", ADMIN_2).status_code == 200

    assert client.post(f"{GOV}/policies/{policy_id}/submit-review", headers=_as(ADMIN_2)).status_code == 200

    own = _act(client, policy_id, "approve", ADMIN_2)
    assert own.status_code == 403
    assert own.json()["detail"]["error_code"] == FORBIDDEN
    assert _act(client, policy_id, "approve", ADMIN).status_code == 200


def test_direct_submit_review_errors_still_win_and_record_nothing(
    client: TestClient, db_session: Session
) -> None:
    assert client.post(f"{GOV}/policies/999999/submit-review", headers=_as(ADMIN)).status_code == 404

    policy_id = _direct_submit(client, ADMIN)
    again = client.post(f"{GOV}/policies/{policy_id}/submit-review", headers=_as(ADMIN_2))
    assert again.status_code == 409
    assert again.json()["detail"]["error_code"] == "GOVERNANCE_POLICY_LIFECYCLE"
    assert [e.actor for e in _events(db_session, policy_id, APPROVAL_EVENT_SUBMITTED)] == [ADMIN[0]]


def test_anonymous_principal_direct_submit_review_is_subject_to_the_rule(anonymous_client: TestClient) -> None:
    created = anonymous_client.post(
        f"{GOV}/policies",
        json={
            "name": "Anonymous direct SoD",
            "category": "DATA_PROTECTION",
            "status": "DRAFT",
            "policy_json": {
                "conditions": [{"field": "classification", "operator": "equals", "value": "RESTRICTED"}],
                "actions": [{"type": "quarantine"}],
            },
        },
    )
    policy_id = created.json()["policy"]["id"]
    assert anonymous_client.post(f"{GOV}/policies/{policy_id}/submit-review").status_code == 200

    denied = anonymous_client.post(f"{GOV}/policies/{policy_id}/activate")
    allowed = anonymous_client.post(f"{GOV}/policies/{policy_id}/activate", json={"allow_self_approval": True})

    assert denied.status_code == 403
    assert denied.json()["detail"]["error_code"] == FORBIDDEN
    assert allowed.status_code == 200


def test_service_level_submit_requires_an_actor_and_records_it(db_session: Session) -> None:
    """The shared transition function is the only way into REVIEW; it cannot be called anonymously."""

    row = create_governance_policy(
        db_session,
        name="Service level",
        description=None,
        category="DATA_PROTECTION",
        status=POLICY_STATUS_DRAFT,
        policy_json={
            "conditions": [{"field": "classification", "operator": "equals", "value": "RESTRICTED"}],
            "actions": [{"type": "quarantine"}],
        },
    )

    with pytest.raises(TypeError):
        submit_policy_for_review(db_session, int(row.id))  # type: ignore[call-arg]

    submit_policy_for_review(db_session, int(row.id), actor="svc-user")
    assert [e.actor for e in _events(db_session, int(row.id), APPROVAL_EVENT_SUBMITTED)] == ["svc-user"]


_APP_DIR = Path(__file__).resolve().parents[1] / "app"


def test_no_code_path_moves_a_policy_into_review_without_the_recording_function() -> None:
    """Static inventory of the paths into REVIEW (F-187 follow-up).

    Today there are exactly two entry points, both ending in ``submit_policy_for_review``:
    ``POST /governance/approvals/{id}/submit`` and ``POST /governance/policies/{id}/submit-review``.
    Any new writer of ``status = REVIEW`` (import, seed, helper) must record a submitter too, so this
    fails until it is routed through that function or consciously added here.
    """

    status_assignment = re.compile(r"""\.status\s*=\s*(POLICY_STATUS_REVIEW|["']REVIEW["'])""")
    status_kwarg = re.compile(r"""\bstatus\s*=\s*(POLICY_STATUS_REVIEW|["']REVIEW["'])""")
    transition_call = re.compile(r"target_status\s*=\s*POLICY_STATUS_REVIEW")
    raw_sql = re.compile(r"""(?is)update\s+governance_policies\b[^;]*['"]REVIEW['"]""")

    assignments: list[str] = []
    transitions: list[str] = []
    for path in sorted(_APP_DIR.rglob("*.py")):
        text = path.read_text(encoding="utf-8")
        rel = str(path.relative_to(_APP_DIR.parent))
        if status_assignment.search(text) or raw_sql.search(text):
            assignments.append(rel)
        if rel.startswith("app/governance_policies/") or rel.startswith("app/governance_approval/"):
            # ``status=POLICY_STATUS_REVIEW`` as a filter/compare is fine; constructing a row is not.
            if re.search(r"GovernancePolicy\([^)]*" + status_kwarg.pattern, text, re.S):
                assignments.append(rel)
        if transition_call.search(text):
            transitions.append(rel)

    assert assignments == []
    assert transitions == ["app/governance_policies/service.py"]
    source = (_APP_DIR / "governance_policies" / "service.py").read_text(encoding="utf-8")
    assert len(transition_call.findall(source)) == 1
    body = source[source.index("def submit_policy_for_review(") :]
    body = body[: body.index("\ndef ", 10)]
    assert "record_submission_event(" in body


# --- legacy policies with no recorded submitter -> UNKNOWN, fail closed ------------------------


def _legacy_review(
    client: TestClient,
    db: Session,
    events: list[tuple[str, str]] | None = None,
    *,
    name: str = "Legacy policy",
) -> int:
    """A policy in REVIEW the way POST /policies/{id}/submit-review left it before the fix.

    ``events`` are ``(event_type, actor)`` rows inserted in order, oldest first.
    """

    policy_id = _create_policy(client, name)
    row = db.get(GovernancePolicy, policy_id)
    assert row is not None
    row.status = POLICY_STATUS_REVIEW
    base = datetime.now(timezone.utc) - timedelta(hours=1)
    for offset, (event_type, actor) in enumerate(events or []):
        db.add(
            GovernancePolicyApprovalEvent(
                policy_id=policy_id,
                event_type=event_type,
                actor=actor,
                comment=None,
                created_at=base + timedelta(minutes=offset),
            )
        )
    db.commit()
    return policy_id


@pytest.mark.parametrize("who", [ADMIN, APPROVER])
def test_review_policy_without_any_submitter_evidence_is_denied_by_default(
    client: TestClient, db_session: Session, who
) -> None:
    """Denied for everybody, not just for some assumed author: the submitter cannot be identified."""

    policy_id = _legacy_review(client, db_session)

    approve = _act(client, policy_id, "approve", who)
    assert approve.status_code == 403, approve.text
    assert approve.json()["detail"]["error_code"] == UNKNOWN
    assert "not recorded" in approve.json()["detail"]["message"]

    direct = client.post(f"{GOV}/policies/{policy_id}/activate", headers=_as(who))
    assert direct.status_code == 403, direct.text
    assert direct.json()["detail"]["error_code"] == UNKNOWN
    assert _status(db_session, policy_id) == POLICY_STATUS_REVIEW
    assert _events(db_session, policy_id, APPROVAL_EVENT_APPROVED) == []


@pytest.mark.parametrize("flag", [False, None])
def test_missing_or_false_flag_does_not_lift_the_unknown_submitter_block(
    client: TestClient, db_session: Session, flag: bool | None
) -> None:
    policy_id = _legacy_review(client, db_session)
    body = {} if flag is None else {"allow_self_approval": flag}

    resp = _act(client, policy_id, "approve", ADMIN, **body)

    assert resp.status_code == 403
    assert resp.json()["detail"]["error_code"] == UNKNOWN


@pytest.mark.parametrize("value", ["true", 1, "yes"])
def test_only_json_true_lifts_the_unknown_submitter_block(
    client: TestClient, db_session: Session, value: object
) -> None:
    policy_id = _legacy_review(client, db_session)

    resp = _act(client, policy_id, "approve", ADMIN, allow_self_approval=value)

    assert resp.status_code == 422
    assert _events(db_session, policy_id, APPROVAL_EVENT_APPROVED) == []


def test_explicit_override_permits_approve_of_an_unknown_submitter_and_marks_the_history(
    client: TestClient, db_session: Session
) -> None:
    policy_id = _legacy_review(client, db_session)

    resp = _act(client, policy_id, "approve", ADMIN, comment="checked offline", allow_self_approval=True)

    assert resp.status_code == 200, resp.text
    approved = _events(db_session, policy_id, APPROVAL_EVENT_APPROVED)
    assert [e.actor for e in approved] == [ADMIN[0]]
    assert approved[0].comment == f"{SUBMITTER_UNKNOWN_OVERRIDE_MARKER} checked offline"
    # Activation is gated on its own, again with the same explicit override. (The approval workflow's
    # activate needs a recorded submission to call the cycle approved, so a legacy policy is activated
    # through the policy endpoint, or rejected and resubmitted.)
    denied = client.post(f"{GOV}/policies/{policy_id}/activate", headers=_as(ADMIN_2))
    assert denied.status_code == 403
    assert denied.json()["detail"]["error_code"] == UNKNOWN
    allowed = client.post(
        f"{GOV}/policies/{policy_id}/activate", json={"allow_self_approval": True}, headers=_as(ADMIN_2)
    )
    assert allowed.status_code == 200, allowed.text
    assert _status(db_session, policy_id) == POLICY_STATUS_ACTIVE


def test_explicit_override_permits_direct_activate_of_an_unknown_submitter(
    client: TestClient, db_session: Session
) -> None:
    policy_id = _legacy_review(client, db_session)

    resp = client.post(
        f"{GOV}/policies/{policy_id}/activate", json={"allow_self_approval": True}, headers=_as(ADMIN)
    )

    assert resp.status_code == 200, resp.text
    assert _status(db_session, policy_id) == POLICY_STATUS_ACTIVE


def test_unknown_submitter_policy_with_an_approved_event_cannot_be_activated_directly_by_default(
    client: TestClient, db_session: Session
) -> None:
    """Legacy "approved" state: REVIEW + an APPROVED event but no submission event at all."""

    policy_id = _legacy_review(client, db_session, [(APPROVAL_EVENT_APPROVED, "bob-reviewer")])

    direct = client.post(f"{GOV}/policies/{policy_id}/activate", headers=_as(ADMIN))
    workflow = _act(client, policy_id, "activate", ADMIN)

    assert direct.status_code == 403
    assert direct.json()["detail"]["error_code"] == UNKNOWN
    # No approved cycle exists for the workflow endpoint: its 409 comes first.
    assert workflow.status_code == 409
    assert _status(db_session, policy_id) == POLICY_STATUS_REVIEW


def test_reject_stays_allowed_for_an_unknown_submitter(client: TestClient, db_session: Session) -> None:
    policy_id = _legacy_review(client, db_session)

    resp = _act(client, policy_id, "reject", ADMIN, comment="resubmit please")

    assert resp.status_code == 200, resp.text
    assert _status(db_session, policy_id) == POLICY_STATUS_DRAFT
    # Resubmitting through the direct endpoint now records a submitter, so the rule is back to normal.
    assert client.post(f"{GOV}/policies/{policy_id}/submit-review", headers=_as(AUTHOR)).status_code == 200
    assert _act(client, policy_id, "approve", REVIEWER).status_code == 200


def test_detail_reports_an_unknown_submitter(client: TestClient, db_session: Session) -> None:
    policy_id = _legacy_review(client, db_session)

    detail = client.get(f"{GOV}/approvals/{policy_id}", headers=_as(ADMIN)).json()

    assert detail["current_status"] == "REVIEW"
    assert detail["submitter_unknown"] is True
    assert detail["requester"] is None


def test_unknown_submitter_does_not_mask_404_or_409(client: TestClient, db_session: Session) -> None:
    assert _act(client, 999999, "approve", ADMIN).status_code == 404
    assert client.post(f"{GOV}/policies/999999/activate", headers=_as(ADMIN)).status_code == 404

    draft_id = _create_policy(client, "Plain draft")
    approve_draft = _act(client, draft_id, "approve", ADMIN)
    assert approve_draft.status_code == 409
    assert approve_draft.json()["detail"]["error_code"] == "GOVERNANCE_APPROVAL"
    activate_draft = client.post(f"{GOV}/policies/{draft_id}/activate", headers=_as(ADMIN))
    assert activate_draft.status_code == 409
    assert activate_draft.json()["detail"]["error_code"] == "GOVERNANCE_POLICY_LIFECYCLE"

    # A review that was never approved: the workflow's own 409 still precedes the separation check.
    legacy_id = _legacy_review(client, db_session)
    not_approved = _act(client, legacy_id, "activate", ADMIN)
    assert not_approved.status_code == 409


def test_single_administrator_environment_is_blocked_by_default(client: TestClient, db_session: Session) -> None:
    """No flag relaxes the rule: a sole administrator needs the explicit per-request override."""

    policy_id = _direct_submit(client, ADMIN)
    legacy_id = _legacy_review(client, db_session, name="Legacy for the sole admin")

    for target, expected in ((policy_id, FORBIDDEN), (legacy_id, UNKNOWN)):
        resp = _act(client, target, "approve", ADMIN)
        assert resp.status_code == 403
        assert resp.json()["detail"]["error_code"] == expected


# --- fallback evidence rules (pure unit tests of the requester resolution) ----------------------


def _ev(event_type: str, actor: str, minute: int) -> GovernancePolicyApprovalEvent:
    return GovernancePolicyApprovalEvent(
        policy_id=1,
        event_type=event_type,
        actor=actor,
        created_at=datetime(2026, 1, 1, 12, minute, tzinfo=timezone.utc),
    )


def test_open_cycle_requester_uses_the_latest_submission_event() -> None:
    events = [_ev(APPROVAL_EVENT_SUBMITTED, "alice", 0), _ev(APPROVAL_EVENT_APPROVED, "bob", 1)]

    assert open_cycle_requester(events) == "alice"


def test_open_cycle_requester_follows_a_resubmission_after_a_rejection() -> None:
    events = [
        _ev(APPROVAL_EVENT_SUBMITTED, "alice", 0),
        _ev(APPROVAL_EVENT_REJECTED, "bob", 1),
        _ev(APPROVAL_EVENT_SUBMITTED, "carol", 2),
    ]

    assert open_cycle_requester(events) == "carol"


@pytest.mark.parametrize(
    "ending", [APPROVAL_EVENT_REJECTED, APPROVAL_EVENT_REQUEST_CHANGES, APPROVAL_EVENT_CANCELLED]
)
def test_open_cycle_requester_is_unknown_when_the_submitted_cycle_already_ended(ending: str) -> None:
    """The policy is in REVIEW again, so it was resubmitted without a recorded submitter."""

    events = [_ev(APPROVAL_EVENT_SUBMITTED, "alice", 0), _ev(ending, "bob", 1)]

    assert open_cycle_requester(events) is None


@pytest.mark.parametrize("actor", ["", "   "])
def test_open_cycle_requester_is_unknown_for_a_blank_actor(actor: str) -> None:
    assert open_cycle_requester([_ev(APPROVAL_EVENT_SUBMITTED, actor, 0)]) is None


def test_open_cycle_requester_is_unknown_without_any_submission_event() -> None:
    assert open_cycle_requester([]) is None
    assert open_cycle_requester([_ev(APPROVAL_EVENT_APPROVED, "bob", 0)]) is None


# --- fallback evidence through the API ---------------------------------------------------------


def test_legacy_review_with_a_submission_event_uses_it(client: TestClient, db_session: Session) -> None:
    policy_id = _legacy_review(client, db_session, [(APPROVAL_EVENT_SUBMITTED, ADMIN[0])])

    own = _act(client, policy_id, "approve", ADMIN)
    other = _act(client, policy_id, "approve", ADMIN_2)

    assert own.status_code == 403
    assert own.json()["detail"]["error_code"] == FORBIDDEN
    assert other.status_code == 200, other.text


def test_stale_submitter_of_a_finished_cycle_is_not_reused(client: TestClient, db_session: Session) -> None:
    """alice submitted, bob rejected, then the policy went back to REVIEW without a recorded submitter."""

    policy_id = _legacy_review(
        client,
        db_session,
        [(APPROVAL_EVENT_SUBMITTED, AUTHOR[0]), (APPROVAL_EVENT_REJECTED, REVIEWER[0])],
    )

    for who in (ADMIN, ADMIN_2):
        resp = _act(client, policy_id, "approve", who)
        assert resp.status_code == 403
        assert resp.json()["detail"]["error_code"] == UNKNOWN
    detail = client.get(f"{GOV}/approvals/{policy_id}", headers=_as(ADMIN)).json()
    assert detail["submitter_unknown"] is True
    assert detail["requester"] is None


def test_blank_actor_on_the_submission_event_fails_closed(client: TestClient, db_session: Session) -> None:
    policy_id = _legacy_review(client, db_session, [(APPROVAL_EVENT_SUBMITTED, "  ")])

    resp = _act(client, policy_id, "approve", ADMIN)

    assert resp.status_code == 403
    assert resp.json()["detail"]["error_code"] == UNKNOWN
