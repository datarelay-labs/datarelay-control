"""Backend tests proving Viewer / Operator role enforcement is JWT-driven.

After spec 020 the role is taken from a signed JWT (``Authorization: Bearer``).
The legacy ``X-GDC-Role`` HTTP header is ignored by the role guard unless
``settings.AUTH_DEV_HEADER_TRUST`` is explicitly enabled.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.auth.jwt_service import issue_access_token
from app.auth.role_guard import ROLE_HEADER, USERNAME_HEADER
from app.database import get_db
from app.main import app


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def _bearer(role: str, *, username: str | None = None, user_id: int = 1, token_version: int = 1) -> dict[str, str]:
    token, _ = issue_access_token(
        username=username or f"{role.lower()}-1",
        user_id=user_id,
        role=role,
        token_version=token_version,
    )
    return {"Authorization": f"Bearer {token}"}


def test_viewer_can_read_admin_endpoints(client: TestClient) -> None:
    headers = _bearer("VIEWER", username="viewer-1")
    for path in (
        "/api/v1/admin/retention-policy",
        "/api/v1/admin/audit-log",
        "/api/v1/admin/alert-settings",
    ):
        r = client.get(path, headers=headers)
        assert r.status_code == 200, (path, r.text)


def test_viewer_cannot_mutate_retention_policy(client: TestClient) -> None:
    r = client.put(
        "/api/v1/admin/retention-policy",
        headers=_bearer("VIEWER"),
        json={"logs_retention_days": 7, "logs_enabled": True},
    )
    assert r.status_code == 403
    detail = r.json()["detail"]
    assert detail["error_code"] == "ROLE_FORBIDDEN"
    assert detail["role"] == "VIEWER"


def test_viewer_cannot_trigger_cleanup_run(client: TestClient) -> None:
    r = client.post(
        "/api/v1/admin/retention-policy/run",
        headers=_bearer("VIEWER"),
        json={"dry_run": True},
    )
    assert r.status_code == 403
    assert r.json()["detail"]["error_code"] == "ROLE_FORBIDDEN"


def test_viewer_cannot_run_stream(client: TestClient) -> None:
    r = client.post("/api/v1/runtime/streams/9999/run-once", headers=_bearer("VIEWER"))
    assert r.status_code == 403
    assert r.json()["detail"]["error_code"] == "ROLE_FORBIDDEN"


def test_viewer_cannot_dispatch_alert_test(client: TestClient) -> None:
    r = client.post("/api/v1/admin/alert-settings/test", headers=_bearer("VIEWER"), json={})
    assert r.status_code == 403
    assert r.json()["detail"]["error_code"] == "ROLE_FORBIDDEN"


def test_viewer_cannot_post_backup(client: TestClient) -> None:
    r = client.post(
        "/api/v1/backup/import/apply",
        headers=_bearer("VIEWER"),
        json={"bundle": {}, "mode": "APPLY"},
    )
    assert r.status_code == 403
    assert r.json()["detail"]["error_code"] == "ROLE_FORBIDDEN"


def test_operator_can_run_stream_but_not_users(client: TestClient) -> None:
    headers = _bearer("OPERATOR")
    r = client.post("/api/v1/runtime/streams/9999/run-once", headers=headers)
    assert r.status_code != 403
    r2 = client.post(
        "/api/v1/admin/users",
        headers=headers,
        json={"username": "blocked-op", "password": "secret-pw", "role": "VIEWER"},
    )
    assert r2.status_code == 403
    assert r2.json()["detail"]["error_code"] == "ROLE_FORBIDDEN"


def test_viewer_user_mutations_fail_authorization_before_payload_validation(client: TestClient) -> None:
    headers = _bearer("VIEWER", username="viewer-users")

    create = client.post("/api/v1/admin/users", headers=headers, json={})
    assert create.status_code == 403
    assert create.json()["detail"]["error_code"] == "ROLE_FORBIDDEN"

    update = client.patch("/api/v1/admin/users/9999", headers=headers, json={})
    assert update.status_code == 403
    assert update.json()["detail"]["error_code"] == "ROLE_FORBIDDEN"

    delete = client.delete("/api/v1/admin/users/9999", headers=headers)
    assert delete.status_code == 403
    assert delete.json()["detail"]["error_code"] == "ROLE_FORBIDDEN"


def test_viewer_cannot_create_administrator(client: TestClient) -> None:
    response = client.post(
        "/api/v1/admin/users",
        headers=_bearer("VIEWER", username="viewer-users-valid"),
        json={"username": "blocked-admin", "password": "valid-pass-12", "role": "ADMINISTRATOR"},
    )
    assert response.status_code == 403
    assert response.json()["detail"]["error_code"] == "ROLE_FORBIDDEN"


def test_operator_cannot_modify_retention_policy(client: TestClient) -> None:
    r = client.put(
        "/api/v1/admin/retention-policy",
        headers=_bearer("OPERATOR"),
        json={"logs_enabled": True},
    )
    assert r.status_code == 403


def test_administrator_can_modify_retention_policy(client: TestClient) -> None:
    r = client.put(
        "/api/v1/admin/retention-policy",
        headers=_bearer("ADMINISTRATOR"),
        json={"logs_retention_days": 30, "logs_enabled": True},
    )
    assert r.status_code == 200


def test_safe_methods_for_any_role(client: TestClient) -> None:
    for role in ("VIEWER", "OPERATOR", "ADMINISTRATOR"):
        r = client.get("/api/v1/admin/audit-log", headers=_bearer(role))
        assert r.status_code == 200


def test_no_header_treated_as_administrator_backward_compat(client: TestClient) -> None:
    """When REQUIRE_AUTH=False and no bearer token is sent, the request is
    treated as ADMINISTRATOR so existing tooling without auth keeps working."""

    r = client.put(
        "/api/v1/admin/retention-policy",
        json={"logs_retention_days": 30, "logs_enabled": True},
    )
    assert r.status_code == 200


def test_x_gdc_role_header_is_ignored_by_default(client: TestClient) -> None:
    """Spec 020: the client-controlled X-GDC-Role header must NOT grant a role
    on its own.  Passing only the header must fall back to the anonymous
    ADMINISTRATOR (or 401 in REQUIRE_AUTH=True) — not VIEWER as before."""

    r = client.put(
        "/api/v1/admin/retention-policy",
        headers={ROLE_HEADER: "VIEWER", USERNAME_HEADER: "alice"},
        json={"logs_retention_days": 30, "logs_enabled": True},
    )
    # Without a bearer token, the X-GDC-Role header is ignored and the request
    # falls back to anonymous admin (REQUIRE_AUTH=False).
    assert r.status_code == 200


def test_whoami_with_bearer_token(client: TestClient, db_session: Session) -> None:
    from app.platform_admin.models import PlatformUser

    user = PlatformUser(
        username="alice",
        password_hash="x",  # not used by /whoami
        role="VIEWER",
        status="ACTIVE",
        token_version=1,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)

    r = client.get(
        "/api/v1/auth/whoami",
        headers=_bearer("VIEWER", username="alice", user_id=int(user.id), token_version=int(user.token_version)),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["role"] == "VIEWER"
    assert body["username"] == "alice"
    assert body["authenticated"] is True
    assert body["token_expires_at"]


def test_login_endpoint_returns_token_bundle(client: TestClient, db_session: Session) -> None:
    from app.platform_admin.models import PlatformUser

    try:
        from app.auth.security import get_password_hash

        pw_hash = get_password_hash("short-pw")
    except ValueError:
        pytest.skip("local bcrypt backend cannot initialize in this environment")
        return

    u = PlatformUser(
        username="viewer-account",
        password_hash=pw_hash,
        role="VIEWER",
        status="ACTIVE",
        token_version=1,
    )
    db_session.add(u)
    db_session.commit()

    r = client.post(
        "/api/v1/auth/login",
        json={"username": "viewer-account", "password": "short-pw"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["token_type"] == "bearer"
    assert body["expires_in"] > 0
    assert body["access_token"]
    assert body["refresh_token"]
    assert body["user"]["role"] == "VIEWER"
    assert body["user"]["username"] == "viewer-account"
