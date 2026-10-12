"""Opt-in PostgreSQL-backed PF-11A Governance notification outbox.

Events are recorded in the caller's transaction. A separate explicitly
scheduled caller may claim durable channel jobs after that transaction commits.
No worker or external transport is automatically started by this module.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import and_, or_, select, update
from sqlalchemy.orm import Session, sessionmaker

from app.governance_notifications.dispatcher import _event_body, _event_subject, _webhook_payload
from app.governance_notifications.email_sender import EmailSender, get_email_sender
from app.governance_notifications.models import (
    GovernanceNotificationConfig,
    GovernanceNotificationDeliveryJob,
    GovernanceNotificationEvent,
    NOTIFICATION_STATUS_FAILED,
    NOTIFICATION_STATUS_PENDING,
    NOTIFICATION_STATUS_SENT,
)
from app.governance_notifications.webhook_sender import WebhookSender, get_webhook_sender

PENDING = "PENDING"
LEASED = "LEASED"
SENT = "SENT"
DEAD = "DEAD"
MAX_ATTEMPTS = 5
LEASE_SECONDS = 60


@dataclass(frozen=True)
class DeliveryClaim:
    job_id: int
    event_id: int
    channel: str
    token: str
    attempt_count: int


def durable_outbox_enabled() -> bool:
    """Default OFF until migration, scheduling and owner policy are qualified."""
    return os.environ.get("GDC_GOV_NOTIFICATION_DURABLE_QUEUE_ENABLED") == "true"


def enqueue_delivery_jobs(
    db: Session, config: GovernanceNotificationConfig, event: GovernanceNotificationEvent
) -> int:
    """Create one non-secret durable job per configured channel in caller txn."""
    if event.id is None:
        raise ValueError("Notification event must have a persisted id")
    if config.updated_at is None:
        raise ValueError("Notification configuration must have a revision timestamp")
    channels = []
    recipients = config.email_recipients_json
    if config.email_enabled and isinstance(recipients, list) and any(str(r).strip() for r in recipients):
        channels.append("email")
    if config.webhook_enabled and config.webhook_url:
        channels.append("webhook")
    for channel in channels:
        db.add(
            GovernanceNotificationDeliveryJob(
                event_id=int(event.id),
                channel=channel,
                config_updated_at=config.updated_at,
                status=PENDING,
                attempt_count=0,
                next_attempt_at=datetime.now(timezone.utc),
                created_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc),
            )
        )
    return len(channels)


def _eligible_query(now: datetime, *, limit: int):
    return (
        select(GovernanceNotificationDeliveryJob)
        .where(
            or_(
                and_(
                    GovernanceNotificationDeliveryJob.status == PENDING,
                    GovernanceNotificationDeliveryJob.next_attempt_at <= now,
                ),
                and_(
                    GovernanceNotificationDeliveryJob.status == LEASED,
                    GovernanceNotificationDeliveryJob.lease_expires_at <= now,
                ),
            )
        )
        .order_by(GovernanceNotificationDeliveryJob.next_attempt_at, GovernanceNotificationDeliveryJob.id)
        .limit(limit)
        .with_for_update(skip_locked=True)
    )


def _reconcile_event(db: Session, event_id: int, *, now: datetime) -> None:
    event = db.execute(
        select(GovernanceNotificationEvent)
        .where(GovernanceNotificationEvent.id == event_id)
        .with_for_update()
    ).scalar_one_or_none()
    if event is None:
        return
    db.flush()
    statuses = db.execute(
        select(GovernanceNotificationDeliveryJob.status)
        .where(GovernanceNotificationDeliveryJob.event_id == event_id)
    ).scalars().all()
    if statuses and all(status == SENT for status in statuses):
        event.status, event.sent_at = NOTIFICATION_STATUS_SENT, now
    elif DEAD in statuses:
        event.status, event.sent_at = NOTIFICATION_STATUS_FAILED, now
    else:
        event.status, event.sent_at = NOTIFICATION_STATUS_PENDING, None


def claim_delivery_jobs(
    db: Session, *, now: datetime, limit: int = 20, lease_seconds: int = LEASE_SECONDS
) -> list[DeliveryClaim]:
    """Row-lock and claim; caller MUST commit before attempting network I/O."""
    if not 1 <= limit <= 100 or not 30 <= lease_seconds <= 300:
        raise ValueError("Invalid Governance notification claim bounds")
    rows = db.execute(_eligible_query(now, limit=limit)).scalars().all()
    claims = []
    expired = []
    for row in rows:
        if row.attempt_count >= MAX_ATTEMPTS:
            row.status = DEAD
            row.lease_token = None
            row.lease_expires_at = None
            row.last_error_type = "LEASE_EXPIRED"
            row.updated_at = now
            expired.append(row.event_id)
            continue
        token = uuid4().hex
        row.status = LEASED
        row.lease_token = token
        row.lease_expires_at = now + timedelta(seconds=lease_seconds)
        row.attempt_count += 1
        row.updated_at = now
        claims.append(
            DeliveryClaim(int(row.id), int(row.event_id), row.channel, token, row.attempt_count)
        )
    for event_id in set(expired):
        _reconcile_event(db, event_id, now=now)
    return claims


def complete_delivery_job(
    db: Session, *, job_id: int, token: str, success: bool, now: datetime,
    dead_reason: str | None = None,
) -> bool:
    """Compare-and-swap the lease token; stale workers cannot update state."""
    job = db.execute(
        select(GovernanceNotificationDeliveryJob)
        .where(GovernanceNotificationDeliveryJob.id == job_id)
        .with_for_update()
    ).scalar_one_or_none()
    if job is None or job.status != LEASED or job.lease_token != token:
        return False
    if success:
        new_status, next_attempt, reason = SENT, job.next_attempt_at, None
    elif dead_reason is not None or job.attempt_count >= MAX_ATTEMPTS:
        new_status, next_attempt, reason = DEAD, job.next_attempt_at, dead_reason or "RETRY_EXHAUSTED"
    else:
        delay = min(900, 15 * (2 ** (job.attempt_count - 1)))
        new_status = PENDING
        next_attempt = now + timedelta(seconds=delay)
        reason = "DELIVERY_NOT_ACCEPTED"
    changed = db.execute(
        update(GovernanceNotificationDeliveryJob)
        .where(
            GovernanceNotificationDeliveryJob.id == job_id,
            GovernanceNotificationDeliveryJob.status == LEASED,
            GovernanceNotificationDeliveryJob.lease_token == token,
        )
        .values(
            status=new_status,
            next_attempt_at=next_attempt,
            lease_token=None,
            lease_expires_at=None,
            last_error_type=reason,
            updated_at=now,
        )
    )
    if changed.rowcount != 1:
        return False
    _reconcile_event(db, int(job.event_id), now=now)
    return True


def drain_outbox_once(
    session_factory: sessionmaker, *,
    now: datetime | None = None, limit: int = 20,
    email_sender: EmailSender | None = None,
    webhook_sender: WebhookSender | None = None,
) -> int:
    """Opt-in synchronous batch for an authorized caller, NOT automatic startup.

    Claim is committed before the network call. After success an unrelated
    process crash may still cause at-least-once redelivery upon lease expiry;
    exactly-once SMTP/Webhook delivery is never claimed.
    """
    now = now or datetime.now(timezone.utc)
    with session_factory.begin() as db:
        claims = claim_delivery_jobs(db, now=now, limit=limit)

    email = email_sender or get_email_sender()
    webhook = webhook_sender or get_webhook_sender()
    for claim in claims:
        prepared = None
        with session_factory() as db:
            job = db.get(GovernanceNotificationDeliveryJob, claim.job_id)
            event = db.get(GovernanceNotificationEvent, claim.event_id)
            config = db.execute(
                select(GovernanceNotificationConfig)
                .order_by(GovernanceNotificationConfig.id.asc())
                .limit(1)
            ).scalar_one_or_none()
            if job is not None and event is not None and config is not None and (
                config.updated_at == job.config_updated_at
            ):
                if claim.channel == "email" and config.email_enabled:
                    recipients = config.email_recipients_json
                    if isinstance(recipients, list) and recipients:
                        prepared = ("email", ([str(r).strip() for r in recipients if str(r).strip()],
                                              _event_subject(event), _event_body(event)))
                elif claim.channel == "webhook" and config.webhook_enabled and config.webhook_url:
                    prepared = ("webhook", (str(config.webhook_url), _webhook_payload(event)))
        accepted = False
        failure_reason = None
        if prepared is None:
            failure_reason = "CONFIG_CHANGED"
        else:
            try:
                channel, args = prepared
                if channel == "email":
                    recipients, subject, body = args
                    accepted = bool(recipients and email.send_email(
                        recipients=recipients, subject=subject, body=body
                    ))
                else:
                    url, payload = args
                    accepted = webhook.send_webhook(url=url, payload=payload)
            except Exception:
                # Error text may contain credentials, request headers or payload.
                accepted = False
        with session_factory.begin() as db:
            complete_delivery_job(
                db, job_id=claim.job_id, token=claim.token,
                success=accepted, now=now, dead_reason=failure_reason,
            )
    return len(claims)
