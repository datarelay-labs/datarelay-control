"""F-202: self-service account hygiene for every role.

* every role can change its own password and start MFA enrollment through the API
* accounts an administrator creates, or whose password an administrator resets, must change the
  password at next sign-in (``must_change_password=true``) so the administrator who typed it does not
  keep knowing it
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.audit.models import AuditLog
from app.auth.login_throttle import reset_login_throttle_for_tests
from app.auth.security import get_password_hash
from app.database import get_db
from app.main import app
from app.platform_admin.models import PlatformUser

ROLES = [
    "ADMINISTRATOR",
    "OPERATOR",
    "CONNECTOR_OPERATOR",
    "VIEWER",
    "GOVERNANCE_OPERATOR",
    "GOVERNANCE_REVIEWER",
    "GOVERNANCE_APPROVER",
    "GOVERNANCE_AUDITOR",
]
ADMIN = "f202-admin"
ADMIN_PASSWORD = "AdminStart-9!x"
TEMP_PASSWORD = "TempStart-1!x"
OWN_PASSWORD = "OwnerChosen-2!x"


@pytest.fixture
def admin_client(db_session: Session, monkeypatch: pytest.MonkeyPatch):
    from app.config import settings

    monkeypatch.setattr(settings, "REQUIRE_AUTH", True)
    reset_login_throttle_for_tests()

    def override() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = override
    db_session.add(
        PlatformUser(
            username=ADMIN,
            password_hash=get_password_hash(ADMIN_PASSWORD),
            role="ADMINISTRATOR",
            status="ACTIVE",
            token_version=1,
        )
    )
    db_session.commit()
    with TestClient(app) as client:
        login = client.post("/api/v1/auth/login", json={"username": ADMIN, "password": ADMIN_PASSWORD})
        assert login.status_code == 200, login.text
        assert login.json()["user"]["must_change_password"] is False
        client.headers.update({"Authorization": "Bearer " + login.json()["access_token"]})
        yield client
    app.dependency_overrides.pop(get_db, None)
    reset_login_throttle_for_tests()


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _row(db: Session, username: str) -> PlatformUser:
    db.expire_all()
    row = db.query(PlatformUser).filter(PlatformUser.username == username).one()
    return row


def _admin_creates(client: TestClient, username: str, role: str, password: str = TEMP_PASSWORD) -> dict[str, Any]:
    resp = client.post("/api/v1/admin/users", json={"username": username, "password": password, "role": role})
    assert resp.status_code == 201, resp.text
    return resp.json()


def _login(client: TestClient, username: str, password: str) -> Any:
    # A fresh client: the admin client carries the administrator's Authorization header.
    with TestClient(app) as anon:
        return anon.post("/api/v1/auth/login", json={"username": username, "password": password})


def _change_password(token: str, current: str, new: str) -> Any:
    with TestClient(app) as anon:
        return anon.post(
            "/api/v1/auth/change-password",
            headers=_bearer(token),
            json={"current_password": current, "new_password": new, "confirm_new_password": new},
        )


@pytest.mark.parametrize("role", ROLES)
def test_admin_created_account_must_change_password_then_works(
    role: str, admin_client: TestClient, db_session: Session
) -> None:
    username = f"f202-new-{role.lower()}"
    _admin_creates(admin_client, username, role)
    assert _row(db_session, username).must_change_password is True

    created_audit = [
        r for r in db_session.query(AuditLog).filter(AuditLog.action == "USER_CREATED").all()
        if (r.metadata_json or {}).get("entity_name") == username
    ]
    assert created_audit and created_audit[0].metadata_json["must_change_password"] is True

    login = _login(admin_client, username, TEMP_PASSWORD)
    assert login.status_code == 200, login.text
    assert login.json()["user"]["must_change_password"] is True
    token = login.json()["access_token"]

    with TestClient(app) as anon:
        # Everything except the change-password/whoami/refresh/logout set is gated until the change.
        blocked = anon.get("/api/v1/connectors/", headers=_bearer(token))
        assert blocked.status_code == 403
        assert blocked.json()["detail"]["error_code"] == "PASSWORD_CHANGE_REQUIRED"
        who = anon.get("/api/v1/auth/whoami", headers=_bearer(token))
        assert who.status_code == 200 and who.json()["must_change_password"] is True

    # The forced change must be completable by EVERY role (Governance-only roles included).
    changed = _change_password(token, TEMP_PASSWORD, OWN_PASSWORD)
    assert changed.status_code == 200, changed.text
    assert _row(db_session, username).must_change_password is False

    assert _login(admin_client, username, TEMP_PASSWORD).status_code == 400
    relogin = _login(admin_client, username, OWN_PASSWORD)
    assert relogin.status_code == 200, relogin.text
    assert relogin.json()["user"]["must_change_password"] is False
    with TestClient(app) as anon:
        assert anon.get("/api/v1/auth/whoami", headers=_bearer(relogin.json()["access_token"])).json()[
            "must_change_password"
        ] is False


def test_admin_password_reset_forces_a_new_change(admin_client: TestClient, db_session: Session) -> None:
    username = "f202-reset-target"
    created = _admin_creates(admin_client, username, "OPERATOR")
    first = _login(admin_client, username, TEMP_PASSWORD).json()["access_token"]
    assert _change_password(first, TEMP_PASSWORD, OWN_PASSWORD).status_code == 200
    assert _row(db_session, username).must_change_password is False

    reset = admin_client.patch(f"/api/v1/admin/users/{created['id']}", json={"password": "ResetByAdmin-3!x"})
    assert reset.status_code == 200, reset.text

    assert _row(db_session, username).must_change_password is True
    assert _login(admin_client, username, OWN_PASSWORD).status_code == 400
    relogin = _login(admin_client, username, "ResetByAdmin-3!x")
    assert relogin.status_code == 200
    assert relogin.json()["user"]["must_change_password"] is True
    updated_audit = [
        r for r in db_session.query(AuditLog).filter(AuditLog.action == "USER_UPDATED").all()
        if (r.metadata_json or {}).get("entity_name") == username
    ]
    assert updated_audit[-1].metadata_json["must_change_password"] is True


def test_admin_edit_without_a_password_does_not_force_a_change(
    admin_client: TestClient, db_session: Session
) -> None:
    username = "f202-role-change"
    created = _admin_creates(admin_client, username, "VIEWER")
    token = _login(admin_client, username, TEMP_PASSWORD).json()["access_token"]
    assert _change_password(token, TEMP_PASSWORD, OWN_PASSWORD).status_code == 200

    edit = admin_client.patch(f"/api/v1/admin/users/{created['id']}", json={"role": "OPERATOR"})

    assert edit.status_code == 200, edit.text
    assert _row(db_session, username).must_change_password is False
    relogin = _login(admin_client, username, OWN_PASSWORD)
    assert relogin.json()["user"]["must_change_password"] is False


@pytest.mark.parametrize("role", ROLES)
def test_every_role_can_change_its_own_password_without_being_forced(
    role: str, admin_client: TestClient, db_session: Session
) -> None:
    username = f"f202-self-{role.lower()}"
    db_session.add(
        PlatformUser(
            username=username,
            password_hash=get_password_hash(TEMP_PASSWORD),
            role=role,
            status="ACTIVE",
            token_version=1,
            must_change_password=False,
        )
    )
    db_session.commit()
    token = _login(admin_client, username, TEMP_PASSWORD).json()["access_token"]

    wrong = _change_password(token, "not-the-current-1!", OWN_PASSWORD)
    assert wrong.status_code == 400
    assert wrong.json()["detail"]["error_code"] == "USER_AUTH_FAILED"

    weak = _change_password(token, TEMP_PASSWORD, "admin")
    assert weak.status_code == 400
    assert weak.json()["detail"]["error_code"] == "PASSWORD_POLICY_REJECTED"

    ok = _change_password(token, TEMP_PASSWORD, OWN_PASSWORD)
    assert ok.status_code == 200, ok.text
    assert _login(admin_client, username, OWN_PASSWORD).status_code == 200
    assert _login(admin_client, username, TEMP_PASSWORD).status_code == 400


def test_change_password_requires_authentication(admin_client: TestClient) -> None:
    with TestClient(app) as anon:
        resp = anon.post(
            "/api/v1/auth/change-password",
            json={"current_password": "x", "new_password": OWN_PASSWORD, "confirm_new_password": OWN_PASSWORD},
        )
    assert resp.status_code == 401


@pytest.mark.parametrize("role", ROLES)
def test_every_role_reaches_mfa_enrollment_and_must_prove_its_current_password(
    role: str, admin_client: TestClient, db_session: Session
) -> None:
    username = f"f202-mfa-{role.lower()}"
    db_session.add(
        PlatformUser(
            username=username,
            password_hash=get_password_hash(TEMP_PASSWORD),
            role=role,
            status="ACTIVE",
            token_version=1,
            must_change_password=False,
        )
    )
    db_session.commit()
    token = _login(admin_client, username, TEMP_PASSWORD).json()["access_token"]

    with TestClient(app) as anon:
        # Reaches the handler (400 from the password check) instead of being refused by the role guard.
        denied = anon.post(
            "/api/v1/auth/mfa/enroll/start",
            headers=_bearer(token),
            json={"current_password": "wrong-password-1!"},
        )
        status = anon.get("/api/v1/auth/mfa/status", headers=_bearer(token))

    assert denied.status_code == 400, denied.text
    assert denied.json()["detail"]["error_code"] == "MFA_SETUP_DENIED"
    assert status.status_code == 200, status.text
    assert status.json()["enabled"] is False


def test_mfa_enrollment_waits_for_the_forced_password_change(admin_client: TestClient) -> None:
    username = "f202-mfa-forced"
    _admin_creates(admin_client, username, "VIEWER")
    token = _login(admin_client, username, TEMP_PASSWORD).json()["access_token"]

    with TestClient(app) as anon:
        blocked = anon.post(
            "/api/v1/auth/mfa/enroll/start",
            headers=_bearer(token),
            json={"current_password": TEMP_PASSWORD},
        )

    assert blocked.status_code == 403
    assert blocked.json()["detail"]["error_code"] == "PASSWORD_CHANGE_REQUIRED"


def test_non_admin_cannot_create_accounts_or_reset_other_passwords(
    admin_client: TestClient, db_session: Session
) -> None:
    username = "f202-operator-actor"
    _admin_creates(admin_client, username, "OPERATOR")
    token = _login(admin_client, username, TEMP_PASSWORD).json()["access_token"]
    assert _change_password(token, TEMP_PASSWORD, OWN_PASSWORD).status_code == 200
    token = _login(admin_client, username, OWN_PASSWORD).json()["access_token"]
    victim = _admin_creates(admin_client, "f202-victim", "VIEWER")

    with TestClient(app) as anon:
        create = anon.post(
            "/api/v1/admin/users",
            headers=_bearer(token),
            json={"username": "f202-evil", "password": TEMP_PASSWORD, "role": "VIEWER"},
        )
        reset = anon.patch(
            f"/api/v1/admin/users/{victim['id']}", headers=_bearer(token), json={"password": TEMP_PASSWORD}
        )
        other = anon.post(
            "/api/v1/admin/password",
            headers=_bearer(token),
            json={
                "username": "f202-victim",
                "current_password": TEMP_PASSWORD,
                "new_password": OWN_PASSWORD,
                "confirm_password": OWN_PASSWORD,
            },
        )

    assert create.status_code == 403
    assert reset.status_code == 403
    assert other.status_code == 403
