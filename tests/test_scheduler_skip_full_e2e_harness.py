"""Scheduler must not poll [FULL E2E] harness streams (run-once / webhook ownership)."""

from __future__ import annotations

from app.dev_validation_lab.runtime_gates import (
    is_run_once_harness_stream,
    stream_name_is_full_e2e_harness,
)


def test_full_e2e_prefix_is_harness_owned() -> None:
    assert stream_name_is_full_e2e_harness("[FULL E2E]xp-5093f0dda07b-stream")
    assert is_run_once_harness_stream("[FULL E2E]xp-5093f0dda07b-stream")


def test_dev_validation_streams_are_not_harness_owned() -> None:
    assert not is_run_once_harness_stream("[DEV VALIDATION] something")
    assert not is_run_once_harness_stream("[DEV E2E] something")
    assert not is_run_once_harness_stream("prod-stream")


def test_scheduler_loop_skips_full_e2e_without_run(monkeypatch) -> None:
    from app.scheduler.scheduler import Scheduler
    from app.scheduler.enabled_state import EnabledStateCache, StreamSchedulerGate
    from app.scheduler import scheduler as sched_mod

    calls: list[int] = []

    class _FakeRunner:
        def run(self, *_a, **_k):
            calls.append(1)
            return {"outcome": "completed"}

        @staticmethod
        def try_acquire_worker_ownership(_sid: int) -> bool:
            return True

        @staticmethod
        def release_worker_ownership(_sid: int) -> None:
            return None

    sched = Scheduler(streams_provider=lambda: [])
    monkeypatch.setattr(sched, "_runner_for_current_thread", lambda: _FakeRunner())
    monkeypatch.setattr(sched_mod, "StreamRunner", _FakeRunner)
    monkeypatch.setattr(
        sched_mod,
        "enabled_state_cache",
        EnabledStateCache(
            ttl_sec=60.0,
            loader=lambda: {
                99999: StreamSchedulerGate(
                    stream_id=99999,
                    enabled=True, status="RUNNING",
                    polling_interval=1.0,
                    name="[FULL E2E]xp-test-stream",
                )
            },
        ),
    )
    monkeypatch.setattr(sched_mod.Scheduler, "_confirm_stopped_if_disabled", staticmethod(lambda _sid: None))

    # Gate returns enabled FULL E2E stream — loop must exit without calling run.
    sched._loop_stream(99999)
    assert calls == []
