"""Unit tests for centralized RBAC-lite HTTP access rules."""

from __future__ import annotations

import pytest

from app.auth.route_access import (
    ROLE_ADMINISTRATOR,
    ROLE_OPERATOR,
    ROLE_VIEWER,
    evaluate_http_access,
    is_viewer_allowed_post,
)
from app.config import settings


def _p(suffix: str) -> str:
    base = settings.API_PREFIX.rstrip("/")
    return f"{base}{suffix}"


@pytest.mark.parametrize(
    ("role", "method", "path", "expect_denied"),
    [
        (ROLE_VIEWER, "GET", _p("/admin/users"), True),
        (ROLE_OPERATOR, "GET", _p("/admin/users"), True),
        (ROLE_ADMINISTRATOR, "GET", _p("/admin/users"), False),
        (ROLE_VIEWER, "GET", _p("/admin/maintenance/health"), True),
        (ROLE_OPERATOR, "GET", _p("/admin/maintenance/health"), True),
        (ROLE_VIEWER, "GET", _p("/admin/dev-validation/status"), True),
        (ROLE_OPERATOR, "GET", _p("/admin/dev-validation/status"), True),
        (ROLE_ADMINISTRATOR, "GET", _p("/admin/dev-validation/status"), False),
        (ROLE_VIEWER, "GET", _p("/admin/dev-validation/status/"), True),
        (ROLE_ADMINISTRATOR, "GET", _p("/admin/dev-validation/status/"), False),
        (ROLE_VIEWER, "GET", _p("/runtime/dashboard/summary"), False),
        (ROLE_VIEWER, "POST", _p("/runtime/streams/1/start"), True),
        (ROLE_VIEWER, "POST", _p("/runtime/preview/mapping"), False),
        (ROLE_VIEWER, "POST", _p("/auth/change-password"), False),
        (ROLE_OPERATOR, "POST", _p("/auth/change-password"), False),
        (ROLE_OPERATOR, "PUT", _p("/admin/https-settings"), True),
        (ROLE_OPERATOR, "GET", _p("/admin/https-settings"), False),
        (ROLE_OPERATOR, "POST", _p("/backup/import/apply"), True),
        (ROLE_ADMINISTRATOR, "POST", _p("/backup/import/apply"), False),
        (ROLE_OPERATOR, "POST", _p("/admin/config-versions/1/apply-snapshot"), True),
        (ROLE_ADMINISTRATOR, "POST", _p("/admin/config-versions/1/apply-snapshot"), False),
    ],
)
def test_evaluate_http_access(role: str, method: str, path: str, expect_denied: bool) -> None:
    denied = evaluate_http_access(role=role, method=method, path=path)
    if expect_denied:
        assert denied is not None
        assert denied.error_code == "ROLE_FORBIDDEN"
    else:
        assert denied is None


def test_viewer_allowed_post_paths() -> None:
    assert is_viewer_allowed_post(_p("/runtime/preview/mapping")) is True
    assert is_viewer_allowed_post(_p("/runtime/format-preview")) is True
    assert is_viewer_allowed_post(_p("/runtime/streams/1/pipeline-debug")) is True
    assert is_viewer_allowed_post(_p("/runtime/streams/1/start")) is False
