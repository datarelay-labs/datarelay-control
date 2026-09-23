"""Regressions for host I/O amplification from lab cleanup, retention, and polling."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.config import settings
from app.connectors.models import Connector
from app.logs.models import DeliveryLog
from app.platform_admin.alert_monitor import PlatformAlertMonitor
from app.platform_admin.cleanup_service import run_cleanup
from app.retention import batch as retention_batch
from app.retention.batch import batch_delete_by_time_before
from app.sources.models import Source
from app.streams.models import Stream
from app.streams.repository import get_enabled_stream_ids

UTC = timezone.utc


def _seed_stream(
    db: Session,
    *,
    name: str,
    stream_type: str = "HTTP_API_POLLING",
    enabled: bool = True,
    status: str = "RUNNING",
) -> Stream:
    connector = Connector(name=f"conn-{name}", description=None, status="RUNNING")
    db.add(connector)
    db.flush()
    source = Source(
        connector_id=connector.id,
        source_type=stream_type,
        config_json={},
        auth_json={},
        enabled=True,
    )
    db.add(source)
    db.flush()
    stream = Stream(
        connector_id=connector.id,
        source_id=source.id,
        name=name,
        stream_type=stream_type,
        config_json={},
        polling_interval=1,
        enabled=enabled,
        status=status,
        rate_limit_json={},
    )
    db.add(stream)
    db.flush()
    return stream


def test_batch_delete_accepts_max_deleted_and_caps_rows(db_session: Session) -> None:
    stream = _seed_stream(db_session, name="oom-delete-cap")
    old = datetime.now(UTC) - timedelta(days=10)
    for idx in range(3):
        db_session.add(
            DeliveryLog(
                stream_id=stream.id,
                stage="run_complete",
                level="INFO",
                message=f"old-{idx}",
                payload_sample={},
                created_at=old,
            )
        )
    db_session.commit()
    matched, deleted = batch_delete_by_time_before(
        db_session,
        model=DeliveryLog,
        time_column=DeliveryLog.created_at,
        cutoff=datetime.now(UTC) - timedelta(days=1),
        batch_size=100,
        dry_run=False,
        extra=DeliveryLog.stream_id == int(stream.id),
        max_deleted=1,
    )
    assert deleted == 1
    assert matched >= 1
    remaining = (
        db_session.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == stream.id, DeliveryLog.message.like("old-%"))
        .count()
    )
    assert remaining == 2


def test_large_delivery_logs_dry_run_does_not_count(monkeypatch: pytest.MonkeyPatch) -> None:
    counted = {"n": 0}

    class _Query:
        def filter(self, *_args: object, **_kwargs: object) -> "_Query":
            return self

        def count(self) -> int:
            counted["n"] += 1
            raise AssertionError("full count must not run")

    db = MagicMock()
    db.query.return_value = _Query()
    monkeypatch.setattr(retention_batch, "delivery_logs_requires_bounded_count", lambda _db: True)
    monkeypatch.setattr(
        retention_batch,
        "estimate_delivery_logs_eligible",
        lambda _db, *, cutoff: (40, None),
    )
    matched, deleted = batch_delete_by_time_before(
        db,
        model=DeliveryLog,
        time_column=DeliveryLog.created_at,
        cutoff=datetime.now(UTC),
        batch_size=100,
        dry_run=True,
        max_deleted=5,
    )
    assert (matched, deleted) == (5, 0)
    assert counted["n"] == 0


def test_automatic_retention_skip_does_not_count(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "GDC_RETENTION_DESTRUCTIVE_ACTIONS_ENABLED", False, raising=False)

    def _forbidden(*_args: object, **_kwargs: object) -> tuple[int, int]:
        raise AssertionError("automatic skip must not count or delete")

    monkeypatch.setattr(
        "app.platform_admin.cleanup_service.batch_delete_by_time_before",
        _forbidden,
    )
    outcomes = run_cleanup(
        db_session,
        categories=["logs"],
        dry_run=False,
        trigger="scheduler",
    )
    assert len(outcomes) == 1
    assert outcomes[0].status == "skipped"
    assert outcomes[0].deleted_count == 0
    assert outcomes[0].notes.get("count_skipped") is True


def test_disabled_lab_and_webhook_streams_are_not_polled(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "ENABLE_DEV_VALIDATION_LAB", False, raising=False)
    polling = _seed_stream(db_session, name="oom-poll-http")
    webhook = _seed_stream(db_session, name="oom-webhook", stream_type="WEBHOOK_RECEIVER")
    lab = _seed_stream(db_session, name="[DEV VALIDATION] oom-lab")
    e2e = _seed_stream(db_session, name="[DEV E2E] oom-e2e")
    db_session.commit()

    selected = set(get_enabled_stream_ids(db_session))
    assert int(polling.id) in selected
    assert int(webhook.id) not in selected
    assert int(lab.id) not in selected
    assert int(e2e.id) not in selected

    monkeypatch.setattr(settings, "ENABLE_DEV_VALIDATION_LAB", True, raising=False)
    selected_on = set(get_enabled_stream_ids(db_session))
    assert int(lab.id) in selected_on
    assert int(e2e.id) in selected_on
    assert int(webhook.id) not in selected_on


def test_checkpoint_stall_uses_recent_existence_not_historical_count(db_session: Session) -> None:
    recent_stream = _seed_stream(db_session, name="oom-stall-recent")
    idle_stream = _seed_stream(db_session, name="oom-stall-idle")
    stalled_at = datetime.now(UTC) - timedelta(hours=5)
    for stream, created_at, message in (
        (recent_stream, datetime.now(UTC) - timedelta(minutes=10), "recent-run"),
        (idle_stream, datetime.now(UTC) - timedelta(days=40), "historical-run"),
    ):
        db_session.add(
            Checkpoint(
                stream_id=stream.id,
                checkpoint_type="CUSTOM_FIELD",
                checkpoint_value_json={},
                updated_at=stalled_at,
            )
        )
        db_session.add(
            DeliveryLog(
                stream_id=stream.id,
                stage="run_complete",
                level="INFO",
                message=message,
                payload_sample={},
                created_at=created_at,
            )
        )
    db_session.commit()

    events = PlatformAlertMonitor()._detect_checkpoint_stalled(db_session)
    stalled_ids = {int(event.stream_id) for event in events if event.alert_type == "checkpoint_stalled"}
    assert int(recent_stream.id) in stalled_ids
    assert int(idle_stream.id) not in stalled_ids
    recent = next(event for event in events if int(event.stream_id) == int(recent_stream.id))
    assert recent.extra.get("activity_probe") == "exists_within_recent_window"
    assert recent.extra.get("recent_runs") == 1


def test_lab_remediation_errors_use_long_cooldown(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.dev_validation_lab import lab_auto_remediation as remediation

    remediation.clear_auto_remediation_state_for_tests()
    monkeypatch.setattr(
        remediation,
        "auto_remediation_settings",
        lambda: {
            "auto_remediation_enabled": True,
            "auto_cleanup_enabled": True,
            "auto_wiremock_reset": False,
            "cooldown_seconds": 30,
            "max_rows_per_run": 1000,
            "statement_timeout_ms": 1000,
        },
    )
    monkeypatch.setattr(
        remediation,
        "_delete_retention_rows",
        lambda *_args, **_kwargs: {
            "status": "error",
            "deleted_rows": 0,
            "outcomes": [],
            "errors": ["TypeError: max_deleted"],
            "partition_drop_candidates": [],
        },
    )
    monkeypatch.setattr(
        remediation,
        "_reset_wiremock_if_needed",
        lambda *_args, **_kwargs: {"attempted": False, "ok": None},
    )

    result = remediation.run_lab_auto_remediation(
        MagicMock(),
        {"status": "exceeded", "exceeded_reasons": ["delivery_logs"]},
        reevaluate=lambda *_args, **_kwargs: {
            "status": "exceeded",
            "exceeded_reasons": ["delivery_logs"],
            "delivery_logs_rows": 10,
        },
    )
    assert result["status"] == "error"
    until = datetime.fromisoformat(str(result["auto_cleanup_cooldown_until"]))
    assert until - datetime.now(UTC) > timedelta(minutes=10)
    remediation.clear_auto_remediation_state_for_tests()
