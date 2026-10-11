"""PF-9 Control opt-in MFA native API contract (dedicated pytest catalog only)."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import threading

from fastapi import HTTPException, Request
from fastapi.testclient import TestClient
import pytest
from sqlalchemy.orm import Session
from datarelay_onprem_security import code_at

from app.auth.security import get_password_hash
from app.auth.jwt_service import decode_token
from app.config import settings
from app.database import get_db, SessionLocal
from app.auth.login_throttle import client_ip_from_request, reset_login_throttle_for_tests
from app.main import app
from app.platform_admin.models import PlatformUser, PlatformUserMfa, PlatformMfaChallenge
from app.auth.mfa import _seal, _unseal, verify_password_challenge

MFA_KEY = "c1" * 32
USERNAME = "mfa-demo-1"
PASSWORD = "ExamplePassword9!"


@pytest.fixture
def client(db_session: Session, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "GDC_MFA_ENCRYPTION_KEY_HEX", MFA_KEY)
    reset_login_throttle_for_tests()
    def override():
        yield db_session
    app.dependency_overrides[get_db] = override
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.pop(get_db, None)
    reset_login_throttle_for_tests()


def create_user(db: Session, username: str = USERNAME, role: str = "OPERATOR") -> PlatformUser:
    row = PlatformUser(username=username, password_hash=get_password_hash(PASSWORD),
                       role=role, status="ACTIVE", token_version=1)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def begin_enrollment(client: TestClient, db: Session, username: str = USERNAME) -> tuple[PlatformUser, str, list[str], str]:
    user = create_user(db, username=username)
    login = client.post("/api/v1/auth/login", json={"username":username,"password":PASSWORD})
    assert login.status_code == 200, login.text
    first = login.json()
    assert first["access_token"] and first["refresh_token"]
    auth = {"Authorization": "Bearer " + first["access_token"]}
    r = client.post("/api/v1/auth/mfa/enroll/start", json={"current_password": PASSWORD},
                    headers=auth)
    assert r.status_code == 200, r.text
    payload = r.json()
    assert payload["otpauth_uri"].startswith("otpauth://totp/")
    key = payload["secret"]
    db.expire_all()
    profile = db.get(PlatformUserMfa, user.id)
    assert profile.required is False and profile.secret_ciphertext is None
    assert key not in (profile.pending_secret_ciphertext or "")
    from app.auth.mfa import _now
    otp = code_at(key, _now().timestamp())
    done = client.post("/api/v1/auth/mfa/enroll/confirm", json={"totp":otp}, headers=auth)
    assert done.status_code == 200, done.text
    codes = done.json()["recovery_codes"]
    assert len(codes) == 8 and key not in json.dumps(codes)
    assert done.json()["enabled"] is True
    db.expire_all()
    return user, key, codes, first["access_token"]


def test_mfa_off_login_issues_jwt_without_second_step(client: TestClient, db_session: Session) -> None:
    create_user(db_session)
    r = client.post("/api/v1/auth/login", json={"username":USERNAME,"password":PASSWORD})
    assert r.status_code == 200, r.text
    assert "access_token" in r.json() and "mfa_required" not in r.json()
    assert decode_token(r.json()["access_token"]).mfa_verified is False
    assert db_session.query(PlatformMfaChallenge).count() == 0


def test_enrollment_recovery_never_stores_plaintext_and_revokes_old_jwt(
    client: TestClient, db_session: Session,
) -> None:
    user, secret, codes, old_access = begin_enrollment(client, db_session)
    profile = db_session.get(PlatformUserMfa, user.id)
    assert profile.required is True
    assert profile.secret_ciphertext and secret not in profile.secret_ciphertext
    assert profile.pending_secret_ciphertext is None
    assert profile.last_counter >= 0
    assert all(v not in json.dumps(profile.recovery_hashes_json) for v in codes)
    changed = db_session.get(PlatformUser, user.id)
    assert changed.token_version > decode_token(old_access).token_version
    revoked = client.get("/api/v1/auth/whoami", headers={"Authorization":"Bearer " + old_access})
    assert revoked.status_code == 401, revoked.text
    assert revoked.json()["detail"]["error_code"] == "AUTH_TOKEN_REVOKED"


def test_password_then_recovery_issues_no_jwt_before_factor_and_replay_is_denied(
    client: TestClient, db_session: Session,
) -> None:
    user, _, codes, _ = begin_enrollment(client, db_session)
    password = client.post("/api/v1/auth/login", json={"username":USERNAME,"password":PASSWORD})
    assert password.status_code == 200, password.text
    challenge = password.json()
    assert challenge["mfa_required"] is True
    assert "access_token" not in challenge and "refresh_token" not in challenge
    assert "user" not in challenge
    assert "set-cookie" not in {k.lower() for k in password.headers}
    pending = db_session.query(PlatformMfaChallenge).one()
    assert challenge["challenge_token"] not in pending.token_hash
    assert pending.user_id == user.id
    complete = client.post("/api/v1/auth/mfa/verify", json={
        "challenge_token":challenge["challenge_token"], "recovery_code":codes[0],
    })
    assert complete.status_code == 200, complete.text
    assert decode_token(complete.json()["access_token"]).mfa_verified is True
    assert decode_token(complete.json()["refresh_token"]).mfa_verified is True
    again = client.post("/api/v1/auth/mfa/verify",json={
        "challenge_token":challenge["challenge_token"], "recovery_code":codes[0],
    })
    assert again.status_code == 401
    new = client.post("/api/v1/auth/login",json={"username":USERNAME,"password":PASSWORD}).json()
    consumed = client.post("/api/v1/auth/mfa/verify", json={
        "challenge_token":new["challenge_token"], "recovery_code":codes[0],
    })
    assert consumed.status_code == 401


def test_invalid_factor_consumes_challenge_and_preserves_rate_limiter(
    client: TestClient, db_session: Session,
) -> None:
    begin_enrollment(client, db_session)
    pwd = client.post("/api/v1/auth/login", json={"username":USERNAME,"password":PASSWORD})
    assert pwd.status_code == 200
    attempt = client.post("/api/v1/auth/mfa/verify",json={
        "challenge_token":pwd.json()["challenge_token"],"totp":"000000",
    })
    assert attempt.status_code == 401
    assert db_session.query(PlatformMfaChallenge).count() == 0
    retried = client.post("/api/v1/auth/mfa/verify",json={
        "challenge_token":pwd.json()["challenge_token"],"totp":"000000",
    })
    assert retried.status_code == 401


def test_stale_role_or_ip_spoof_cannot_mint_jwt(client: TestClient, db_session: Session) -> None:
    user, _, codes, _ = begin_enrollment(client, db_session)
    first = client.post("/api/v1/auth/login", json={"username":USERNAME,"password":PASSWORD},
                        headers={"x-forwarded-for":"198.51.100.1"})
    assert first.status_code == 200
    db_session.query(PlatformUser).filter(PlatformUser.id == user.id).update({
        "role":"VIEWER", "token_version":PlatformUser.token_version + 1,
    })
    db_session.commit()
    result = client.post("/api/v1/auth/mfa/verify",json={
        "challenge_token":first.json()["challenge_token"],"recovery_code":codes[0],
    },headers={"x-forwarded-for":"198.51.100.2"})
    assert result.status_code == 401, result.text
    assert "access_token" not in result.text


def test_mfa_key_lost_does_not_fallback_to_password_only(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch,
) -> None:
    begin_enrollment(client, db_session)
    monkeypatch.setattr(settings, "GDC_MFA_ENCRYPTION_KEY_HEX", "")
    password = client.post("/api/v1/auth/login",json={"username":USERNAME,"password":PASSWORD})
    assert password.status_code == 503, password.text
    assert "access_token" not in password.text and "refresh_token" not in password.text


def test_aead_user_binding_and_missing_key_fail_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "GDC_MFA_ENCRYPTION_KEY_HEX", MFA_KEY)
    value = _seal(33, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")
    assert "GEZDG" not in value
    assert _unseal(33, value) == "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
    with pytest.raises(Exception):
        _unseal(34, value)
    monkeypatch.setattr(settings, "GDC_MFA_ENCRYPTION_KEY_HEX", "")
    with pytest.raises(Exception):
        _seal(33, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")


def _request_from(ip: str, agent: str = "testclient") -> Request:
    """A controlled direct ASGI peer, not a user-supplied forwarding header."""
    return Request({
        "type": "http", "method": "POST", "scheme": "http",
        "path": "/api/v1/auth/mfa/verify", "root_path": "",
        "headers": [(b"user-agent", agent.encode())],
        "client": (ip, 12345), "server": ("testserver", 80),
        "query_string": b"",
    })


def test_login_throttle_ignores_spoofed_x_forwarded_for(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.auth import login_throttle
    fake_request = Request({
        "type": "http", "headers": [(b"x-forwarded-for", b"198.51.100.200")],
        "client": ("203.0.113.20", 51200), "server": ("testserver", 80),
    })
    assert client_ip_from_request(fake_request) == "203.0.113.20"
    assert client_ip_from_request(None) == "unknown"
    monkeypatch.setattr(login_throttle, "_DEFAULT", login_throttle.LoginThrottleConfig(
        max_failures_per_username=8, max_failures_per_ip=3,
    ))
    for i in range(3):
        result = client.post("/api/v1/auth/login", json={
            "username": "nonexistent-" + str(i), "password": "invalid",
        }, headers={"x-forwarded-for": "198.51.100." + str(i)})
        assert result.status_code == 400, result.text
    denied = client.post("/api/v1/auth/login", json={
        "username": "nonexistent-4", "password": "invalid",
    }, headers={"x-forwarded-for": "192.0.2.99"})
    assert denied.status_code == 429, denied.text
    assert denied.json()["detail"]["error_code"] == "LOGIN_RATE_LIMITED"


def test_expired_or_source_changed_challenge_fails_closed(
    client: TestClient, db_session: Session,
) -> None:
    _, secret, codes, _ = begin_enrollment(client, db_session)
    first = client.post("/api/v1/auth/login", json={
        "username": USERNAME, "password": PASSWORD,
    }).json()
    with pytest.raises(HTTPException) as changed:
        verify_password_challenge(
            db_session, first["challenge_token"], "", codes[0],
            _request_from("198.51.100.99"),
        )
    assert changed.value.status_code == 401
    assert db_session.query(PlatformMfaChallenge).count() == 0
    # A failed source binding does not consume a valid recovery code.
    assert len(db_session.get(PlatformUserMfa, 1).recovery_hashes_json) == 8

    second = client.post("/api/v1/auth/login", json={
        "username": USERNAME, "password": PASSWORD,
    }).json()
    challenge = db_session.query(PlatformMfaChallenge).one()
    challenge.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    db_session.commit()
    expired = client.post("/api/v1/auth/mfa/verify", json={
        "challenge_token": second["challenge_token"], "recovery_code": codes[0],
    })
    assert expired.status_code == 401
    assert db_session.query(PlatformMfaChallenge).count() == 0
    assert len(db_session.get(PlatformUserMfa, 1).recovery_hashes_json) == 8
    assert secret  # Enrollment secret only used by the registered authenticator.


def test_old_refresh_and_protected_access_are_revoked_on_enablement(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch,
) -> None:
    user, _, _, old_access = begin_enrollment(client, db_session)
    # Request a token from the first login epoch to show refresh revocation.
    from app.auth.jwt_service import issue_refresh_token
    old_refresh, _ = issue_refresh_token(
        username=user.username, user_id=user.id, role=user.role,
        token_version=1,
    )
    refused = client.post("/api/v1/auth/refresh", json={"refresh_token": old_refresh})
    assert refused.status_code == 401
    assert refused.json()["detail"]["error_code"] == "AUTH_TOKEN_REVOKED"
    refused = client.get("/api/v1/auth/mfa/status", headers={
        "Authorization": "Bearer " + old_access,
    })
    assert refused.status_code == 401
    # Live JWT/role check must stay active on other guarded product routes.
    monkeypatch.setattr(settings, "REQUIRE_AUTH", True)
    refused = client.get("/api/v1/admin/users", headers={
        "Authorization": "Bearer " + old_access,
    })
    assert refused.status_code == 401


def test_totp_counter_one_time_even_across_distinct_login_challenges(
    client: TestClient, db_session: Session,
) -> None:
    user, secret, _, _ = begin_enrollment(client, db_session)
    mfa = db_session.get(PlatformUserMfa, user.id)
    enrolled_counter = int(mfa.last_counter)
    consumed_code = code_at(secret, enrolled_counter * 30)
    first = client.post("/api/v1/auth/login", json={
        "username": USERNAME, "password": PASSWORD,
    }).json()
    # Force the authenticator's already-consumed enrollment counter to be in
    # its acceptance window, not dependent on a 30-second wall-clock edge.
    with pytest.raises(HTTPException) as replay:
        verify_password_challenge(
            db_session, first["challenge_token"], consumed_code, "",
            _request_from("testclient"),
            current=datetime.fromtimestamp(enrolled_counter * 30, timezone.utc),
        )
    assert replay.value.status_code == 401

    # Move the synthetic factor clock at least one full counter forward.
    # Challenge remains within its 180-second lifetime.
    future_time = datetime.fromtimestamp((enrolled_counter + 2) * 30, timezone.utc)
    future_code = code_at(secret, future_time.timestamp())
    second = client.post("/api/v1/auth/login", json={
        "username": USERNAME, "password": PASSWORD,
    }).json()
    result = verify_password_challenge(
        db_session, second["challenge_token"], future_code, "",
        _request_from("testclient"), current=future_time,
    )
    assert result.id == user.id
    third = client.post("/api/v1/auth/login", json={
        "username": USERNAME, "password": PASSWORD,
    }).json()
    with pytest.raises(HTTPException) as reused:
        verify_password_challenge(
            db_session, third["challenge_token"], future_code, "",
            _request_from("testclient"), current=future_time,
        )
    assert reused.value.status_code == 401


def test_concurrent_recovery_verification_has_only_one_winner(
    client: TestClient, db_session: Session,
) -> None:
    _, _, codes, _ = begin_enrollment(client, db_session)
    challenge = client.post("/api/v1/auth/login", json={
        "username": USERNAME, "password": PASSWORD,
    }).json()
    db_session.commit()  # Do not hold the fixture transaction across workers.
    barrier = threading.Barrier(2)

    def run() -> int:
        with SessionLocal() as session:
            barrier.wait(timeout=10)
            try:
                verify_password_challenge(
                    session, challenge["challenge_token"], "", codes[0],
                    _request_from("testclient"),
                )
                return 200
            except HTTPException as exc:
                return exc.status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: run(), range(2)))
    assert sorted(results) == [200, 401], results
    db_session.expire_all()
    assert db_session.query(PlatformMfaChallenge).count() == 0
    assert len(db_session.get(PlatformUserMfa, 1).recovery_hashes_json) == 7


def test_mfa_failures_share_password_login_lockout(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.auth import login_throttle
    monkeypatch.setattr(login_throttle, "_DEFAULT", login_throttle.LoginThrottleConfig(
        max_failures_per_username=3, max_failures_per_ip=40,
    ))
    begin_enrollment(client, db_session)
    for i in range(3):
        password = client.post("/api/v1/auth/login", json={
            "username": USERNAME, "password": PASSWORD,
        })
        assert password.status_code == 200
        rejected = client.post("/api/v1/auth/mfa/verify", json={
            "challenge_token": password.json()["challenge_token"],
            "totp": "00000" + str(i),
        })
        assert rejected.status_code == 401
    limited = client.post("/api/v1/auth/login", json={
        "username": USERNAME, "password": PASSWORD,
    })
    assert limited.status_code == 429
    assert limited.json()["detail"]["error_code"] == "LOGIN_RATE_LIMITED"


def test_mfa_lockout_is_db_persistent_after_soft_throttle_reset(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.auth import login_throttle
    monkeypatch.setattr(login_throttle, "_DEFAULT", login_throttle.LoginThrottleConfig(
        max_failures_per_username=100, max_failures_per_ip=100,
    ))
    user, secret, _, _ = begin_enrollment(client, db_session)
    for _ in range(8):
        password = client.post("/api/v1/auth/login", json={
            "username": USERNAME, "password": PASSWORD,
        })
        assert password.status_code == 200
        rejected = client.post("/api/v1/auth/mfa/verify", json={
            "challenge_token": password.json()["challenge_token"],
            "totp": "invalid",
        })
        assert rejected.status_code == 401
    db_session.expire_all()
    profile = db_session.get(PlatformUserMfa, user.id)
    assert profile.failed_attempts == 8
    assert profile.locked_until > datetime.now(timezone.utc)
    # Simulate another API worker/restart with an empty process-local throttle.
    reset_login_throttle_for_tests()
    fresh = client.post("/api/v1/auth/login", json={
        "username": USERNAME, "password": PASSWORD,
    }).json()
    real_code = code_at(secret, datetime.now(timezone.utc).timestamp())
    refused = client.post("/api/v1/auth/mfa/verify", json={
        "challenge_token": fresh["challenge_token"], "totp": real_code,
    })
    assert refused.status_code == 429, refused.text
    assert refused.json()["detail"]["error_code"] == "MFA_RATE_LIMITED"
    assert "access_token" not in refused.text


def test_refresh_token_replay_race_mints_one_bundle(
    client: TestClient, db_session: Session,
) -> None:
    create_user(db_session)
    token = client.post("/api/v1/auth/login", json={
        "username": USERNAME, "password": PASSWORD,
    }).json()["refresh_token"]
    db_session.commit()
    barrier = threading.Barrier(2)
    from app.auth.router import refresh, RefreshRequest

    def run() -> int:
        with SessionLocal() as session:
            barrier.wait(timeout=10)
            try:
                bundle = refresh(RefreshRequest(refresh_token=token), db=session)
                assert bundle.access_token
                return 200
            except HTTPException as exc:
                return exc.status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: run(), range(2)))
    assert sorted(results) == [200, 401], results


def test_mfa_migration_0067_downgrade_upgrade_on_guarded_pytest_db_only(
    db_session: Session, db_engine, test_db_url: str, project_root,
) -> None:
    """Run real reversible DDL exclusively in the policy-protected pytest catalog."""
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import inspect, text
    from tests.db_test_policy import catalog_name_from_database_url, validate_host_pytest_catalog

    validate_host_pytest_catalog(catalog_name_from_database_url(test_db_url))
    db_session.commit()
    cfg = Config(str(project_root / "alembic.ini"))
    cfg.set_main_option("script_location", str(project_root / "alembic"))
    cfg.set_main_option("sqlalchemy.url", test_db_url)

    def columns() -> set[str]:
        with db_engine.connect() as conn:
            return {col["name"] for col in inspect(conn).get_columns("platform_user_mfa")}

    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar() == "20261009_0067_mfa_lockout"
    assert {"failed_attempts", "failure_window_started_at", "locked_until"} <= columns()
    try:
        command.downgrade(cfg, "20261009_0066_platform_mfa")
        assert "failed_attempts" not in columns()
        assert "secret_ciphertext" in columns()
    finally:
        command.upgrade(cfg, "head")
    assert {"failed_attempts", "failure_window_started_at", "locked_until"} <= columns()
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar() == "20261009_0067_mfa_lockout"


@pytest.mark.parametrize("role", ["VIEWER", "CONNECTOR_OPERATOR", "GOVERNANCE_REVIEWER"])
def test_read_only_members_can_enroll_only_own_mfa(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch, role: str,
) -> None:
    """MFA self-enrollment is not a platform-admin mutation privilege."""
    monkeypatch.setattr(settings, "REQUIRE_AUTH", True)
    user = create_user(db_session, role=role)
    signed_in = client.post("/api/v1/auth/login", json={
        "username": user.username, "password": PASSWORD,
    })
    assert signed_in.status_code == 200, signed_in.text
    auth = {"Authorization": "Bearer " + signed_in.json()["access_token"]}
    status = client.get("/api/v1/auth/mfa/status", headers=auth)
    assert status.status_code == 200 and status.json()["enabled"] is False

    # Ordinary privileged administrator mutations remain disallowed.
    if role == "VIEWER":
        denied = client.post("/api/v1/admin/users", headers=auth, json={})
        assert denied.status_code == 403

    started = client.post("/api/v1/auth/mfa/enroll/start", headers=auth, json={
        "current_password": PASSWORD,
    })
    assert started.status_code == 200, started.text
    otp = code_at(started.json()["secret"], datetime.now(timezone.utc).timestamp())
    confirmed = client.post("/api/v1/auth/mfa/enroll/confirm", headers=auth, json={"totp": otp})
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["enabled"] is True
    assert len(confirmed.json()["recovery_codes"]) == 8

    # Newly enrolled account's original JWT is revoked for all roles.
    revoked = client.get("/api/v1/auth/mfa/status", headers=auth)
    assert revoked.status_code == 401


def test_mfa_challenge_creation_is_bounded_per_account_and_cleans_expired_proofs(
    client: TestClient, db_session: Session,
) -> None:
    user, _, codes, _ = begin_enrollment(client, db_session)
    created = []
    for _ in range(5):
        result = client.post("/api/v1/auth/login", json={
            "username": USERNAME, "password": PASSWORD,
        })
        assert result.status_code == 200
        created.append(result.json()["challenge_token"])
        assert "access_token" not in result.text

    blocked = client.post("/api/v1/auth/login", json={
        "username": USERNAME, "password": PASSWORD,
    })
    assert blocked.status_code == 429
    assert blocked.json()["detail"]["error_code"] == "MFA_CHALLENGE_LIMIT"
    assert blocked.headers.get("retry-after")
    assert db_session.query(PlatformMfaChallenge).filter_by(user_id=user.id).count() == 5

    # Valid completion frees one slot without resetting other pending proofs.
    verified = client.post("/api/v1/auth/mfa/verify", json={
        "challenge_token": created[0], "recovery_code": codes[0],
    })
    assert verified.status_code == 200
    allowed = client.post("/api/v1/auth/login", json={
        "username": USERNAME, "password": PASSWORD,
    })
    assert allowed.status_code == 200
    db_session.query(PlatformMfaChallenge).filter(
        PlatformMfaChallenge.user_id == user.id,
    ).update({"expires_at": datetime.now(timezone.utc) - timedelta(seconds=5)})
    db_session.commit()
    expired_replaced = client.post("/api/v1/auth/login", json={
        "username": USERNAME, "password": PASSWORD,
    })
    assert expired_replaced.status_code == 200
    assert db_session.query(PlatformMfaChallenge).filter_by(user_id=user.id).count() == 1


def test_mfa_enrollment_password_guesses_share_login_throttle(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.auth import login_throttle
    monkeypatch.setattr(login_throttle, "_DEFAULT", login_throttle.LoginThrottleConfig(
        max_failures_per_username=3, max_failures_per_ip=30,
    ))
    user = create_user(db_session)
    first = client.post("/api/v1/auth/login", json={
        "username": user.username, "password": PASSWORD,
    })
    auth = {"Authorization": "Bearer " + first.json()["access_token"]}
    for i in range(3):
        invalid = client.post("/api/v1/auth/mfa/enroll/start", headers=auth, json={
            "current_password": "guessed-password-" + str(i),
        })
        assert invalid.status_code == 400
        assert "secret" not in invalid.text
    blocked = client.post("/api/v1/auth/mfa/enroll/start", headers=auth, json={
        "current_password": PASSWORD,
    })
    assert blocked.status_code == 429
    assert blocked.json()["detail"]["error_code"] == "LOGIN_RATE_LIMITED"
    assert db_session.query(PlatformUserMfa).filter_by(user_id=user.id).count() == 0


def test_enrollment_totp_guessing_locks_out_across_restart_and_restart_setup(
    client: TestClient, db_session: Session,
) -> None:
    user = create_user(db_session)
    first = client.post("/api/v1/auth/login", json={
        "username": user.username, "password": PASSWORD,
    })
    auth = {"Authorization": "Bearer " + first.json()["access_token"]}
    started = client.post("/api/v1/auth/mfa/enroll/start", headers=auth, json={
        "current_password": PASSWORD,
    })
    assert started.status_code == 200
    for _ in range(8):
        invalid = client.post("/api/v1/auth/mfa/enroll/confirm", headers=auth, json={
            "totp": "aaaaaa",
        })
        assert invalid.status_code == 400, invalid.text
    db_session.expire_all()
    row = db_session.get(PlatformUserMfa, user.id)
    assert row.failed_attempts == 8
    assert row.locked_until > datetime.now(timezone.utc)
    reset_login_throttle_for_tests()
    correct = code_at(started.json()["secret"], datetime.now(timezone.utc).timestamp())
    refused = client.post("/api/v1/auth/mfa/enroll/confirm", headers=auth, json={
        "totp": correct,
    })
    assert refused.status_code == 429
    assert refused.json()["detail"]["error_code"] == "MFA_RATE_LIMITED"
    restart = client.post("/api/v1/auth/mfa/enroll/start", headers=auth, json={
        "current_password": PASSWORD,
    })
    assert restart.status_code == 429
    assert db_session.get(PlatformUserMfa, user.id).required is False


def test_concurrent_password_verified_challenges_share_account_cap(
    client: TestClient, db_session: Session,
) -> None:
    from app.auth.mfa import begin_password_challenge
    user, _, _, _ = begin_enrollment(client, db_session)
    user_id = int(user.id)
    db_session.commit()
    barrier = threading.Barrier(6)

    def start_proof(_: int) -> int:
        # Release all workers before they acquire DB connections; the guarded
        # test engine has a bounded connection pool, not six idle slots.
        barrier.wait(timeout=20)
        with SessionLocal() as db:
            account = db.get(PlatformUser, user_id)
            assert account is not None
            try:
                result = begin_password_challenge(db, account, _request_from("testclient"))
                assert result["mfa_required"] is True
                return 200
            except HTTPException as exc:
                return exc.status_code

    with ThreadPoolExecutor(max_workers=6) as pool:
        codes = list(pool.map(start_proof, range(6)))
    assert sorted(codes) == [200, 200, 200, 200, 200, 429], codes
    db_session.expire_all()
    assert db_session.query(PlatformMfaChallenge).filter_by(user_id=user_id).count() == 5


def test_enrollment_confirmation_locks_live_user_epoch_before_mutation(
    db_session: Session, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A refresh transaction cannot race enrollment into reusing a JWT epoch."""
    from app.auth import router as auth_router
    from app.auth.jwt_service import issue_access_token

    user = create_user(db_session)
    user_id = int(user.id)
    access, _ = issue_access_token(
        username=user.username, user_id=user_id,
        role=user.role, token_version=1,
    )
    request = Request({
        "type": "http", "method": "POST", "path": "/api/v1/auth/mfa/enroll/confirm",
        "headers": [(b"authorization", ("Bearer " + access).encode())],
        "client": ("testclient", 12345), "server": ("testserver", 80),
    })

    actor_entered = threading.Event()
    confirm_called = threading.Event()
    original_resolve = auth_router.resolve_auth_context

    def signal_before_user_lookup(req: Request):
        actor_entered.set()
        return original_resolve(req)

    def fake_confirm(db, account, code):
        confirm_called.set()
        return ("test-recovery-code",)

    monkeypatch.setattr(auth_router, "resolve_auth_context", signal_before_user_lookup)
    monkeypatch.setattr(auth_router, "confirm_enrollment", fake_confirm)

    with SessionLocal() as other_session:
        locked = other_session.query(PlatformUser).filter(
            PlatformUser.id == user_id,
        ).with_for_update().one()
        locked.token_version = 2
        other_session.flush()  # Uncommitted refresh epoch while holding the row lock.

        def confirm_using_old_jwt() -> int:
            with SessionLocal() as session:
                try:
                    auth_router.mfa_enroll_confirm(
                        auth_router.MfaEnrollConfirmRequest(totp="123456"),
                        request, db=session,
                    )
                    return 200
                except HTTPException as exc:
                    return exc.status_code

        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(confirm_using_old_jwt)
            assert actor_entered.wait(timeout=5)
            try:
                # Under the old non-locking actor this callback ran while
                # refresh still held a newer, uncommitted token epoch.
                assert not confirm_called.wait(timeout=1), "stale JWT bypassed user row lock"
            finally:
                other_session.commit()
            assert future.result(timeout=10) == 401
    assert not confirm_called.is_set()


def test_expired_challenge_cleanup_skips_inflight_verification_lock(
    client: TestClient, db_session: Session,
) -> None:
    """Pruning cannot block/deadlock when OTP verification owns a challenge."""
    from sqlalchemy import text
    from app.auth.mfa import begin_password_challenge

    user, _, _, _ = begin_enrollment(client, db_session)
    user_id = int(user.id)
    previous = client.post("/api/v1/auth/login", json={
        "username": USERNAME, "password": PASSWORD,
    })
    assert previous.status_code == 200, previous.text
    stale = db_session.query(PlatformMfaChallenge).one()
    stale_hash = str(stale.token_hash)
    stale.expires_at = datetime.now(timezone.utc) - timedelta(seconds=2)
    db_session.commit()

    with SessionLocal() as verifying:
        held = verifying.query(PlatformMfaChallenge).filter_by(
            token_hash=stale_hash,
        ).with_for_update().one()
        assert held.token_hash == stale_hash

        with SessionLocal() as login:
            login.execute(text("SET LOCAL lock_timeout = '1000ms'"))
            account = login.get(PlatformUser, user_id)
            assert account is not None
            proof = begin_password_challenge(login, account, _request_from("testclient"))
            assert proof["mfa_required"] is True

        # The other transaction still owns this expired proof, so skip it,
        # rather than waiting for and deadlocking against its row lock.
        verifying.rollback()

    with SessionLocal() as next_login:
        account = next_login.get(PlatformUser, user_id)
        assert account is not None
        begin_password_challenge(next_login, account, _request_from("testclient"))
    db_session.expire_all()
    assert db_session.query(PlatformMfaChallenge).filter_by(token_hash=stale_hash).count() == 0


@pytest.mark.parametrize("invalid_role", ["UNRECOGNIZED_ROLE", "admin", ""])
def test_unknown_stored_role_never_issues_password_or_refresh_jwt(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch,
    invalid_role: str,
) -> None:
    """An invalid stored identity role is never silently upgraded to admin."""
    from app.auth.token_bundle import build_token_bundle
    monkeypatch.setattr(settings, "REQUIRE_AUTH", True)
    user = create_user(db_session, role=invalid_role)
    username = str(user.username)
    user_id = int(user.id)

    first = client.post("/api/v1/auth/login", json={
        "username": username, "password": PASSWORD,
    })
    assert first.status_code in (400, 401, 403), first.text
    assert "access_token" not in first.text
    assert "refresh_token" not in first.text
    assert "challenge_token" not in first.text

    # A still-valid signed Viewer token must not resurrect an account whose
    # database role is outside the known persistent role vocabulary.
    signed = build_token_bundle(
        user_id=user_id, username=username,
        role="VIEWER", token_version=1,
        user_status="ACTIVE",
    )
    denied = client.get("/api/v1/auth/whoami", headers={
        "Authorization": "Bearer " + signed.access_token,
    })
    assert denied.status_code == 401, denied.text
    assert denied.json()["detail"]["error_code"] == "AUTH_TOKEN_REVOKED"

    rotated = client.post("/api/v1/auth/refresh", json={
        "refresh_token": signed.refresh_token,
    })
    assert rotated.status_code in (400, 401, 403), rotated.text
    assert "access_token" not in rotated.text
    assert "refresh_token" not in rotated.text


def test_revoked_access_token_cannot_revoke_new_sessions_twice(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Revoked bearer tokens are not allowed to mutate any live login epoch."""
    monkeypatch.setattr(settings, "REQUIRE_AUTH", True)
    user = create_user(db_session)
    user_id = int(user.id)
    first = client.post("/api/v1/auth/login", json={
        "username": USERNAME, "password": PASSWORD,
    })
    assert first.status_code == 200, first.text
    stale = {"Authorization": "Bearer " + first.json()["access_token"]}
    first_logout = client.post("/api/v1/auth/logout", headers=stale, json={
        "revoke_all": True,
    })
    assert first_logout.status_code == 204, first_logout.text
    db_session.expire_all()
    initial_revocation_epoch = db_session.get(PlatformUser, user_id).token_version
    assert initial_revocation_epoch == 2

    next_session = client.post("/api/v1/auth/login", json={
        "username": USERNAME, "password": PASSWORD,
    })
    assert next_session.status_code == 200
    live_access = next_session.json()["access_token"]
    # An old JWT can still have a valid signature and unexpired iat/exp,
    # but it must not force-log-out newly established sessions.
    for _ in range(2):
        expired_logout = client.post("/api/v1/auth/logout", headers=stale, json={
            "revoke_all": True,
        })
        assert expired_logout.status_code == 204, expired_logout.text
    db_session.expire_all()
    assert db_session.get(PlatformUser, user_id).token_version == initial_revocation_epoch
    still_current = client.get("/api/v1/auth/whoami", headers={
        "Authorization": "Bearer " + live_access,
    })
    assert still_current.status_code == 200, still_current.text


def test_parallel_revoke_all_calls_advance_epoch_only_once(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two API workers must not use one valid access JWT to revoke twice."""
    from app.auth.router import LogoutRequest, logout

    monkeypatch.setattr(settings, "REQUIRE_AUTH", True)
    user = create_user(db_session)
    user_id = int(user.id)
    login = client.post("/api/v1/auth/login", json={
        "username": USERNAME, "password": PASSWORD,
    })
    assert login.status_code == 200, login.text
    jwt = login.json()["access_token"]
    db_session.commit()
    barrier = threading.Barrier(2)

    def revoke(_: int) -> None:
        # Do not share a SQLAlchemy Session or Request among threads.
        barrier.wait(timeout=10)
        req = Request({
            "type": "http", "method": "POST", "path": "/api/v1/auth/logout",
            "headers": [(b"authorization", ("Bearer " + jwt).encode())],
            "client": ("testclient", 12345), "server": ("testserver", 80),
        })
        with SessionLocal() as session:
            result = logout(req, LogoutRequest(revoke_all=True), db=session)
            assert result is None

    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(revoke, (1, 2)))
    db_session.expire_all()
    assert db_session.get(PlatformUser, user_id).token_version == 2


def test_admin_mfa_reset_requires_reauthentication_and_invalidates_target_tokens(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Only the authenticated Administrator can recover an enrolled user."""
    from app.platform_admin.models import PlatformAuditEvent

    monkeypatch.setattr(settings, "REQUIRE_AUTH", True)
    admin = create_user(db_session, username="mfa-admin-reset", role="ADMINISTRATOR")
    target = create_user(db_session, username="mfa-target-reset", role="VIEWER")
    target_id, admin_id = int(target.id), int(admin.id)
    db_session.add(PlatformUserMfa(
        user_id=target_id, required=True,
        secret_ciphertext=_seal(target_id, "JBSWY3DPEHPK3PXP"),
        recovery_hashes_json=["not-a-real-code"],
    ))
    db_session.commit()

    signed_admin = client.post("/api/v1/auth/login", json={
        "username": admin.username, "password": PASSWORD,
    })
    assert signed_admin.status_code == 200, signed_admin.text
    auth_admin = {"Authorization": "Bearer " + signed_admin.json()["access_token"]}
    listed = client.get("/api/v1/admin/users", headers=auth_admin)
    assert listed.status_code == 200, listed.text
    summaries = {u["username"]: u for u in listed.json()}
    assert summaries["mfa-target-reset"]["mfa_enabled"] is True
    assert summaries["mfa-admin-reset"]["mfa_enabled"] is False

    target_login = client.post("/api/v1/auth/login", json={
        "username": target.username, "password": PASSWORD,
    })
    assert target_login.status_code == 200
    assert target_login.json()["mfa_required"] is True
    challenge = target_login.json()["challenge_token"]

    unsigned = client.post(f"/api/v1/admin/users/{target_id}/mfa/reset", json={
        "confirm_username": target.username, "current_password": PASSWORD,
    })
    assert unsigned.status_code == 401
    wrong_confirm = client.post(f"/api/v1/admin/users/{target_id}/mfa/reset", headers=auth_admin, json={
        "confirm_username": "wrong-target", "current_password": PASSWORD,
    })
    assert wrong_confirm.status_code == 400
    wrong_password = client.post(f"/api/v1/admin/users/{target_id}/mfa/reset", headers=auth_admin, json={
        "confirm_username": target.username, "current_password": "incorrect-password",
    })
    assert wrong_password.status_code == 400
    db_session.expire_all()
    assert db_session.get(PlatformUserMfa, target_id).required is True

    other = create_user(db_session, username="mfa-not-admin", role="OPERATOR")
    other_login = client.post("/api/v1/auth/login", json={
        "username": other.username, "password": PASSWORD,
    })
    assert other_login.status_code == 200
    not_admin = client.post(f"/api/v1/admin/users/{target_id}/mfa/reset", headers={
        "Authorization": "Bearer " + other_login.json()["access_token"],
    }, json={"confirm_username": target.username, "current_password": PASSWORD})
    assert not_admin.status_code == 403

    reset = client.post(f"/api/v1/admin/users/{target_id}/mfa/reset", headers=auth_admin, json={
        "confirm_username": target.username, "current_password": PASSWORD,
    })
    assert reset.status_code == 204, reset.text
    db_session.expire_all()
    mfa = db_session.get(PlatformUserMfa, target_id)
    assert mfa.required is False
    assert mfa.secret_ciphertext is None
    assert mfa.pending_secret_ciphertext is None
    assert mfa.recovery_hashes_json == []
    assert db_session.get(PlatformUser, target_id).token_version == 2
    assert db_session.get(PlatformUser, admin_id).token_version == 1
    assert db_session.query(PlatformMfaChallenge).filter_by(user_id=target_id).count() == 0
    assert db_session.query(PlatformAuditEvent).filter_by(
        action="MFA_ADMIN_RESET", entity_id=target_id,
    ).count() == 1
    old_challenge = client.post("/api/v1/auth/mfa/verify", json={
        "challenge_token": challenge, "totp": "123456",
    })
    assert old_challenge.status_code == 401
    after = client.post("/api/v1/auth/login", json={
        "username": target.username, "password": PASSWORD,
    })
    assert after.status_code == 200 and "access_token" in after.json()

    repeat = client.post(f"/api/v1/admin/users/{target_id}/mfa/reset", headers=auth_admin, json={
        "confirm_username": target.username, "current_password": PASSWORD,
    })
    assert repeat.status_code == 409


def test_revoked_admin_jwt_cannot_reset_enrolled_user(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "REQUIRE_AUTH", True)
    admin = create_user(db_session, username="mfa-admin-old", role="ADMINISTRATOR")
    target = create_user(db_session, username="mfa-target-old", role="VIEWER")
    target_id = int(target.id)
    db_session.add(PlatformUserMfa(
        user_id=target_id, required=True, secret_ciphertext=_seal(target_id, "JBSWY3DPEHPK3PXP"),
    ))
    db_session.commit()
    logged_in = client.post("/api/v1/auth/login", json={
        "username": admin.username, "password": PASSWORD,
    })
    auth = {"Authorization": "Bearer " + logged_in.json()["access_token"]}
    revoke = client.post("/api/v1/auth/logout", headers=auth, json={"revoke_all": True})
    assert revoke.status_code == 204
    stale = client.post(f"/api/v1/admin/users/{target_id}/mfa/reset", headers=auth, json={
        "confirm_username": target.username, "current_password": PASSWORD,
    })
    assert stale.status_code == 401
    db_session.expire_all()
    assert db_session.get(PlatformUserMfa, target_id).required is True
