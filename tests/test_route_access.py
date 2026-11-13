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


ALL_ROLES = (
    "ADMINISTRATOR",
    "OPERATOR",
    "CONNECTOR_OPERATOR",
    "VIEWER",
    "GOVERNANCE_OPERATOR",
    "GOVERNANCE_REVIEWER",
    "GOVERNANCE_APPROVER",
    "GOVERNANCE_AUDITOR",
)


@pytest.mark.parametrize("role", ALL_ROLES)
def test_display_settings_write_is_administrator_only(role: str) -> None:
    """F-192: the platform default timezone is Administrator-only to write, readable by everyone."""

    write = evaluate_http_access(role=role, method="PUT", path=_p("/admin/display-settings"))
    read = evaluate_http_access(role=role, method="GET", path=_p("/admin/display-settings"))

    assert read is None
    if role == ROLE_ADMINISTRATOR:
        assert write is None
    else:
        assert write is not None
        assert write.error_code == "ROLE_FORBIDDEN"


@pytest.mark.parametrize("role", ALL_ROLES)
@pytest.mark.parametrize(
    "path", ["/auth/change-password", "/auth/mfa/enroll/start", "/auth/mfa/enroll/confirm"]
)
def test_every_role_can_reach_self_service_credential_endpoints(role: str, path: str) -> None:
    """F-202: change-password and MFA enrollment are open to every role, Governance-only included."""

    assert evaluate_http_access(role=role, method="POST", path=_p(path)) is None


@pytest.mark.parametrize("role", ALL_ROLES)
def test_self_service_exception_is_limited_to_the_exact_post_paths(role: str) -> None:
    """The F-202 exception must not open sibling paths or other verbs for restricted roles."""

    if role == ROLE_ADMINISTRATOR:
        return
    admin_password = evaluate_http_access(role=role, method="POST", path=_p("/admin/password"))
    assert admin_password is not None
    assert admin_password.error_code == "ROLE_FORBIDDEN"
    if role.startswith("GOVERNANCE_"):
        for method, path in (
            ("PUT", "/auth/change-password"),
            ("POST", "/auth/change-password/extra"),
            ("POST", "/runtime/streams/1/start"),
        ):
            denied = evaluate_http_access(role=role, method=method, path=_p(path))
            assert denied is not None, (role, method, path)


def test_viewer_allowed_post_paths() -> None:
    assert is_viewer_allowed_post(_p("/runtime/preview/mapping")) is True
    assert is_viewer_allowed_post(_p("/runtime/format-preview")) is True
    assert is_viewer_allowed_post(_p("/runtime/streams/1/pipeline-debug")) is True
    assert is_viewer_allowed_post(_p("/runtime/streams/1/start")) is False
