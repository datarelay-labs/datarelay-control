"""Runtime vs API test parity for HTTP request time and checkpoint template variables."""

from __future__ import annotations

import json
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from app.http import shared_request_builder
from app.http.shared_request_builder import build_shared_http_request
from app.pollers.http_poller import HttpPoller

# 2026-10-29T12:39:44Z
_FROZEN_NOW = 1793277584.25
_FROZEN_ISO = "2026-10-29T12:39:44Z"
_FROZEN_MS = "1793277584250"
_FROZEN_START_MS = str(int(_FROZEN_MS) - 86400000)

_SRC = {"base_url": "https://api.example", "headers": {"X-Conn-Now": "{{now}}"}}

# Wizard default "Query Parameters" incremental template (Timestamp checkpoint).
_WIZARD_PARAMS = {
    "limit": "100",
    "timestamp_gt": "{{checkpoint.last_timestamp}}",
    "timestamp_lte": "{{now}}",
    "sort": "timestamp:asc",
}


@pytest.fixture(autouse=True)
def _freeze_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(shared_request_builder, "_utc_now_seconds", lambda: _FROZEN_NOW)


def _time_stream_config() -> dict:
    return {
        "endpoint": "/events/{{runtime.now_ms}}",
        "method": "POST",
        "headers": {"X-Now": "{{now}}", "X-Now-Iso": "{{runtime.now_iso}}"},
        "params": {
            "now": "{{now}}",
            "now_ms": "{{runtime.now_ms}}",
            "start": "{{start_ms}}",
            "end": "{{end_ms}}",
        },
        "body": '{"lte":"{{now}}","window":["{{start_ms}}","{{end_ms}}"]}',
    }


def _assert_time_rendered(plan: shared_request_builder.SharedHttpRequestPlan) -> None:
    assert plan.params == {"now": _FROZEN_ISO, "now_ms": _FROZEN_MS, "start": _FROZEN_START_MS, "end": _FROZEN_MS}
    assert plan.connector_headers == {"X-Conn-Now": _FROZEN_ISO}
    assert plan.stream_headers == {"X-Now": _FROZEN_ISO, "X-Now-Iso": _FROZEN_ISO}
    body = plan.normalized_json_body
    body = json.loads(body) if isinstance(body, str) else body
    assert body == {"lte": _FROZEN_ISO, "window": [_FROZEN_START_MS, _FROZEN_MS]}


def test_runtime_renders_time_variables_in_endpoint_headers_params_and_body() -> None:
    plan = build_shared_http_request(
        source_config=_SRC,
        stream_config=_time_stream_config(),
        mode="runtime",
        checkpoint_value={},
    )
    assert plan.url == f"https://api.example/events/{_FROZEN_MS}"
    _assert_time_rendered(plan)


def test_runtime_renders_time_variables_in_dict_body() -> None:
    stm = {"endpoint": "/events", "method": "POST", "body": {"range": {"lte": "{{now}}", "end": "{{end_ms}}"}}}
    plan = build_shared_http_request(source_config=_SRC, stream_config=stm, mode="runtime", checkpoint_value={})
    assert plan.normalized_json_body == {"range": {"lte": _FROZEN_ISO, "end": _FROZEN_MS}}


def test_runtime_and_api_test_render_time_variables_identically() -> None:
    runtime = build_shared_http_request(
        source_config=_SRC,
        stream_config=_time_stream_config(),
        mode="runtime",
        checkpoint_value={},
    )
    api_test = build_shared_http_request(
        source_config=_SRC,
        stream_config=_time_stream_config(),
        mode="api_test",
        api_test_checkpoint=None,
    )
    _assert_time_rendered(api_test)
    assert runtime.params == api_test.params
    assert runtime.connector_headers == api_test.connector_headers
    assert runtime.stream_headers == api_test.stream_headers


def test_wizard_default_query_template_runtime_matches_api_test_for_iso_checkpoint() -> None:
    """D1 + D2: the request the API test validates is the request the poller sends."""

    stm = {"endpoint": "/events", "method": "GET", "params": dict(_WIZARD_PARAMS)}
    checkpoint = {"last_timestamp": "2026-10-29T12:01:00Z"}
    runtime = build_shared_http_request(source_config=_SRC, stream_config=stm, mode="runtime", checkpoint_value=checkpoint)
    api_test = build_shared_http_request(source_config=_SRC, stream_config=stm, mode="api_test", api_test_checkpoint=checkpoint)
    expected = {
        "limit": "100",
        "timestamp_gt": "2026-10-29T12:01:00Z",
        "timestamp_lte": _FROZEN_ISO,
        "sort": "timestamp:asc",
    }
    assert runtime.params == expected
    assert api_test.params == expected


def test_api_test_resolves_last_success_event_checkpoint_like_runtime() -> None:
    """A stored runtime checkpoint (``last_success_event``) must render the same raw ISO value in both paths."""

    stm = {
        "endpoint": "/events",
        "method": "GET",
        "event_array_path": "$.items",
        "checkpoint": {"mode": "Timestamp", "cursor_path": "$.items[*].timestamp"},
        "params": dict(_WIZARD_PARAMS),
    }
    checkpoint = {"last_success_event": {"id": "e1", "timestamp": "2026-10-29T12:01:00Z"}}
    runtime = build_shared_http_request(source_config=_SRC, stream_config=stm, mode="runtime", checkpoint_value=checkpoint)
    api_test = build_shared_http_request(source_config=_SRC, stream_config=stm, mode="api_test", api_test_checkpoint=checkpoint)
    assert runtime.params["timestamp_gt"] == "2026-10-29T12:01:00Z"
    assert api_test.params["timestamp_gt"] == runtime.params["timestamp_gt"]
    assert api_test.params == runtime.params


def test_api_test_keeps_explicit_last_timestamp_ms_numeric() -> None:
    stm = {
        "endpoint": "/events",
        "method": "GET",
        "params": {"gt": "{{checkpoint.last_timestamp}}", "gt_ms": "{{checkpoint.last_timestamp_ms}}"},
    }
    checkpoint = {"last_timestamp": "2026-10-29T12:01:00Z", "last_timestamp_ms": "1793275260000"}
    api_test = build_shared_http_request(source_config=_SRC, stream_config=stm, mode="api_test", api_test_checkpoint=checkpoint)
    runtime = build_shared_http_request(source_config=_SRC, stream_config=stm, mode="runtime", checkpoint_value=checkpoint)
    assert api_test.params == {"gt": "2026-10-29T12:01:00Z", "gt_ms": "1793275260000"}
    assert runtime.params == api_test.params


def test_runtime_checkpoint_and_unknown_placeholders_keep_existing_behavior() -> None:
    stm = {
        "endpoint": "/events",
        "method": "GET",
        "params": {
            "after": "{{checkpoint.cursor}}",
            "missing_ts": "{{checkpoint.last_timestamp}}",
            "missing_custom": "{{checkpoint.custom_field}}",
            "unknown": "{{something.else}}",
        },
    }
    plan = build_shared_http_request(
        source_config=_SRC,
        stream_config=stm,
        mode="runtime",
        checkpoint_value={"cursor": "tok-1"},
    )
    assert plan.params == {
        "after": "tok-1",
        "missing_ts": "0",
        "missing_custom": "",
        "unknown": "{{something.else}}",
    }


# --- {{start_ts}} / {{end_ts}} (advertised by the wizard variable chips) ---
# Old code left both placeholders literal in runtime and API test requests, so every assertion below on a
# rendered start_ts/end_ts value fails on the old code (the param equals "{{start_ts}}" / "{{end_ts}}").

_FROZEN_START_FALLBACK_ISO = "2026-10-28T12:39:44Z"  # _FROZEN_ISO minus 24 hours

_WINDOW_STREAM = {
    "endpoint": "/events",
    "method": "POST",
    "headers": {"X-Window-End": "{{end_ts}}"},
    "params": {"from": "{{start_ts}}", "to": "{{end_ts}}"},
    "body": '{"range":{"gt":"{{start_ts}}","lte":"{{end_ts}}"}}',
}


def _window_plans(checkpoint: dict | None):
    runtime = build_shared_http_request(
        source_config=_SRC, stream_config=_WINDOW_STREAM, mode="runtime", checkpoint_value=checkpoint
    )
    api_test = build_shared_http_request(
        source_config=_SRC, stream_config=_WINDOW_STREAM, mode="api_test", api_test_checkpoint=checkpoint
    )
    return runtime, api_test


def _body(plan) -> dict:
    body = plan.normalized_json_body
    return json.loads(body) if isinstance(body, str) else body


def test_start_end_ts_render_from_iso_checkpoint_identically_in_runtime_and_api_test() -> None:
    runtime, api_test = _window_plans({"last_timestamp": "2026-10-29T12:01:00.123Z"})
    expected_params = {"from": "2026-10-29T12:01:00.123Z", "to": _FROZEN_ISO}
    assert runtime.params == expected_params
    assert api_test.params == expected_params
    assert runtime.stream_headers == api_test.stream_headers == {"X-Window-End": _FROZEN_ISO}
    expected_body = {"range": {"gt": "2026-10-29T12:01:00.123Z", "lte": _FROZEN_ISO}}
    assert _body(runtime) == expected_body
    assert _body(api_test) == expected_body


def test_end_ts_equals_now() -> None:
    stm = {"endpoint": "/events", "method": "GET", "params": {"now": "{{now}}", "end": "{{end_ts}}"}}
    plan = build_shared_http_request(source_config=_SRC, stream_config=stm, mode="runtime", checkpoint_value={})
    assert plan.params["end"] == plan.params["now"] == _FROZEN_ISO


def test_start_ts_without_checkpoint_falls_back_to_24h_window_in_both_paths() -> None:
    for checkpoint in (None, {}, {"cursor": "tok-1"}, {"last_timestamp": "not-a-time"}, {"last_timestamp": "0"}):
        runtime, api_test = _window_plans(checkpoint)
        assert runtime.params == {"from": _FROZEN_START_FALLBACK_ISO, "to": _FROZEN_ISO}, checkpoint
        assert api_test.params == runtime.params, checkpoint
        assert "{{" not in json.dumps(_body(runtime)) and "{{" not in json.dumps(_body(api_test))


def test_start_ts_converts_epoch_checkpoint_to_iso() -> None:
    for checkpoint in (
        {"last_timestamp_ms": "1793275260000"},
        {"last_timestamp": 1793275260000},
        {"last_timestamp": "1793275260"},
    ):
        runtime, api_test = _window_plans(checkpoint)
        assert runtime.params["from"] == "2026-10-29T12:01:00Z", checkpoint
        assert api_test.params == runtime.params, checkpoint


def test_start_ts_resolves_last_success_event_checkpoint_like_runtime() -> None:
    stm = {
        **_WINDOW_STREAM,
        "event_array_path": "$.items",
        "checkpoint": {"mode": "Timestamp", "cursor_path": "$.items[*].timestamp"},
    }
    checkpoint = {"last_success_event": {"id": "e1", "timestamp": "2026-10-29T12:01:00Z"}}
    runtime = build_shared_http_request(source_config=_SRC, stream_config=stm, mode="runtime", checkpoint_value=checkpoint)
    api_test = build_shared_http_request(source_config=_SRC, stream_config=stm, mode="api_test", api_test_checkpoint=checkpoint)
    assert runtime.params == {"from": "2026-10-29T12:01:00Z", "to": _FROZEN_ISO}
    assert api_test.params == runtime.params


def test_start_ts_does_not_re_render_placeholders_from_checkpoint_values() -> None:
    runtime, api_test = _window_plans({"last_timestamp": "{{now}}"})
    assert runtime.params["from"] == _FROZEN_START_FALLBACK_ISO
    assert api_test.params["from"] == _FROZEN_START_FALLBACK_ISO


def test_http_poller_sends_rendered_start_end_ts(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: list[httpx.Request] = []

    def _handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json=[])

    transport = httpx.MockTransport(_handler)
    real_client = httpx.Client

    def _client_factory(*args, **kwargs):
        kwargs.pop("proxy", None)
        kwargs.pop("proxies", None)
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "Client", _client_factory)

    stm = {"endpoint": "/events", "method": "GET", "params": {"from": "{{start_ts}}", "to": "{{end_ts}}"}}
    HttpPoller().fetch({"base_url": "https://api.example"}, stm, {"last_timestamp": "2026-10-29T12:01:00Z"})
    assert captured, "poller did not send a request"
    query = parse_qs(urlsplit(str(captured[-1].url)).query)
    assert query["from"] == ["2026-10-29T12:01:00Z"]
    assert query["to"] == [_FROZEN_ISO]
    assert "{{" not in str(captured[-1].url) and "%7B%7B" not in str(captured[-1].url)


def test_runtime_does_not_re_render_placeholders_inside_checkpoint_values() -> None:
    stm = {"endpoint": "/events", "method": "GET", "params": {"after": "{{checkpoint.cursor}}"}}
    plan = build_shared_http_request(
        source_config=_SRC,
        stream_config=stm,
        mode="runtime",
        checkpoint_value={"cursor": "literal-{{now}}"},
    )
    assert plan.params == {"after": "literal-{{now}}"}


def test_http_poller_sends_rendered_now_query_param(monkeypatch: pytest.MonkeyPatch) -> None:
    """End-to-end at the poller boundary: the outbound URL must not carry a literal ``{{now}}``."""

    captured: list[httpx.Request] = []

    def _handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json=[])

    transport = httpx.MockTransport(_handler)
    real_client = httpx.Client

    def _client_factory(*args, **kwargs):
        kwargs.pop("proxy", None)
        kwargs.pop("proxies", None)
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "Client", _client_factory)

    stm = {"endpoint": "/events", "method": "GET", "params": dict(_WIZARD_PARAMS)}
    HttpPoller().fetch(
        {"base_url": "https://api.example"},
        stm,
        {"last_timestamp": "2026-10-29T12:01:00Z"},
    )
    assert captured, "poller did not send a request"
    query = parse_qs(urlsplit(str(captured[-1].url)).query)
    assert query["timestamp_lte"] == [_FROZEN_ISO]
    assert query["timestamp_gt"] == ["2026-10-29T12:01:00Z"]
    assert "{{" not in str(captured[-1].url) and "%7B%7B" not in str(captured[-1].url)
