"""T2: the API test renders time/checkpoint templates in the endpoint path exactly like the runtime.

Old code: build_shared_http_request(mode="api_test") used ``ep_rendered = ep``, so the API test URL kept the
literal ``{{now}}`` / ``{{runtime.now_ms}}`` / ``{{start_ts}}`` / ``{{checkpoint.*}}`` placeholders while the
runtime rendered them. Every ``api_test.url`` assertion below fails on the old code.
"""

from __future__ import annotations

import pytest

from app.http import shared_request_builder
from app.http.shared_request_builder import build_shared_http_request

_FROZEN_NOW = 1793277584.25  # 2026-10-29T12:39:44Z
_FROZEN_ISO = "2026-10-29T12:39:44Z"
_FROZEN_MS = "1793277584250"
_SRC = {"base_url": "https://api.example"}


@pytest.fixture(autouse=True)
def _freeze_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(shared_request_builder, "_utc_now_seconds", lambda: _FROZEN_NOW)


def _plans(endpoint: str, checkpoint: dict | None):
    stm = {"endpoint": endpoint, "method": "GET"}
    runtime = build_shared_http_request(source_config=_SRC, stream_config=stm, mode="runtime", checkpoint_value=checkpoint)
    api_test = build_shared_http_request(
        source_config=_SRC, stream_config=stm, mode="api_test", api_test_checkpoint=checkpoint
    )
    return runtime, api_test


def test_api_test_renders_time_variables_in_endpoint_path_like_runtime() -> None:
    runtime, api_test = _plans("/events/{{runtime.now_ms}}/until/{{now}}", None)
    expected = f"https://api.example/events/{_FROZEN_MS}/until/{_FROZEN_ISO}"
    assert runtime.url == expected
    assert api_test.url == expected


def test_api_test_renders_start_end_ts_in_endpoint_path_like_runtime() -> None:
    checkpoint = {"last_timestamp": "2026-10-29T12:01:00Z"}
    runtime, api_test = _plans("/range/{{start_ts}}/{{end_ts}}", checkpoint)
    expected = f"https://api.example/range/2026-10-29T12:01:00Z/{_FROZEN_ISO}"
    assert runtime.url == expected
    assert api_test.url == runtime.url


def test_api_test_renders_checkpoint_variables_in_endpoint_path_like_runtime() -> None:
    checkpoint = {"last_timestamp": "2026-10-29T12:01:00Z", "last_timestamp_ms": "1793275260000"}
    runtime, api_test = _plans("/since/{{checkpoint.last_timestamp_ms}}", checkpoint)
    assert runtime.url == "https://api.example/since/1793275260000"
    assert api_test.url == runtime.url


def test_endpoint_without_templates_is_unchanged() -> None:
    runtime, api_test = _plans("v1/events", None)
    assert runtime.url == api_test.url == "https://api.example/v1/events"
    assert api_test.endpoint == "v1/events"
