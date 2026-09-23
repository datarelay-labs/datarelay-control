"""Periodic scheduler — invokes StreamRunner per enabled stream."""

from __future__ import annotations

import errno
import logging
import threading
from typing import Any, Callable

from app.database import SessionLocal
from app.runners.stream_runner_db import run_with_db
from app.scheduler.context_cache import load_scheduler_stream_context
from app.scheduler.enabled_state import StreamSchedulerGate, enabled_state_cache
from app.runners.stream_runner import StreamRunner
from app.streams.repository import get_enabled_stream_ids, get_stream_by_id
from app.streams.runtime_eligibility import is_stream_scheduler_runnable
from app.scheduler import runtime_state as scheduler_runtime_state

logger = logging.getLogger(__name__)


def is_transient_scheduler_error(exc: BaseException) -> bool:
    """Return True for connection/pipe/timeout style errors that warrant backoff."""

    if isinstance(exc, (BrokenPipeError, ConnectionError, TimeoutError)):
        return True
    if isinstance(exc, OSError):
        if getattr(exc, "errno", None) in {errno.EPIPE, errno.ECONNREFUSED, errno.ETIMEDOUT, errno.ECONNRESET}:
            return True
        # errno 32 is EPIPE on Linux
        if getattr(exc, "errno", None) == 32:
            return True
    msg = str(exc).lower()
    needles = (
        "broken pipe",
        "connection refused",
        "connection reset",
        "timed out",
        "timeout",
        "connection aborted",
    )
    return any(n in msg for n in needles)


def compute_scheduler_backoff_wait_sec(*, interval: float, consecutive_failures: int) -> float:
    """Exponential backoff capped at 300s: min(300, interval * 2**min(failures, 5))."""

    failures = max(0, int(consecutive_failures))
    base = max(float(interval), 0.1)
    return float(min(300.0, base * (2 ** min(failures, 5))))


class Scheduler:
    """Thread-based stream scheduler.

    A supervisor periodically discovers enabled streams and starts a long-lived worker per stream_id.
    Each worker reloads DB-backed context every poll cycle (fresh mapping/routes/checkpoint).
    """

    _SUPERVISOR_INTERVAL_SEC = 12.0

    def __init__(
        self,
        streams_provider: Callable[[], list[Any]] | None = None,
        runner: StreamRunner | None = None,
    ) -> None:
        self._streams_provider = streams_provider  # retained for compatibility; start() does not use it
        self._injected_runner = runner
        self._thread_local = threading.local()
        self._stop_event = threading.Event()
        self._threads: list[threading.Thread] = []
        self._workers_lock = threading.Lock()
        self._workers: dict[int, threading.Thread] = {}
        self._stream_stop_events: dict[int, threading.Event] = {}
        self._backoff_lock = threading.Lock()
        self._stream_backoff: dict[int, dict[str, Any]] = {}

    def _runner_for_current_thread(self) -> StreamRunner:
        """One StreamRunner per worker thread — run-scoped state is not thread-safe on a shared instance."""

        if self._injected_runner is not None:
            return self._injected_runner
        runner = getattr(self._thread_local, "runner", None)
        if runner is None:
            runner = StreamRunner()
            self._thread_local.runner = runner
        return runner

    def stream_backoff_summary(self) -> dict[int, dict[str, Any]]:
        """Optional diagnostics: stream_id -> consecutive failures / last wait."""

        with self._backoff_lock:
            return {sid: dict(info) for sid, info in self._stream_backoff.items()}

    def _set_backoff(self, stream_id: int, *, failures: int, wait_sec: float, last_error: str | None) -> None:
        with self._backoff_lock:
            if failures <= 0:
                self._stream_backoff.pop(stream_id, None)
                return
            self._stream_backoff[stream_id] = {
                "consecutive_failures": int(failures),
                "wait_sec": float(wait_sec),
                "last_error": (last_error or "")[:300] or None,
            }

    def start(self) -> None:
        """Start supervisor thread that spawns per-stream polling workers."""

        scheduler_runtime_state.mark_scheduler_started()
        self._stop_event.clear()
        supervisor = threading.Thread(
            target=self._supervisor_loop,
            daemon=True,
            name="stream-scheduler-supervisor",
        )
        supervisor.start()
        self._threads.append(supervisor)
        logger.info("%s", {"stage": "scheduler_supervisor_started"})

    def stop(self) -> None:
        """Stop supervisor and wait for worker threads to finish."""

        self._stop_event.set()
        with self._workers_lock:
            for event in self._stream_stop_events.values():
                event.set()
            workers = list(self._workers.values())
        for thread in self._threads:
            thread.join(timeout=5.0)
        self._threads.clear()
        # Bounded join for per-stream workers (supervisor join alone is not enough).
        for worker in workers:
            worker.join(timeout=5.0)
        with self._workers_lock:
            self._workers.clear()
            self._stream_stop_events.clear()
        logger.info("%s", {"stage": "scheduler_stopped"})

    def run_stream(self, stream: Any) -> dict[str, Any]:
        """Run one stream once via a thread-local StreamRunner (class-level rate-limit locks remain shared)."""

        return self._runner_for_current_thread().run(stream)

    def run_stream_by_id(self, stream_id: int) -> dict[str, Any]:
        """Load stream context from DB and run by stream_id."""

        context = load_scheduler_stream_context(stream_id)
        return self._runner_for_current_thread().run(context)

    def schedule_enabled_streams(self) -> list[int]:
        """Load enabled stream IDs and run each once by stream_id."""

        db = SessionLocal()
        try:
            stream_ids = get_enabled_stream_ids(db)
        finally:
            db.close()
        for stream_id in stream_ids:
            self.run_stream_by_id(stream_id)
        return stream_ids

    def _supervisor_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                db = SessionLocal()
                try:
                    enabled_ids = get_enabled_stream_ids(db)
                finally:
                    db.close()

                for sid in enabled_ids:
                    if self._stop_event.is_set():
                        break
                    sid_i = int(sid)
                    if self._is_run_once_harness_stream_id(sid_i):
                        continue
                    self._ensure_worker(sid_i)
            except Exception as exc:  # pragma: no cover - defensive
                logger.error(
                    "%s",
                    {
                        "stage": "scheduler_supervisor_error",
                        "error_type": type(exc).__name__,
                        "message": str(exc),
                    },
                )

            self._stop_event.wait(self._SUPERVISOR_INTERVAL_SEC)

    def alive_worker_count(self) -> int:
        """Count scheduler worker threads that are still alive."""

        with self._workers_lock:
            return sum(1 for t in self._workers.values() if t.is_alive())

    def request_stream_stop(self, stream_id: int) -> None:
        """Signal one process-local stream worker to exit promptly."""

        with self._workers_lock:
            event = self._stream_stop_events.setdefault(int(stream_id), threading.Event())
            event.set()

    def is_stream_worker_alive(self, stream_id: int) -> bool:
        """Return whether this scheduler owns a live worker for stream_id."""

        with self._workers_lock:
            worker = self._workers.get(int(stream_id))
            return bool(worker is not None and worker.is_alive())

    def join_stream_worker(self, stream_id: int, timeout: float) -> bool:
        """Wait up to timeout for one worker; return True once it has exited."""

        with self._workers_lock:
            worker = self._workers.get(int(stream_id))
        if worker is None:
            return True
        worker.join(timeout=max(0.0, float(timeout)))
        return not worker.is_alive()

    @staticmethod
    def _is_run_once_harness_stream_id(stream_id: int) -> bool:
        """True when the stream is harness-owned (``[FULL E2E]``) and must not be polled."""

        from app.dev_validation_lab.runtime_gates import is_run_once_harness_stream

        try:
            gate = enabled_state_cache.get_gate(int(stream_id))
            if gate is None:
                return False
            return bool(is_run_once_harness_stream(gate.name))
        except Exception:  # pragma: no cover - defensive
            return False

    def _ensure_worker(self, stream_id: int) -> None:
        with self._workers_lock:
            existing = self._workers.get(stream_id)
            if existing is not None:
                if existing.is_alive():
                    return
                self._workers.pop(stream_id, None)

            stop_event = self._stream_stop_events.setdefault(stream_id, threading.Event())
            stop_event.clear()
            thread = threading.Thread(
                target=self._loop_stream,
                args=(stream_id,),
                daemon=True,
                name=f"stream-scheduler-{stream_id}",
            )
            self._workers[stream_id] = thread
            thread.start()
            logger.info("%s", {"stage": "scheduler_worker_spawned", "stream_id": stream_id})

    def _loop_stream(self, stream_id: int) -> None:
        consecutive_failures = 0
        worker_owned = StreamRunner.try_acquire_worker_ownership(stream_id)
        if not worker_owned:
            logger.warning(
                "%s",
                {
                    "stage": "scheduler_worker_ownership_busy",
                    "stream_id": stream_id,
                    "message": "another process already owns this stream worker",
                },
            )
            with self._workers_lock:
                self._workers.pop(stream_id, None)
                self._stream_stop_events.pop(stream_id, None)
            return
        with self._workers_lock:
            stream_stop_event = self._stream_stop_events.setdefault(stream_id, threading.Event())
        try:
            while not self._stop_event.is_set() and not stream_stop_event.is_set():
                interval = 60.0
                context = None
                wait_sec = interval
                cycle_error: BaseException | None = None
                try:
                    gate = self._load_stream_gate(stream_id)
                    if gate is None:
                        logger.info(
                            "%s",
                            {"stage": "scheduler_loop_exit", "stream_id": stream_id, "reason": "stream_missing"},
                        )
                        break
                    if not is_stream_scheduler_runnable(enabled=gate.enabled, status=gate.status):
                        logger.info(
                            "%s",
                            {
                                "stage": "scheduler_loop_exit",
                                "stream_id": stream_id,
                                "reason": "stream_not_runnable",
                                "enabled": bool(gate.enabled),
                                "status": str(gate.status),
                            },
                        )
                        break
                    interval = float(gate.polling_interval)

                    from app.dev_validation_lab.runtime_gates import (
                        dev_validation_runtime_enabled,
                        is_lab_fixture_stream,
                        is_run_once_harness_stream,
                    )
                    from app.dev_validation_lab.lab_resource_guardrail import lab_generation_should_pause
                    from app.streams.runtime_eligibility import is_push_only_stream_type

                    if is_push_only_stream_type(getattr(gate, "stream_type", None)):
                        logger.info(
                            "%s",
                            {
                                "stage": "scheduler_skip_push_only_stream",
                                "stream_id": stream_id,
                                "stream_name": gate.name,
                                "stream_type": getattr(gate, "stream_type", None),
                                "reason": "push_ingest_not_polled",
                            },
                        )
                        break

                    if is_lab_fixture_stream(gate.name) and not dev_validation_runtime_enabled():
                        logger.info(
                            "%s",
                            {
                                "stage": "scheduler_skip_lab_stream_runtime_disabled",
                                "stream_id": stream_id,
                                "stream_name": gate.name,
                                "reason": "dev_validation_lab_disabled",
                            },
                        )
                        break

                    # Cross-product / FULL E2E streams are owned by harness run-once / webhook ingest.
                    # Polling them races the in-process StreamRunner lock and yields RUN_ALREADY_ACTIVE.
                    if is_run_once_harness_stream(gate.name):
                        logger.info(
                            "%s",
                            {
                                "stage": "scheduler_skip_run_once_harness_stream",
                                "stream_id": stream_id,
                                "stream_name": gate.name,
                                "reason": "harness_owned_run_once",
                            },
                        )
                        break

                    if is_lab_fixture_stream(gate.name):
                        paused, pause_reason = lab_generation_should_pause()
                        if paused:
                            from app.config import settings

                            wait_sec = float(
                                getattr(settings, "GDC_LAB_PAUSE_BACKOFF_SECONDS", 30.0) or 30.0
                            )
                            wait_sec = max(wait_sec, float(interval))
                            logger.warning(
                                "%s",
                                {
                                    "stage": "scheduler_lab_stream_paused",
                                    "stream_id": stream_id,
                                    "stream_name": gate.name,
                                    "reason": pause_reason,
                                    "wait_sec": wait_sec,
                                },
                            )
                            if not self._interruptible_wait(stream_id, stream_stop_event, wait_sec):
                                break
                            continue

                    context = load_scheduler_stream_context(stream_id)
                except ValueError as exc:
                    msg = str(exc).lower()
                    if (
                        "disabled" in msg
                        or "no enabled routes" in msg
                        or "destination row missing" in msg
                        or "stream disabled" in msg
                    ):
                        logger.warning(
                            "%s",
                            {
                                "stage": "scheduler_context_unavailable",
                                "stream_id": stream_id,
                                "message": str(exc),
                            },
                        )
                        break
                    cycle_error = exc
                    logger.error(
                        "%s",
                        {
                            "stage": "scheduler_stream_error",
                            "stream_id": stream_id,
                            "error_type": type(exc).__name__,
                            "message": str(exc),
                        },
                    )
                except Exception as exc:  # pragma: no cover - runtime guard
                    cycle_error = exc
                    logger.error(
                        "%s",
                        {
                            "stage": "scheduler_stream_error",
                            "stream_id": stream_id,
                            "error_type": type(exc).__name__,
                            "message": str(exc),
                        },
                    )

                if context is not None:
                    try:
                        self._runner_for_current_thread().run(context)
                        consecutive_failures = 0
                        self._set_backoff(stream_id, failures=0, wait_sec=interval, last_error=None)
                    except ValueError as exc:
                        msg = str(exc).lower()
                        if (
                            "disabled" in msg
                            or "no enabled routes" in msg
                            or "destination row missing" in msg
                            or "stream disabled" in msg
                        ):
                            logger.warning(
                                "%s",
                                {
                                    "stage": "scheduler_context_unavailable",
                                    "stream_id": stream_id,
                                    "message": str(exc),
                                },
                            )
                            break
                        cycle_error = exc
                        logger.error(
                            "%s",
                            {
                                "stage": "scheduler_stream_error",
                                "stream_id": stream_id,
                                "error_type": type(exc).__name__,
                                "message": str(exc),
                            },
                        )
                    except Exception as exc:  # pragma: no cover - runtime guard
                        cycle_error = exc
                        logger.error(
                            "%s",
                            {
                                "stage": "scheduler_stream_error",
                                "stream_id": stream_id,
                                "error_type": type(exc).__name__,
                                "message": str(exc),
                            },
                        )

                wait_sec = max(interval, 0.1)
                if cycle_error is not None and is_transient_scheduler_error(cycle_error):
                    consecutive_failures += 1
                    wait_sec = compute_scheduler_backoff_wait_sec(
                        interval=interval, consecutive_failures=consecutive_failures
                    )
                    self._set_backoff(
                        stream_id,
                        failures=consecutive_failures,
                        wait_sec=wait_sec,
                        last_error=str(cycle_error),
                    )
                    logger.warning(
                        "%s",
                        {
                            "stage": "scheduler_stream_backoff",
                            "stream_id": stream_id,
                            "failures": consecutive_failures,
                            "wait_sec": wait_sec,
                            "last_error": str(cycle_error)[:300],
                            "error_type": type(cycle_error).__name__,
                        },
                    )
                elif cycle_error is not None:
                    # Non-transient: keep base interval but do not reset success counter mid-failure streak
                    # unless we never entered backoff (leave consecutive_failures unchanged only for transient).
                    pass

                if not self._interruptible_wait(stream_id, stream_stop_event, wait_sec):
                    break
        finally:
            self._confirm_stopped_if_disabled(stream_id)
            with self._workers_lock:
                self._workers.pop(stream_id, None)
                self._stream_stop_events.pop(stream_id, None)
            with self._backoff_lock:
                self._stream_backoff.pop(stream_id, None)
            if worker_owned:
                StreamRunner.release_worker_ownership(stream_id)
            logger.info("%s", {"stage": "scheduler_worker_stopped", "stream_id": stream_id})

    def _interruptible_wait(
        self, stream_id: int, stream_stop_event: threading.Event, wait_sec: float
    ) -> bool:
        """Wait up to wait_sec; return False when the worker should exit promptly.

        Cross-process stop sets ``enabled=false`` in the DB without a process-local
        stop event. Poll that flag in short slices so ownership can be released
        without waiting for a full polling interval.
        """

        import time

        deadline = time.monotonic() + max(0.0, float(wait_sec))
        while time.monotonic() < deadline:
            if self._stop_event.is_set() or stream_stop_event.is_set():
                return False
            if not self._stream_still_enabled(stream_id):
                return False
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            stream_stop_event.wait(min(0.5, remaining))
        return not (self._stop_event.is_set() or stream_stop_event.is_set())

    @staticmethod
    def _load_stream_gate(stream_id: int) -> StreamSchedulerGate | None:
        """Read stream gate from the shared bulk snapshot (detached scalars)."""

        return enabled_state_cache.get_gate(int(stream_id))

    @staticmethod
    def _stream_still_enabled(stream_id: int) -> bool:
        """Check enabled flag via bulk snapshot; fail-open on refresh errors."""

        try:
            return bool(enabled_state_cache.is_enabled(int(stream_id)))
        except Exception:  # pragma: no cover - defensive
            return True

    @staticmethod
    def _confirm_stopped_if_disabled(stream_id: int) -> None:
        """When stop left the row STOPPING, confirm STOPPED after ownership ends."""

        def _confirm(db):
            row = get_stream_by_id(db, stream_id)
            if row is None:
                return False
            if not bool(row.enabled) and str(row.status) in {"STOPPING", "RUNNING"}:
                row.status = "STOPPED"
                db.commit()
                return True
            return False

        try:
            confirmed = bool(run_with_db(_confirm))
            if confirmed:
                logger.info(
                    "%s",
                    {"stage": "scheduler_stream_stop_confirmed", "stream_id": stream_id},
                )
        except Exception:  # pragma: no cover - defensive
            logger.exception("scheduler_stream_stop_confirm_failed stream_id=%s", stream_id)
