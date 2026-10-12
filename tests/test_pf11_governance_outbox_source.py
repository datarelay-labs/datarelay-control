"""PF-11A opt-in durable notification outbox (no real SMTP, HTTP, or production DB)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.dialects.postgresql import JSONB, dialect as pg_dialect
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.governance_notifications.email_sender import MockEmailSender
from app.governance_notifications.models import (
    GovernanceNotificationConfig,
    GovernanceNotificationDeliveryJob,
    GovernanceNotificationEvent,
    NOTIFICATION_STATUS_PENDING,
    NOTIFICATION_STATUS_SENT,
    NOTIFICATION_STATUS_FAILED,
)
from app.governance_notifications.outbox import (
    _eligible_query,
    claim_delivery_jobs,
    complete_delivery_job,
    drain_outbox_once,
)
from app.governance_notifications.service import NotificationService
from app.governance_notifications.webhook_sender import MockWebhookSender


@compiles(JSONB, "sqlite")
def _compile_jsonb_for_private_sqlite(_type, _compiler, **_kwargs):
    return "JSON"


@pytest.fixture
def sessions(monkeypatch):
    monkeypatch.setenv("GDC_GOV_NOTIFICATION_DURABLE_QUEUE_ENABLED", "true")
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(
        engine, tables=[
            GovernanceNotificationConfig.__table__,
            GovernanceNotificationEvent.__table__,
            GovernanceNotificationDeliveryJob.__table__,
        ],
    )
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    yield factory
    engine.dispose()


def _enqueue(factory, *, both=True):
    with factory.begin() as db:
        config = NotificationService.get_or_create_config(db)
        config.email_enabled = both
        config.email_recipients_json = ["ops@example.com"] if both else []
        config.webhook_enabled = True
        config.webhook_url = "https://hooks.example.com/notification"
        config.updated_at = datetime.now(timezone.utc)
        event = NotificationService.record_event(
            db, event_type="POLICY_SUBMITTED", payload={"policy_id": 99, "secret": "do-not-leak"},
        )
        assert event is not None
        event_id = event.id
        assert NotificationService.dispatch_pending(db) == 0
        assert event.status == NOTIFICATION_STATUS_PENDING
    return event_id


def test_outbox_requires_explicit_opt_in_and_records_per_channel_unique_jobs(sessions):
    event_id = _enqueue(sessions)
    with sessions() as db:
        jobs = db.scalars(select(GovernanceNotificationDeliveryJob).order_by(GovernanceNotificationDeliveryJob.channel)).all()
        assert [j.channel for j in jobs] == ["email", "webhook"]
        assert all(j.event_id == event_id and j.attempt_count == 0 and j.status == "PENDING" for j in jobs)
        assert all(j.config_updated_at is not None for j in jobs)
    sql = str(_eligible_query(datetime.now(timezone.utc), limit=2).compile(dialect=pg_dialect()))
    assert "SKIP LOCKED" in sql.upper()


def test_outbox_channel_isolation_backoff_and_recovery(sessions):
    event_id = _enqueue(sessions)
    email, webhook = MockEmailSender(), MockWebhookSender()
    webhook.should_fail = True
    now = datetime.now(timezone.utc)
    assert drain_outbox_once(sessions, now=now, email_sender=email, webhook_sender=webhook) == 2
    with sessions() as db:
        jobs = {job.channel: job for job in db.scalars(select(GovernanceNotificationDeliveryJob))}
        assert jobs["email"].status == "SENT"
        assert jobs["webhook"].status == "PENDING"
        assert jobs["webhook"].attempt_count == 1
        assert jobs["webhook"].next_attempt_at.replace(tzinfo=timezone.utc) > now
        assert db.get(GovernanceNotificationEvent, event_id).status == NOTIFICATION_STATUS_PENDING
    assert len(email.sent) == 1 and len(webhook.sent) == 0
    webhook.should_fail = False
    assert drain_outbox_once(sessions, now=now + timedelta(seconds=40),
                             email_sender=email, webhook_sender=webhook) == 1
    with sessions() as db:
        assert db.get(GovernanceNotificationEvent, event_id).status == NOTIFICATION_STATUS_SENT
        assert all(j.status == "SENT" for j in db.scalars(select(GovernanceNotificationDeliveryJob)))
    assert len(email.sent) == 1 and len(webhook.sent) == 1
    assert webhook.sent[0]["payload"]["payload"] == {"policy_id": 99}


def test_outbox_stale_configuration_revision_never_sends(sessions):
    event_id = _enqueue(sessions, both=False)
    with sessions.begin() as db:
        config = db.scalars(select(GovernanceNotificationConfig)).one()
        config.updated_at += timedelta(seconds=5)
    webhook = MockWebhookSender()
    assert drain_outbox_once(sessions, now=datetime.now(timezone.utc),
                             webhook_sender=webhook) == 1
    assert not webhook.sent
    with sessions() as db:
        assert db.get(GovernanceNotificationEvent, event_id).status == NOTIFICATION_STATUS_FAILED
        job = db.scalars(select(GovernanceNotificationDeliveryJob)).one()
        assert job.status == "DEAD" and job.last_error_type == "CONFIG_CHANGED"


def test_outbox_cas_rejects_stale_ack_and_recovers_expired_leases(sessions):
    event_id = _enqueue(sessions, both=False)
    now = datetime.now(timezone.utc)
    with sessions.begin() as db:
        first = claim_delivery_jobs(db, now=now, limit=1)[0]
    with sessions.begin() as db:
        assert not complete_delivery_job(
            db, job_id=first.job_id, token="forged", success=True, now=now
        )
    with sessions.begin() as db:
        second = claim_delivery_jobs(db, now=now + timedelta(seconds=61), limit=1)[0]
        assert second.token != first.token and second.attempt_count == 2
    with sessions.begin() as db:
        assert not complete_delivery_job(
            db, job_id=first.job_id, token=first.token, success=True, now=now
        )
        assert complete_delivery_job(
            db, job_id=second.job_id, token=second.token, success=True,
            now=now + timedelta(seconds=62),
        )
    with sessions() as db:
        assert db.get(GovernanceNotificationEvent, event_id).status == NOTIFICATION_STATUS_SENT


def test_outbox_failed_attempts_end_in_dead_letter(sessions):
    event_id = _enqueue(sessions, both=False)
    webhook = MockWebhookSender()
    webhook.should_fail = True
    base = datetime.now(timezone.utc)
    for idx in range(5):
        assert drain_outbox_once(
            sessions, now=base + timedelta(days=idx), webhook_sender=webhook
        ) == 1
    with sessions() as db:
        job = db.scalars(select(GovernanceNotificationDeliveryJob)).one()
        assert job.status == "DEAD" and job.attempt_count == 5
        assert db.get(GovernanceNotificationEvent, event_id).status == NOTIFICATION_STATUS_FAILED
    assert drain_outbox_once(sessions, now=base + timedelta(days=6),
                             webhook_sender=webhook) == 0


def test_legacy_immediate_dispatch_is_unchanged_when_outbox_disabled(sessions, monkeypatch):
    monkeypatch.delenv("GDC_GOV_NOTIFICATION_DURABLE_QUEUE_ENABLED")
    mail = MockEmailSender()
    with sessions.begin() as db:
        config = NotificationService.get_or_create_config(db)
        config.email_enabled = True
        config.email_recipients_json = ["ops@example.com"]
        event = NotificationService.record_event(
            db, event_type="POLICY_SUBMITTED", payload={"policy_id": 10}
        )
        assert event is not None
        assert NotificationService.dispatch_pending(db, email_sender=mail) == 1
        assert event.status == NOTIFICATION_STATUS_SENT
        assert list(db.scalars(select(GovernanceNotificationDeliveryJob))) == []
    assert len(mail.sent) == 1


def test_outbox_unconfigured_channels_cannot_leave_orphan_pending_jobs(sessions):
    with sessions.begin() as db:
        config = NotificationService.get_or_create_config(db)
        config.email_enabled = True
        config.email_recipients_json = []
        config.webhook_enabled = False
        event = NotificationService.record_event(
            db, event_type="POLICY_SUBMITTED", payload={"policy_id": 10}
        )
        assert event is not None and event.status == NOTIFICATION_STATUS_FAILED
        assert list(db.scalars(select(GovernanceNotificationDeliveryJob))) == []


def test_outbox_health_exposes_read_only_channel_backlog_without_payload(sessions):
    _enqueue(sessions)
    with sessions() as db:
        health = NotificationService.get_health(db).model_dump()
        assert health["pending_delivery_jobs"] == 2
        assert health["leased_delivery_jobs"] == 0
        assert health["retry_scheduled_delivery_jobs"] == 0
        assert health["dead_letter_delivery_jobs"] == 0
        assert "secret" not in repr(health) and "webhook_url" not in repr(health)
    webhook = MockWebhookSender()
    webhook.should_fail = True
    now = datetime.now(timezone.utc)
    drain_outbox_once(sessions, now=now, email_sender=MockEmailSender(), webhook_sender=webhook)
    with sessions() as db:
        health = NotificationService.get_health(db).model_dump()
        assert health["pending_delivery_jobs"] == 1
        assert health["retry_scheduled_delivery_jobs"] == 1
    for day in (1, 2, 3, 4):
        drain_outbox_once(sessions, now=now + timedelta(days=day), webhook_sender=webhook)
    with sessions() as db:
        health = NotificationService.get_health(db).model_dump()
        assert health["dead_letter_delivery_jobs"] == 1
        assert health["pending_delivery_jobs"] == 0
        assert health["failed_notifications"] == 1


def test_health_does_not_query_outbox_table_while_feature_off(sessions, monkeypatch):
    monkeypatch.delenv("GDC_GOV_NOTIFICATION_DURABLE_QUEUE_ENABLED", raising=False)
    with sessions() as db:
        GovernanceNotificationDeliveryJob.__table__.drop(bind=db.bind)
        health = NotificationService.get_health(db).model_dump()
        assert health["pending_delivery_jobs"] == 0
        assert health["dead_letter_delivery_jobs"] == 0
