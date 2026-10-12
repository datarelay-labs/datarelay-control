"""PF-11A opt-in outbox worker: no product DB or live transport."""

from __future__ import annotations

import logging
from threading import Event

import pytest

from app.governance_notifications.worker import GovernanceOutboxWorker


@pytest.mark.parametrize("queue_on, worker_on, enabled", [
    (False, False, False),
    (True, False, False),
    (False, True, False),
    (True, True, True),
])
def test_outbox_worker_needs_both_explicit_flags(
    monkeypatch, queue_on, worker_on, enabled
):
    if queue_on:
        monkeypatch.setenv("GDC_GOV_NOTIFICATION_DURABLE_QUEUE_ENABLED", "true")
    else:
        monkeypatch.delenv("GDC_GOV_NOTIFICATION_DURABLE_QUEUE_ENABLED", raising=False)
    if worker_on:
        monkeypatch.setenv("GDC_GOV_NOTIFICATION_WORKER_ENABLED", "true")
    else:
        monkeypatch.delenv("GDC_GOV_NOTIFICATION_WORKER_ENABLED", raising=False)
    worker = GovernanceOutboxWorker(session_factory=object(), drain=lambda *_args: 0)
    assert worker.is_enabled() is enabled
    if not enabled:
        assert worker.start() is False
        assert worker.is_running() is False
    worker.stop()


def test_outbox_worker_runs_one_fake_batch_only_when_both_flags_enabled(monkeypatch):
    monkeypatch.setenv("GDC_GOV_NOTIFICATION_DURABLE_QUEUE_ENABLED", "true")
    monkeypatch.setenv("GDC_GOV_NOTIFICATION_WORKER_ENABLED", "true")
    seen = Event()
    sessions = object()

    def fake_drain(factory):
        assert factory is sessions
        seen.set()
        return 1

    worker = GovernanceOutboxWorker(session_factory=sessions, drain=fake_drain, poll_seconds=30)
    try:
        assert worker.start() is True
        assert seen.wait(2)
        assert worker.is_running() is True
    finally:
        worker.stop()
    assert worker.is_running() is False


def test_worker_errors_log_only_exception_type(monkeypatch, caplog):
    monkeypatch.setenv("GDC_GOV_NOTIFICATION_DURABLE_QUEUE_ENABLED", "true")
    monkeypatch.setenv("GDC_GOV_NOTIFICATION_WORKER_ENABLED", "true")

    def failed(_sessions):
        raise RuntimeError("secret-payload-cannot-be-logged")

    worker = GovernanceOutboxWorker(session_factory=object(), drain=failed)
    with caplog.at_level(logging.WARNING):
        assert worker.trigger_once() == 0
    assert "RuntimeError" in caplog.text
    assert "secret-payload-cannot-be-logged" not in caplog.text
