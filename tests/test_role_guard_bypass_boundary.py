"""Prevent bypass-path lexical prefix collisions from disabling JWT guard.

This is a pure security-router unit contract: no API server or catalog DB.
"""
from __future__ import annotations

import pytest

from app.auth.role_guard import _is_bypass, _must_change_password_bypass
from app.config import settings


def _method_for_path(path: str) -> str:
    return "POST" if path.startswith(settings.API_PREFIX.rstrip("/") + "/") else "GET"


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
    assert _is_bypass(path, method=_method_for_path(path)) is False


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
    assert _is_bypass(path, method=_method_for_path(path)) is True


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


@pytest.mark.parametrize("path", [
    "/health/internal",
    "/docs/unknown",
    "/redoc/private",
    "/openapi.json/internal",
    settings.API_PREFIX.rstrip("/") + "/auth/login/admin",
    settings.API_PREFIX.rstrip("/") + "/auth/mfa/verify/admin",
    settings.API_PREFIX.rstrip("/") + "/auth/refresh/all",
    settings.API_PREFIX.rstrip("/") + "/auth/logout/other",
    settings.API_PREFIX.rstrip("/") + "/ingest/webhook",
    settings.API_PREFIX.rstrip("/") + "/ingest/webhook/receiver/private",
    settings.API_PREFIX.rstrip("/") + "/ingest/ai",
    settings.API_PREFIX.rstrip("/") + "/ingest/ai/stream/v1/chat/completions/extra",
])
def test_only_registered_path_shapes_skip_authentication(path: str) -> None:
    # A valid parent route does not exempt hypothetical child routes.
    assert _is_bypass(path, method=_method_for_path(path)) is False


@pytest.mark.parametrize(("method", "path"), [
    ("GET", settings.API_PREFIX.rstrip("/") + "/auth/login"),
    ("DELETE", settings.API_PREFIX.rstrip("/") + "/auth/logout"),
    ("GET", settings.API_PREFIX.rstrip("/") + "/ingest/webhook/key"),
    ("PUT", settings.API_PREFIX.rstrip("/") + "/ingest/ai/stream/v1/chat/completions"),
    ("POST", "/health"),
    ("POST", "/docs/oauth2-redirect"),
])
def test_only_intended_methods_skip_authentication(method: str, path: str) -> None:
    assert _is_bypass(path, method=method) is False


@pytest.mark.parametrize(("method", "path"), [
    ("POST", settings.API_PREFIX.rstrip("/") + "/auth/login"),
    ("POST", settings.API_PREFIX.rstrip("/") + "/auth/mfa/verify"),
    ("POST", settings.API_PREFIX.rstrip("/") + "/auth/refresh"),
    ("POST", settings.API_PREFIX.rstrip("/") + "/auth/logout"),
    ("POST", settings.API_PREFIX.rstrip("/") + "/ingest/webhook/key"),
    ("POST", settings.API_PREFIX.rstrip("/") + "/ingest/ai/stream/v1/chat/completions"),
    ("GET", "/health"),
    ("GET", "/docs"),
    ("GET", "/docs/oauth2-redirect"),
    ("GET", "/redoc"),
    ("GET", "/openapi.json"),
])
def test_registered_methods_keep_intended_bypass(method: str, path: str) -> None:
    assert _is_bypass(path, method=method) is True


@pytest.mark.parametrize(("method", "path"), [
    ("GET", settings.API_PREFIX.rstrip("/") + "/auth/login/admin"),
    ("POST", settings.API_PREFIX.rstrip("/") + "/ingest/webhook/key/extra"),
    ("GET", "/health/private"),
    ("GET", settings.API_PREFIX.rstrip("/") + "/ingest/webhook/key"),
])
def test_middleware_denies_unregistered_bypass_shapes_without_token(
    method: str, path: str, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from fastapi.testclient import TestClient
    from app.main import app

    monkeypatch.setattr(settings, "REQUIRE_AUTH", True)
    res = TestClient(app).request(method, path)
    assert res.status_code == 401, res.text
    assert res.json()["detail"]["error_code"] == "AUTH_REQUIRED"
