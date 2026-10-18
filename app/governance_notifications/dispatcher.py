"""Dispatch governance notification events to configured channels (M20.2)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app.governance_notifications.email_sender import EmailSender, get_email_sender
from app.governance_notifications.models import (
    GovernanceNotificationConfig,
    GovernanceNotificationEvent,
    NOTIFICATION_STATUS_FAILED,
    NOTIFICATION_STATUS_SENT,
)
from app.governance_notifications.webhook_sender import WebhookSender, get_webhook_sender


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _event_subject(event: GovernanceNotificationEvent) -> str:
    return f"[Governance] {event.event_type.replace('_', ' ').title()}"


def _external_event_identifiers(event: GovernanceNotificationEvent) -> dict[str, int]:
    """Transmit only verified opaque IDs; leave raw event details in Control.

    A notification can be sent outside the tenant. Comments, error messages,
    URL/headers, credentials and arbitrary nested payloads are not safe to
    copy into email or Webhook, even when internal event audit retains them.
    """
    payload = event.payload_json if isinstance(event.payload_json, dict) else {}
    id_keys = ("policy_id", "replay_event_id", "stream_id", "route_id", "destination_id")
    return {
        key: value for key in id_keys
        if isinstance((value := payload.get(key)), int) and
        not isinstance(value, bool) and 0 < value <= 2**63 - 1
    }


def _event_body(event: GovernanceNotificationEvent) -> str:
    payload = _external_event_identifiers(event)
    lines = [
        f"Event: {event.event_type}",
        f"Category: {event.event_category}",
        f"Severity: {event.severity}",
        f"Time: {event.created_at.isoformat()}",
    ]
    for key, value in payload.items():
        lines.append(f"{key}: {value}")
    lines.append("")
    lines.append("Review this event in the Governance Notifications page.")
    return "\n".join(lines)


def _webhook_payload(event: GovernanceNotificationEvent) -> dict[str, Any]:
    return {
        "event_type": event.event_type,
        "severity": event.severity,
        "timestamp": event.created_at.isoformat(),
        "payload": _external_event_identifiers(event),
    }


def dispatch_notification_event(
    event: GovernanceNotificationEvent,
    config: GovernanceNotificationConfig,
    *,
    email_sender: EmailSender | None = None,
    webhook_sender: WebhookSender | None = None,
) -> bool:
    """Attempt delivery on all enabled channels. Returns True if any channel succeeded."""

    email = email_sender or get_email_sender()
    webhook = webhook_sender or get_webhook_sender()
    successes = 0
    attempts = 0

    if config.email_enabled:
        recipients_raw = config.email_recipients_json if isinstance(config.email_recipients_json, list) else []
        recipients = [str(r).strip() for r in recipients_raw if str(r).strip()]
        if recipients:
            attempts += 1
            if email.send_email(
                recipients=recipients,
                subject=_event_subject(event),
                body=_event_body(event),
            ):
                successes += 1

    if config.webhook_enabled and config.webhook_url:
        attempts += 1
        if webhook.send_webhook(url=str(config.webhook_url), payload=_webhook_payload(event)):
            successes += 1

    if attempts == 0:
        return False

    now = _utc_now()
    if successes > 0:
        event.status = NOTIFICATION_STATUS_SENT
        event.sent_at = now
        return True

    event.status = NOTIFICATION_STATUS_FAILED
    event.sent_at = now
    return False
