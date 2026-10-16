from __future__ import annotations

import json

import httpx
import pytest

from app.http.shared_request_builder import build_shared_http_request
from app.pollers.http_poller import HttpPoller
from app.pollers.http_query_params import (
    coerce_stream_body_fields_to_json_objects,
    drop_placeholder_pagination_params,
    httpx_body_kwargs,
)
from app.runtime.errors import SourceFetchError


def test_drop_placeholder_removes_templated_cursor_when_pagination_none():
    stream_config = {"pagination": {"type": "None"}, "endpoint": "/x"}
    params = {"cursor": "{{checkpoint.cursor}}", "filter": "active"}
    assert drop_placeholder_pagination_params(stream_config, params) == {"filter": "active"}


def test_drop_placeholder_keeps_static_limit():
    stream_config: dict = {"pagination": {"type": "none"}}
    assert drop_placeholder_pagination_params(stream_config, {"limit": "100"}) == {"limit": "100"}


def test_drop_placeholder_keeps_all_params_when_cursor_pagination_enabled():
    stream_config = {"pagination": {"type": "Cursor based"}}
    params = {"cursor": "{{checkpoint.cursor}}"}
    assert drop_placeholder_pagination_params(stream_config, params) == params


def test_api_test_pagination_param_uses_explicit_next_cursor_checkpoint():
    plan = build_shared_http_request(
        source_config={"base_url": "https://example.test"},
        stream_config={
            "method": "GET",
            "endpoint": "/events",
            "params": {"tenant": "acme", "cursor": "{{checkpoint.next_cursor}}"},
            "pagination": {"type": "Cursor based", "cursor_param": "cursor"},
        },
        mode="api_test",
        api_test_checkpoint={"next_cursor": "cursor-42"},
    )
    assert plan.params == {"tenant": "acme", "cursor": "cursor-42"}


def test_http_poller_sends_json_body_on_get(monkeypatch: pytest.MonkeyPatch):
    captured: dict = {}

    class _CaptureClient:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        def __enter__(self) -> _CaptureClient:
            return self

        def __exit__(self, *args: object) -> None:
            return None

        def request(self, method: str, url: str, **kwargs: object) -> httpx.Response:
            captured.clear()
            captured.update({"method": method, "url": url, **kwargs})
            req = httpx.Request(method, url)
            return httpx.Response(200, request=req, json={"hits": {"hits": []}})

    monkeypatch.setattr("app.pollers.http_poller.httpx.Client", _CaptureClient)
    monkeypatch.setattr(
        "app.pollers.http_poller._apply_auth_to_request",
        lambda auth, h, p, *rest: (h, p),
    )

    poller = HttpPoller()
    poller.fetch(
        {"base_url": "https://xdr.test", "common_headers": {}},
        {
            "method": "GET",
            "endpoint": "/connect/api/data/aella-ser-*/_search",
            "params": {},
            "body": {"size": 10, "query": {"bool": {"filter": []}}},
            "pagination": {"type": "None"},
        },
        None,
    )

    assert captured.get("method") == "GET"
    assert captured.get("params") in (None, {})
    assert captured.get("json") == {"size": 10, "query": {"bool": {"filter": []}}}


def test_http_poller_post_without_body_no_json_key(monkeypatch: pytest.MonkeyPatch):
    captured: dict = {}

    class _CaptureClient:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        def __enter__(self) -> _CaptureClient:
            return self

        def __exit__(self, *args: object) -> None:
            return None

        def request(self, method: str, url: str, **kwargs: object) -> httpx.Response:
            captured.clear()
            captured.update(kwargs)
            req = httpx.Request(method, url)
            return httpx.Response(200, request=req, json={})

    monkeypatch.setattr("app.pollers.http_poller.httpx.Client", _CaptureClient)
    monkeypatch.setattr(
        "app.pollers.http_poller._apply_auth_to_request",
        lambda auth, h, p, *rest: (h, p),
    )

    poller = HttpPoller()
    poller.fetch(
        {"base_url": "https://example.test", "common_headers": {}},
        {"method": "POST", "endpoint": "/v1", "params": {}},
        None,
    )

    assert "json" not in captured or captured.get("json") is None


def test_httpx_body_kwargs_decodes_json_object_string():
    body = '{\n  "size": 10,\n  "query": {"bool": {"filter": []}}\n}'
    kw = httpx_body_kwargs(body, {"Content-Type": "application/json"})
    assert kw == {"json": {"size": 10, "query": {"bool": {"filter": []}}}}


def test_httpx_body_kwargs_decodes_double_json_encoded_string():
    inner = '{"size": 10, "sort": [{"_id": "asc"}]}'
    outer = json.dumps(inner)
    kw = httpx_body_kwargs(outer, {"Content-Type": "application/json"})
    assert kw["json"] == {"size": 10, "sort": [{"_id": "asc"}]}


def test_httpx_body_kwargs_plain_text_without_json_content_type_uses_content():
    kw = httpx_body_kwargs("plain payload", {"Content-Type": "text/plain"})
    assert list(kw.keys()) == ["content"]
    assert kw["content"] == b"plain payload"


def test_http_poller_get_with_json_string_body_sends_decoded_object(monkeypatch: pytest.MonkeyPatch):
    captured: dict = {}

    class _CaptureClient:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        def __enter__(self) -> _CaptureClient:
            return self

        def __exit__(self, *args: object) -> None:
            return None

        def request(self, method: str, url: str, **kwargs: object) -> httpx.Response:
            captured.clear()
            captured.update({"method": method, "url": url, **kwargs})
            req = httpx.Request(method, url)
            return httpx.Response(200, request=req, json={"hits": {"hits": []}})

    monkeypatch.setattr("app.pollers.http_poller.httpx.Client", _CaptureClient)
    monkeypatch.setattr(
        "app.pollers.http_poller._apply_auth_to_request",
        lambda auth, h, p, *rest: (h, p),
    )

    json_text = json.dumps(
        {"size": 10, "sort": [{"timestamp": "asc"}], "query": {"bool": {"filter": []}}},
        indent=2,
    )

    poller = HttpPoller()
    poller.fetch(
        {"base_url": "https://xdr.test", "common_headers": {"Content-Type": "application/json"}},
        {
            "method": "GET",
            "endpoint": "/connect/api/data/aella-ser-*/_search",
            "params": {},
            "body": json_text,
            "pagination": {"type": "None"},
        },
        None,
    )

    jb = captured.get("json")
    assert isinstance(jb, dict), "runtime must send dict via json=, not a JSON-encoded string"
    assert jb["size"] == 10
    assert isinstance(jb["sort"], list)


def test_coerce_stream_body_fields_parses_json_string_to_object():
    cfg = coerce_stream_body_fields_to_json_objects(
        {
            "method": "GET",
            "endpoint": "/_search",
            "body": '{\n  "size": 10,\n  "query": {"bool": {"filter": []}}\n}',
        }
    )
    assert cfg["body"] == {"size": 10, "query": {"bool": {"filter": []}}}


def test_http_poller_source_error_body_preview_is_normalized_object(monkeypatch: pytest.MonkeyPatch):
    """Regression: outbound debug must reflect parsed JSON object, not a quoted JSON string."""

    class _BadClient:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        def __enter__(self) -> _BadClient:
            return self

        def __exit__(self, *args: object) -> None:
            return None

        def request(self, method: str, url: str, **kwargs: object) -> httpx.Response:
            req = httpx.Request(method, url)
            return httpx.Response(400, request=req, json={"error": "Invalid JSON format"})

    monkeypatch.setattr("app.pollers.http_poller.httpx.Client", _BadClient)
    monkeypatch.setattr(
        "app.pollers.http_poller._apply_auth_to_request",
        lambda auth, h, p, *rest: (h, p),
    )

    poller = HttpPoller()
    with pytest.raises(SourceFetchError) as excinfo:
        poller.fetch(
            {"base_url": "https://stellar.test", "common_headers": {"Content-Type": "application/json"}},
            {
                "method": "GET",
                "endpoint": "/ser/_search",
                "params": {},
                "body": '{"size": 10, "sort": [{"timestamp": "asc"}], "query": {"bool": {"filter": []}}}',
                "pagination": {"type": "none"},
            },
            None,
        )

    preview = str(excinfo.value.detail.get("body_preview") or "")
    assert preview.strip().startswith("{"), preview[:200]
    assert "size" in preview and "10" in preview
