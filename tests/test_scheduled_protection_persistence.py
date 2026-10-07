from __future__ import annotations

from contextlib import contextmanager

import pytest
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.logs.models import DeliveryLog
from app.protection.engine import ProtectBatchResult, ProtectionFieldWarning
from app.protection.identity_vault import count_vault_entries_for_stream
from app.protection.models import (
    PROTECTION_MODE_FULL_MASK,
    PROTECTION_MODE_TOKENIZATION,
    StreamProtectionRule,
)
from app.quarantine.models import StreamQuarantineEvent
from app.runtime.errors import ProtectionApplicationError
from app.scheduler.scheduler import Scheduler
from app.runners.stream_loader import load_stream_context
from app.streams.models import Stream
from tests.test_stream_runner_e2e import (
    _FakePoller,
    _FakeWebhookSender,
    _build_runner,
    _seed_stream_runtime,
)


def _checkpoint_value(db: Session, stream_id: int) -> dict:
    row = db.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).one()
    return dict(row.checkpoint_value_json or {})


def test_scheduled_runner_tokenizes_string_with_short_persistence_session(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.config.settings.GDC_PROTECTION_ENABLED", True)
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = int(fixture["stream_id"])
    db.add(
        StreamProtectionRule(
            stream_id=stream_id,
            field_path="$.message",
            sensitivity_class="pii",
            protection_mode=PROTECTION_MODE_TOKENIZATION,
            enabled=True,
            created_by="test",
        )
    )
    db.commit()

    context = load_stream_context(db, stream_id)
    sender = _FakeWebhookSender()
    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "evt-1", "message": "alice@example.com", "vendor": "acme"}]}),
        webhook_sender=sender,
    )

    Scheduler(runner=runner).run_stream(context)

    assert len(sender.calls) == 1
    delivered = sender.calls[0]["events"][0]
    assert delivered["message"].startswith("USER_")
    assert delivered["message"] != "alice@example.com"
    db.expire_all()
    assert count_vault_entries_for_stream(db, stream_id) == 1


def test_scheduled_runner_persists_quarantine_without_caller_session(
    db_session: Session,
) -> None:
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = int(fixture["stream_id"])
    route_id = int(fixture["route_ids"][0])
    stream = db.get(Stream, stream_id)
    assert stream is not None
    config = dict(stream.config_json or {})
    config["governance"] = {
        "route_overrides": [
            {
                "route_id": route_id,
                "enabled": True,
                "delivery_behavior": "quarantine",
            }
        ]
    }
    stream.config_json = config
    db.commit()

    context = load_stream_context(db, stream_id)
    sender = _FakeWebhookSender()
    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "evt-q", "message": "hold", "vendor": "acme"}]}),
        webhook_sender=sender,
    )

    Scheduler(runner=runner).run_stream(context)

    assert sender.calls == []
    db.expire_all()
    row = (
        db.query(StreamQuarantineEvent)
        .filter(StreamQuarantineEvent.stream_id == stream_id, StreamQuarantineEvent.route_id == route_id)
        .order_by(StreamQuarantineEvent.id.desc())
        .first()
    )
    assert row is not None
    assert row.status == "quarantined"
    assert row.protected_payload_json["events"][0]["message"] == "hold"


def test_protection_warning_fails_closed_before_delivery(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.config.settings.GDC_PROTECTION_ENABLED", True)
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = int(fixture["stream_id"])
    db.add(
        StreamProtectionRule(
            stream_id=stream_id,
            field_path="$.message",
            sensitivity_class="pii",
            protection_mode=PROTECTION_MODE_FULL_MASK,
            enabled=True,
            created_by="test",
        )
    )
    db.commit()
    before_checkpoint = _checkpoint_value(db, stream_id)

    def _warning_result(events, *args, **kwargs):
        return ProtectBatchResult(
            events=[dict(item) for item in events],
            rules_applied=1,
            warning_count=1,
            warnings=[
                ProtectionFieldWarning(
                    field_path="$.message",
                    rule_id=1,
                    error_message="synthetic protection failure",
                )
            ],
        )

    monkeypatch.setattr("app.route_protection.stage.protect_batch", _warning_result)

    context = load_stream_context(db, stream_id)
    sender = _FakeWebhookSender()
    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "evt-f", "message": "raw-secret", "vendor": "acme"}]}),
        webhook_sender=sender,
    )

    with pytest.raises(ProtectionApplicationError, match="delivery blocked"):
        runner.run(context)

    assert sender.calls == []
    db.expire_all()
    assert _checkpoint_value(db, stream_id) == before_checkpoint
    failed = (
        db.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == stream_id, DeliveryLog.stage == "run_failed")
        .order_by(DeliveryLog.id.desc())
        .first()
    )
    assert failed is not None
    assert failed.error_code == "PROTECTION_APPLICATION_FAILED"
    assert "raw-secret" not in str(failed.message or "")
    assert "$.message" in str(failed.message or "")


def test_tokenization_persistence_failure_fails_closed_before_delivery(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.config.settings.GDC_PROTECTION_ENABLED", True)
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = int(fixture["stream_id"])
    db.add(
        StreamProtectionRule(
            stream_id=stream_id,
            field_path="$.message",
            sensitivity_class="pii",
            protection_mode=PROTECTION_MODE_TOKENIZATION,
            enabled=True,
            created_by="test",
        )
    )
    db.commit()
    before_checkpoint = _checkpoint_value(db, stream_id)

    @contextmanager
    def _broken_persistence(existing_db, *, required):
        assert existing_db is None
        assert required is True
        raise RuntimeError("synthetic vault unavailable")
        yield None

    monkeypatch.setattr("app.route_protection.stage.stage_persistence_session", _broken_persistence)

    context = load_stream_context(db, stream_id)
    sender = _FakeWebhookSender()
    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "evt-p", "message": "raw-secret", "vendor": "acme"}]}),
        webhook_sender=sender,
    )

    with pytest.raises(ProtectionApplicationError, match="delivery blocked"):
        runner.run(context)

    assert sender.calls == []
    db.expire_all()
    assert _checkpoint_value(db, stream_id) == before_checkpoint
    failed = (
        db.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == stream_id, DeliveryLog.stage == "run_failed")
        .order_by(DeliveryLog.id.desc())
        .first()
    )
    assert failed is not None
    assert failed.error_code == "PROTECTION_APPLICATION_FAILED"
    assert "raw-secret" not in str(failed.message or "")
    assert "$.message" in str(failed.message or "")


def test_scheduled_numeric_tokenization_preserves_full_mask_fallback(
    db_session: Session,
) -> None:
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = int(fixture["stream_id"])
    db.add(
        StreamProtectionRule(
            stream_id=stream_id,
            field_path="$.message",
            sensitivity_class="pii",
            protection_mode=PROTECTION_MODE_TOKENIZATION,
            enabled=True,
            created_by="test",
        )
    )
    db.commit()

    context = load_stream_context(db, stream_id)
    sender = _FakeWebhookSender()
    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "evt-n", "message": 42, "vendor": "acme"}]}),
        webhook_sender=sender,
    )

    Scheduler(runner=runner).run_stream(context)

    assert len(sender.calls) == 1
    assert sender.calls[0]["events"][0]["message"] is None
    db.expire_all()
    assert count_vault_entries_for_stream(db, stream_id) == 0


def test_scheduled_mixed_delivery_and_quarantine_is_partial_success(
    db_session: Session,
) -> None:
    db = db_session
    fixture = _seed_stream_runtime(
        db,
        failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE"],
    )
    stream_id = int(fixture["stream_id"])
    route_a, route_b = [int(v) for v in fixture["route_ids"]]
    stream = db.get(Stream, stream_id)
    assert stream is not None
    config = dict(stream.config_json or {})
    config["governance"] = {
        "route_overrides": [
            {
                "route_id": route_b,
                "enabled": True,
                "delivery_behavior": "quarantine",
            }
        ]
    }
    stream.config_json = config
    db.commit()

    context = load_stream_context(db, stream_id)
    sender = _FakeWebhookSender()
    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "evt-m", "message": "mixed", "vendor": "acme"}]}),
        webhook_sender=sender,
    )

    summary = Scheduler(runner=runner).run_stream(context)

    assert len(sender.calls) == 1
    assert summary["partial_success"] is True
    assert summary["policy_withheld_route_count"] == 1
    assert summary["policy_withheld_route_ids"] == [route_b]
    assert summary["route_delivery_quarantine_count"] == 1
    assert summary["checkpoint_updated"] is True
    db.expire_all()
    held = (
        db.query(StreamQuarantineEvent)
        .filter(StreamQuarantineEvent.stream_id == stream_id, StreamQuarantineEvent.route_id == route_b)
        .one()
    )
    assert held.status == "quarantined"
    assert route_a != route_b
