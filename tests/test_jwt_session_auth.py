"""JWT session/auth tests for spec 020.

Covers:
- token issuance + claims roundtrip
- expired token rejection (401 AUTH_TOKEN_EXPIRED)
- tampered token rejection (401 AUTH_TOKEN_INVALID)
- token_version invalidation (logout-all, password change)
- /auth/login -> /auth/refresh -> /auth/logout flow
- REQUIRE_AUTH=True returns 401 on missing/invalid tokens
- X-GDC-Role header is ignored when AUTH_DEV_HEADER_TRUST=False (default)
- legacy header path stays available when AUTH_DEV_HEADER_TRUST=True
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.auth.jwt_service import (
    AuthTokenError,
    TOKEN_TYPE_ACCESS,
    TOKEN_TYPE_REFRESH,
    decode_token,
    issue_access_token,
    issue_refresh_token,
)
from app.auth.role_guard import ROLE_HEADER, USERNAME_HEADER
from app.config import settings
from app.database import get_db
from app.db.seed import seed_default_platform_admin
from app.main import app
from app.platform_admin.models import PlatformUser


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def _seed_user(db: Session, *, username: str, role: str, password_hash: str = "x", token_version: int = 1) -> PlatformUser:
    u = PlatformUser(
        username=username,
        password_hash=password_hash,
        role=role,
        status="ACTIVE",
        token_version=token_version,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _bearer(role: str, *, username: str = "u", user_id: int = 1, token_version: int = 1) -> dict[str, str]:
    token, _ = issue_access_token(username=username, user_id=user_id, role=role, token_version=token_version)
    return {"Authorization": f"Bearer {token}"}


def test_issue_and_decode_access_token_roundtrip() -> None:
    token, exp = issue_access_token(username="alice", user_id=42, role="OPERATOR", token_version=3)
    claims = decode_token(token, expected_type=TOKEN_TYPE_ACCESS)
    assert claims.subject == "alice"
    assert claims.user_id == 42
    assert claims.role == "OPERATOR"
    assert claims.token_version == 3
    assert claims.token_type == TOKEN_TYPE_ACCESS
    assert claims.must_change_password is False
    assert claims.expires_at > datetime.now(timezone.utc)
    assert abs((claims.expires_at - exp).total_seconds()) < 1


def test_issue_and_decode_must_change_password_claim() -> None:
    token, _ = issue_access_token(
        username="bob",
        user_id=2,
        role="ADMINISTRATOR",
        token_version=1,
        must_change_password=True,
    )
    claims = decode_token(token, expected_type=TOKEN_TYPE_ACCESS)
    assert claims.must_change_password is True


def test_decode_rejects_wrong_type() -> None:
    refresh, _ = issue_refresh_token(username="bob", user_id=7, role="VIEWER", token_version=1)
    with pytest.raises(AuthTokenError) as excinfo:
        decode_token(refresh, expected_type=TOKEN_TYPE_ACCESS)
    assert excinfo.value.code == "AUTH_TOKEN_INVALID"


def test_decode_rejects_tampered_signature() -> None:
    token, _ = issue_access_token(username="alice", user_id=1, role="ADMINISTRATOR", token_version=1)
    parts = token.rsplit(".", 1)
    bad = parts[0] + ".tamperedsignature"
    with pytest.raises(AuthTokenError) as excinfo:
        decode_token(bad, expected_type=TOKEN_TYPE_ACCESS)
    assert excinfo.value.code == "AUTH_TOKEN_INVALID"


def test_decode_rejects_expired_token(monkeypatch: pytest.MonkeyPatch) -> None:
    # Force ACCESS_TOKEN_EXPIRE_MINUTES to 1 minute, then time-travel past expiry.
    monkeypatch.setattr(settings, "ACCESS_TOKEN_EXPIRE_MINUTES", 1)
    token, _ = issue_access_token(username="x", user_id=1, role="VIEWER", token_version=1)

    # Re-decode after manually advancing the system clock via a real expiry.
    # Easiest path: forge a token by re-issuing with an iat far in the past.
    # Instead, just sleep is too slow — we craft a token with a past exp via jose.
    from jose import jwt
    from app.auth.jwt_service import _signing_key  # type: ignore[attr-defined]

    expired_payload = {
        "sub": "x",
        "uid": 1,
        "role": "VIEWER",
        "tv": 1,
        "typ": TOKEN_TYPE_ACCESS,
        "iat": int(datetime.now(timezone.utc).timestamp()) - 3600,
        "exp": int(datetime.now(timezone.utc).timestamp()) - 60,
        "iss": settings.JWT_ISSUER,
        "jti": "abc",
    }
    expired = jwt.encode(expired_payload, _signing_key(), algorithm=settings.JWT_ALGORITHM)
    with pytest.raises(AuthTokenError) as excinfo:
        decode_token(expired, expected_type=TOKEN_TYPE_ACCESS)
    assert excinfo.value.code == "AUTH_TOKEN_EXPIRED"


def test_login_returns_token_bundle_and_records_audit(client: TestClient, db_session: Session) -> None:
    try:
        from app.auth.security import get_password_hash

        pw_hash = get_password_hash("test-pw-123")
    except ValueError:
        pytest.skip("local bcrypt backend unavailable in this environment")
        return
    _seed_user(db_session, username="op-1", role="OPERATOR", password_hash=pw_hash)

    r = client.post("/api/v1/auth/login", json={"username": "op-1", "password": "test-pw-123"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["token_type"] == "bearer"
    assert body["expires_in"] > 0
    assert body["user"]["role"] == "OPERATOR"
    # Audit row should be present
    audit = client.get(
        "/api/v1/admin/audit-log?limit=20",
        headers={"Authorization": f"Bearer {body['access_token']}"},
    ).json()
    actions = {item["action"] for item in audit["items"]}
    assert "USER_LOGIN" in actions


def test_fresh_default_bootstrap_admin_admin_login_requires_password_change(
    client: TestClient,
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.delenv("GDC_SEED_ADMIN_PASSWORD", raising=False)
    monkeypatch.setattr(settings, "REQUIRE_AUTH", True)

    seed_default_platform_admin(db_session)

    r = client.post("/api/v1/auth/login", json={"username": "admin", "password": "admin"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["user"]["must_change_password"] is True
    claims = decode_token(body["access_token"], expected_type=TOKEN_TYPE_ACCESS)
    assert claims.must_change_password is True

    blocked = client.get("/api/v1/connectors/", headers={"Authorization": f"Bearer {body['access_token']}"})
    assert blocked.status_code == 403
    assert blocked.json()["detail"]["error_code"] == "PASSWORD_CHANGE_REQUIRED"


def test_login_rejects_bad_password(client: TestClient, db_session: Session) -> None:
    try:
        from app.auth.security import get_password_hash

        pw_hash = get_password_hash("right-pw")
    except ValueError:
        pytest.skip("local bcrypt backend unavailable in this environment")
        return
    _seed_user(db_session, username="user-bad", role="ADMINISTRATOR", password_hash=pw_hash)

    r = client.post("/api/v1/auth/login", json={"username": "user-bad", "password": "wrong"})
    assert r.status_code == 400
    assert r.json()["detail"]["error_code"] == "USER_AUTH_FAILED"


def test_whoami_returns_principal_after_login(client: TestClient, db_session: Session) -> None:
    try:
        from app.auth.security import get_password_hash

        pw_hash = get_password_hash("whoami-pw-1")
    except ValueError:
        pytest.skip("local bcrypt backend unavailable in this environment")
        return
    _seed_user(db_session, username="whoami-user", role="OPERATOR", password_hash=pw_hash)

    login = client.post("/api/v1/auth/login", json={"username": "whoami-user", "password": "whoami-pw-1"})
    assert login.status_code == 200, login.text
    token = login.json()["access_token"]

    r = client.get("/api/v1/auth/whoami", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["authenticated"] is True
    assert body["username"] == "whoami-user"
    assert body["role"] == "OPERATOR"
    assert body["token_expires_at"]


def test_refresh_rejects_after_token_version_bumped_in_database(
    client: TestClient, db_session: Session
) -> None:
    """Mirrors seed/admin password reset: bumping ``token_version`` invalidates refresh JWTs."""

    try:
        from app.auth.security import get_password_hash

        pw_hash = get_password_hash("bump-pw-99")
    except ValueError:
        pytest.skip("local bcrypt backend unavailable in this environment")
        return
    u = _seed_user(db_session, username="bump-tv-user", role="VIEWER", password_hash=pw_hash)
    uid = int(u.id)

    login = client.post("/api/v1/auth/login", json={"username": "bump-tv-user", "password": "bump-pw-99"})
    assert login.status_code == 200
    refresh = login.json()["refresh_token"]

    row = db_session.get(PlatformUser, uid)
    assert row is not None
    row.token_version = int(row.token_version) + 1
    db_session.commit()

    r = client.post("/api/v1/auth/refresh", json={"refresh_token": refresh})
    assert r.status_code == 401
    assert r.json()["detail"]["error_code"] == "AUTH_TOKEN_REVOKED"


def test_refresh_returns_new_access_token(client: TestClient, db_session: Session) -> None:
    try:
        from app.auth.security import get_password_hash

        pw_hash = get_password_hash("pw-xyz")
    except ValueError:
        pytest.skip("local bcrypt backend unavailable in this environment")
        return
    _seed_user(db_session, username="ref-user", role="ADMINISTRATOR", password_hash=pw_hash)

    login = client.post("/api/v1/auth/login", json={"username": "ref-user", "password": "pw-xyz"})
    assert login.status_code == 200
    refresh = login.json()["refresh_token"]

    r = client.post("/api/v1/auth/refresh", json={"refresh_token": refresh})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["access_token"]
    assert body["refresh_token"]
    assert body["user"]["username"] == "ref-user"


def test_refresh_rejects_access_token(client: TestClient) -> None:
    headers = _bearer("VIEWER")
    access_token = headers["Authorization"].split(" ", 1)[1]
    r = client.post("/api/v1/auth/refresh", json={"refresh_token": access_token})
    assert r.status_code == 401
    assert r.json()["detail"]["error_code"] == "AUTH_TOKEN_INVALID"


def test_logout_revoke_all_bumps_token_version(client: TestClient, db_session: Session) -> None:
    user = _seed_user(db_session, username="kill-sessions", role="OPERATOR")
    user_id = int(user.id)
    original_tv = int(user.token_version)
    token, _ = issue_access_token(
        username=user.username, user_id=user_id, role=user.role, token_version=original_tv
    )

    r = client.post(
        "/api/v1/auth/logout",
        headers={"Authorization": f"Bearer {token}"},
        json={"revoke_all": True},
    )
    assert r.status_code == 204
    db_session.expire_all()
    refreshed = db_session.get(PlatformUser, user_id)
    assert refreshed is not None
    assert int(refreshed.token_version) == original_tv + 1

    # The previous access token is signature-valid but its tv claim is stale;
    # whoami rejects it because the live row's tv has advanced.
    w = client.get("/api/v1/auth/whoami", headers={"Authorization": f"Bearer {token}"})
    assert w.status_code == 401
    assert w.json()["detail"]["error_code"] == "AUTH_TOKEN_REVOKED"


def test_stale_access_token_tv_still_passes_non_auth_routes_until_ttl(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """INTENTIONAL_BY_CONTRACT: middleware does not live-check token_version.

    After ``token_version`` bumps, access JWTs remain usable on ordinary APIs
    until TTL; only refresh / whoami / change-password enforce live TV.
    """

    monkeypatch.setattr(settings, "REQUIRE_AUTH", True)
    user = _seed_user(db_session, username="stale-tv-api", role="OPERATOR")
    user_id = int(user.id)
    tv = int(user.token_version)
    token, _ = issue_access_token(
        username=user.username, user_id=user_id, role=user.role, token_version=tv
    )

    row = db_session.get(PlatformUser, user_id)
    assert row is not None
    row.token_version = tv + 1
    db_session.commit()

    # Live TV mismatch → whoami revoked.
    who = client.get("/api/v1/auth/whoami", headers={"Authorization": f"Bearer {token}"})
    assert who.status_code == 401
    assert who.json()["detail"]["error_code"] == "AUTH_TOKEN_REVOKED"

    # Same access token still authorizes a non-auth API (signature + role only).
    api = client.get("/api/v1/connectors/", headers={"Authorization": f"Bearer {token}"})
    assert api.status_code == 200, api.text


def test_logout_without_revoke_all_leaves_token_version_unchanged(
    client: TestClient, db_session: Session
) -> None:
    user = _seed_user(db_session, username="soft-logout", role="VIEWER")
    uid = int(user.id)
    tv_before = int(user.token_version)
    token, _ = issue_access_token(
        username=user.username, user_id=uid, role=user.role, token_version=tv_before
    )

    r = client.post(
        "/api/v1/auth/logout",
        headers={"Authorization": f"Bearer {token}"},
        json={"revoke_all": False},
    )
    assert r.status_code == 204
    db_session.expire_all()
    row = db_session.get(PlatformUser, uid)
    assert row is not None
    assert int(row.token_version) == tv_before


def test_whoami_rejects_invalid_token(client: TestClient) -> None:
    r = client.get("/api/v1/auth/whoami", headers={"Authorization": "Bearer not.a.token"})
    assert r.status_code == 401
    assert r.json()["detail"]["error_code"] in {"AUTH_TOKEN_INVALID", "AUTH_TOKEN_MISSING"}


def test_require_auth_blocks_anonymous(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "REQUIRE_AUTH", True)
    r = client.put(
        "/api/v1/admin/retention-policy",
        json={"logs_retention_days": 30, "logs_enabled": True},
    )
    assert r.status_code == 401
    assert r.json()["detail"]["error_code"] == "AUTH_REQUIRED"


def test_options_preflight_connectors_not_401_when_require_auth(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Browser CORS preflight must reach CORSMiddleware, not 401 from role_guard."""

    monkeypatch.setattr(settings, "REQUIRE_AUTH", True)
    r = client.options(
        "/api/v1/connectors/",
        headers={
            "Origin": "http://datarelay.run:5173",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    assert r.status_code != 401, r.text
    assert r.headers.get("access-control-allow-origin")


def test_get_connectors_requires_auth_when_require_auth(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "REQUIRE_AUTH", True)
    r = client.get("/api/v1/connectors/")
    assert r.status_code == 401
    assert r.json()["detail"]["error_code"] == "AUTH_REQUIRED"


def test_require_auth_allows_jwt(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "REQUIRE_AUTH", True)
    r = client.put(
        "/api/v1/admin/retention-policy",
        headers=_bearer("ADMINISTRATOR"),
        json={"logs_retention_days": 30, "logs_enabled": True},
    )
    assert r.status_code == 200


def test_x_gdc_role_header_trust_off_by_default(client: TestClient) -> None:
    """A client setting X-GDC-Role=VIEWER without a JWT cannot demote itself
    *or* claim a higher role. The header is ignored entirely."""

    r = client.put(
        "/api/v1/admin/retention-policy",
        headers={ROLE_HEADER: "VIEWER", USERNAME_HEADER: "evil"},
        json={"logs_retention_days": 30, "logs_enabled": True},
    )
    # Falls back to anonymous admin (REQUIRE_AUTH=False) -> 200.
    assert r.status_code == 200


def test_x_gdc_role_header_trust_when_enabled(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """The deprecation-only dev escape hatch still works when explicitly enabled."""

    monkeypatch.setattr(settings, "AUTH_DEV_HEADER_TRUST", True)
    r = client.put(
        "/api/v1/admin/retention-policy",
        headers={ROLE_HEADER: "VIEWER"},
        json={"logs_retention_days": 30, "logs_enabled": True},
    )
    assert r.status_code == 403


def test_jwt_decode_missing_token_raises() -> None:
    with pytest.raises(AuthTokenError) as excinfo:
        decode_token("", expected_type=TOKEN_TYPE_ACCESS)
    assert excinfo.value.code == "AUTH_TOKEN_MISSING"


def test_require_auth_blocks_api_when_must_change_password_set(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "REQUIRE_AUTH", True)
    try:
        from app.auth.security import get_password_hash

        pw_hash = get_password_hash("StartPw-9")
    except ValueError:
        pytest.skip("local bcrypt backend unavailable in this environment")
        return
    u = PlatformUser(
        username="must-change-user",
        password_hash=pw_hash,
        role="ADMINISTRATOR",
        status="ACTIVE",
        must_change_password=True,
    )
    db_session.add(u)
    db_session.commit()

    login = client.post("/api/v1/auth/login", json={"username": "must-change-user", "password": "StartPw-9"})
    assert login.status_code == 200, login.text
    assert login.json()["user"]["must_change_password"] is True
    token = login.json()["access_token"]

    blocked = client.get("/api/v1/connectors/", headers={"Authorization": f"Bearer {token}"})
    assert blocked.status_code == 403
    assert blocked.json()["detail"]["error_code"] == "PASSWORD_CHANGE_REQUIRED"


def test_change_password_self_service_then_relogin(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "REQUIRE_AUTH", True)
    try:
        from app.auth.security import get_password_hash

        pw_hash = get_password_hash("admin")
    except ValueError:
        pytest.skip("local bcrypt backend unavailable in this environment")
        return
    u = PlatformUser(
        username="self-pw-user",
        password_hash=pw_hash,
        role="ADMINISTRATOR",
        status="ACTIVE",
        must_change_password=True,
    )
    db_session.add(u)
    db_session.commit()

    login = client.post("/api/v1/auth/login", json={"username": "self-pw-user", "password": "admin"})
    assert login.status_code == 200
    token = login.json()["access_token"]

    bad = client.post(
        "/api/v1/auth/change-password",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "current_password": "admin",
            "new_password": "admin",
            "confirm_new_password": "admin",
        },
    )
    assert bad.status_code == 400
    assert bad.json()["detail"]["error_code"] == "PASSWORD_POLICY_REJECTED"

    ok = client.post(
        "/api/v1/auth/change-password",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "current_password": "admin",
            "new_password": "FreshStrong1!",
            "confirm_new_password": "FreshStrong1!",
        },
    )
    assert ok.status_code == 200, ok.text

    old_refresh = login.json()["refresh_token"]
    stale_refresh = client.post("/api/v1/auth/refresh", json={"refresh_token": old_refresh})
    assert stale_refresh.status_code == 401
    assert stale_refresh.json()["detail"]["error_code"] == "AUTH_TOKEN_REVOKED"

    who = client.get("/api/v1/auth/whoami", headers={"Authorization": f"Bearer {token}"})
    assert who.status_code == 401

    login2 = client.post("/api/v1/auth/login", json={"username": "self-pw-user", "password": "FreshStrong1!"})
    assert login2.status_code == 200
    assert login2.json()["user"]["must_change_password"] is False
