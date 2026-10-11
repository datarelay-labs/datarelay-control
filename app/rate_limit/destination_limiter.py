"""Destination-side rate limiting — EPS, batching, burst."""

from __future__ import annotations

import math
import threading
import time
from typing import Any


class DestinationRateLimiter:
    """Throttle deliveries per route using ``max_events`` / ``per_seconds`` windows.

    Must remain separate from SourceRateLimiter (project policy).
    Call ``allow(route_id, rate_limit_json)`` with the effective merged JSON from
    Route / Destination (see StreamRunner fan-out).
    """

    def __init__(self) -> None:
        self._windows: dict[int, dict[str, Any]] = {}
        # In-process UDP datagram pacing. Reservations are per Route; a future
        # reservation is retained across batches and concurrent senders.
        self._pacing_lock = threading.Lock()
        self._pacing: dict[int, tuple[float, float, float, int]] = {}

    def reserve_event(
        self, route_id: int, *, per_second: float, burst_size: int, now: float
    ) -> float:
        """Reserve one event with a token bucket; return seconds until safe to send.

        Unlike legacy allow(), pacing reserves every datagram rather than
        rejecting a whole event batch. A concurrent reservation may be in the
        future, so we never let another caller jump ahead of it.
        """
        rate = float(per_second)
        burst = int(burst_size)
        if (
            not math.isfinite(rate) or rate <= 0 or
            float(burst_size) != burst or burst <= 0 or
            not math.isfinite(now)
        ):
            raise ValueError("invalid UDP event rate or burst")
        with self._pacing_lock:
            previous = self._pacing.get(route_id)
            if previous is None or (previous[2], previous[3]) != (rate, burst):
                clock = now
                tokens = float(burst)
            else:
                clock = max(now, previous[0])
                tokens = min(float(burst), previous[1] + (clock - previous[0]) * rate)
            if tokens >= 1:
                tokens -= 1
            else:
                clock += (1 - tokens) / rate
                tokens = 0.0
            self._pacing[route_id] = (clock, tokens, rate, burst)
            return max(0.0, clock - now)

    def allow(self, route_id: int, rate_limit_json: dict[str, Any] | None = None) -> bool:
        """Return True if delivery may proceed for this route."""

        cfg = rate_limit_json or {}
        if not cfg:
            return True

        max_events = int(cfg.get("max_events", 0))
        per_seconds = float(cfg.get("per_seconds", 1))
        if max_events <= 0 or per_seconds <= 0:
            return True

        now = time.monotonic()
        st = self._windows.get(route_id)
        if st is None:
            self._windows[route_id] = {"window_start": now, "sent": 1}
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
