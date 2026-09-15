"""Unit tests for SourceRateLimiter windowing."""

from __future__ import annotations

from app.rate_limit.source_limiter import SourceRateLimiter


def test_source_rate_limiter_allows_when_unconfigured() -> None:
    limiter = SourceRateLimiter()
    assert limiter.allow(1) is True
    assert limiter.allow(1, {}) is True
    assert limiter.allow(1, {"max_events": 0, "per_seconds": 60}) is True


def test_source_rate_limiter_enforces_max_events_window(monkeypatch) -> None:
    limiter = SourceRateLimiter()
    clock = {"t": 100.0}
    monkeypatch.setattr("app.rate_limit.source_limiter.time.monotonic", lambda: clock["t"])

    cfg = {"max_events": 2, "per_seconds": 10}
    assert limiter.allow(7, cfg) is True
    assert limiter.allow(7, cfg) is True
    assert limiter.allow(7, cfg) is False

    clock["t"] = 110.0
    assert limiter.allow(7, cfg) is True
