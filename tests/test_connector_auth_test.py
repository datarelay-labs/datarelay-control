"""Connector auth probe (custom path/method) — preview_service only."""

from __future__ import annotations

import base64
from unittest.mock import MagicMock

import httpx
import pytest

from app.runtime.preview_service import PreviewRequestError, run_connector_auth_test
from app.runtime.schemas import ConnectorAuthTestRequest


def test_connector_auth_test_get_custom_path(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str]] = []

    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def request(self, method: str, url: str, **kwargs):  # noqa: ANN003
            calls.append((method, url))
            req = httpx.Request(method, url)
            return httpx.Response(405, request=req, text="Method Not Allowed")

    monkeypatch.setattr("app.runtime.preview_service.httpx.Client", lambda *a, **k: _Client())
    monkeypatch.setattr(
        "app.runtime.preview_service._load_source_config_for_connector",
        lambda db, cid: {
            "base_url": "https://xdr.ooo",
            "verify_ssl": True,
            "headers": {},
            "auth_type": "bearer",
            "bearer_token": "secret-token",
        },
    )

    res = run_connector_auth_test(
        ConnectorAuthTestRequest(
            connector_id=1,
            method="GET",
            test_path="/connect/api/v1/alerts",
        ),
        MagicMock(),
    )
    assert calls == [("GET", "https://xdr.ooo/connect/api/v1/alerts")]
    assert res.response_status_code == 405
    assert res.response_body == "Method Not Allowed"
    assert res.ok is False
    assert res.error_type == "target_405_method_not_allowed"
    assert res.request_method == "GET"
    assert res.request_headers_masked.get("Authorization") == "********"


def test_connector_auth_test_saved_connector_uses_visible_bearer_draft(monkeypatch: pytest.MonkeyPatch) -> None:
    auth_headers: list[str] = []

    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def request(self, method: str, url: str, **kwargs):  # noqa: ANN003
            headers = kwargs.get("headers") or {}
            auth_headers.append(str(headers.get("Authorization") or ""))
            req = httpx.Request(method, url)
            return httpx.Response(401, request=req, text="Unauthorized")

    monkeypatch.setattr("app.runtime.preview_service.httpx.Client", lambda *a, **k: _Client())
    monkeypatch.setattr(
        "app.runtime.preview_service._load_source_config_for_connector",
        lambda db, cid: {
            "base_url": "https://draft.test",
            "verify_ssl": True,
            "headers": {},
            "auth_type": "bearer",
            "bearer_token": "saved-token",
        },
    )

    res = run_connector_auth_test(
        ConnectorAuthTestRequest(
            connector_id=1,
            inline_flat_source={
                "base_url": "https://draft.test",
                "verify_ssl": True,
                "headers": {},
                "auth_type": "bearer",
                "bearer_token": "visible-invalid-draft",
            },
            method="GET",
            test_path="/",
        ),
        MagicMock(),
    )

    assert auth_headers == ["Bearer visible-invalid-draft"]
    assert res.ok is False
    assert res.response_status_code == 401


def test_connector_auth_test_saved_connector_resolves_masked_secret_server_side(monkeypatch: pytest.MonkeyPatch) -> None:
    auth_headers: list[str] = []

    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def request(self, method: str, url: str, **kwargs):  # noqa: ANN003
            headers = kwargs.get("headers") or {}
            auth_headers.append(str(headers.get("Authorization") or ""))
            req = httpx.Request(method, url)
            return httpx.Response(200, request=req, json={"ok": True})

    monkeypatch.setattr("app.runtime.preview_service.httpx.Client", lambda *a, **k: _Client())
    monkeypatch.setattr(
        "app.runtime.preview_service._load_source_config_for_connector",
        lambda db, cid: {
            "base_url": "https://draft.test",
            "verify_ssl": True,
            "headers": {},
            "auth_type": "bearer",
            "bearer_token": "saved-token",
        },
    )

    res = run_connector_auth_test(
        ConnectorAuthTestRequest(
            connector_id=1,
            inline_flat_source={
                "base_url": "https://draft.test",
                "verify_ssl": True,
                "headers": {},
                "auth_type": "bearer",
                "bearer_token": "********",
            },
            method="GET",
            test_path="/",
        ),
        MagicMock(),
    )

    assert auth_headers == ["Bearer saved-token"]
    assert res.ok is True


def test_connector_auth_test_does_not_reuse_saved_secret_across_draft_origin_change(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[tuple[str, str]] = []

    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def request(self, method: str, url: str, **kwargs):  # noqa: ANN003
            headers = kwargs.get("headers") or {}
            seen.append((url, str(headers.get("Authorization") or "")))
            req = httpx.Request(method, url)
            return httpx.Response(401, request=req, text="Unauthorized")

    monkeypatch.setattr("app.runtime.preview_service.httpx.Client", lambda *a, **k: _Client())
    monkeypatch.setattr(
        "app.runtime.preview_service._load_source_config_for_connector",
        lambda db, cid: {
            "base_url": "https://saved.example/api",
            "verify_ssl": True,
            "headers": {},
            "auth_type": "bearer",
            "bearer_token": "saved-token",
        },
    )

    res = run_connector_auth_test(
        ConnectorAuthTestRequest(
            connector_id=1,
            inline_flat_source={
                "base_url": "https://draft.example/api",
                "verify_ssl": True,
                "headers": {},
                "auth_type": "bearer",
                "bearer_token": "********",
            },
            method="GET",
            test_path="/probe",
        ),
        MagicMock(),
    )

    assert seen == [("https://draft.example/api/probe", "")]
    assert res.ok is False
    assert "saved-token" not in str(res)


def test_connector_auth_test_rejects_saved_non_http_draft_overlay(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.runtime.preview_service._load_source_config_for_connector",
        lambda db, cid: {
            "source_type": "S3_OBJECT_POLLING",
            "endpoint_url": "https://saved-s3.example",
            "bucket": "saved",
            "access_key": "configured-access",
            "secret_key": "configured-value",
            "auth_type": "no_auth",
        },
    )

    with pytest.raises(PreviewRequestError) as exc:
        run_connector_auth_test(
            ConnectorAuthTestRequest(
                connector_id=1,
                inline_flat_source={
                    "base_url": "https://draft-http.example",
                    "auth_type": "no_auth",
                },
                method="GET",
                test_path="/",
            ),
            MagicMock(),
        )

    assert exc.value.status_code == 400
    assert exc.value.detail["error_type"] == "inline_draft_overlay_not_supported"


def test_connector_auth_test_rejects_foreign_test_url_host(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.runtime.preview_service._load_source_config_for_connector",
        lambda db, cid: {
            "base_url": "https://xdr.ooo",
            "verify_ssl": True,
            "headers": {},
            "auth_type": "bearer",
            "bearer_token": "t",
        },
    )
    with pytest.raises(PreviewRequestError) as exc:
        run_connector_auth_test(
            ConnectorAuthTestRequest(
                connector_id=1,
                method="GET",
                test_url="https://evil.example/foo",
            ),
            MagicMock(),
        )
    assert exc.value.status_code == 400
    assert exc.value.detail["error_type"] == "invalid_test_url"


def test_vendor_jwt_stellar_default_token_exchange_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stellar Cyber default: POST token URL, Basic user_id:api_key, empty body, no Content-Type when unset, Bearer final."""

    calls: list[dict[str, object]] = []

    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def request(self, method: str, url: str, **kwargs):  # noqa: ANN003
            calls.append({"method": method, "url": url, **kwargs})
            req = httpx.Request(method, url)
            if url.endswith("/connect/api/v1/access_token"):
                return httpx.Response(200, request=req, json={"access_token": "tok-secret"})
            return httpx.Response(200, request=req, json={"hits": []})

    monkeypatch.setattr("app.runtime.preview_service.httpx.Client", lambda *a, **k: _Client())

    res = run_connector_auth_test(
        ConnectorAuthTestRequest(
            inline_flat_source={
                "base_url": "https://stellar.example",
                "verify_ssl": True,
                "headers": {"Content-Type": "application/json", "Accept": "application/json", "X-Common": "yes"},
                "auth_type": "vendor_jwt_exchange",
                "user_id": "uid1",
                "api_key": "api-secret-val",
                "token_url": "/connect/api/v1/access_token",
                "token_method": "POST",
                "token_auth_mode": "basic_user_api_key",
                "token_body_mode": "empty",
                "token_path": "$.access_token",
                "access_token_injection": "bearer_authorization",
            },
            method="GET",
            test_path="/connect/api/data/events/_search",
        ),
        MagicMock(),
    )

    assert len(calls) == 2
    tok = calls[0]
    assert tok["method"] == "POST"
    assert tok["url"] == "https://stellar.example/connect/api/v1/access_token"
    th = tok["headers"]
    assert isinstance(th, dict)
    assert th.get("Content-Type") is None
    assert th.get("Accept") == "application/json"
    assert "X-Common" not in th
    authz = str(th.get("Authorization") or "")
    assert authz.startswith("Basic ")
    decoded = base64.b64decode(authz.split(" ", 1)[1]).decode("ascii")
    assert decoded == "uid1:api-secret-val"
    assert tok.get("content") == b""
    assert "json" not in tok

    fin = calls[1]
    assert fin["method"] == "GET"
    fh = fin["headers"]
    assert fh.get("Authorization") == "Bearer tok-secret"
    assert fh.get("Content-Type") == "application/json"
    assert fh.get("X-Common") == "yes"

    assert res.ok is True


def test_vendor_jwt_token_exchange_explicit_content_type_header(monkeypatch: pytest.MonkeyPatch) -> None:
    """Advanced option: explicit token_content_type is sent when set."""

    calls: list[dict[str, object]] = []

    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def request(self, method: str, url: str, **kwargs):  # noqa: ANN003
            calls.append({"method": method, "url": url, **kwargs})
            req = httpx.Request(method, url)
            if "/access_token" in url:
                return httpx.Response(200, request=req, json={"access_token": "tok-x"})
            return httpx.Response(200, request=req, json={"ok": True})

    monkeypatch.setattr("app.runtime.preview_service.httpx.Client", lambda *a, **k: _Client())

    res = run_connector_auth_test(
        ConnectorAuthTestRequest(
            inline_flat_source={
                "base_url": "https://vendor.example",
                "verify_ssl": True,
                "headers": {},
                "auth_type": "vendor_jwt_exchange",
                "user_id": "u",
                "api_key": "k",
                "token_url": "/connect/api/v1/access_token",
                "token_method": "POST",
                "token_auth_mode": "basic_user_api_key",
                "token_content_type": "application/x-www-form-urlencoded",
                "token_body_mode": "empty",
                "token_path": "$.access_token",
            },
            method="GET",
            test_path="/r",
        ),
        MagicMock(),
    )

    assert res.ok is True
    th = calls[0]["headers"]
    assert isinstance(th, dict)
    assert th.get("Content-Type") == "application/x-www-form-urlencoded"


def test_vendor_jwt_regression_token_post_empty_body_final_search(monkeypatch: pytest.MonkeyPatch) -> None:
    """Token endpoint accepts POST only with empty body; final probe matches GET .../_search."""

    calls: list[dict[str, object]] = []

    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def request(self, method: str, url: str, **kwargs):  # noqa: ANN003
            calls.append({"method": method, "url": url, **kwargs})
            req = httpx.Request(method, url)
            if "/connect/api/v1/access_token" in url:
                if method != "POST":
                    return httpx.Response(405, request=req, text="POST required")
                hdrs = kwargs.get("headers") or {}
                ct = str(hdrs.get("Content-Type") or "")
                if ct.strip():
                    return httpx.Response(401, request=req, text="Stellar-style token exchange expects no Content-Type")
                if kwargs.get("content") != b"":
                    return httpx.Response(400, request=req, text="body must be empty")
                return httpx.Response(200, request=req, json={"access_token": "tok-reg"})
            assert method == "GET"
            assert "/connect/api/data/aella-ser-test/_search" in url
            return httpx.Response(200, request=req, json={"hits": []})

    monkeypatch.setattr("app.runtime.preview_service.httpx.Client", lambda *a, **k: _Client())

    res = run_connector_auth_test(
        ConnectorAuthTestRequest(
            inline_flat_source={
                "base_url": "https://xdr.ooo",
                "verify_ssl": True,
                "headers": {"X-Env": "prod"},
                "auth_type": "vendor_jwt_exchange",
                "user_id": "u",
                "api_key": "k",
                "token_url": "/connect/api/v1/access_token",
                "token_method": "POST",
                "token_auth_mode": "basic_user_api_key",
                "token_body_mode": "empty",
                "token_path": "$.access_token",
            },
            method="GET",
            test_path="/connect/api/data/aella-ser-test/_search",
        ),
        MagicMock(),
    )

    assert res.ok is True
    assert len(calls) == 2
    assert calls[0]["method"] == "POST"
    assert calls[0].get("content") == b""
    assert calls[1]["method"] == "GET"
    assert "aella-ser-test/_search" in str(calls[1]["url"])
    fh = calls[1]["headers"]
    assert isinstance(fh, dict)
    assert fh.get("Authorization") == "Bearer tok-reg"
    assert fh.get("X-Env") == "prod"


def test_vendor_jwt_token_exchange_405_phase(monkeypatch: pytest.MonkeyPatch) -> None:

    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def request(self, method: str, url: str, **kwargs):  # noqa: ANN003
            req = httpx.Request(method, url)
            if "/access_token" in url:
                return httpx.Response(405, request=req, text="Method Not Allowed")
            return httpx.Response(200, request=req)

    monkeypatch.setattr("app.runtime.preview_service.httpx.Client", lambda *a, **k: _Client())

    res = run_connector_auth_test(
        ConnectorAuthTestRequest(
            inline_flat_source={
                "base_url": "https://stellar.example",
                "verify_ssl": True,
                "headers": {},
                "auth_type": "vendor_jwt_exchange",
                "user_id": "u",
                "api_key": "k",
                "token_url": "/connect/api/v1/access_token",
                "token_auth_mode": "basic_user_api_key",
            },
            method="GET",
            test_path="/",
        ),
        MagicMock(),
    )

    assert res.ok is False
    assert res.phase == "token_exchange"
    assert res.token_response_status_code == 405
    assert res.error_type == "target_405_method_not_allowed"


def test_vendor_jwt_final_request_405_phase(monkeypatch: pytest.MonkeyPatch) -> None:

    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def request(self, method: str, url: str, **kwargs):  # noqa: ANN003
            req = httpx.Request(method, url)
            if "/access_token" in url:
                return httpx.Response(200, request=req, json={"access_token": "tok"})
            return httpx.Response(405, request=req, text="Method Not Allowed")

    monkeypatch.setattr("app.runtime.preview_service.httpx.Client", lambda *a, **k: _Client())

    res = run_connector_auth_test(
        ConnectorAuthTestRequest(
            inline_flat_source={
                "base_url": "https://stellar.example",
                "verify_ssl": True,
                "headers": {},
                "auth_type": "vendor_jwt_exchange",
                "user_id": "u",
                "api_key": "k",
                "token_url": "/connect/api/v1/access_token",
                "token_auth_mode": "basic_user_api_key",
            },
            method="GET",
            test_path="/probe",
        ),
        MagicMock(),
    )

    assert res.ok is False
    assert res.phase == "final_request"
    assert res.response_status_code == 405
    assert res.error_type == "target_405_method_not_allowed"


def test_connector_auth_test_masked_json_body(monkeypatch: pytest.MonkeyPatch) -> None:

    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def request(self, method: str, url: str, **kwargs):  # noqa: ANN003
            req = httpx.Request(method, url)
            return httpx.Response(
                200,
                request=req,
                json={"access_token": "secret-at", "api_key": "never-show"},
            )

    monkeypatch.setattr("app.runtime.preview_service.httpx.Client", lambda *a, **k: _Client())

    res = run_connector_auth_test(
        ConnectorAuthTestRequest(
            inline_flat_source={
                "base_url": "https://inline.test",
                "verify_ssl": True,
                "headers": {},
                "auth_type": "bearer",
                "bearer_token": "probe-token",
            },
            method="GET",
            test_path="/",
        ),
        MagicMock(),
    )
    assert res.ok is True
    assert "secret-at" not in (res.response_body or "")
    assert "never-show" not in (res.response_body or "")
    assert "********" in (res.response_body or "")


def test_connector_auth_test_inline_flat_source_no_db(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str]] = []

    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def request(self, method: str, url: str, **kwargs):  # noqa: ANN003
            calls.append((method, url))
            req = httpx.Request(method, url)
            return httpx.Response(200, request=req, json={"ok": True})

    monkeypatch.setattr("app.runtime.preview_service.httpx.Client", lambda *a, **k: _Client())

    res = run_connector_auth_test(
        ConnectorAuthTestRequest(
            inline_flat_source={
                "base_url": "https://inline.test",
                "verify_ssl": True,
                "headers": {"X-Env": "dev"},
                "auth_type": "bearer",
                "bearer_token": "inline-secret",
            },
            method="GET",
            test_path="/v1/ping",
        ),
        MagicMock(),
    )
    assert calls == [("GET", "https://inline.test/v1/ping")]
    assert res.ok is True
    assert res.request_headers_masked.get("Authorization") == "********"


def test_connector_auth_test_session_login_form_urlencoded_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    """SESSION_LOGIN uses form body + same client cookies for GET probe."""

    calls: list[dict[str, object]] = []

    class _Client:
        def __init__(self) -> None:
            self.cookies = httpx.Cookies()

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def request(self, method: str, url: str, **kwargs):  # noqa: ANN003
            calls.append({"method": method, "url": url, **kwargs})
            req = httpx.Request(method, url)
            if "/login.html" in url:
                self.cookies.set("JSESSIONID", "abc", domain="cyber.example", path="/")
                return httpx.Response(
                    200,
                    request=req,
                    headers={"Set-Cookie": "JSESSIONID=abc; Path=/"},
                    text="",
                )
            assert method == "GET"
            assert "/rest/users/current" in url
            return httpx.Response(200, request=req, json={"user": "ok"})

    monkeypatch.setattr("app.runtime.preview_service.httpx.Client", lambda *a, **k: _Client())

    res = run_connector_auth_test(
        ConnectorAuthTestRequest(
            inline_flat_source={
                "base_url": "https://cyber.example",
                "verify_ssl": True,
                "headers": {},
                "auth_type": "session_login",
                "login_path": "/login.html",
                "login_method": "POST",
                "login_username": "u",
                "login_password": "p",
                "login_body_mode": "form_urlencoded",
                "login_body_raw": "username={{username}}&password={{password}}",
                "login_allow_redirects": False,
                "login_headers": {"Content-Type": "application/x-www-form-urlencoded"},
            },
            method="GET",
            test_path="/rest/users/current",
        ),
        MagicMock(),
    )

    assert len(calls) == 2
    assert calls[0]["method"] == "POST"
    assert calls[0].get("follow_redirects") is False
    assert calls[0].get("data") == "username=u&password=p"
    assert "json" not in calls[0]
    assert res.ok is True
    assert res.session_login_body_mode == "form_urlencoded"
    assert res.session_login_follow_redirects is False
    assert res.session_login_request_encoding == "data"
    assert res.session_login_content_type == "application/x-www-form-urlencoded"
    assert res.session_login_body_preview is not None
    assert "********" in (res.session_login_body_preview or "")


def test_connector_auth_test_request_requires_saved_or_valid_inline_source() -> None:
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        ConnectorAuthTestRequest(method="GET", test_path="/only")
    with pytest.raises(ValidationError):
        ConnectorAuthTestRequest(
            connector_id=1,
            inline_flat_source={},
            method="GET",
            test_path="/",
        )

    payload = ConnectorAuthTestRequest(
        connector_id=1,
        inline_flat_source={"base_url": "https://draft.test", "auth_type": "bearer", "bearer_token": "draft"},
        method="GET",
        test_path="/",
    )
    assert payload.connector_id == 1
    assert payload.inline_flat_source is not None
