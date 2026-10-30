"""Unit + service coverage for per-Route delivery state (R2)."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import pytest
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.checkpoints.route_delivery_state import (
    MAX_FINGERPRINTS_PER_ROUTE,
    ROUTE_DELIVERY_STATE_KEY,
    build_route_delivery_state,
    checkpoint_anchor,
    event_fingerprints,
    load_route_fingerprints,
    merge_fingerprints,
    split_route_delivery_state,
)
from app.checkpoints.service import CheckpointService
from app.connectors.models import Connector
from app.delivery import webhook_sender as webhook_module
from app.delivery.webhook_sender import WebhookSender
from app.runtime.copy_utils import checkpoint_read_view, slim_checkpoint_for_log
from app.runtime.errors import DestinationSendError
from app.sources.models import Source
from app.streams.models import Stream


_BASE = {"last_success_event": {"event_id": "seed-0", "message": "secret payload"}}


def _state_for(base: Any, routes: dict[str, list[str]]) -> dict[str, Any]:
    state = build_route_delivery_state(checkpoint_anchor(base), routes)
    assert state is not None
    return state


# --- fingerprints ---------------------------------------------------------------------


def test_fingerprints_are_stable_and_ignore_runtime_dedup_metadata() -> None:
    first = [{"id": "e1", "b": 2, "a": 1}, {"id": "e2"}]
    # Same content, different key order and a per-run dedup queue id.
    second = [{"a": 1, "b": 2, "id": "e1", "__gdc_dedup_queue_id": 7}, {"id": "e2"}]
    assert event_fingerprints(first) == event_fingerprints(second)
    assert len(set(event_fingerprints(first))) == 2


def test_fingerprints_distinguish_identical_events_by_occurrence() -> None:
    """Two identical source events must not collapse (a partial send could skip a copy)."""

    fps = event_fingerprints([{"m": "x"}, {"m": "x"}, {"m": "y"}])
    assert len(set(fps)) == 3
    assert fps[1] == f"{fps[0]}#1"


def test_fingerprints_never_contain_raw_event_content() -> None:
    fps = event_fingerprints([{"user": "alice@example.com", "token": "s3cr3t"}])
    assert "alice" not in json.dumps(fps) and "s3cr3t" not in json.dumps(fps)


# --- (5) bounded / cleared / bound to the window ------------------------------------------


def test_merge_fingerprints_is_bounded_and_keeps_newest() -> None:
    existing = [f"fp-{i}" for i in range(MAX_FINGERPRINTS_PER_ROUTE)]
    merged = merge_fingerprints(existing, ["fp-new", "fp-0"])
    assert len(merged) == MAX_FINGERPRINTS_PER_ROUTE
    assert merged[-1] == "fp-new"
    assert "fp-0" not in merged  # oldest dropped => possible re-send, never a skipped event


def test_load_route_fingerprints_rejects_state_from_another_window() -> None:
    state = _state_for(_BASE, {"5": ["a", "b"]})
    assert load_route_fingerprints(state, checkpoint_anchor(_BASE)) == {"5": ["a", "b"]}
    moved = {"last_success_event": {"event_id": "seed-1"}}
    assert load_route_fingerprints(state, checkpoint_anchor(moved)) == {}
    # Reduced API summaries or garbage written back by an operator are ignored.
    assert load_route_fingerprints({"route_delivered_event_counts": {"5": 2}}, checkpoint_anchor(_BASE)) == {}


def test_build_route_delivery_state_prunes_removed_routes_and_empty_state() -> None:
    state = build_route_delivery_state("anchor", {"1": ["a"], "2": ["b"]}, keep_route_ids={"1"})
    assert state == {"version": 1, "anchor": "anchor", "routes": {"1": ["a"]}}
    assert build_route_delivery_state("anchor", {"2": ["b"]}, keep_route_ids={"1"}) is None


def test_split_route_delivery_state_hides_key_from_cursor_readers() -> None:
    state = _state_for(_BASE, {"1": ["a"]})
    base, raw = split_route_delivery_state({**_BASE, ROUTE_DELIVERY_STATE_KEY: state})
    assert base == _BASE and raw == state
    assert split_route_delivery_state(_BASE) == (_BASE, None)
    # An empty checkpoint stays empty for readers...
    empty_state = _state_for({}, {"1": ["a"]})
    assert split_route_delivery_state({ROUTE_DELIVERY_STATE_KEY: empty_state}) == ({}, empty_state)
    # ...and a row created only for per-Route state still reads as "no checkpoint".
    absent_state = build_route_delivery_state(checkpoint_anchor(None), {"1": ["a"]}, cursor_absent=True)
    assert split_route_delivery_state({ROUTE_DELIVERY_STATE_KEY: absent_state}) == (None, absent_state)
    # No checkpoint and an empty checkpoint are the same window.
    assert checkpoint_anchor(None) == checkpoint_anchor({})


# --- read views (C8) -------------------------------------------------------------------


def test_read_view_and_log_snapshot_do_not_expose_fingerprints() -> None:
    fps = event_fingerprints([{"id": "e1"}, {"id": "e2"}])
    stored = {**_BASE, ROUTE_DELIVERY_STATE_KEY: _state_for(_BASE, {"7": fps})}

    view = checkpoint_read_view(stored)
    assert view[ROUTE_DELIVERY_STATE_KEY] == {"route_delivered_event_counts": {"7": 2}}
    assert fps[0] not in json.dumps(view)

    only_state = {ROUTE_DELIVERY_STATE_KEY: stored[ROUTE_DELIVERY_STATE_KEY]}
    assert not slim_checkpoint_for_log(only_state)
    assert fps[0] not in json.dumps(slim_checkpoint_for_log(stored))


# --- webhook partial progress ----------------------------------------------------------


class _FlakyClient:
    def __init__(self, fail_on_call: int) -> None:
        self.fail_on_call = fail_on_call
        self.calls = 0

    def post(self, url: str, **kwargs: Any) -> httpx.Response:
        self.calls += 1
        status = 500 if self.calls == self.fail_on_call else 200
        return httpx.Response(status, request=httpx.Request("POST", url))


def test_webhook_sender_reports_events_delivered_before_mid_batch_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _FlakyClient(fail_on_call=3)
    monkeypatch.setattr(webhook_module, "get_httpx_client", lambda **_kw: client)
    monkeypatch.setattr(webhook_module, "invalidate_httpx_client", lambda _key: None)

    events = [{"id": f"e{i}"} for i in range(1, 6)]
    config = {"url": "https://receiver.example.com/e", "batch_size": 1, "retry_count": 0, "retry_backoff_seconds": 0}
    with pytest.raises(DestinationSendError) as err:
        WebhookSender().send(events, config)

    assert err.value.delivered_event_count == 2
    assert client.calls == 3


# --- CheckpointService.save_route_delivery_state (DB) -----------------------------------


def _seed_stream(db: Session) -> int:
    suffix = uuid.uuid4().hex[:10]
    connector = Connector(name=f"pytest-r2u-{suffix}", description="r2", status="RUNNING")
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
        name=f"pytest-r2u-stream-{suffix}",
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=60,
        enabled=True,
        status="RUNNING",
        rate_limit_json={},
    )
    db.add(stream)
    db.flush()
    return int(stream.id)


def test_save_route_delivery_state_keeps_cursor_and_updated_at(db_session: Session) -> None:
    db = db_session
    sid = _seed_stream(db)
    old_ts = datetime.now(timezone.utc) - timedelta(hours=3)
    db.add(Checkpoint(stream_id=sid, checkpoint_type="EVENT_ID", checkpoint_value_json=dict(_BASE), updated_at=old_ts))
    db.commit()

    state = _state_for(_BASE, {"3": ["fp-a"]})
    wrote = CheckpointService().save_route_delivery_state(
        db=db, stream_id=sid, checkpoint_type="EVENT_ID", anchor=checkpoint_anchor(_BASE), route_delivery_state=state
    )
    db.commit()
    db.expire_all()

    row = db.query(Checkpoint).filter(Checkpoint.stream_id == sid).one()
    assert wrote is True
    assert row.checkpoint_value_json == {**_BASE, ROUTE_DELIVERY_STATE_KEY: state}
    assert row.checkpoint_type == "EVENT_ID"
    # updated_at drives checkpoint_window dedup scope; a held window must not move it.
    assert abs((row.updated_at - old_ts).total_seconds()) < 1


def test_save_route_delivery_state_skips_when_window_moved(db_session: Session) -> None:
    db = db_session
    sid = _seed_stream(db)
    moved = {"last_success_event": {"event_id": "advanced"}}
    db.add(Checkpoint(stream_id=sid, checkpoint_type="EVENT_ID", checkpoint_value_json=dict(moved)))
    db.commit()

    wrote = CheckpointService().save_route_delivery_state(
        db=db,
        stream_id=sid,
        checkpoint_type="EVENT_ID",
        anchor=checkpoint_anchor(_BASE),
        route_delivery_state=_state_for(_BASE, {"3": ["fp-a"]}),
    )
    db.commit()
    db.expire_all()

    assert wrote is False
    assert db.query(Checkpoint).filter(Checkpoint.stream_id == sid).one().checkpoint_value_json == moved


def test_save_route_delivery_state_creates_row_for_first_window(db_session: Session) -> None:
    db = db_session
    sid = _seed_stream(db)
    db.commit()

    state = build_route_delivery_state(checkpoint_anchor(None), {"3": ["fp-a"]}, cursor_absent=True)
    wrote = CheckpointService().save_route_delivery_state(
        db=db, stream_id=sid, checkpoint_type="CUSTOM_FIELD", anchor=checkpoint_anchor(None), route_delivery_state=state
    )
    db.commit()

    row = db.query(Checkpoint).filter(Checkpoint.stream_id == sid).one()
    assert wrote is True
    assert row.checkpoint_value_json == {ROUTE_DELIVERY_STATE_KEY: state}
    # Next run sees "no cursor checkpoint" plus valid state for the same (empty) window.
    base, raw = split_route_delivery_state(row.checkpoint_value_json)
    assert base is None
    assert load_route_fingerprints(raw, checkpoint_anchor(base)) == {"3": ["fp-a"]}
