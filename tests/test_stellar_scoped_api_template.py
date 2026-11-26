"""Stellar Cyber scoped-key starter template: no live DP or operator keys required."""

from __future__ import annotations

from unittest.mock import patch

import httpx
import pytest

from app.connectors.auth.normalize import normalize_connector_auth
from app.connectors.auth.registry import apply_auth_to_http_request
from app.runtime.errors import PreviewRequestError
from app.templates.registry import get_template, load_template_definitions


TEMPLATE_ID = "stellar_cyber_scoped_cases_api"
HOST = "https://dp.example.invalid"
SCOPED_KEY = "fixture-scoped-key-do-not-use"


def test_scoped_cases_template_is_discoverable_and_read_only() -> None:
    assert TEMPLATE_ID in load_template_definitions(force_reload=True)
    template = get_template(TEMPLATE_ID)
    assert template is not None
    assert template.auth_type == "jwt_refresh_token"
    assert template.connector_defaults["verify_ssl"] is True
    assert template.connector_defaults["token_path"] == "/connect/api/v1/access_token"
    assert template.connector_defaults["token_http_method"] == "POST"
    assert template.connector_defaults["refresh_token_header_prefix"] == "Bearer"
    assert template.connector_defaults["token_ttl_seconds"] == 600
    assert template.stream_defaults["config_json"]["method"] == "GET"
    assert template.stream_defaults["config_json"]["endpoint"].startswith("/connect/api/v1/cases?")
    assert template.mapping_defaults["event_array_path"] == "$.data.cases"
    assert template.mapping_defaults["field_mappings_json"]["case_id"] == "$._id"
    assert template.route_suggestions[0]["enabled"] is False
    assert "refresh_token" not in template.connector_defaults
    assert SCOPED_KEY not in str(template.model_dump())


def test_scoped_key_exchanged_without_basic_auth_or_request_body() -> None:
    template = get_template(TEMPLATE_ID)
    assert template is not None
    auth = normalize_connector_auth({
        **template.connector_defaults,
        "refresh_token": SCOPED_KEY,
    })
    seen = []

    def respond(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        assert request.method == "POST"
        assert str(request.url) == HOST + "/connect/api/v1/access_token"
        assert request.headers["Authorization"] == "Bearer " + SCOPED_KEY
        assert request.content == b""
        return httpx.Response(200, json={"access_token": "fixture-short-lived-jwt"})

    transport = httpx.MockTransport(respond)
    client = httpx.Client(transport=transport)
    with patch("app.connectors.auth.runtime_extra_strategies.httpx.Client", return_value=client):
        headers, params = apply_auth_to_http_request(
            auth, {}, {}, verify_ssl=True, proxy_url=None, timeout_seconds=10, base_url=HOST,
        )
    assert len(seen) == 1
    assert headers == {"Authorization": "Bearer fixture-short-lived-jwt"}
    assert params == {}


@pytest.mark.parametrize("status,payload", [
    (401, {"error": "invalid scoped key"}),
    (200, {"not_access_token": "missing"}),
])
def test_scoped_exchange_rejects_invalid_key_or_missing_jwt(status: int, payload: dict) -> None:
    template = get_template(TEMPLATE_ID)
    assert template is not None
    auth = normalize_connector_auth({**template.connector_defaults, "refresh_token": SCOPED_KEY})
    transport = httpx.MockTransport(lambda _: httpx.Response(status, json=payload))
    client = httpx.Client(transport=transport)
    with patch("app.connectors.auth.runtime_extra_strategies.httpx.Client", return_value=client):
        with pytest.raises(PreviewRequestError):
            apply_auth_to_http_request(
                auth, {}, {}, verify_ssl=True, proxy_url=None, timeout_seconds=10, base_url=HOST,
            )
