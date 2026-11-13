"""Incremental request test — API test checkpoint substitution and HTTP preview."""

from __future__ import annotations

import json

import httpx
import pytest

from app.http.shared_request_builder import api_test_checkpoint_replacements, build_shared_http_request
from app.runtime.preview_service import PreviewRequestError, run_http_api_test
from app.runtime.schemas import HttpApiTestRequest

_HTTPX_CLIENT = "app.connectors.auth_execute.httpx.Client"


class _FakeClient:
    def __init__(self, responses: list[httpx.Response]):
        self._responses = responses
        self.last_kwargs: dict | None = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def request(self, method: str, url: str, **kwargs):
        self.last_kwargs = kwargs
        return self._responses.pop(0)


def _httpx_response(method: str, url: str, status_code: int, *, json_body=None):
    request = httpx.Request(method, url)
    return httpx.Response(status_code=status_code, request=request, json=json_body)


def test_api_test_checkpoint_replacements_supports_explicit_placeholders() -> None:
    repl = api_test_checkpoint_replacements(
        {
            "last_timestamp": "1700000000000",
            "last_timestamp_ms": "1700000000000",
            "last_event_id": "evt-9",
            "next_cursor": "cursor-abc",
        }
    )
    assert repl["{{checkpoint.last_timestamp}}"] == "1700000000000"
    assert repl["{{checkpoint.last_event_id}}"] == "evt-9"
    assert repl["{{checkpoint.next_cursor}}"] == "cursor-abc"
    assert repl["{{now}}"]
    assert repl["{{runtime.now_ms}}"]


def test_api_test_substitutes_incremental_json_body(monkeypatch: pytest.MonkeyPatch) -> None:
    response = _httpx_response(
        "POST",
        "https://example.test/v1/search",
        200,
        json_body={"data": {"events": [{"id": "1"}, {"id": "2"}]}},
    )
    fake = _FakeClient([response])
    monkeypatch.setattr(_HTTPX_CLIENT, lambda *args, **kwargs: fake)

    body_template = json.dumps(
        {
            "from": "{{checkpoint.last_timestamp}}",
            "to": "{{now}}",
            "limit": 100,
        }
    )
    payload = HttpApiTestRequest(
        source_config={"base_url": "https://example.test"},
        stream_config={
            "method": "POST",
            "endpoint": "/v1/search",
            "body": body_template,
            "event_array_path": "data.events",
        },
        checkpoint={"last_timestamp": "1700000000000", "last_timestamp_ms": "1700000000000"},
    )
    result = run_http_api_test(payload)
    assert result.ok is True
    assert fake.last_kwargs is not None
    sent = fake.last_kwargs.get("json")
    assert sent is not None
    assert sent["from"] == "1700000000000"
    assert sent["to"] != "{{now}}"
    assert "{{checkpoint.last_timestamp}}" not in json.dumps(sent)


def test_shared_builder_api_test_does_not_mutate_template_string_in_stream_config() -> None:
    template = '{"from":"{{checkpoint.last_timestamp}}","to":"{{now}}"}'
    stream_config = {"method": "POST", "endpoint": "/v1/search", "body": template}
    plan = build_shared_http_request(
        source_config={"base_url": "https://example.test"},
        stream_config=stream_config,
        mode="api_test",
        api_test_checkpoint={"last_timestamp": "99"},
    )
    assert plan.normalized_json_body["from"] == "99"
    assert stream_config["body"] == template


def test_api_test_http_error_surfaces_for_incremental_test(monkeypatch: pytest.MonkeyPatch) -> None:
    response = _httpx_response("POST", "https://example.test/v1/search", 400, json_body={"error": "bad"})
    monkeypatch.setattr(_HTTPX_CLIENT, lambda *args, **kwargs: _FakeClient([response]))
    payload = HttpApiTestRequest(
        source_config={"base_url": "https://example.test"},
        stream_config={"method": "POST", "endpoint": "/v1/search", "body": '{"from":"{{checkpoint.last_timestamp}}"}'},
        checkpoint={"last_timestamp": "1"},
    )
    with pytest.raises(PreviewRequestError) as exc:
        run_http_api_test(payload)
    assert exc.value.detail.get("target_status_code") == 400


def test_fetch_sample_without_checkpoint_uses_neutral_checkpoint_replacements(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = _httpx_response(
        "POST",
        "https://example.test/v1/search",
        200,
        json_body={"data": {"events": [{"id": "1"}]}},
    )
    fake = _FakeClient([response])
    monkeypatch.setattr(_HTTPX_CLIENT, lambda *args, **kwargs: fake)

    payload = HttpApiTestRequest(
        source_config={"base_url": "https://example.test"},
        stream_config={
            "method": "POST",
            "endpoint": "/v1/search",
            "body": '{"from":"{{checkpoint.last_timestamp}}","to":"{{now}}"}',
            "event_array_path": "data.events",
        },
        checkpoint=None,
        fetch_sample=True,
    )
    result = run_http_api_test(payload)
    assert result.ok is True
    assert fake.last_kwargs is not None
    sent = fake.last_kwargs.get("json")
    assert isinstance(sent, dict)
    assert sent["from"] == "0"
    assert "{{checkpoint.last_timestamp}}" not in json.dumps(sent)


def test_api_test_checkpoint_replacements_match_runtime_aliases() -> None:
    """F-120: {{checkpoint.value}} / cursor / last_seen are runtime aliases; Run Test must substitute them."""

    repl = api_test_checkpoint_replacements({"value": "6899", "last_timestamp": "6899", "last_event_id": "6899"})

    assert repl["{{checkpoint.value}}"] == "6899"
    assert repl["{{checkpoint.cursor}}"] == "6899"
    assert repl["{{checkpoint.last_seen}}"] == "6899"
    # Names the runtime does not know stay unsubstituted so the wizard can flag them.
    assert "{{checkpoint.last_id}}" not in repl
