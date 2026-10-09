"""PF-9 source-only management ingress preview negative/security contract.

No live ingress ACL, firewall, SSH, nginx, user accounts, or production DB is
modified. These tests use only the dedicated gdc_pytest fixture catalog.
"""
from __future__ import annotations

from fastapi import Request
from fastapi.testclient import TestClient
import pytest

from app.auth.security import get_password_hash
from app.config import settings
from app.database import get_db
from app.main import app
from app.platform_admin.management_acl_preview import _observed_source
from app.platform_admin.models import PlatformUser


@pytest.fixture
def browser_client(db_session, monkeypatch):
    monkeypatch.setattr(settings, "REQUIRE_AUTH", True)
    monkeypatch.setattr(settings, "AUTH_DEV_HEADER_TRUST", False)
    user = PlatformUser(
        username="acl-source-admin", password_hash=get_password_hash("AclSourcePassword9!"),
        role="ADMINISTRATOR", status="ACTIVE", token_version=1,
    )
    readonly = PlatformUser(
        username="acl-source-viewer", password_hash=get_password_hash("AclSourcePassword9!"),
        role="VIEWER", status="ACTIVE", token_version=1,
    )
    db_session.add_all([user, readonly])
    db_session.commit()

    def override_db():
        yield db_session

    app.dependency_overrides[get_db] = override_db
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.pop(get_db, None)


def sign_in(client: TestClient, user: str) -> dict[str, str]:
    res = client.post("/api/v1/auth/login", json={
        "username": user, "password": "AclSourcePassword9!",
    })
    assert res.status_code == 200, res.text
    return {"Authorization": "Bearer " + res.json()["access_token"]}


def test_management_allowlist_preview_disabled_by_default_but_never_apply_ready(
    browser_client: TestClient,
) -> None:
    headers = sign_in(browser_client, "acl-source-admin")
    res = browser_client.post("/api/v1/admin/management-access/preview", json={}, headers=headers)
    assert res.status_code == 200, res.text
    result = res.json()
    assert result["mode"] == "PREVIEW_ONLY"
    assert result["candidate_web_enabled"] is False
    assert result["candidate_ssh_enabled"] is False
    assert result["apply_available"] is False
    assert result["web_enforcement_available"] is False
    assert result["ssh_enforcement_available"] is False
    assert result["web_reason"] == "ALLOW_DISABLED"
    assert result["ssh_reason"] == "ALLOW_DISABLED"
    assert "WEB_PROXY_AND_API_ATOMIC_ENFORCEMENT_UNAVAILABLE" in result["blockers"]
    assert "HOST_SSH_APPLY_AND_ROLLBACK_UNAVAILABLE" in result["blockers"]
    # No implementation may falsely advertise an apply/reload endpoint.
    for path in ("/api/v1/admin/management-access/apply",
                 "/api/v1/admin/management-access/enable"):
        applied = browser_client.post(path, json={}, headers=headers)
        # The SPA fallback's GET-only catch-all can return 405 instead of 404.
        assert applied.status_code in (404, 405)


@pytest.mark.parametrize("cidr", [
    "0.0.0.0/0", "::/0", "::ffff:0:0/96", "not-a-cidr", "224.300.2.1",
])
def test_preview_rejects_invalid_or_unrestricted_web_cidrs(
    browser_client: TestClient, cidr: str,
) -> None:
    headers = sign_in(browser_client, "acl-source-admin")
    res = browser_client.post("/api/v1/admin/management-access/preview", headers=headers, json={
        "web": {"enabled": True, "sources": [{"cidr": cidr}]},
    })
    assert res.status_code == 422, res.text
    assert res.json()["detail"]["error_code"] == "ACL_PREVIEW_INVALID_POLICY"


def test_preview_rejects_duplicate_and_empty_enabled_policy(browser_client: TestClient) -> None:
    headers = sign_in(browser_client, "acl-source-admin")
    for candidate in (
        {"enabled": True, "sources": []},
        {"enabled": True, "sources": [{"cidr": "198.51.100.0/24"}, {"cidr": "198.51.100.23/24"}]},
    ):
        res = browser_client.post("/api/v1/admin/management-access/preview",
                                  headers=headers, json={"web": candidate})
        assert res.status_code == 422, res.text


def test_spoofed_forwarded_headers_cannot_claim_current_web_source(
    browser_client: TestClient,
) -> None:
    headers = sign_in(browser_client, "acl-source-admin")
    headers.update({
        "X-Forwarded-For": "198.51.100.14",
        "Forwarded": "for=198.51.100.14",
    })
    res = browser_client.post("/api/v1/admin/management-access/preview", headers=headers, json={
        "web": {"enabled": True, "sources": [{"cidr": "198.51.100.0/24"}]},
        "ssh": {"enabled": True, "sources": [{"cidr": "198.51.100.0/24"}]},
    })
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["apply_available"] is False
    assert data["observed_api_source"] is None
    assert data["web_source_matches"] is False
    assert data["web_reason"] == "DENY_UNKNOWN_SOURCE"
    assert "WEB_SELF_LOCKOUT" in data["blockers"]
    assert "SSH_ENFORCEMENT_UNAVAILABLE" in data["blockers"]


def test_role_and_authentication_negative_matrix(browser_client: TestClient) -> None:
    path = "/api/v1/admin/management-access/preview"
    anonymous = browser_client.post(path, json={})
    assert anonymous.status_code == 401
    viewer = browser_client.post(path, json={}, headers=sign_in(browser_client, "acl-source-viewer"))
    assert viewer.status_code == 403
    # A forged role header cannot elevate the authenticated Viewer.
    claimed_admin = browser_client.post(path, json={}, headers={
        **sign_in(browser_client, "acl-source-viewer"),
        "X-GDC-Role": "ADMINISTRATOR",
    })
    assert claimed_admin.status_code == 403


def test_observed_peer_is_not_supplied_xff():
    req = Request({
        "type": "http", "method": "POST", "path": "/api/v1/admin/management-access/preview",
        "headers": [(b"x-forwarded-for", b"198.51.100.14")],
        "client": ("203.0.113.10", 1234), "server": ("testserver", 80),
    })
    assert _observed_source(req) == "203.0.113.10"
