"""Unit tests for Retry-After parsing (delta-seconds + HTTP-date)."""

from __future__ import annotations

from datetime import datetime, timezone

from app.http_util.retry_after import parse_retry_after_seconds


def test_parse_retry_after_delta_seconds() -> None:
    assert parse_retry_after_seconds("12") == 12.0
    assert parse_retry_after_seconds("9999", max_wait_seconds=300) == 300.0


def test_parse_retry_after_http_date() -> None:
    now = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    # 90 seconds in the future
    header = "Thu, 01 Jan 2026 12:01:30 GMT"
    assert parse_retry_after_seconds(header, now=now, max_wait_seconds=300) == 90.0


def test_parse_retry_after_invalid_falls_back() -> None:
    assert parse_retry_after_seconds("not-a-date", fallback_seconds=7.5) == 7.5
