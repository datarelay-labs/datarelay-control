"""Canonical Stream runtime eligibility (Create ≠ Start).

Scheduler and destructive-operation guards must agree:

- CREATE → enabled=false, status=STOPPED (no delivery)
- START  → enabled=true, status=RUNNING
- STOP   → enabled=false, status=STOPPED

A stale/inconsistent row with enabled=true and status=STOPPED must not execute.
"""

from __future__ import annotations

from typing import Any


PUSH_ONLY_SCHEDULER_STREAM_TYPES = frozenset({"WEBHOOK_RECEIVER", "WEBHOOK", "WEBHOOK_PUSH"})


def is_push_only_stream_type(stream_type: str | None) -> bool:
    """True for push ingest types the scheduler must never poll."""

    return str(stream_type or "").strip().upper() in PUSH_ONLY_SCHEDULER_STREAM_TYPES


def is_stream_scheduler_runnable(*, enabled: bool, status: str | None) -> bool:
    """True only when the Stream is explicitly started for delivery."""

    return bool(enabled) and str(status or "") == "RUNNING"


def stream_row_is_scheduler_runnable(stream: Any) -> bool:
    """ORM / mapping helper for Stream-like objects."""

    return is_stream_scheduler_runnable(
        enabled=bool(getattr(stream, "enabled", False)),
        status=getattr(stream, "status", None),
    )


def stream_has_local_runtime_owner(stream_id: int) -> bool:
    """True when this process still owns a lock, worker claim, or live scheduler worker."""

    from app.runners.stream_runner import StreamRunner
    from app.scheduler import runtime_state as scheduler_runtime_state

    return bool(
        StreamRunner.is_lock_held(int(stream_id))
        or StreamRunner.is_worker_ownership_held(int(stream_id))
        or scheduler_runtime_state.is_stream_worker_alive(int(stream_id))
    )


def is_stream_runtime_active(*, enabled: bool, status: str | None, stream_id: int | None = None) -> bool:
    """Fail-closed active-runtime test for destructive operations.

    A Stream is considered active when any of the following is true:
    - it is scheduler-runnable (enabled + RUNNING)
    - DB status is RUNNING or STOPPING (worker may still be winding down)
    - enabled=true (historical scheduler selected on enabled alone; fail closed)
    - a local runtime owner/lock/worker is still alive
    """

    status_s = str(status or "")
    enabled_b = bool(enabled)
    if is_stream_scheduler_runnable(enabled=enabled_b, status=status_s):
        return True
    if status_s in {"RUNNING", "STOPPING"}:
        return True
    if enabled_b:
        return True
    if stream_id is not None and stream_has_local_runtime_owner(int(stream_id)):
        return True
    return False


def reconcile_and_list_active_streams_for_destructive_ops(db: Any, *, limit: int = 20) -> list[tuple[int, str]]:
    """Return (id, label) for streams that still block destructive ops after stale reconcile."""

    from app.runtime.control_service import reconcile_stale_stream_runtime
    from app.streams.models import Stream

    rows = db.query(Stream.id, Stream.name, Stream.enabled, Stream.status).order_by(Stream.id.asc()).all()
    active: list[tuple[int, str]] = []
    for row in rows:
        sid = int(row[0])
        enabled = bool(row[2])
        status = str(row[3] or "")
        if not enabled and status in {"RUNNING", "STOPPING"} and not stream_has_local_runtime_owner(sid):
            try:
                reconcile_stale_stream_runtime(db, sid)
            except Exception:
                pass
            refreshed = db.query(Stream.enabled, Stream.status).filter(Stream.id == sid).first()
            if refreshed is not None:
                enabled = bool(refreshed[0])
                status = str(refreshed[1] or "")
        if is_stream_runtime_active(enabled=enabled, status=status, stream_id=sid):
            label = f"{row[1] or 'stream'}#{sid}"
            active.append((sid, label))
            if len(active) >= max(1, int(limit)):
                break
    return active
