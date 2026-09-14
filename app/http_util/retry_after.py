"""Parse HTTP ``Retry-After`` values (delta-seconds or HTTP-date)."""

from __future__ import annotations

from datetime import datetime, timezone
from email.utils import parsedate_to_datetime


DEFAULT_MAX_WAIT_SECONDS = 300.0


def parse_retry_after_seconds(
    value: str | None,
    *,
    now: datetime | None = None,
    max_wait_seconds: float = DEFAULT_MAX_WAIT_SECONDS,
    fallback_seconds: float = 1.0,
) -> float:
    """Return a clamped wait duration in seconds.

    Supports RFC 7231 ``delta-seconds`` and ``HTTP-date``. Invalid values fall
    back to ``fallback_seconds``. Result is always in ``[0, max_wait_seconds]``.
    """

    raw = (value or "").strip()
    if not raw:
        return max(0.0, min(float(fallback_seconds), float(max_wait_seconds)))

    try:
        delta = float(raw)
        if delta == delta and delta >= 0:  # not NaN
            return max(0.0, min(delta, float(max_wait_seconds)))
    except ValueError:
        pass

    try:
        when = parsedate_to_datetime(raw)
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        base = now or datetime.now(timezone.utc)
        seconds = (when - base).total_seconds()
        if seconds < 0:
            seconds = 0.0
        return max(0.0, min(seconds, float(max_wait_seconds)))
    except (TypeError, ValueError, IndexError, OverflowError):
        return max(0.0, min(float(fallback_seconds), float(max_wait_seconds)))


__all__ = ["DEFAULT_MAX_WAIT_SECONDS", "parse_retry_after_seconds"]
