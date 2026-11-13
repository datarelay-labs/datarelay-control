"""Per-Route delivery state within a held stream checkpoint window (R2).

Defect: when one Route fails with a non-absorbing failure policy the stream checkpoint is
held, so every poll re-fetches the same window and the healthy Route re-received the same
events (N+1 copies for an N-poll outage), while the failing Route always restarted from
its first event. These tests drive the real StreamRunner + CheckpointService against the
test database across several polls.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import replace
from datetime import datetime, timezone
from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.checkpoints.route_delivery_state import ROUTE_DELIVERY_STATE_KEY, strip_route_delivery_state
from app.connectors.models import Connector
from app.destinations.models import Destination
from app.enrichments.models import Enrichment
from app.mappings.models import Mapping
from app.routes.models import Route
from app.runners.stream_loader import load_stream_context
from app.runners.stream_runner import StreamRunner
from app.runtime.copy_utils import checkpoint_read_view
from app.runtime.errors import DestinationSendError
from app.sources.models import Source
from app.streams.models import Stream


class _AllowAllLimiter:
    def allow(self, _value: int, rate_limit_json: dict[str, Any] | None = None) -> bool:
        return True


class _FakePoller:
    def __init__(self) -> None:
        self.items: list[dict[str, Any]] = []
        self.checkpoints_seen: list[Any] = []

    def fetch(self, source_config: dict[str, Any], stream_config: dict[str, Any], checkpoint: Any) -> Any:
        self.checkpoints_seen.append(checkpoint)
        return {"items": [dict(item) for item in self.items]}


class _ReceiverSender:
    """Webhook stand-in: records what each receiver URL actually accepted."""

    def __init__(self) -> None:
        self.fail_urls: set[str] = set()
        # url -> number of leading events accepted before failing once (chunked send).
        self.partial_once: dict[str, int] = {}
        self.accepted: dict[str, list[str]] = {}
        self.attempts: dict[str, list[list[str]]] = {}

    def send(
        self,
        events: list[dict[str, Any]],
        config: dict[str, Any],
        formatter_override: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        url = str(config.get("url"))
        ids = [str(event.get("event_id")) for event in events]
        self.attempts.setdefault(url, []).append(ids)
        if url in self.partial_once:
            accepted = self.partial_once.pop(url)
            self.accepted.setdefault(url, []).extend(ids[:accepted])
            err = DestinationSendError("receiver failed mid-batch")
            err.delivered_event_count = accepted
            raise err
        if url in self.fail_urls:
            raise DestinationSendError(f"receiver returned 500: {url}")
        self.accepted.setdefault(url, []).extend(ids)


class _NoSyslog:
    def send(self, *args: Any, **kwargs: Any) -> None:  # pragma: no cover
        raise AssertionError("syslog sender must not be called")


def _url(idx: int) -> str:
    return f"https://r2-receiver-{idx}.example.com/events"


_SEED_CHECKPOINT: dict[str, Any] = {"last_success_event": {"event_id": "seed-0"}}


def _seed(
    db: Session,
    *,
    failure_policies: list[str],
    checkpoint_value: dict[str, Any] | None = _SEED_CHECKPOINT,
) -> dict[str, Any]:
    suffix = uuid.uuid4().hex[:10]
    connector = Connector(name=f"pytest-r2-{suffix}", description="route delivery state", status="RUNNING")
    db.add(connector)
    db.flush()
    source = Source(
        connector_id=connector.id,
        source_type="HTTP_API_POLLING",
        config_json={"base_url": "https://api.example.com"},
        auth_json={},
        enabled=True,
    )
    db.add(source)
    db.flush()
    stream = Stream(
        connector_id=connector.id,
        source_id=source.id,
        name=f"pytest-r2-stream-{suffix}",
        stream_type="HTTP_API_POLLING",
        config_json={"endpoint": "/events", "event_array_path": "$.items"},
        polling_interval=60,
        enabled=True,
        status="RUNNING",
        rate_limit_json={"max_requests": 100, "per_seconds": 60},
    )
    db.add(stream)
    db.flush()
    db.add_all(
        [
            Mapping(
                stream_id=stream.id,
                event_array_path="$.items",
                field_mappings_json={"event_id": "$.id", "message": "$.message"},
                raw_payload_mode="JSON",
            ),
            Enrichment(
                stream_id=stream.id,
                enrichment_json={"product": "GDC"},
                override_policy="KEEP_EXISTING",
                enabled=True,
            ),
        ]
    )
    db.flush()
    route_ids: list[int] = []
    for idx, policy in enumerate(failure_policies):
        destination = Destination(
            name=f"pytest-r2-dest-{suffix}-{idx}",
            destination_type="WEBHOOK_POST",
            config_json={"url": _url(idx)},
            rate_limit_json={"max_events": 1000, "per_seconds": 1},
            enabled=True,
        )
        db.add(destination)
        db.flush()
        route = Route(
            stream_id=stream.id,
            destination_id=destination.id,
            enabled=True,
            failure_policy=policy,
            formatter_config_json={},
            rate_limit_json={},
            status="ENABLED",
        )
        db.add(route)
        db.flush()
        route_ids.append(int(route.id))
    if checkpoint_value is not None:
        db.add(
            Checkpoint(
                stream_id=stream.id,
                checkpoint_type="EVENT_ID",
                checkpoint_value_json=dict(checkpoint_value),
            )
        )
    db.commit()
    return {"stream_id": int(stream.id), "route_ids": route_ids}


def _checkpoint(db: Session, stream_id: int) -> dict[str, Any]:
    row = db.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).first()
    assert row is not None
    return dict(row.checkpoint_value_json)


def _poll(db: Session, runner: StreamRunner, stream_id: int, **context_overrides: Any) -> dict[str, Any]:
    """One scheduler-equivalent poll: fresh context (fresh checkpoint) then run."""

    context = load_stream_context(db, stream_id)
    for route in context.routes:
        # RETRY_AND_BACKOFF without in-run retries/sleeps: the failure stays non-absorbed.
        route["retry_count"] = 0
        route["backoff_seconds"] = 0
    if context_overrides:
        context = replace(context, **context_overrides)
    return runner.run(context, db=db)


def _events(*ids: str) -> list[dict[str, Any]]:
    return [{"id": event_id, "message": f"msg-{event_id}"} for event_id in ids]


@pytest.fixture
def harness(db_session: Session) -> tuple[Session, StreamRunner, _FakePoller, _ReceiverSender]:
    poller = _FakePoller()
    sender = _ReceiverSender()
    runner = StreamRunner(
        poller=poller,  # type: ignore[arg-type]
        source_limiter=_AllowAllLimiter(),  # type: ignore[arg-type]
        destination_limiter=_AllowAllLimiter(),  # type: ignore[arg-type]
        webhook_sender=sender,  # type: ignore[arg-type]
        syslog_sender=_NoSyslog(),  # type: ignore[arg-type]
    )
    return db_session, runner, poller, sender


def test_healthy_route_is_not_resent_delivered_events_while_other_route_keeps_failing(harness: Any) -> None:
    """(1) Receiver B is down for 3 polls; healthy Receiver A gets each event exactly once.

    Old code: A accepted e1..e3 on every poll (9 events, 3 copies each).
    """

    db, runner, poller, sender = harness
    seeded = _seed(db, failure_policies=["LOG_AND_CONTINUE", "RETRY_AND_BACKOFF"])
    sid = seeded["stream_id"]
    route_a = seeded["route_ids"][0]
    before = _checkpoint(db, sid)
    poller.items = _events("e1", "e2", "e3")
    sender.fail_urls = {_url(1)}

    for _ in range(3):
        _poll(db, runner, sid)

    assert sender.accepted.get(_url(0)) == ["e1", "e2", "e3"]
    # Failing Route keeps being retried with the whole undelivered window (at-least-once).
    assert sender.attempts[_url(1)] == [["e1", "e2", "e3"]] * 3
    assert _url(1) not in sender.accepted

    after = _checkpoint(db, sid)
    # Stream checkpoint cursor is held exactly as before.
    assert strip_route_delivery_state(after) == before
    state = after[ROUTE_DELIVERY_STATE_KEY]
    # Fingerprints only: no raw event content is stored in the checkpoint.
    fingerprints = [fp for fps in state["routes"].values() for fp in fps]
    assert fingerprints
    assert all(re.fullmatch(r"[0-9a-f]+(#\d+)?", fp) for fp in fingerprints)
    assert "msg-" not in json.dumps(state)
    assert list(state["routes"].keys()) == [str(route_a)]
    # Runtime read APIs expose only per-Route counts (C8 reduced checkpoint view).
    assert checkpoint_read_view(after)[ROUTE_DELIVERY_STATE_KEY] == {
        "route_delivered_event_counts": {str(route_a): 3}
    }


@pytest.mark.parametrize("initial_checkpoint", [None, {}], ids=["no_checkpoint_row", "empty_checkpoint"])
def test_first_window_without_cursor_keeps_route_progress_and_source_view(
    harness: Any, initial_checkpoint: dict[str, Any] | None
) -> None:
    """(1) also holds for the very first window (UI-created stream / after reset).

    Sources must keep seeing exactly the original checkpoint (``None`` or ``{}``).
    """

    db, runner, poller, sender = harness
    seeded = _seed(
        db,
        failure_policies=["LOG_AND_CONTINUE", "RETRY_AND_BACKOFF"],
        checkpoint_value=initial_checkpoint,
    )
    sid = seeded["stream_id"]
    poller.items = _events("e1", "e2")
    sender.fail_urls = {_url(1)}

    for _ in range(3):
        _poll(db, runner, sid)

    assert sender.accepted[_url(0)] == ["e1", "e2"]
    assert poller.checkpoints_seen == [initial_checkpoint] * 3

    sender.fail_urls = set()
    _poll(db, runner, sid)
    assert sender.accepted[_url(0)] == ["e1", "e2"]
    assert sender.accepted[_url(1)] == ["e1", "e2"]
    after = _checkpoint(db, sid)
    assert after["last_success_event"]["event_id"] == "e2"
    assert ROUTE_DELIVERY_STATE_KEY not in after


def test_failing_route_receives_every_event_once_after_recovery_then_checkpoint_advances(harness: Any) -> None:
    """(2) After B recovers it gets every held event exactly once; A gets only the new one.

    Old code: A accepted e1..e3 again on the recovery poll.
    """

    db, runner, poller, sender = harness
    seeded = _seed(db, failure_policies=["LOG_AND_CONTINUE", "RETRY_AND_BACKOFF"])
    sid = seeded["stream_id"]
    sender.fail_urls = {_url(1)}
    poller.items = _events("e1", "e2", "e3")
    _poll(db, runner, sid)
    _poll(db, runner, sid)

    sender.fail_urls = set()
    poller.items = _events("e1", "e2", "e3", "e4")  # held window plus one new event
    summary = _poll(db, runner, sid)

    assert sender.accepted[_url(0)] == ["e1", "e2", "e3", "e4"]
    assert sender.accepted[_url(1)] == ["e1", "e2", "e3", "e4"]
    assert summary["checkpoint_updated"] is True
    after = _checkpoint(db, sid)
    assert after["last_success_event"]["event_id"] == "e4"
    # (5) Checkpoint advance clears the per-Route state.
    assert ROUTE_DELIVERY_STATE_KEY not in after


def test_route_failing_mid_batch_resumes_from_first_undelivered_event(harness: Any) -> None:
    """(3) Head-of-line: B accepts e1,e2 then fails; next poll sends only e3,e4.

    Old code: the next poll re-sent e1..e4, so B accepted e1,e2 twice.
    """

    db, runner, poller, sender = harness
    seeded = _seed(db, failure_policies=["LOG_AND_CONTINUE", "RETRY_AND_BACKOFF"])
    sid = seeded["stream_id"]
    poller.items = _events("e1", "e2", "e3", "e4")
    sender.partial_once = {_url(1): 2}
    _poll(db, runner, sid)
    assert sender.accepted[_url(1)] == ["e1", "e2"]

    summary = _poll(db, runner, sid)

    assert sender.attempts[_url(1)][-1] == ["e3", "e4"]
    assert sender.accepted[_url(1)] == ["e1", "e2", "e3", "e4"]
    assert sender.accepted[_url(0)] == ["e1", "e2", "e3", "e4"]
    assert summary["checkpoint_updated"] is True
    after = _checkpoint(db, sid)
    assert after["last_success_event"]["event_id"] == "e4"
    assert ROUTE_DELIVERY_STATE_KEY not in after


def test_all_routes_succeed_keeps_existing_behavior(harness: Any) -> None:
    """(4) No regression: every Route delivers, checkpoint advances, no state is written."""

    db, runner, poller, sender = harness
    seeded = _seed(db, failure_policies=["LOG_AND_CONTINUE", "RETRY_AND_BACKOFF"])
    sid = seeded["stream_id"]
    poller.items = _events("e1", "e2")
    summary = _poll(db, runner, sid)

    assert summary["checkpoint_updated"] is True
    assert sender.accepted[_url(0)] == ["e1", "e2"]
    assert sender.accepted[_url(1)] == ["e1", "e2"]
    after = _checkpoint(db, sid)
    assert after["last_success_event"]["event_id"] == "e2"
    assert ROUTE_DELIVERY_STATE_KEY not in after

    poller.items = _events("e3")
    _poll(db, runner, sid)
    assert sender.accepted[_url(0)] == ["e1", "e2", "e3"]
    assert sender.accepted[_url(1)] == ["e1", "e2", "e3"]


def test_replay_run_is_not_suppressed_by_route_delivery_state(harness: Any) -> None:
    """Replay/backfill deliberately re-sends; per-Route state must neither filter nor record."""

    db, runner, poller, sender = harness
    seeded = _seed(db, failure_policies=["LOG_AND_CONTINUE", "RETRY_AND_BACKOFF"])
    sid = seeded["stream_id"]
    poller.items = _events("e1", "e2")
    sender.fail_urls = {_url(1)}
    _poll(db, runner, sid)
    state_before = _checkpoint(db, sid)[ROUTE_DELIVERY_STATE_KEY]

    _poll(
        db,
        runner,
        sid,
        replay_start=datetime(2026, 1, 1, tzinfo=timezone.utc),
        replay_end=datetime(2026, 1, 2, tzinfo=timezone.utc),
        persist_checkpoint=False,
    )

    assert sender.accepted[_url(0)] == ["e1", "e2", "e1", "e2"]
    assert _checkpoint(db, sid)[ROUTE_DELIVERY_STATE_KEY] == state_before


def test_manual_checkpoint_change_invalidates_route_delivery_state(harness: Any) -> None:
    """State is bound to the exact held window; an operator edit makes it stale (re-send, no loss)."""

    db, runner, poller, sender = harness
    seeded = _seed(db, failure_policies=["LOG_AND_CONTINUE", "RETRY_AND_BACKOFF"])
    sid = seeded["stream_id"]
    poller.items = _events("e1")
    sender.fail_urls = {_url(1)}
    _poll(db, runner, sid)

    row = db.query(Checkpoint).filter(Checkpoint.stream_id == sid).one()
    edited = dict(row.checkpoint_value_json)
    edited["last_success_event"] = {"event_id": "operator-edit"}
    row.checkpoint_value_json = edited  # keeps the old route_delivery_state key verbatim
    db.commit()

    _poll(db, runner, sid)
    assert sender.accepted[_url(0)] == ["e1", "e1"]


# --- dynamic routes (R2b) ----------------------------------------------------------------

_DYN_URL = "https://r2-dynamic-receiver.example.com/events"


def _add_dynamic_match(db: Session, runner: StreamRunner, *, dynamic_route_id: int) -> None:
    """Every poll matches one dynamic route whose destination is not a base Route destination."""

    from app.dynamic_routing.dynamic_routing_engine import DynamicRouteMatch, DynamicRoutingBatchResult

    destination = Destination(
        name=f"pytest-r2-dyn-{uuid.uuid4().hex[:10]}",
        destination_type="WEBHOOK_POST",
        config_json={"url": _DYN_URL},
        rate_limit_json={},
        enabled=True,
    )
    db.add(destination)
    db.commit()
    match = DynamicRouteMatch(
        dynamic_route_id=dynamic_route_id,
        dynamic_route_name="pytest-dyn",
        destination_id=int(destination.id),
        destination_name=str(destination.name),
        destination_type="WEBHOOK_POST",
        destination_config={"url": _DYN_URL},
        rate_limit_json={},
        destination_enabled=True,
    )

    def _evaluate(*, stream_id: int, enriched_events: list[dict[str, Any]]) -> Any:
        return DynamicRoutingBatchResult(
            matches=[match],
            dynamic_route_count=1,
            matched_dynamic_route_count=1,
            selected_destination_count=1,
        )

    runner._evaluate_dynamic_routes = _evaluate  # type: ignore[method-assign]


def test_dynamic_route_is_not_resent_delivered_events_while_base_route_keeps_failing(harness: Any) -> None:
    """A base Route is down for 3 polls; the matched dynamic route gets each event once.

    Old code: the dynamic receiver accepted e1..e3 on every poll (3 copies each) and no
    ``dyn:<id>`` state was recorded.
    """

    db, runner, poller, sender = harness
    seeded = _seed(db, failure_policies=["LOG_AND_CONTINUE", "RETRY_AND_BACKOFF"])
    sid = seeded["stream_id"]
    route_a = seeded["route_ids"][0]
    # Same numeric id as base Route A: the state keys must not collide.
    _add_dynamic_match(db, runner, dynamic_route_id=route_a)
    before = _checkpoint(db, sid)
    poller.items = _events("e1", "e2", "e3")
    sender.fail_urls = {_url(1)}

    for _ in range(3):
        _poll(db, runner, sid)

    assert sender.accepted[_DYN_URL] == ["e1", "e2", "e3"]
    assert sender.attempts[_DYN_URL] == [["e1", "e2", "e3"]]
    assert sender.accepted[_url(0)] == ["e1", "e2", "e3"]

    after = _checkpoint(db, sid)
    assert strip_route_delivery_state(after) == before
    state = after[ROUTE_DELIVERY_STATE_KEY]
    assert set(state["routes"]) == {str(route_a), f"dyn:{route_a}"}
    assert "msg-" not in json.dumps(state)
    assert checkpoint_read_view(after)[ROUTE_DELIVERY_STATE_KEY] == {
        "route_delivered_event_counts": {str(route_a): 3, f"dyn:{route_a}": 3}
    }

    # Recovery: the held window plus one new event; dynamic route gets only the new one.
    sender.fail_urls = set()
    poller.items = _events("e1", "e2", "e3", "e4")
    summary = _poll(db, runner, sid)

    assert sender.accepted[_DYN_URL] == ["e1", "e2", "e3", "e4"]
    assert sender.attempts[_DYN_URL][-1] == ["e4"]
    assert summary["checkpoint_updated"] is True
    advanced = _checkpoint(db, sid)
    assert advanced["last_success_event"]["event_id"] == "e4"
    # Checkpoint advance clears dynamic-route state as well.
    assert ROUTE_DELIVERY_STATE_KEY not in advanced


def test_dynamic_route_failing_mid_batch_resumes_from_first_undelivered_event(harness: Any) -> None:
    """Dynamic route accepts e1,e2 then fails; next poll of the held window sends only e3,e4.

    Old code: the next poll re-sent e1..e4, so the dynamic receiver accepted e1,e2 twice.
    """

    db, runner, poller, sender = harness
    seeded = _seed(db, failure_policies=["LOG_AND_CONTINUE", "RETRY_AND_BACKOFF"])
    sid = seeded["stream_id"]
    _add_dynamic_match(db, runner, dynamic_route_id=4242)
    poller.items = _events("e1", "e2", "e3", "e4")
    sender.fail_urls = {_url(1)}  # hold the checkpoint
    sender.partial_once = {_DYN_URL: 2}
    _poll(db, runner, sid)
    assert sender.accepted[_DYN_URL] == ["e1", "e2"]
    assert _checkpoint(db, sid)[ROUTE_DELIVERY_STATE_KEY]["routes"]["dyn:4242"]

    sender.fail_urls = set()
    summary = _poll(db, runner, sid)

    assert sender.attempts[_DYN_URL][-1] == ["e3", "e4"]
    assert sender.accepted[_DYN_URL] == ["e1", "e2", "e3", "e4"]
    assert summary["checkpoint_updated"] is True
    assert ROUTE_DELIVERY_STATE_KEY not in _checkpoint(db, sid)


def test_dynamic_route_failure_never_holds_the_checkpoint(harness: Any) -> None:
    """Dynamic delivery stays LOG_AND_CONTINUE: base Routes succeed => checkpoint advances (guard)."""

    db, runner, poller, sender = harness
    seeded = _seed(db, failure_policies=["LOG_AND_CONTINUE", "RETRY_AND_BACKOFF"])
    sid = seeded["stream_id"]
    _add_dynamic_match(db, runner, dynamic_route_id=4243)
    poller.items = _events("e1", "e2")
    sender.fail_urls = {_DYN_URL}

    summary = _poll(db, runner, sid)

    assert summary["checkpoint_updated"] is True
    assert sender.accepted[_url(0)] == ["e1", "e2"]
    assert sender.accepted[_url(1)] == ["e1", "e2"]
    after = _checkpoint(db, sid)
    assert after["last_success_event"]["event_id"] == "e2"
    assert ROUTE_DELIVERY_STATE_KEY not in after
