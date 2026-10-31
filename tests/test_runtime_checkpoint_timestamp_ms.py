"""T1: runtime checkpoint ``last_timestamp_ms`` is numeric epoch ms, like the API Test checkpoint.

``last_timestamp`` stays the canonical raw sample value (e.g. ISO). The API Test payload
(buildApiTestCheckpointPayload in wizard-incremental-request.ts) sends
``{"last_timestamp": <raw sample>, "last_timestamp_ms": String(epoch ms)}`` for timestamp-like values and
``String(value)`` for plain numeric/string cursors.

Old code stored the raw ISO sample in ``last_timestamp_ms`` (build_runtime_checkpoint_template_context set
``last_timestamp_ms = cursor_value``), so every assertion below that expects an int / epoch-ms string fails on
the old code. Checkpoints written by the old code are converted on read (no data migration).
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.http import shared_request_builder
from app.http.shared_request_builder import (
    build_runtime_checkpoint_template_context,
    build_shared_http_request,
    checkpoint_timestamp_ms,
)
from app.runtime.incremental_fetch import (
    build_delivery_checkpoint_update,
    build_fetch_window,
    parse_incremental_fetch_config,
    prepare_fetch_checkpoint_context,
)

_ISO = "2026-10-29T12:01:00.123Z"
_ISO_MS = 1793275260123  # Date.parse(_ISO) in the API Test
_SRC = {"base_url": "https://api.example"}
_STREAM = {
    "endpoint": "/events",
    "method": "GET",
    "event_array_path": "$.items",
    "checkpoint": {"mode": "Timestamp", "cursor_path": "$.items[*].timestamp"},
    "params": {"gt": "{{checkpoint.last_timestamp}}", "gt_ms": "{{checkpoint.last_timestamp_ms}}"},
}


@pytest.fixture(autouse=True)
def _freeze_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(shared_request_builder, "_utc_now_seconds", lambda: 1793277584.25)


def _runtime_written_checkpoint(event_value: object) -> dict:
    # Exactly what StreamRunner._update_checkpoint_after_success stores for a successful delivery.
    return build_runtime_checkpoint_template_context(
        {"last_success_event": {"id": "e1", "timestamp": event_value}},
        _STREAM,
    )


def _api_test_payload(raw_sample: object, ms: int) -> dict:
    # buildApiTestCheckpointPayload for valueKind "timestamp".
    return {"last_timestamp": str(raw_sample), "last_timestamp_ms": str(ms)}


def test_new_runtime_checkpoint_stores_numeric_last_timestamp_ms_for_iso_sample() -> None:
    ck = _runtime_written_checkpoint(_ISO)
    assert ck["last_timestamp"] == _ISO  # canonical raw sample is unchanged
    # Old code: ck["last_timestamp_ms"] == "2026-10-29T12:01:00.123Z".
    assert ck["last_timestamp_ms"] == _ISO_MS
    assert isinstance(ck["last_timestamp_ms"], int)


@pytest.mark.parametrize(
    ("event_value", "expected_ms"),
    [
        (_ISO, _ISO_MS),
        ("2026-10-29T12:01:00Z", 1793275260000),
        ("2026-10-29T14:01:00+02:00", 1793275260000),
        (1793275260, 1793275260000),  # epoch seconds
        ("1793275260", 1793275260000),
        (1793275260123, 1793275260123),  # epoch ms
    ],
)
def test_runtime_checkpoint_ms_matches_api_test_payload(event_value: object, expected_ms: int) -> None:
    ck = _runtime_written_checkpoint(event_value)
    api = _api_test_payload(event_value, expected_ms)
    assert ck["last_timestamp_ms"] == expected_ms
    assert str(ck["last_timestamp_ms"]) == api["last_timestamp_ms"]
    assert str(ck["last_timestamp"]) == api["last_timestamp"]


@pytest.mark.parametrize("event_value", [12345, "cursor-abc", "20260101"])
def test_non_timestamp_cursor_keeps_raw_last_timestamp_ms_like_api_test(event_value: object) -> None:
    # API Test (non-timestamp valueKind): last_timestamp_ms = String(value).
    ck = _runtime_written_checkpoint(event_value)
    assert ck["last_timestamp_ms"] == event_value
    assert ck["last_timestamp"] == event_value


def test_runtime_and_api_test_render_identical_checkpoint_templates() -> None:
    stored = _runtime_written_checkpoint(_ISO)
    runtime = build_shared_http_request(source_config=_SRC, stream_config=_STREAM, mode="runtime", checkpoint_value=stored)
    api_test = build_shared_http_request(
        source_config=_SRC,
        stream_config=_STREAM,
        mode="api_test",
        api_test_checkpoint=_api_test_payload(_ISO, _ISO_MS),
    )
    # Old code: runtime gt_ms == "2026-10-29T12:01:00.123Z" while the API Test sent "1793275260123".
    assert runtime.params == {"gt": _ISO, "gt_ms": str(_ISO_MS)}
    assert api_test.params == runtime.params


def test_legacy_iso_last_timestamp_ms_is_converted_on_read() -> None:
    legacy = {
        "last_success_event": {"id": "e1", "timestamp": _ISO},
        "last_timestamp": _ISO,
        "last_timestamp_ms": _ISO,  # written by the old code
    }
    ctx = build_runtime_checkpoint_template_context(legacy, _STREAM)
    assert ctx["last_timestamp_ms"] == _ISO_MS
    assert ctx["last_timestamp"] == _ISO
    assert legacy["last_timestamp_ms"] == _ISO  # read-time only: the stored dict is not mutated

    plan = build_shared_http_request(source_config=_SRC, stream_config=_STREAM, mode="runtime", checkpoint_value=legacy)
    assert plan.params == {"gt": _ISO, "gt_ms": str(_ISO_MS)}


def test_unparseable_last_timestamp_ms_is_left_unchanged() -> None:
    ctx = build_runtime_checkpoint_template_context({"last_timestamp_ms": "not-a-time"}, {})
    assert ctx["last_timestamp_ms"] == "not-a-time"


def test_checkpoint_timestamp_ms_never_rounds_up() -> None:
    # Sub-millisecond precision is floored: the window must never start after the stored checkpoint.
    assert checkpoint_timestamp_ms("2026-10-29T12:01:00.123999Z") == _ISO_MS
    assert checkpoint_timestamp_ms(1793275260123.9) == _ISO_MS
    assert checkpoint_timestamp_ms(True) is None
    assert checkpoint_timestamp_ms(999_999_999) is None


_CLOSED_WINDOW = {"incremental_fetch": {"strategy": "closed_window_watermark", "watermark_field": "$.timestamp"}}


def test_closed_window_lower_bound_reads_numeric_last_timestamp_ms() -> None:
    config = parse_incremental_fetch_config(_CLOSED_WINDOW)
    now = datetime(2026, 10, 29, 13, 0, 0, tzinfo=timezone.utc)
    window = build_fetch_window(config=config, checkpoint={"last_timestamp_ms": 1793275260000}, now=now)
    assert window is not None
    # Old code could not parse epoch ms and fell back to now - initial_lookback (window lost).
    assert window.lower_bound == "2026-10-29T12:01:00Z"
    assert window.lower_bound_ms == 1793275260000


def test_closed_window_lower_bound_still_reads_legacy_iso() -> None:
    config = parse_incremental_fetch_config(_CLOSED_WINDOW)
    now = datetime(2026, 10, 29, 13, 0, 0, tzinfo=timezone.utc)
    window = build_fetch_window(config=config, checkpoint={"last_timestamp_ms": "2026-10-29T12:01:00Z"}, now=now)
    assert window is not None
    assert window.lower_bound == "2026-10-29T12:01:00Z"


_WATERMARK = {"incremental_fetch": {"strategy": "timestamp_watermark", "watermark_field": "$.timestamp"}}


def test_framework_fetch_context_exposes_numeric_last_timestamp_ms() -> None:
    ctx = prepare_fetch_checkpoint_context({"last_timestamp": _ISO, "last_timestamp_ms": _ISO}, _WATERMARK)
    # Old code: the stored ISO value (or the ISO watermark via setdefault) was exposed as-is.
    assert ctx["last_timestamp_ms"] == _ISO_MS
    assert ctx["last_timestamp"] == _ISO


def test_framework_delivery_checkpoint_rewrites_legacy_iso_last_timestamp_ms() -> None:
    merged = build_delivery_checkpoint_update(
        successful_events=[{"id": "e2", "timestamp": _ISO}],
        stream_config=_WATERMARK,
        existing_checkpoint={"last_timestamp_ms": "2026-10-29T12:00:00Z"},
    )
    # Old code preserved the ISO string through setdefault and wrote it back.
    assert merged["last_timestamp_ms"] == 1793275200000
