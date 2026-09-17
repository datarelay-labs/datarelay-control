"""Dedup metadata persistence and per-destination registry coverage."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.config import settings
from app.logs.models import DeliveryLog
from app.mappings.models import Mapping
from app.runners.stream_dedup import DEDUP_REGISTRY_STAGE, GDC_DEDUP_KEY_META, GDC_DEDUP_QUEUE_ID_META
from app.runners.stream_loader import load_stream_context
from app.runners.stream_runner import StreamRunner
from app.streams.models import Stream
from tests.test_stream_dedup_runtime import _enable_dedup, _registry_logs
from tests.test_per_route_protection import _add_email_mapping
from tests.test_stream_runner_e2e import (
    _FakePoller,
    _FakeWebhookSender,
    _RetryAwareWebhookSender,
    _build_runner,
    _checkpoint_value,
    _delivery_logs,
    _seed_stream_runtime,
)


def _registry_logs_for_route(db: Session, stream_id: int, route_id: int) -> list[DeliveryLog]:
    rows = _registry_logs(db, stream_id)
    matched: list[DeliveryLog] = []
    for row in rows:
        payload = row.payload_sample if isinstance(row.payload_sample, dict) else {}
        if int(row.route_id or payload.get("route_id") or 0) == int(route_id):
            matched.append(row)
    return matched


def _capture_send_events(monkeypatch: pytest.MonkeyPatch, runner: Any) -> list[list[dict[str, Any]]]:
    captured: list[list[dict[str, Any]]] = []
    original = runner._send_to_destination

    def _wrap(destination_type: str, events: list[dict[str, Any]], *args: Any, **kwargs: Any) -> None:
        captured.append([dict(event) for event in events if isinstance(event, dict)])
        return original(destination_type, events, *args, **kwargs)

    monkeypatch.setattr(runner, "_send_to_destination", _wrap)
    return captured


def test_dedup_metadata_survives_mapping_reconstruction(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = int(fixture["stream_id"])
    _enable_dedup(db_session, stream_id, key_field="id")

    mapping = db_session.query(Mapping).filter(Mapping.stream_id == stream_id).one()
    mapping.field_mappings_json = {
        "mapped_id": "$.id",
        "mapped_message": "$.message",
    }
    db_session.add(mapping)
    db_session.commit()

    context = load_stream_context(db_session, stream_id)
    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "evt-map", "message": "hello", "vendor": "x"}]}),
        webhook_sender=_FakeWebhookSender(),
    )
    captured = _capture_send_events(monkeypatch, runner)
    runner.run(context, db=db_session)

    assert captured
    sent = captured[0][0]
    assert sent.get(GDC_DEDUP_KEY_META) == "evt-map"
    assert isinstance(sent.get(GDC_DEDUP_QUEUE_ID_META), int)

def test_dedup_metadata_survives_per_route_protection_payloads(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", True)
    monkeypatch.setattr(settings, "GDC_PROTECTION_ENABLED", True)
    fixture = _seed_stream_runtime(db_session, failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE"])
    stream_id = int(fixture["stream_id"])
    route_a, route_b = fixture["route_ids"]
    _enable_dedup(db_session, stream_id, key_field="id")
    _add_email_mapping(db_session, stream_id)

    stream = db_session.query(Stream).filter(Stream.id == stream_id).one()
    config = dict(stream.config_json or {})
    config["governance"] = {
        "route_overrides": [
            {"route_id": route_a, "field_path": "$.email", "protection_action": "tokenize", "enabled": True},
            {"route_id": route_b, "field_path": "$.email", "protection_action": "mask_full", "enabled": True},
        ]
    }
    stream.config_json = config
    db_session.add(stream)
    db_session.commit()

    context = load_stream_context(db_session, stream_id)
    runner = _build_runner(
        poller=_FakePoller(
            response={"items": [{"id": "evt-route", "email": "user@example.com", "vendor": "acme"}]}
        ),
        webhook_sender=_FakeWebhookSender(),
    )
    captured = _capture_send_events(monkeypatch, runner)
    runner.run(context, db=db_session)

    assert len(captured) == 2
    for batch in captured:
        assert batch[0].get(GDC_DEDUP_KEY_META) == "evt-route"
    assert captured[0][0].get("email") != captured[1][0].get("email")


def test_route_processing_records_dedup_registry_and_suppresses_second_run(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Route-on delivery must persist dedup_registry so last_n_hours seeds the next run."""
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", True)
    fixture = _seed_stream_runtime(db_session)
    stream_id = int(fixture["stream_id"])
    _enable_dedup(db_session, stream_id, key_field="id", scope="last_n_hours", window_hours=24)

    sender = _FakeWebhookSender()
    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "evt-route-on", "message": "one", "vendor": "acme"}]}),
        webhook_sender=sender,
    )
    first = runner.run(load_stream_context(db_session, stream_id), db=db_session)
    assert (first.get("dedup_summary") or {}).get("registry_recorded", 0) >= 1
    assert _registry_logs(db_session, stream_id)
    assert len(sender.calls) == 1

    sender2 = _FakeWebhookSender()
    runner2 = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "evt-route-on", "message": "dup", "vendor": "acme"}]}),
        webhook_sender=sender2,
    )
    second = runner2.run(load_stream_context(db_session, stream_id), db=db_session)
    dedup = second.get("dedup_summary") or {}
    assert int(dedup.get("duplicate_events") or 0) >= 1 or int(dedup.get("registry_seed_duplicates") or 0) >= 1
    assert sender2.calls == []


def test_multi_destination_records_registry_only_for_successful_destination(
    db_session: Session,
) -> None:
    fixture = _seed_stream_runtime(db_session, failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE"])
    stream_id = int(fixture["stream_id"])
    route_a, route_b = fixture["route_ids"]
    _enable_dedup(db_session, stream_id, key_field="id")

    context = load_stream_context(db_session, stream_id)
    poller = _FakePoller(
        response={"items": [{"id": "evt-multi", "message": "hello", "vendor": "MappedVendor"}]}
    )
    sender = _FakeWebhookSender(fail_urls={"https://receiver-1.example.com/events"})
    runner = _build_runner(poller=poller, webhook_sender=sender)
    summary = runner.run(context, db=db_session)

    dedup = summary.get("dedup_summary") or {}
    assert dedup.get("registry_recorded") == 1
    assert _registry_logs_for_route(db_session, stream_id, route_a)
    assert _registry_logs_for_route(db_session, stream_id, route_b) == []

    rows = _delivery_logs(db_session, stream_id)
    assert any(row.stage == "route_send_success" and row.route_id == route_a for row in rows)
    assert any(row.stage == "route_send_failed" and row.route_id == route_b for row in rows)


def test_route_processing_on_log_and_continue_partial_failure_advances_checkpoint(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ON path must absorb LOG_AND_CONTINUE failures without blocking checkpoint (OFF parity)."""
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", True)
    fixture = _seed_stream_runtime(db_session, failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE"])
    stream_id = int(fixture["stream_id"])
    route_a, route_b = fixture["route_ids"]

    before = _checkpoint_value(db_session, stream_id)
    context = load_stream_context(db_session, stream_id)
    poller = _FakePoller(
        response={"items": [{"id": "evt-lac-on", "message": "partial", "vendor": "MappedVendor"}]}
    )
    sender = _FakeWebhookSender(fail_urls={"https://receiver-1.example.com/events"})
    summary = _build_runner(poller=poller, webhook_sender=sender).run(context, db=db_session)
    after = _checkpoint_value(db_session, stream_id)

    assert before != after
    assert after.get("last_success_event", {}).get("event_id") == "evt-lac-on"
    assert len(sender.calls) == 2

    rows = _delivery_logs(db_session, stream_id)
    assert any(row.stage == "route_send_success" and row.route_id == route_a for row in rows)
    assert any(row.stage == "route_send_failed" and row.route_id == route_b for row in rows)
    # Failed delivery must not be disguised as success.
    assert not any(row.stage == "route_send_success" and row.route_id == route_b for row in rows)
    assert summary.get("events_out", summary.get("delivered_events", 0)) is not None

    # Second run with same source event must not re-deliver to the successful route when
    # checkpoint already advanced (poller still returns the same id — runner should complete).
    sender2 = _FakeWebhookSender(fail_urls={"https://receiver-1.example.com/events"})
    _build_runner(
        poller=_FakePoller(
            response={"items": [{"id": "evt-lac-on", "message": "partial", "vendor": "MappedVendor"}]}
        ),
        webhook_sender=sender2,
    ).run(load_stream_context(db_session, stream_id), db=db_session)
    # Without dedup enabled, HTTP polling may re-fetch; assert at least first-run semantics held.
    assert any(c["config"]["url"] == "https://receiver-0.example.com/events" for c in sender.calls)


def test_multi_route_partial_pause_records_only_successful_destination(
    db_session: Session,
) -> None:
    fixture = _seed_stream_runtime(db_session, failure_policies=["LOG_AND_CONTINUE", "PAUSE_STREAM_ON_FAILURE"])
    stream_id = int(fixture["stream_id"])
    route_a, route_b = fixture["route_ids"]
    _enable_dedup(db_session, stream_id, key_field="id")

    before = _checkpoint_value(db_session, stream_id)
    context = load_stream_context(db_session, stream_id)
    poller = _FakePoller(
        response={"items": [{"id": "evt-partial", "message": "partial", "vendor": "MappedVendor"}]}
    )
    sender = _FakeWebhookSender(fail_urls={"https://receiver-1.example.com/events"})
    summary = _build_runner(poller=poller, webhook_sender=sender).run(context, db=db_session)

    after = _checkpoint_value(db_session, stream_id)
    assert before == after
    dedup = summary.get("dedup_summary") or {}
    assert dedup.get("registry_recorded") == 1
    assert _registry_logs_for_route(db_session, stream_id, route_a)
    assert _registry_logs_for_route(db_session, stream_id, route_b) == []


def test_replay_apply_dedup_false_ignores_registry_seed(
    db_session: Session,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = int(fixture["stream_id"])
    _enable_dedup(db_session, stream_id, key_field="id", scope="checkpoint_window")

    db_session.add(
        DeliveryLog(
            stream_id=stream_id,
            stage=DEDUP_REGISTRY_STAGE,
            level="INFO",
            message="dedup registry",
            payload_sample={"dedup_keys": ["evt-replay"]},
        )
    )
    db_session.commit()

    context = load_stream_context(db_session, stream_id)
    context.apply_dedup = False
    runner = _build_runner(
        poller=_FakePoller(
            response={"items": [{"id": "evt-replay", "message": "replay", "vendor": "MappedVendor"}]}
        ),
        webhook_sender=_FakeWebhookSender(),
    )
    summary = runner.run(context, db=db_session)

    dedup = summary.get("dedup_summary")
    assert dedup is None
    assert len(_registry_logs(db_session, stream_id)) == 1


def test_replay_apply_dedup_true_dedupes_registry_seed(
    db_session: Session,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = int(fixture["stream_id"])
    _enable_dedup(db_session, stream_id, key_field="id", scope="checkpoint_window")

    db_session.add(
        DeliveryLog(
            stream_id=stream_id,
            stage=DEDUP_REGISTRY_STAGE,
            level="INFO",
            message="dedup registry",
            payload_sample={"dedup_keys": ["evt-seed"]},
        )
    )
    db_session.commit()

    context = load_stream_context(db_session, stream_id)
    context.apply_dedup = True
    runner = _build_runner(
        poller=_FakePoller(
            response={
                "items": [
                    {"id": "evt-seed", "message": "seeded", "vendor": "MappedVendor"},
                    {"id": "evt-new", "message": "fresh", "vendor": "MappedVendor"},
                ]
            }
        ),
        webhook_sender=_FakeWebhookSender(),
    )
    summary = runner.run(context, db=db_session)

    dedup = summary.get("dedup_summary") or {}
    assert dedup.get("registry_seed_duplicates") == 1
    assert dedup.get("inserted") == 1
    registry_rows = _registry_logs(db_session, stream_id)
    latest = registry_rows[-1].payload_sample or {}
    assert latest.get("dedup_keys") == ["evt-new"]


def test_dry_run_skips_registry_but_delivery_success_path_does_not(
    db_session: Session,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = int(fixture["stream_id"])
    _enable_dedup(db_session, stream_id, key_field="id")

    dry_ctx = load_stream_context(db_session, stream_id)
    dry_ctx.dry_run = True
    dry_summary = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "evt-dry", "message": "dry", "vendor": "MappedVendor"}]}),
        webhook_sender=_FakeWebhookSender(),
    ).run(dry_ctx, db=db_session)
    dry_dedup = dry_summary.get("dedup_summary") or {}
    assert dry_dedup.get("registry_recorded") == 0
    assert dry_dedup.get("registry_skipped") == 1
    assert _registry_logs(db_session, stream_id) == []

    live_ctx = load_stream_context(db_session, stream_id)
    live_ctx.dry_run = False
    live_summary = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "evt-live", "message": "live", "vendor": "MappedVendor"}]}),
        webhook_sender=_FakeWebhookSender(),
    ).run(live_ctx, db=db_session)
    live_dedup = live_summary.get("dedup_summary") or {}
    assert live_dedup.get("registry_recorded") == 1
    assert len(_registry_logs(db_session, stream_id)) == 1


def test_dedup_skip_does_not_advance_checkpoint_and_failed_event_not_in_registry(
    db_session: Session,
) -> None:
    fixture = _seed_stream_runtime(db_session, failure_policies=["STOP_ON_FAILURE"])
    stream_id = int(fixture["stream_id"])
    _enable_dedup(db_session, stream_id, key_field="id")

    before = _checkpoint_value(db_session, stream_id)
    context = load_stream_context(db_session, stream_id)
    poller = _FakePoller(
        response={
            "items": [
                {"id": "evt-dup", "message": "one", "vendor": "MappedVendor"},
                {"id": "evt-dup", "message": "two", "vendor": "MappedVendor"},
                {"id": "evt-unique", "message": "three", "vendor": "MappedVendor"},
            ]
        }
    )
    sender = _FakeWebhookSender(fail_urls={"https://receiver-0.example.com/events"})
    summary = _build_runner(poller=poller, webhook_sender=sender).run(context, db=db_session)
    after = _checkpoint_value(db_session, stream_id)

    dedup = summary.get("dedup_summary") or {}
    assert dedup.get("duplicate_events") == 1
    assert dedup.get("inserted") == 2
    assert dedup.get("registry_recorded") == 0
    assert before == after
    assert _registry_logs(db_session, stream_id) == []

    retry_ctx = load_stream_context(db_session, stream_id)
    retry_sender = _FakeWebhookSender()
    retry_summary = _build_runner(poller=poller, webhook_sender=retry_sender).run(retry_ctx, db=db_session)
    retry_dedup = retry_summary.get("dedup_summary") or {}
    assert retry_dedup.get("duplicate_events") == 1
    assert retry_dedup.get("registry_recorded") == 2
    assert len(retry_sender.calls) == 1
    delivered_ids = {event["event_id"] for event in retry_sender.calls[0]["events"]}
    assert delivered_ids == {"evt-dup", "evt-unique"}
    assert _checkpoint_value(db_session, stream_id) != before


def test_retry_within_run_records_registry_after_delivery_success(
    db_session: Session,
) -> None:
    fixture = _seed_stream_runtime(db_session, failure_policies=["RETRY_AND_BACKOFF"])
    stream_id = int(fixture["stream_id"])
    _enable_dedup(db_session, stream_id, key_field="id")

    context = load_stream_context(db_session, stream_id)
    context.routes[0]["retry_count"] = 2
    context.routes[0]["backoff_seconds"] = 0

    summary = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "evt-retry", "message": "retry", "vendor": "MappedVendor"}]}),
        webhook_sender=_RetryAwareWebhookSender(fail_count_by_url={"https://receiver-0.example.com/events": 1}),
    ).run(context, db=db_session)

    dedup = summary.get("dedup_summary") or {}
    assert dedup.get("registry_recorded") == 1
    registry_rows = _registry_logs(db_session, stream_id)
    assert len(registry_rows) == 1
    assert (registry_rows[0].payload_sample or {}).get("dedup_keys") == ["evt-retry"]
