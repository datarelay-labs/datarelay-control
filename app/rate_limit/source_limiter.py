"""Source-side rate limiting — protects upstream APIs (429, Retry-After)."""

from __future__ import annotations

import time
from typing import Any


class SourceRateLimiter:
    """Throttle outbound API fetches per stream using ``max_events`` / ``per_seconds``.

    Must remain separate from DestinationRateLimiter (project policy).
    Call ``allow(stream_id, rate_limit_json)`` with Stream.rate_limit_json.
    Empty / unset config allows all fetches (same contract as destination limiter).
    """

    def __init__(self) -> None:
        self._windows: dict[int, dict[str, Any]] = {}

    def allow(self, stream_id: int, rate_limit_json: dict[str, Any] | None = None) -> bool:
        """Return True if a source fetch may proceed for this stream."""

        cfg = rate_limit_json or {}
        if not cfg:
            return True

        max_events = int(cfg.get("max_events", 0))
        per_seconds = float(cfg.get("per_seconds", 1))
        if max_events <= 0 or per_seconds <= 0:
            return True

        now = time.monotonic()
        st = self._windows.get(stream_id)
        if st is None:
            self._windows[stream_id] = {"window_start": now, "sent": 1}
            return True

        window_start = float(st["window_start"])
        sent = int(st["sent"])
        elapsed = now - window_start
        if elapsed >= per_seconds:
            st["window_start"] = now
            st["sent"] = 1
            return True

        if sent >= max_events:
            return False

        st["sent"] = sent + 1
        return True
