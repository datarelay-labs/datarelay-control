"""F-192: the platform-wide default timezone is writable by Administrators only.

Every role is exercised through the full application with its own bearer token against a real
``platform_users`` row (live-authority check on), so the 403 comes from the role guard and not from a
test shortcut.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.audit.models import AuditLog
from app.auth.jwt_service import issue_access_token
from app.config import settings
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
URL = "/api/v1/admin/display-settings"


@pytest.fixture
def role_headers(db_session: Session, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "REQUIRE_AUTH", True)

    def _override() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override
    headers: dict[str, dict[str, str]] = {}
    for role in ROLES:
        user = PlatformUser(
            username=f"f192-{role.lower()}",
            password_hash="x",
            role=role,
            status="ACTIVE",
            token_version=1,
        )
        db_session.add(user)
        db_session.commit()
        db_session.refresh(user)
        token, _ = issue_access_token(
            username=user.username, user_id=int(user.id), role=role, token_version=1
        )
        headers[role] = {"Authorization": f"Bearer {token}"}
    try:
        yield headers
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _platform_default(client: TestClient, headers: dict[str, str]) -> str:
    resp = client.get(URL, headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()["default_timezone"]


@pytest.mark.parametrize("role", ROLES)
def test_only_administrator_can_write_the_platform_default_timezone(
    role: str, client: TestClient, role_headers: dict[str, dict[str, str]]
) -> None:
    admin = role_headers["ADMINISTRATOR"]
    before = _platform_default(client, admin)
    target = "Asia/Seoul" if before != "Asia/Seoul" else "Europe/Berlin"

    resp = client.put(URL, headers=role_headers[role], json={"default_timezone": target})

    if role == "ADMINISTRATOR":
        assert resp.status_code == 200, resp.text
        assert resp.json()["default_timezone"] == target
        assert _platform_default(client, admin) == target
    else:
        assert resp.status_code == 403, resp.text
        detail = resp.json()["detail"]
        assert detail["error_code"] == "ROLE_FORBIDDEN"
        assert detail["role"] == role
        assert _platform_default(client, admin) == before


@pytest.mark.parametrize("role", [r for r in ROLES if r != "ADMINISTRATOR"])
def test_denied_write_leaves_no_audit_row(
    role: str, client: TestClient, role_headers: dict[str, dict[str, str]], db_session: Session
) -> None:
    resp = client.put(URL, headers=role_headers[role], json={"default_timezone": "Asia/Seoul"})
    assert resp.status_code == 403

    db_session.expire_all()
    assert db_session.query(AuditLog).filter(AuditLog.action == "DISPLAY_SETTINGS_UPDATED").count() == 0


@pytest.mark.parametrize("role", [r for r in ROLES if r != "ADMINISTRATOR"])
def test_denied_even_when_the_body_is_invalid(
    role: str, client: TestClient, role_headers: dict[str, dict[str, str]]
) -> None:
    """Authorization is decided before validation: no information leaks to unauthorized roles."""

    resp = client.put(URL, headers=role_headers[role], json={"default_timezone": "Not/A/Zone"})

    assert resp.status_code == 403
    assert resp.json()["detail"]["error_code"] == "ROLE_FORBIDDEN"


def test_administrator_still_gets_validation_errors(
    client: TestClient, role_headers: dict[str, dict[str, str]]
) -> None:
    resp = client.put(URL, headers=role_headers["ADMINISTRATOR"], json={"default_timezone": "Not/A/Zone"})

    assert resp.status_code == 422


@pytest.mark.parametrize("role", ROLES)
def test_every_role_can_still_read_the_platform_default(
    role: str, client: TestClient, role_headers: dict[str, dict[str, str]]
) -> None:
    assert _platform_default(client, role_headers[role]) == "UTC"


@pytest.mark.parametrize("role", ["OPERATOR", "CONNECTOR_OPERATOR", "ADMINISTRATOR"])
def test_personal_timezone_preference_is_unaffected(
    role: str, client: TestClient, role_headers: dict[str, dict[str, str]]
) -> None:
    resp = client.patch(
        "/api/v1/auth/profile", headers=role_headers[role], json={"timezone": "Asia/Tokyo"}
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["timezone"] == "Asia/Tokyo"
    # The personal override must not have changed the platform-wide default.
    assert _platform_default(client, role_headers["ADMINISTRATOR"]) == "UTC"


def test_handler_refuses_non_admins_even_without_the_role_guard_middleware(
    db_session: Session, role_headers: dict[str, dict[str, str]]
) -> None:
    """Defense in depth: the route carries its own Administrator dependency."""

    from app.platform_admin.router import router

    bare = FastAPI()
    bare.include_router(router, prefix="/api/v1/admin")

    def _override() -> Any:
        yield db_session

    bare.dependency_overrides[get_db] = _override
    bare_client = TestClient(bare)

    denied = bare_client.put(URL, headers=role_headers["OPERATOR"], json={"default_timezone": "Asia/Seoul"})
    allowed = bare_client.put(
        URL, headers=role_headers["ADMINISTRATOR"], json={"default_timezone": "Asia/Seoul"}
    )

    assert denied.status_code == 403
    assert denied.json()["detail"]["error_code"] == "ROLE_FORBIDDEN"
    assert allowed.status_code == 200, allowed.text
