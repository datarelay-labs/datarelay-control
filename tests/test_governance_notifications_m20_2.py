"""M20.2 Governance Notification Framework tests."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from app.database import get_db, get_db_read_bounded
from app.governance_approval.service import submit_policy_approval
from app.governance_notifications.email_sender import MockEmailSender, reset_email_sender, set_email_sender
from app.governance_notifications.models import (
    EVENT_POLICY_SUBMITTED,
    EVENT_REPLAY_FAILED,
    NOTIFICATION_STATUS_FAILED,
    NOTIFICATION_STATUS_PENDING,
    NOTIFICATION_STATUS_SENT,
    GovernanceNotificationConfig,
    GovernanceNotificationEvent,
)
from app.governance_notifications.schemas import GovernanceNotificationConfigUpdateRequest
from app.governance_notifications.service import NotificationService
from app.governance_notifications.webhook_sender import MockWebhookSender, reset_webhook_sender, set_webhook_sender
from app.governance_policies.models import POLICY_STATUS_DRAFT, GovernancePolicy
from app.governance_replay.service import execute_governance_replay
from app.replay.models import REPLAY_STATUS_FAILED, REPLAY_STATUS_PENDING, StreamReplayEvent
from tests.test_stream_runner_e2e import _seed_stream_runtime


def _governance_app() -> FastAPI:
    from app.governance.router import router

    app = FastAPI()
    app.include_router(router, prefix="/api/v1/governance")
    return app


@pytest.fixture
def governance_client(db_session: Session) -> TestClient:
    app = _governance_app()

    def _override_db():
        yield db_session

    app.dependency_overrides[get_db_read_bounded] = _override_db
    app.dependency_overrides[get_db] = _override_db
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset_senders():
    reset_email_sender()
    reset_webhook_sender()
    yield
    reset_email_sender()
    reset_webhook_sender()


def _enable_channels(db_session: Session) -> None:
    NotificationService.update_config(
        db_session,
        GovernanceNotificationConfigUpdateRequest(
            email_enabled=True,
            email_recipients=["ops@example.com"],
            webhook_enabled=True,
            webhook_url="https://hooks.example.com/governance",
            approval_events=True,
            violation_events=True,
            quarantine_events=True,
            replay_events=True,
        ),
    )
    db_session.commit()


def _create_draft_policy(db_session: Session) -> GovernancePolicy:
    now = datetime.now(timezone.utc)
    row = GovernancePolicy(
        name="notify-policy",
        description=None,
        category="DATA_PROTECTION",
        status=POLICY_STATUS_DRAFT,
        policy_json={"conditions": [], "actions": []},
        version=1,
        created_at=now,
        updated_at=now,
    )
    db_session.add(row)
    db_session.commit()
    return row


def test_notification_config_crud(db_session: Session, governance_client: TestClient) -> None:
    resp = governance_client.get("/api/v1/governance/notifications/config")
    assert resp.status_code == 200
    body = resp.json()
    assert body["approval_events"] is True
    assert body["email_enabled"] is False

    put = governance_client.put(
        "/api/v1/governance/notifications/config",
        json={
            "email_enabled": True,
            "email_recipients": ["admin@example.com"],
            "webhook_enabled": True,
            "webhook_url": "https://example.com/hook",
            "replay_events": False,
        },
    )
    assert put.status_code == 200
    updated = put.json()
    assert updated["email_enabled"] is True
    assert updated["email_recipients"] == ["admin@example.com"]
    assert updated["webhook_enabled"] is True
    assert updated["replay_events"] is False


def test_notification_config_get_is_read_only_on_empty_database(db_session: Session) -> None:
    app = _governance_app()
    bind = db_session.get_bind()

    def _override_read_db():
        read_session = sessionmaker(bind=bind, autocommit=False, autoflush=False, expire_on_commit=False)()
        try:
            read_session.execute(text("SET TRANSACTION READ ONLY"))
            yield read_session
        finally:
            read_session.rollback()
            read_session.close()

    app.dependency_overrides[get_db_read_bounded] = _override_read_db
    client = TestClient(app)

    resp = client.get("/api/v1/governance/notifications/config")

    assert resp.status_code == 200
    assert resp.json()["approval_events"] is True
    assert resp.json()["email_enabled"] is False
    db_session.rollback()
    assert db_session.query(GovernanceNotificationConfig).count() == 0


def test_record_event_persists_pending(db_session: Session) -> None:
    _enable_channels(db_session)
    row = NotificationService.record_event(
        db_session,
        event_type=EVENT_POLICY_SUBMITTED,
        severity="INFO",
        payload={"policy_id": 1},
    )
    assert row is not None
    assert row.status == NOTIFICATION_STATUS_PENDING
    db_session.commit()

    stored = db_session.get(GovernanceNotificationEvent, row.id)
    assert stored is not None
    assert stored.event_type == EVENT_POLICY_SUBMITTED


def test_email_dispatch(db_session: Session) -> None:
    email = MockEmailSender()
    set_email_sender(email)
    _enable_channels(db_session)

    NotificationService.record_event(
        db_session,
        event_type=EVENT_POLICY_SUBMITTED,
        severity="INFO",
        payload={"policy_id": 42},
    )
    NotificationService.dispatch_pending(db_session)
    db_session.commit()

    events = list(db_session.query(GovernanceNotificationEvent).all())
    assert len(events) == 1
    assert events[0].status == NOTIFICATION_STATUS_SENT
    assert len(email.sent) == 1
    assert email.sent[0]["recipients"] == ["ops@example.com"]


def test_webhook_dispatch(db_session: Session) -> None:
    webhook = MockWebhookSender()
    set_webhook_sender(webhook)
    NotificationService.update_config(
        db_session,
        GovernanceNotificationConfigUpdateRequest(
            email_enabled=False,
            webhook_enabled=True,
            webhook_url="https://hooks.example.com/governance",
            approval_events=True,
        ),
    )
    db_session.commit()

    NotificationService.record_event(
        db_session,
        event_type=EVENT_POLICY_SUBMITTED,
        severity="INFO",
        payload={"policy_id": 7},
    )
    NotificationService.dispatch_pending(db_session)
    db_session.commit()

    events = list(db_session.query(GovernanceNotificationEvent).all())
    assert events[0].status == NOTIFICATION_STATUS_SENT
    assert len(webhook.sent) == 1
    payload = webhook.sent[0]["payload"]
    assert payload["event_type"] == EVENT_POLICY_SUBMITTED
    assert payload["severity"] == "INFO"
    assert "timestamp" in payload


def test_failed_status_when_channels_fail(db_session: Session) -> None:
    email = MockEmailSender()
    email.should_fail = True
    webhook = MockWebhookSender()
    webhook.should_fail = True
    set_email_sender(email)
    set_webhook_sender(webhook)
    _enable_channels(db_session)

    NotificationService.record_event(
        db_session,
        event_type=EVENT_POLICY_SUBMITTED,
        severity="INFO",
        payload={"policy_id": 1},
    )
    NotificationService.dispatch_pending(db_session)
    db_session.commit()

    event = db_session.query(GovernanceNotificationEvent).one()
    assert event.status == NOTIFICATION_STATUS_FAILED


def test_approval_event_notification(db_session: Session) -> None:
    email = MockEmailSender()
    set_email_sender(email)
    _enable_channels(db_session)

    policy = _create_draft_policy(db_session)
    submit_policy_approval(db_session, int(policy.id), actor="reviewer")
    db_session.commit()

    events = list(
        db_session.query(GovernanceNotificationEvent)
        .filter(GovernanceNotificationEvent.event_type == EVENT_POLICY_SUBMITTED)
        .all()
    )
    assert len(events) == 1
    assert events[0].status == NOTIFICATION_STATUS_SENT
    assert len(email.sent) >= 1


def test_replay_event_notifications(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    email = MockEmailSender()
    set_email_sender(email)
    _enable_channels(db_session)

    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    destination_id = int(seeded["destination_ids"][0])
    now = datetime.now(timezone.utc)
    replay = StreamReplayEvent(
        stream_id=int(stream_id),
        destination_id=int(destination_id),
        route_id=None,
        delivery_kind="base_route",
        status=REPLAY_STATUS_PENDING,
        retry_count=1,
        event_count=1,
        protected_payload_json={"events": [{"message": "test"}]},
        delivery_context_json={"destination_type": "WEBHOOK"},
        created_at=now,
        updated_at=now,
    )
    db_session.add(replay)
    db_session.commit()

    def _fake_execute(db: Session, event_id: int, **kwargs):
        row = db.get(StreamReplayEvent, int(event_id))
        assert row is not None
        row.status = REPLAY_STATUS_FAILED
        row.updated_at = datetime.now(timezone.utc)
        row.last_replay_at = row.updated_at
        row.error_message = "delivery failed"
        db.flush()
        return {
            "outcome": "failed",
            "message": "delivery failed",
            "status": REPLAY_STATUS_FAILED,
        }

    monkeypatch.setattr("app.replay.service.execute_replay_event", _fake_execute)

    execute_governance_replay(db_session, int(replay.id))

    failed_events = list(
        db_session.query(GovernanceNotificationEvent)
        .filter(GovernanceNotificationEvent.event_type == EVENT_REPLAY_FAILED)
        .all()
    )
    retried_events = list(
        db_session.query(GovernanceNotificationEvent)
        .filter(GovernanceNotificationEvent.event_type == "REPLAY_RETRIED")
        .all()
    )
    assert len(failed_events) == 1
    assert len(retried_events) == 1


def test_test_notification_endpoint(db_session: Session, governance_client: TestClient) -> None:
    email = MockEmailSender()
    set_email_sender(email)
    _enable_channels(db_session)

    resp = governance_client.post("/api/v1/governance/notifications/test", json={"channel": "email"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert body["channel"] == "email"
    assert len(email.sent) == 1


def test_notification_health_endpoint(db_session: Session, governance_client: TestClient) -> None:
    _enable_channels(db_session)
    NotificationService.record_event(
        db_session,
        event_type="REPLAY_COMPLETED",
        severity="INFO",
        payload={"replay_event_id": 1},
    )
    db_session.commit()

    health = governance_client.get("/api/v1/governance/notifications/health")
    assert health.status_code == 200
    body = health.json()
    assert body["pending_notifications"] >= 1

    operations = governance_client.get("/api/v1/governance/operations/summary")
    assert operations.status_code == 200
    summary = operations.json()
    assert "pending_notifications" in summary
    assert "failed_notifications" in summary
    assert "last_notification_delivery_time" not in summary
