"""Scheduler enabled-state architecture, bulk refresh, and behavior regression tests."""

from __future__ import annotations

import ast
import threading
import time
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.scheduler.enabled_state import (
    EnabledStateCache,
    StreamSchedulerGate,
    enabled_state_cache,
)
from app.scheduler.enabled_streams import load_enabled_stream_contexts
from app.scheduler.scheduler import Scheduler
from app.streams.models import Stream
from app.streams.repository import list_stream_scheduler_gates
from tests.test_stream_runner_e2e import _seed_stream_runtime


REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEDULER_PKG = REPO_ROOT / "app" / "scheduler"


def _collect_imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                modules.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                modules.add(node.module)
    return modules


def test_scheduler_package_must_not_import_app_main() -> None:
    """Import boundary: app.scheduler.* must not depend on FastAPI entrypoint app.main."""

    offenders: list[str] = []
    for path in sorted(SCHEDULER_PKG.rglob("*.py")):
        if path.name == "__pycache__":
            continue
        for mod in _collect_imports(path):
            if mod == "app.main" or mod.startswith("app.main."):
                offenders.append(f"{path.relative_to(REPO_ROOT)} -> {mod}")
    assert offenders == []


def test_standalone_uses_shared_enabled_stream_loader() -> None:
    standalone_src = (SCHEDULER_PKG / "standalone.py").read_text(encoding="utf-8")
    main_src = (REPO_ROOT / "app" / "main.py").read_text(encoding="utf-8")
    assert "from app.scheduler.enabled_streams import load_enabled_stream_contexts" in standalone_src
    assert "from app.scheduler.enabled_streams import load_enabled_stream_contexts" in main_src
    assert "from app.main import" not in standalone_src
    assert "load_enabled_stream_contexts" in standalone_src
    assert callable(load_enabled_stream_contexts)


def test_enabled_state_bulk_query_does_not_scale_with_stream_count(db_session: Session) -> None:
    """N streams must not produce N enabled-state SELECTs per refresh cycle."""

    from app.connectors.models import Connector
    from app.sources.models import Source

    connector = Connector(name="sched-bulk-conn", description="", status="RUNNING")
    db_session.add(connector)
    db_session.flush()
    source = Source(
        connector_id=connector.id,
        source_type="HTTP_API_POLLING",
        config_json={},
        auth_json={},
        enabled=True,
    )
    db_session.add(source)
    db_session.flush()

    for i in range(100):
        db_session.add(
            Stream(
                connector_id=connector.id,
                source_id=source.id,
                name=f"sched-bulk-stream-{i}",
                stream_type="HTTP_API_POLLING",
                config_json={},
                polling_interval=60,
                enabled=True,
                status="STOPPED",
                rate_limit_json={},
            )
        )
    db_session.commit()

    query_counts: list[int] = []

    def _count_for(n: int) -> int:
        # Build a cache that only sees the first n stream ids via real DB bulk loader.
        ids = [
            int(r[0])
            for r in db_session.query(Stream.id)
            .filter(Stream.name.like("sched-bulk-stream-%"))
            .order_by(Stream.id.asc())
            .limit(n)
            .all()
        ]
        id_set = set(ids)

        def _loader() -> dict[int, StreamSchedulerGate]:
            rows = list_stream_scheduler_gates(db_session)
            return {
                int(row.stream_id): StreamSchedulerGate(
                    stream_id=int(row.stream_id),
                    enabled=bool(row.enabled),
                    status="RUNNING",
                    polling_interval=float(row.polling_interval),
                    name=row.name,
                )
                for row in rows
                if int(row.stream_id) in id_set
            }

        cache = EnabledStateCache(ttl_sec=60.0, loader=_loader)
        # Force one refresh and touch all gates.
        for sid in ids:
            assert cache.is_enabled(sid) is True
        metrics = cache.metrics()
        query_counts.append(int(metrics["query_count"]))
        return int(metrics["query_count"])

    q10 = _count_for(10)
    q100 = _count_for(100)
    assert q10 == 1
    assert q100 == 1
    assert q10 == q100


def test_enabled_state_cache_single_flight_across_workers() -> None:
    """Concurrent waiters in one TTL window share a single bulk refresh."""

    loads = {"count": 0}
    ready = threading.Event()
    release = threading.Event()

    def _loader() -> dict[int, StreamSchedulerGate]:
        loads["count"] += 1
        ready.set()
        release.wait(timeout=2.0)
        return {
            i: StreamSchedulerGate(stream_id=i, enabled=True, status="RUNNING", polling_interval=60.0, name=f"s-{i}")
            for i in range(1, 101)
        }

    cache = EnabledStateCache(ttl_sec=5.0, loader=_loader)
    results: list[bool] = []

    def _worker(sid: int) -> None:
        results.append(cache.is_enabled(sid))

    threads = [threading.Thread(target=_worker, args=(i,), daemon=True) for i in range(1, 51)]
    for t in threads:
        t.start()
    assert ready.wait(timeout=2.0)
    release.set()
    for t in threads:
        t.join(timeout=2.0)
    assert loads["count"] == 1
    assert all(results)
    assert cache.metrics()["query_count"] == 1


def test_case_a_enabled_stream_is_scheduler_candidate() -> None:
    cache = EnabledStateCache(
        ttl_sec=60.0,
        loader=lambda: {
            1: StreamSchedulerGate(stream_id=1, enabled=True, status="RUNNING", polling_interval=30.0, name="ok")
        },
    )
    gate = cache.get_gate(1)
    assert gate is not None
    assert gate.enabled is True
    assert gate.polling_interval == 30.0


def test_case_b_disabled_stream_excluded() -> None:
    cache = EnabledStateCache(
        ttl_sec=60.0,
        loader=lambda: {
            2: StreamSchedulerGate(stream_id=2, enabled=False, status="RUNNING", polling_interval=30.0, name="off")
        },
    )
    assert cache.is_enabled(2) is False


def test_case_c_enabled_to_disabled_after_refresh() -> None:
    state = {"enabled": True}

    def _loader() -> dict[int, StreamSchedulerGate]:
        return {
            3: StreamSchedulerGate(
                stream_id=3,
                enabled=bool(state["enabled"]),
                    status="RUNNING",
                polling_interval=10.0,
                name="toggle",
            )
        }

    cache = EnabledStateCache(ttl_sec=0.05, loader=_loader)
    assert cache.is_enabled(3) is True
    state["enabled"] = False
    cache.invalidate()
    assert cache.is_enabled(3) is False


def test_case_d_disabled_to_enabled_after_refresh() -> None:
    state = {"enabled": False}

    def _loader() -> dict[int, StreamSchedulerGate]:
        return {
            4: StreamSchedulerGate(
                stream_id=4,
                enabled=bool(state["enabled"]),
                    status="RUNNING",
                polling_interval=10.0,
                name="toggle-on",
            )
        }

    cache = EnabledStateCache(ttl_sec=0.05, loader=_loader)
    assert cache.is_enabled(4) is False
    state["enabled"] = True
    cache.invalidate()
    assert cache.is_enabled(4) is True


def test_case_f_refresh_failure_fail_open_on_wait_check() -> None:
    def _loader() -> dict[int, StreamSchedulerGate]:
        raise RuntimeError("db down")

    cache = EnabledStateCache(ttl_sec=0.05, loader=_loader)
    # Swap process cache temporarily for Scheduler helper.
    import app.scheduler.scheduler as sched_mod

    previous = sched_mod.enabled_state_cache
    sched_mod.enabled_state_cache = cache
    try:
        assert Scheduler._stream_still_enabled(99) is True
    finally:
        sched_mod.enabled_state_cache = previous


def test_case_g_standalone_module_imports_without_app_main() -> None:
    import importlib

    mod = importlib.import_module("app.scheduler.standalone")
    assert hasattr(mod, "run_standalone_scheduler")
    assert "app.main" not in _collect_imports(SCHEDULER_PKG / "standalone.py")


def test_loop_exits_when_gate_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.scheduler import scheduler as sched_mod

    calls: list[int] = []

    class _FakeRunner:
        def run(self, *_a: Any, **_k: Any) -> dict[str, Any]:
            calls.append(1)
            return {"outcome": "completed"}

        @staticmethod
        def try_acquire_worker_ownership(_sid: int) -> bool:
            return True

        @staticmethod
        def release_worker_ownership(_sid: int) -> None:
            return None

    monkeypatch.setattr(sched_mod, "StreamRunner", _FakeRunner)
    monkeypatch.setattr(
        sched_mod,
        "enabled_state_cache",
        EnabledStateCache(
            ttl_sec=60.0,
            loader=lambda: {
                42: StreamSchedulerGate(
                    stream_id=42, enabled=False, status="RUNNING", polling_interval=0.01, name="disabled"
                )
            },
        ),
    )
    monkeypatch.setattr(sched_mod.Scheduler, "_confirm_stopped_if_disabled", staticmethod(lambda _sid: None))
    sched = sched_mod.Scheduler()
    sched._loop_stream(42)
    assert calls == []


def test_loop_runs_when_gate_enabled_then_disables(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.scheduler import scheduler as sched_mod

    fixture = _seed_stream_runtime(db_session)
    stream_id = int(fixture["stream_id"])
    run_calls: list[int] = []
    state = {"enabled": True}

    class _TrackingRunner:
        def run(self, *_a: Any, **_k: Any) -> dict[str, Any]:
            run_calls.append(1)
            state["enabled"] = False
            return {"outcome": "completed"}

        @staticmethod
        def try_acquire_worker_ownership(_sid: int) -> bool:
            return True

        @staticmethod
        def release_worker_ownership(_sid: int) -> None:
            return None

    def _loader() -> dict[int, StreamSchedulerGate]:
        return {
            stream_id: StreamSchedulerGate(
                stream_id=stream_id,
                enabled=bool(state["enabled"]),
                    status="RUNNING",
                polling_interval=0.01,
                name=f"pytest-enabled-toggle-{stream_id}",
            )
        }

    cache = EnabledStateCache(ttl_sec=0.01, loader=_loader)
    monkeypatch.setattr(sched_mod, "StreamRunner", _TrackingRunner)
    monkeypatch.setattr(sched_mod, "enabled_state_cache", cache)
    monkeypatch.setattr(sched_mod, "load_scheduler_stream_context", lambda _sid: object())
    monkeypatch.setattr(sched_mod.Scheduler, "_confirm_stopped_if_disabled", staticmethod(lambda _sid: None))

    sched = sched_mod.Scheduler()
    sched._loop_stream(stream_id)
    assert len(run_calls) == 1


def test_interruptible_wait_uses_bulk_cache_not_per_check_query(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.scheduler import scheduler as sched_mod

    loads = {"count": 0}

    def _loader() -> dict[int, StreamSchedulerGate]:
        loads["count"] += 1
        return {
            7: StreamSchedulerGate(stream_id=7, enabled=True, status="RUNNING", polling_interval=60.0, name="wait")
        }

    cache = EnabledStateCache(ttl_sec=0.5, loader=_loader)
    monkeypatch.setattr(sched_mod, "enabled_state_cache", cache)
    sched = sched_mod.Scheduler()
    stop = threading.Event()
    started = time.monotonic()
    assert sched._interruptible_wait(7, stop, 2.0) is True
    elapsed = time.monotonic() - started
    assert elapsed >= 1.9
    # Prior behavior: ~4 get_stream_by_id calls over 2s. Bulk cache: ~1 per TTL window.
    assert loads["count"] <= 5
    assert cache.metrics()["query_count"] == loads["count"]


def test_scheduler_manual_run_once_ownership_unchanged(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Ownership gate semantics must remain process-file based (no redesign)."""

    from app.runners.stream_runner import StreamRunner

    monkeypatch.setenv("GDC_STREAM_RUN_LOCK_DIR", str(tmp_path))
    stream_id = 555001
    assert StreamRunner.try_acquire_worker_ownership(stream_id) is True
    try:
        assert StreamRunner.try_acquire_worker_ownership(stream_id) is False
        assert StreamRunner.is_worker_ownership_held(stream_id) is True
    finally:
        StreamRunner.release_worker_ownership(stream_id)
    assert StreamRunner.is_worker_ownership_held(stream_id) is False


@pytest.fixture(autouse=True)
def _reset_enabled_state_cache() -> Any:
    enabled_state_cache.reset_for_tests()
    yield
    enabled_state_cache.reset_for_tests()
