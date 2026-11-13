"""Process-local scheduler diagnostics for runtime APIs (no DB)."""

from __future__ import annotations

import weakref
from datetime import datetime, timezone
from typing import Any

_scheduler_started_at: datetime | None = None
_scheduler_ref: weakref.ref | None = None


def mark_scheduler_started() -> None:
    """Record UTC time when the scheduler supervisor starts (once per process)."""

    global _scheduler_started_at
    if _scheduler_started_at is None:
        _scheduler_started_at = datetime.now(timezone.utc)


def register_scheduler_instance(scheduler: Any) -> None:
    """Hold a weak reference for worker/thread introspection."""

    global _scheduler_ref
    _scheduler_ref = weakref.ref(scheduler)


def get_scheduler() -> Any | None:
    """Return the process-local scheduler instance, when registered."""

    ref = _scheduler_ref
    return ref() if ref is not None else None


def request_stream_stop(stream_id: int) -> None:
    scheduler = get_scheduler()
    if scheduler is not None:
        scheduler.request_stream_stop(stream_id)


def current_worker_stop_requested(stream_id: int) -> bool:
    """True when the calling thread is this stream's scheduler worker and a stop was requested.

    Manual runs (Run Now) execute on other threads and are never interrupted by a stale stop signal.
    """

    import threading

    if threading.current_thread().name != f"stream-scheduler-{int(stream_id)}":
        return False
    scheduler = get_scheduler()
    return bool(scheduler is not None and scheduler.is_stream_stop_requested(stream_id))


def is_stream_worker_alive(stream_id: int) -> bool:
    scheduler = get_scheduler()
    return bool(scheduler is not None and scheduler.is_stream_worker_alive(stream_id))


def join_stream_worker(stream_id: int, timeout: float) -> bool:
    scheduler = get_scheduler()
    return True if scheduler is None else bool(scheduler.join_stream_worker(stream_id, timeout))


def scheduler_started_at() -> datetime | None:
    return _scheduler_started_at


def active_worker_count() -> int | None:
    """Return live worker threads if a scheduler instance is registered."""

    ref = _scheduler_ref
    if ref is None:
        return None
    sched = ref()
    if sched is None:
        return None
    return int(sched.alive_worker_count())


def scheduler_uptime_seconds(now: datetime | None = None) -> float | None:
    started = _scheduler_started_at
    if started is None:
        return None
    t = now or datetime.now(timezone.utc)
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    delta = (t - started.astimezone(timezone.utc)).total_seconds()
    return max(0.0, float(delta))
