"""Regression: refresh tokens are single-use; login soft rate-limits failures."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.auth.login_throttle import LoginThrottleConfig, reset_login_throttle_for_tests
from app.auth.security import get_password_hash
from app.main import app
from app.platform_admin.models import PlatformUser


@pytest.fixture
def client(db_session: Session) -> TestClient:
    return TestClient(app)


def _mk_user(db: Session, username: str, password: str) -> PlatformUser:
    u = PlatformUser(
        username=username,
        password_hash=get_password_hash(password),
        role="OPERATOR",
        status="ACTIVE",
        token_version=1,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def test_refresh_token_cannot_be_replayed(client: TestClient, db_session: Session) -> None:
    _mk_user(db_session, "refresh-replay", "Pw-replay-1")
    login = client.post("/api/v1/auth/login", json={"username": "refresh-replay", "password": "Pw-replay-1"})
    assert login.status_code == 200, login.text
    refresh = login.json()["refresh_token"]

    first = client.post("/api/v1/auth/refresh", json={"refresh_token": refresh})
    assert first.status_code == 200, first.text
    assert first.json()["refresh_token"] != refresh

    second = client.post("/api/v1/auth/refresh", json={"refresh_token": refresh})
    assert second.status_code == 401
    assert second.json()["detail"]["error_code"] == "AUTH_TOKEN_REVOKED"


def test_login_rate_limited_after_repeated_failures(client: TestClient, db_session: Session, monkeypatch) -> None:
    reset_login_throttle_for_tests()
    _mk_user(db_session, "rate-user", "Good-Pw-99")
    monkeypatch.setattr(
        "app.auth.login_throttle._DEFAULT",
        LoginThrottleConfig(
            max_failures_per_username=3,
            max_failures_per_ip=100,
            window_seconds=600,
            lockout_seconds=30,
        ),
    )

    for _ in range(3):
        r = client.post("/api/v1/auth/login", json={"username": "rate-user", "password": "wrong"})
        assert r.status_code == 400

    blocked = client.post("/api/v1/auth/login", json={"username": "rate-user", "password": "wrong"})
    assert blocked.status_code == 429
    assert blocked.json()["detail"]["error_code"] == "LOGIN_RATE_LIMITED"
    assert blocked.headers.get("retry-after")
    reset_login_throttle_for_tests()
