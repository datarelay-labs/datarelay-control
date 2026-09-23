"""Process-local bulk-refreshed enabled-state snapshot for scheduler workers.

Workers share one immutable snapshot refreshed on a short TTL (default 0.5s,
matching the prior per-stream interruptible-wait poll slice). This replaces
N independent ``SELECT`` calls per slice with a single bulk query per refresh.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Callable

from sqlalchemy.orm import Session

from app.runners.stream_runner_db import run_with_db
from app.streams.repository import list_stream_scheduler_gates
from app.streams.runtime_eligibility import is_stream_scheduler_runnable

DEFAULT_TTL_SEC = 0.5


@dataclass(frozen=True, slots=True)
class StreamSchedulerGate:
    """Minimal detached gate used by scheduler workers (no ORM session)."""

    stream_id: int
    enabled: bool
    status: str
    polling_interval: float
    name: str | None
    stream_type: str = ""


GateLoader = Callable[[], dict[int, StreamSchedulerGate]]


class EnabledStateCache:
    """Thread-safe bulk snapshot of stream enabled gates."""

    def __init__(self, *, ttl_sec: float = DEFAULT_TTL_SEC, loader: GateLoader | None = None) -> None:
        self._ttl_sec = max(0.05, float(ttl_sec))
        self._loader = loader
        self._lock = threading.Lock()
        self._fetched_at = 0.0
        self._gates: dict[int, StreamSchedulerGate] = {}
        self._refresh_count = 0
        self._query_count = 0
        self._refreshing = False
        self._refresh_done = threading.Event()
        self._refresh_done.set()

    def reset_for_tests(self) -> None:
        """Clear snapshot state (tests only)."""

        with self._lock:
            self._fetched_at = 0.0
            self._gates = {}
            self._refresh_count = 0
            self._query_count = 0
            self._refreshing = False
            self._refresh_done.set()

    def invalidate(self) -> None:
        """Force the next read to refresh from DB."""

        with self._lock:
            self._fetched_at = 0.0

    def metrics(self) -> dict[str, int | float]:
        with self._lock:
            return {
                "refresh_count": int(self._refresh_count),
                "query_count": int(self._query_count),
                "size": len(self._gates),
                "ttl_sec": float(self._ttl_sec),
            }

    def get_gate(self, stream_id: int) -> StreamSchedulerGate | None:
        """Return the latest gate for ``stream_id``, refreshing when TTL expired."""

        self._ensure_fresh()
        with self._lock:
            return self._gates.get(int(stream_id))

    def is_enabled(self, stream_id: int) -> bool:
        """True when the stream is scheduler-runnable (enabled + RUNNING)."""

        gate = self.get_gate(stream_id)
        if gate is None:
            return False
        return is_stream_scheduler_runnable(enabled=gate.enabled, status=gate.status)

    def snapshot_gates(self) -> dict[int, StreamSchedulerGate]:
        """Return a shallow copy of the current gate map (after refresh)."""

        self._ensure_fresh()
        with self._lock:
            return dict(self._gates)

    def _ensure_fresh(self) -> None:
        wait_for: threading.Event | None = None
        should_load = False
        with self._lock:
            now = time.monotonic()
            if self._fetched_at > 0.0 and (now - self._fetched_at) < self._ttl_sec:
                return
            if self._refreshing:
                wait_for = self._refresh_done
            else:
                self._refreshing = True
                self._refresh_done = threading.Event()
                should_load = True

        if wait_for is not None:
            wait_for.wait(timeout=max(self._ttl_sec * 4.0, 2.0))
            return

        assert should_load
        error: BaseException | None = None
        gates: dict[int, StreamSchedulerGate] = {}
        try:
            gates = self._load_gates()
        except BaseException as exc:  # pragma: no cover - surfaced to callers
            error = exc
        finally:
            with self._lock:
                if error is None:
                    self._gates = gates
                    self._fetched_at = time.monotonic()
                    self._refresh_count += 1
                    self._query_count += 1
                self._refreshing = False
                self._refresh_done.set()
        if error is not None:
            raise error

    def _load_gates(self) -> dict[int, StreamSchedulerGate]:
        if self._loader is not None:
            return dict(self._loader())

        def _load(db: Session) -> dict[int, StreamSchedulerGate]:
            rows = list_stream_scheduler_gates(db)
            return {
                int(row.stream_id): StreamSchedulerGate(
                    stream_id=int(row.stream_id),
                    enabled=bool(row.enabled),
                    status=str(row.status or ""),
                    polling_interval=float(row.polling_interval),
                    name=row.name,
                    stream_type=str(getattr(row, "stream_type", "") or ""),
                )
                for row in rows
            }

        return run_with_db(_load)


# Process-local singleton used by Scheduler workers.
enabled_state_cache = EnabledStateCache()
