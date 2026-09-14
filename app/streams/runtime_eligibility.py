"""Canonical Stream runtime eligibility (Create ≠ Start).

Scheduler and destructive-operation guards must agree:

- CREATE → enabled=false, status=STOPPED (no delivery)
- START  → enabled=true, status=RUNNING
- STOP   → enabled=false, status=STOPPED

A stale/inconsistent row with enabled=true and status=STOPPED must not execute.
"""

from __future__ import annotations

from typing import Any


def is_stream_scheduler_runnable(*, enabled: bool, status: str | None) -> bool:
    """True only when the Stream is explicitly started for delivery."""

    return bool(enabled) and str(status or "") == "RUNNING"


def stream_row_is_scheduler_runnable(stream: Any) -> bool:
    """ORM / mapping helper for Stream-like objects."""

    return is_stream_scheduler_runnable(
        enabled=bool(getattr(stream, "enabled", False)),
        status=getattr(stream, "status", None),
    )
