"""OSS v1.0.1 Sprint 5 — deepcopy and delivery_logs optimization regression."""

from __future__ import annotations

import json
from types import MethodType
from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.logs.payload_sample import build_delivery_log_payload_sample
from app.runners.stream_loader import load_stream_context
from app.runners.stream_runner import StreamRunner
from app.logs.models import DeliveryLog
from app.runtime.copy_utils import copy_json_value, slim_checkpoint_for_log
from tests.test_stream_runner_e2e import (
    _FakePoller,
    _FakeWebhookSender,
    _build_runner,
    _seed_stream_runtime,
)


def test_copy_json_value_isolates_nested_dict_without_scalar_copy() -> None:
    nested = {"a": 1}
    event = {"id": "e1", "meta": nested}
    copied = copy_json_value(event)
    assert copied == event
    assert copied is not event
    assert copied["meta"] is not nested
    copied["meta"]["a"] = 99
    assert nested["a"] == 1


def test_slim_checkpoint_for_log_drops_full_event_body() -> None:
    checkpoint = {
        "last_processed_key": "obj/key.json",
        "last_success_event": {
            "event_id": "evt-1",
            "message": "x" * 4000,
            "nested": {"secret": "value"},
        },
    }
    slim = slim_checkpoint_for_log(checkpoint)
    assert slim is not None
    assert slim["last_processed_key"] == "obj/key.json"
    lse = slim.get("last_success_event")
    assert isinstance(lse, dict)
    assert lse.get("event_id") == "evt-1"
    assert "message" not in lse
    assert "nested" not in lse


def test_build_delivery_log_payload_sample_keeps_replay_events_isolated() -> None:
    events = [{"event_id": "e1", "payload": {"k": 1}}]
    sample = build_delivery_log_payload_sample(
        {
            "stage": "route_send_failed",
            "stream_id": 1,
            "replay_events": events,
            "events": [{"event_id": "bulk"}],
            "enriched_events": [{"event_id": "bulk-enriched"}],
        }
    )
    assert sample["stage"] == "route_send_failed"
    assert sample["stream_id"] == 1
    assert "events" not in sample
    assert "enriched_events" not in sample
    assert sample["replay_events"][0]["event_id"] == "e1"
    sample["replay_events"][0]["payload"]["k"] = 99
    assert events[0]["payload"]["k"] == 1


def test_successful_run_persists_fewer_low_value_delivery_log_rows(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    context = load_stream_context(db_session, seeded["stream_id"])
    poller = _FakePoller(
        response={"items": [{"id": "s5-evt-1", "message": "perf", "vendor": "MappedVendor"}]}
    )
    runner = _build_runner(poller=poller, webhook_sender=_FakeWebhookSender())
    runner.run(context, db=db_session)

    rows = (
        db_session.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == seeded["stream_id"])
        .order_by(DeliveryLog.id.asc())
        .all()
    )
    stages = [row.stage for row in rows]
    assert "route_send_success" in stages
    assert "run_complete" in stages
    assert "route" not in stages
    assert stages.count("mapping") == 0
    assert stages.count("enrichment") == 0
    # Route Processing emits protection/classification/policy complete + route_send +
    # route_processing_loop + checkpoint + run lifecycle (≤11 rows on the happy path).
    assert len(rows) <= 11


def test_run_complete_checkpoint_payload_is_slim(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    context = load_stream_context(db_session, seeded["stream_id"])
    poller = _FakePoller(
        response={"items": [{"id": "s5-evt-2", "message": "x" * 5000, "vendor": "MappedVendor"}]}
    )
    runner = _build_runner(poller=poller, webhook_sender=_FakeWebhookSender())
    runner.run(context, db=db_session)

    rc = (
        db_session.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == seeded["stream_id"], DeliveryLog.stage == "run_complete")
        .order_by(DeliveryLog.id.desc())
        .first()
    )
    assert rc is not None
    ps = rc.payload_sample
    assert isinstance(ps, dict)
    before = ps.get("checkpoint_before")
    if isinstance(before, dict):
        lse = before.get("last_success_event")
        if isinstance(lse, dict):
            assert "message" not in lse
    serialized = json.dumps(ps)
    assert len(serialized) < 8000
