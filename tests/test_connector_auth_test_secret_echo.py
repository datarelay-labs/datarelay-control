"""E-096: connector Test Authentication / HTTP API test must not echo query-carried secrets.

Every user-visible field of the response (message, request/probe/final/token request URLs, response
bodies that echo the URL, persisted last-auth-error text) must carry the query parameter *name* with the
value replaced by the mask. Masking is keyed on the parameter name, not on matching the saved value, so a
wrong typed value is masked as well.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest

from app.runtime.preview_service import PreviewRequestError, run_connector_auth_test, run_http_api_test
from app.runtime.schemas import ConnectorAuthTestRequest, HttpApiTestRequest

_MASK = "********"
_SECRET = "K3y-9f2c71ab-LIVE"
_WRONG = "wrong-key-b8"
_TOKEN = "AT-0f9e8d7c-LIVE"


class _EchoClient:
    """Fake httpx.Client whose server echoes the full request URL (incl. query) in the body."""

    def __init__(self, status: int = 200, token_body: dict[str, Any] | None = None, raise_connect: bool = False):
        self.status = status
        self.token_body = token_body
        self.raise_connect = raise_connect
        self.calls: list[tuple[str, str, dict[str, Any]]] = []

    def __enter__(self) -> _EchoClient:
        return self

    def __exit__(self, *a: object) -> bool:
        return False

    def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        params = kwargs.get("params")
        req = httpx.Request(method, url, params=params)
        self.calls.append((method, str(req.url), dict(kwargs)))
        if self.raise_connect:
            raise httpx.ConnectError(f"All connection attempts failed for {req.url}")
        if self.token_body is not None and "/token" in url:
            return httpx.Response(200, request=req, json=self.token_body)
        return httpx.Response(self.status, request=req, text=f"you requested {req.url}")


def _install(monkeypatch: pytest.MonkeyPatch, client: _EchoClient) -> _EchoClient:
    monkeypatch.setattr("app.runtime.preview_service.httpx.Client", lambda *a, **k: client)
    return client


def _all_text(res: Any) -> str:
    return json.dumps(res.model_dump(), ensure_ascii=False, default=str)


def _api_key_query_source(value: str, name: str = "api_key") -> dict[str, Any]:
    return {
        "base_url": "http://probe.test:19974",
        "verify_ssl": True,
        "headers": {},
        "auth_type": "api_key",
        "api_key_name": name,
        "api_key_value": value,
        "api_key_location": "query_params",
    }


@pytest.mark.parametrize("value", [_SECRET, _WRONG])
def test_api_key_query_params_is_masked_in_every_response_field(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    client = _install(monkeypatch, _EchoClient())

    res = run_connector_auth_test(
        ConnectorAuthTestRequest(
            inline_flat_source=_api_key_query_source(value),
            method="GET",
            test_path="/apikey/events",
        ),
        None,
    )

    # The probe really carried the typed key to the target ...
    assert client.calls and f"api_key={value}" in client.calls[0][1]
    # ... but nothing user-visible does.
    text = _all_text(res)
    assert value not in text
    assert f"api_key={_MASK}" in (res.request_url or "")
    assert f"api_key={_MASK}" in (res.message or "")
    assert res.ok is True


def test_api_key_query_params_preserves_other_query_params_in_echo(monkeypatch: pytest.MonkeyPatch) -> None:
    _install(monkeypatch, _EchoClient())

    res = run_connector_auth_test(
        ConnectorAuthTestRequest(
            inline_flat_source=_api_key_query_source(_SECRET),
            method="GET",
            test_path="/apikey/events",
            query_params={"limit": "2"},
        ),
        None,
    )

    assert "limit=2" in (res.request_url or "")
    assert _SECRET not in _all_text(res)


def test_custom_api_key_query_name_is_masked(monkeypatch: pytest.MonkeyPatch) -> None:
    _install(monkeypatch, _EchoClient())

    res = run_connector_auth_test(
        ConnectorAuthTestRequest(
            inline_flat_source=_api_key_query_source(_SECRET, name="acct_ref"),
            method="GET",
            test_path="/x",
        ),
        None,
    )

    assert _SECRET not in _all_text(res)
    assert f"acct_ref={_MASK}" in (res.request_url or "")


@pytest.mark.parametrize(
    "name",
    ["api_key", "apikey", "access_token", "token", "key", "secret", "password", "sig", "signature"],
)
def test_common_secret_names_in_probe_query_are_masked(monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    _install(monkeypatch, _EchoClient())

    res = run_connector_auth_test(
        ConnectorAuthTestRequest(
            inline_flat_source={"base_url": "http://probe.test:19974", "auth_type": "no_auth", "headers": {}},
            method="GET",
            test_path="/x",
            query_params={name: "typed-value-123456", "limit": "5"},
        ),
        None,
    )

    text = _all_text(res)
    assert "typed-value-123456" not in text
    assert f"{name}={_MASK}" in (res.request_url or "")
    assert "limit=5" in (res.request_url or "")


def test_secret_in_test_path_query_is_masked(monkeypatch: pytest.MonkeyPatch) -> None:
    _install(monkeypatch, _EchoClient())

    res = run_connector_auth_test(
        ConnectorAuthTestRequest(
            inline_flat_source={"base_url": "http://probe.test:19974", "auth_type": "no_auth", "headers": {}},
            method="GET",
            test_path="/events?sig=pathsig-98765432&limit=1",
        ),
        None,
    )

    text = _all_text(res)
    assert "pathsig-98765432" not in text
    assert "limit=1" in text


def test_transport_error_text_is_masked(monkeypatch: pytest.MonkeyPatch) -> None:
    _install(monkeypatch, _EchoClient(raise_connect=True))

    res = run_connector_auth_test(
        ConnectorAuthTestRequest(
            inline_flat_source=_api_key_query_source(_SECRET),
            method="GET",
            test_path="/apikey/events",
        ),
        None,
    )

    assert res.ok is False
    assert res.error_type == "network_error"
    assert _SECRET not in _all_text(res)


def test_saved_connector_secret_never_appears_even_when_value_unknown_to_client(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _install(monkeypatch, _EchoClient())
    monkeypatch.setattr(
        "app.runtime.preview_service._load_source_config_for_connector",
        lambda db, cid: _api_key_query_source(_SECRET),
    )

    res = run_connector_auth_test(
        ConnectorAuthTestRequest(connector_id=16, method="GET", test_path="/apikey/events"),
        MagicMock(),
    )

    assert f"api_key={_SECRET}" in client.calls[0][1]
    assert _SECRET not in _all_text(res)


def _vendor_source(injection: str, **extra: Any) -> dict[str, Any]:
    return {
        "base_url": "http://probe.test:19974",
        "verify_ssl": True,
        "headers": {},
        "auth_type": "vendor_jwt_exchange",
        "user_id": "uid1",
        "api_key": "vendor-api-key-value",
        "token_url": "/token",
        "token_method": "POST",
        "token_auth_mode": "basic_user_api_key",
        "token_body_mode": "empty",
        "token_path": "$.access_token",
        "access_token_injection": injection,
        **extra,
    }


@pytest.mark.parametrize("query_name", [None, "my_session_ref"])
def test_vendor_access_token_query_param_injection_is_masked(monkeypatch: pytest.MonkeyPatch, query_name: str | None) -> None:
    client = _install(monkeypatch, _EchoClient(token_body={"access_token": _TOKEN}))
    extra = {"access_token_query_name": query_name} if query_name else {}

    res = run_connector_auth_test(
        ConnectorAuthTestRequest(
            inline_flat_source=_vendor_source("query_param", **extra),
            method="GET",
            test_path="/events",
        ),
        None,
    )

    final_url = client.calls[1][1]
    assert f"{query_name or 'access_token'}={_TOKEN}" in final_url
    text = _all_text(res)
    assert _TOKEN not in text
    assert f"{query_name or 'access_token'}={_MASK}" in (res.final_request_url or "")
    assert f"{query_name or 'access_token'}={_MASK}" in (res.message or "")
    assert res.ok is True


def test_vendor_token_exchange_api_key_query_is_masked(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _install(monkeypatch, _EchoClient(token_body={"access_token": _TOKEN}))

    res = run_connector_auth_test(
        ConnectorAuthTestRequest(
            inline_flat_source=_vendor_source(
                "bearer_authorization",
                token_auth_mode="api_key_query",
                api_key_name="vendor_key",
                api_key_value=_SECRET,
            ),
            method="GET",
            test_path="/events",
        ),
        None,
    )

    assert f"vendor_key={_SECRET}" in client.calls[0][1]
    text = _all_text(res)
    assert _SECRET not in text
    assert f"vendor_key={_MASK}" in (res.token_request_url or "")


def test_vendor_final_failure_message_is_masked(monkeypatch: pytest.MonkeyPatch) -> None:
    _install(monkeypatch, _EchoClient(status=401, token_body={"access_token": _TOKEN}))

    res = run_connector_auth_test(
        ConnectorAuthTestRequest(
            inline_flat_source=_vendor_source("query_param"),
            method="GET",
            test_path="/events",
        ),
        None,
    )

    assert res.ok is False
    assert _TOKEN not in _all_text(res)


# --- POST /runtime/api-test/http (stream sample test) ---------------------------------------------------


class _LabClient:
    def __init__(self, status: int = 200) -> None:
        self.status = status

    def __enter__(self) -> _LabClient:
        return self

    def __exit__(self, *a: object) -> bool:
        return False

    def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        req = httpx.Request(method, url, params=kwargs.get("params"))
        if self.status == 200:
            return httpx.Response(200, request=req, json={"data": {"events": [{"id": 1}]}, "echo": str(req.url)})
        return httpx.Response(self.status, request=req, json={"error": "denied", "echo": str(req.url)})


def _http_test_payload(value: str) -> HttpApiTestRequest:
    return HttpApiTestRequest(
        source_config=_api_key_query_source(value),
        stream_config={"method": "GET", "endpoint": "/apikey/events", "event_array_path": "data.events"},
    )


def test_http_api_test_success_masks_effective_request_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.connectors.auth_execute.httpx.Client", lambda *a, **k: _LabClient(200))

    res = run_http_api_test(_http_test_payload(_SECRET))

    assert res.ok is True
    assert _SECRET not in res.request.url
    assert f"api_key={_MASK}" in res.request.url
    assert res.actual_request_sent is not None
    assert _SECRET not in res.actual_request_sent.url
    assert _SECRET not in json.dumps([s.model_dump() for s in res.steps])


def test_http_api_test_failure_detail_masks_url_echoes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.connectors.auth_execute.httpx.Client", lambda *a, **k: _LabClient(401))

    with pytest.raises(PreviewRequestError) as exc:
        run_http_api_test(_http_test_payload(_SECRET))

    assert _SECRET not in json.dumps(exc.value.detail, default=str)


# --- HTTP endpoints (the same contract the browser and E-096-VERIFY exercise) -----------------------------


def test_connector_auth_endpoint_never_returns_query_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient

    from app.main import app

    client = _install(monkeypatch, _EchoClient())

    response = TestClient(app).post(
        "/api/v1/runtime/api-test/connector-auth",
        json={
            "inline_flat_source": _api_key_query_source(_SECRET),
            "method": "GET",
            "test_path": "/apikey/events",
        },
    )

    assert response.status_code == 200
    assert f"api_key={_SECRET}" in client.calls[0][1]
    assert _SECRET not in response.text
    body = response.json()
    assert f"api_key={_MASK}" in body["message"]
    assert f"api_key={_MASK}" in body["request_url"]


def test_http_api_test_endpoint_never_returns_query_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient

    from app.main import app

    monkeypatch.setattr("app.connectors.auth_execute.httpx.Client", lambda *a, **k: _LabClient(401))

    response = TestClient(app).post(
        "/api/v1/runtime/api-test/http",
        json={
            "source_config": _api_key_query_source(_SECRET),
            "stream_config": {"method": "GET", "endpoint": "/apikey/events"},
        },
    )

    assert response.status_code == 400
    assert _SECRET not in response.text


def test_stored_last_auth_error_from_before_the_fix_is_masked_on_read() -> None:
    """Probe messages persisted by earlier versions may still carry a query-string credential."""

    from app.connectors.operations_service import read_operational_config

    stored = {"operational": {"last_auth_error": "401 GET http://h/p?limit=2&api_key=OLD-LEAK-12345 -> HTTP 401"}}

    err = read_operational_config(stored)["last_auth_error"]

    assert "OLD-LEAK-12345" not in err
    assert f"api_key={_MASK}" in err and "limit=2" in err
