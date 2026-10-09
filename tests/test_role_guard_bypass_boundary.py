"""Prevent bypass-path lexical prefix collisions from disabling JWT guard.

This is a pure security-router unit contract: no API server or catalog DB.
"""
from __future__ import annotations

import pytest

from app.auth.role_guard import _is_bypass, _must_change_password_bypass
from app.config import settings


@pytest.mark.parametrize("path", [
    "/healthcare",
    "/healthcheck",
    "/docs-malicious",
    "/redoc-test",
    "/openapi.json-malicious",
    "/api/openapi.json-internal",
    settings.API_PREFIX.rstrip("/") + "/auth/loginAgain",
    settings.API_PREFIX.rstrip("/") + "/auth/mfa/verify-backdoor",
    settings.API_PREFIX.rstrip("/") + "/auth/refreshToken",
    settings.API_PREFIX.rstrip("/") + "/auth/logoutAll",
    settings.API_PREFIX.rstrip("/") + "/ingest/webhookExtra",
    settings.API_PREFIX.rstrip("/") + "/ingest/ai-admin",
])
def test_auth_bypass_does_not_match_partial_path_segments(path: str) -> None:
    assert _is_bypass(path) is False


@pytest.mark.parametrize("path", [
    "/health",
    "/docs",
    "/docs/oauth2-redirect",
    "/redoc",
    "/openapi.json",
    "/api/openapi.json",
    settings.API_PREFIX.rstrip("/") + "/auth/login",
    settings.API_PREFIX.rstrip("/") + "/auth/mfa/verify",
    settings.API_PREFIX.rstrip("/") + "/auth/refresh",
    settings.API_PREFIX.rstrip("/") + "/auth/logout",
    settings.API_PREFIX.rstrip("/") + "/ingest/webhook/key",
    settings.API_PREFIX.rstrip("/") + "/ingest/ai/stream/v1/chat/completions",
])
def test_existing_intended_auth_bypass_routes_remain_available(path: str) -> None:
    assert _is_bypass(path) is True


@pytest.mark.parametrize("path", [
    settings.API_PREFIX.rstrip("/") + "/auth/refreshSome",
    settings.API_PREFIX.rstrip("/") + "/auth/logoutAll",
    settings.API_PREFIX.rstrip("/") + "/auth/whoamiElse",
    settings.API_PREFIX.rstrip("/") + "/auth/change-passwordAnything",
])
def test_forced_password_change_exception_must_not_match_partial_segments(path: str) -> None:
    assert _must_change_password_bypass(path) is False


@pytest.mark.parametrize("path", [
    settings.API_PREFIX.rstrip("/") + "/auth/refresh",
    settings.API_PREFIX.rstrip("/") + "/auth/logout",
    settings.API_PREFIX.rstrip("/") + "/auth/whoami",
    settings.API_PREFIX.rstrip("/") + "/auth/change-password",
])
def test_existing_password_change_escape_paths_stay_available(path: str) -> None:
    assert _must_change_password_bypass(path) is True



@pytest.mark.parametrize("path", [
    "/healthcheck",
    "/docs-malicious",
    settings.API_PREFIX.rstrip("/") + "/auth/loginAgain",
    settings.API_PREFIX.rstrip("/") + "/auth/refreshToken",
    settings.API_PREFIX.rstrip("/") + "/ingest/webhookExtra",
])
def test_missing_bearer_cannot_skip_live_http_middleware_on_prefix_collision(
    path: str, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from fastapi.testclient import TestClient
    from app.main import app

    monkeypatch.setattr(settings, "REQUIRE_AUTH", True)
    # No lifespan/startup: the public middleware denial must occur before
    # any product DB or scheduler can be touched.
    res = TestClient(app).get(path)
    assert res.status_code == 401, res.text
    assert res.json()["detail"]["error_code"] == "AUTH_REQUIRED"
