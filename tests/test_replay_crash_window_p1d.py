"""P1-D replay crash window — claim before send, recovery, idempotency propagation."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from sqlalchemy.orm import Session, sessionmaker

from app.destinations.adapters.registry import DestinationAdapterRegistry
from app.replay.models import (
    DELIVERY_ATTEMPT_CONTEXT_KEY,
    REPLAY_DELIVERY_GUARANTEE_AT_LEAST_ONCE,
    REPLAY_STATUS_PENDING,
    REPLAY_STATUS_REPLAYED,
    REPLAY_STATUS_REPLAYING,
    StreamReplayEvent,
)
from app.replay.service import (
    REPLAY_CLAIM_STALE_AFTER_SECONDS,
    ReplayInProgressError,
    execute_replay_event,
)
from tests.test_replay_engine_m11 import _insert_replay_row
from tests.test_stream_runner_e2e import _seed_stream_runtime


class _ClaimAwareWebhookSender:
    """Records calls and optionally inspects durable claim state mid-send."""

    def __init__(
        self,
        *,
        db_engine: Any | None = None,
        event_id: int | None = None,
        fail: bool = False,
    ) -> None:
        self.db_engine = db_engine
        self.event_id = event_id
        self.fail = fail
        self.calls: list[dict[str, Any]] = []
        self.status_at_send: str | None = None
        self.attempt_at_send: dict[str, Any] | None = None

    def send(
        self,
        events: list[dict[str, Any]],
        config: dict[str, Any],
        formatter_override: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        if self.db_engine is not None and self.event_id is not None:
            SessionLocal = sessionmaker(bind=self.db_engine, expire_on_commit=False)
            probe = SessionLocal()
            try:
                row = probe.get(StreamReplayEvent, int(self.event_id))
                assert row is not None
                self.status_at_send = row.status
                ctx = row.delivery_context_json if isinstance(row.delivery_context_json, dict) else {}
                attempt = ctx.get(DELIVERY_ATTEMPT_CONTEXT_KEY)
                self.attempt_at_send = dict(attempt) if isinstance(attempt, dict) else None
            finally:
                probe.close()
        self.calls.append(
            {
                "events": events,
                "config": config,
                "idempotency_key": kwargs.get("idempotency_key"),
            }
        )
        if self.fail:
            raise RuntimeError("simulated destination failure")


def test_claim_committed_before_destination_send(db_session: Session, db_engine: Any) -> None:
    seeded = _seed_stream_runtime(db_session)
    row = _insert_replay_row(db_session, seeded=seeded, events=[{"event_id": "claim-1"}])
    event_id = int(row.id)
    sender = _ClaimAwareWebhookSender(db_engine=db_engine, event_id=event_id)
    registry = DestinationAdapterRegistry(webhook_sender=sender)

    result = execute_replay_event(db_session, event_id, destination_registry=registry)
    db_session.commit()

    assert sender.status_at_send == REPLAY_STATUS_REPLAYING
    assert sender.attempt_at_send is not None
    assert sender.attempt_at_send.get("attempt_id")
    assert sender.attempt_at_send.get("idempotency_key") == sender.calls[0]["idempotency_key"]
    assert result["outcome"] == "replayed"
    assert result["status"] == REPLAY_STATUS_REPLAYED
    assert result["delivery_guarantee"] == REPLAY_DELIVERY_GUARANTEE_AT_LEAST_ONCE
    assert result["prior_delivery_uncertain"] is False
    assert result["attempt_id"] == sender.attempt_at_send["attempt_id"]


def test_crash_after_send_before_final_commit_leaves_replaying(
    db_session: Session,
    db_engine: Any,
) -> None:
    """Simulate crash after durable claim + successful send, before REPLAYED commit."""

    seeded = _seed_stream_runtime(db_session)
    row = _insert_replay_row(db_session, seeded=seeded, events=[{"event_id": "crash-1"}])
    event_id = int(row.id)
    sender = _ClaimAwareWebhookSender(db_engine=db_engine, event_id=event_id)
    registry = DestinationAdapterRegistry(webhook_sender=sender)

    # Force failure after send while re-locking / finalizing — claim already committed.
    original_lock = __import__("app.replay.service", fromlist=["_lock_replay_event_row"])._lock_replay_event_row
    call_count = {"n": 0}

    def _lock_then_crash(db: Session, eid: int):
        call_count["n"] += 1
        locked = original_lock(db, eid)
        if call_count["n"] >= 2:
            # Claim already durable; abort before REPLAYED write (process crash window).
            db.rollback()
            raise RuntimeError("simulated crash after destination send")
        return locked

    import app.replay.service as replay_service

    monkey_lock = pytest.MonkeyPatch()
    monkey_lock.setattr(replay_service, "_lock_replay_event_row", _lock_then_crash)
    try:
        with pytest.raises(RuntimeError, match="simulated crash"):
            execute_replay_event(db_session, event_id, destination_registry=registry)
    finally:
        monkey_lock.undo()

    db_session.rollback()
    db_session.expire_all()
    refreshed = db_session.get(StreamReplayEvent, event_id)
    assert refreshed is not None
    assert refreshed.status == REPLAY_STATUS_REPLAYING
    attempt = refreshed.delivery_context_json.get(DELIVERY_ATTEMPT_CONTEXT_KEY)
    assert isinstance(attempt, dict)
    assert attempt.get("attempt_id")
    assert len(sender.calls) == 1
    assert sender.calls[0]["idempotency_key"] == attempt.get("idempotency_key")


def test_stale_replaying_recovery_reuses_attempt_and_flags_uncertainty(
    db_session: Session,
    db_engine: Any,
) -> None:
    seeded = _seed_stream_runtime(db_session)
    stale_claimed_at = (
        datetime.now(timezone.utc) - timedelta(seconds=REPLAY_CLAIM_STALE_AFTER_SECONDS + 30)
    ).isoformat()
    attempt_id = "stale-attempt-abc"
    idempotency_key = f"replay-placeholder-{attempt_id}"
    row = _insert_replay_row(
        db_session,
        seeded=seeded,
        events=[{"event_id": "recover-1"}],
        status=REPLAY_STATUS_REPLAYING,
    )
    # Fix idempotency key to match real event id after insert.
    idempotency_key = f"replay-{int(row.id)}-{attempt_id}"
    ctx = dict(row.delivery_context_json)
    ctx[DELIVERY_ATTEMPT_CONTEXT_KEY] = {
        "attempt_id": attempt_id,
        "idempotency_key": idempotency_key,
        "delivery_guarantee": REPLAY_DELIVERY_GUARANTEE_AT_LEAST_ONCE,
        "prior_delivery_uncertain": False,
        "claimed_at": stale_claimed_at,
    }
    row.delivery_context_json = ctx
    row.last_replay_at = datetime.now(timezone.utc) - timedelta(seconds=REPLAY_CLAIM_STALE_AFTER_SECONDS + 30)
    db_session.commit()

    sender = _ClaimAwareWebhookSender(db_engine=db_engine, event_id=int(row.id))
    registry = DestinationAdapterRegistry(webhook_sender=sender)
    result = execute_replay_event(db_session, int(row.id), destination_registry=registry)
    db_session.commit()

    assert len(sender.calls) == 1
    assert sender.calls[0]["idempotency_key"] == idempotency_key
    assert result["outcome"] == "replayed"
    assert result["attempt_id"] == attempt_id
    assert result["idempotency_key"] == idempotency_key
    assert result["prior_delivery_uncertain"] is True
    assert result["delivery_guarantee"] == REPLAY_DELIVERY_GUARANTEE_AT_LEAST_ONCE


def test_fresh_replaying_claim_rejects_concurrent_retry(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    row = _insert_replay_row(
        db_session,
        seeded=seeded,
        events=[{"event_id": "fresh-1"}],
        status=REPLAY_STATUS_REPLAYING,
    )
    ctx = dict(row.delivery_context_json)
    ctx[DELIVERY_ATTEMPT_CONTEXT_KEY] = {
        "attempt_id": "fresh-attempt",
        "idempotency_key": f"replay-{int(row.id)}-fresh-attempt",
        "delivery_guarantee": REPLAY_DELIVERY_GUARANTEE_AT_LEAST_ONCE,
        "prior_delivery_uncertain": False,
        "claimed_at": datetime.now(timezone.utc).isoformat(),
    }
    row.delivery_context_json = ctx
    db_session.commit()

    with pytest.raises(ReplayInProgressError):
        execute_replay_event(db_session, int(row.id))


def test_failed_send_after_claim_marks_failed_with_attempt_meta(
    db_session: Session,
    db_engine: Any,
) -> None:
    seeded = _seed_stream_runtime(db_session)
    row = _insert_replay_row(db_session, seeded=seeded, events=[{"event_id": "fail-1"}])
    event_id = int(row.id)
    assert row.status == REPLAY_STATUS_PENDING
    sender = _ClaimAwareWebhookSender(db_engine=db_engine, event_id=event_id, fail=True)
    registry = DestinationAdapterRegistry(webhook_sender=sender)

    result = execute_replay_event(db_session, event_id, destination_registry=registry)
    db_session.commit()

    assert result["outcome"] == "failed"
    assert result["status"] == "failed"
    assert result["attempt_id"]
    assert result["prior_delivery_uncertain"] is True
    assert result["delivery_guarantee"] == REPLAY_DELIVERY_GUARANTEE_AT_LEAST_ONCE
    db_session.expire_all()
    refreshed = db_session.get(StreamReplayEvent, event_id)
    assert refreshed is not None
    assert refreshed.status == "failed"
    attempt = refreshed.delivery_context_json.get(DELIVERY_ATTEMPT_CONTEXT_KEY)
    assert isinstance(attempt, dict)
    assert attempt.get("attempt_id") == result["attempt_id"]
