"""Webhook delivery for governance notifications (M20.2)."""

from __future__ import annotations

import logging
from typing import Any, Protocol

import httpx

logger = logging.getLogger(__name__)


class WebhookSender(Protocol):
    def send_webhook(self, *, url: str, payload: dict[str, Any]) -> bool:
        """POST payload to webhook URL; return True on success."""


class HttpWebhookSender:
    def __init__(self, *, timeout_seconds: float = 10.0) -> None:
        self.timeout_seconds = timeout_seconds

    def send_webhook(self, *, url: str, payload: dict[str, Any]) -> bool:
        try:
            response = httpx.post(str(url), json=payload, timeout=self.timeout_seconds)
            return 200 <= response.status_code < 300
        except Exception as exc:
            # Endpoint URLs may contain tokens. Avoid leaking them in logs.
            logger.warning("governance_notification_webhook_failed reason=%s", type(exc).__name__)
            return False


class MockWebhookSender:
    def __init__(self) -> None:
        self.sent: list[dict[str, object]] = []
        self.should_fail = False

    def send_webhook(self, *, url: str, payload: dict[str, Any]) -> bool:
        if self.should_fail:
            return False
        self.sent.append({"url": url, "payload": payload})
        return True


class UnavailableWebhookSender:
    """Fail closed until a product-owned egress/SSRF policy is configured."""

    def send_webhook(self, *, url: str, payload: dict[str, Any]) -> bool:
        return False


_default_webhook_sender: WebhookSender = UnavailableWebhookSender()


def get_webhook_sender() -> WebhookSender:
    return _default_webhook_sender


def set_webhook_sender(sender: WebhookSender) -> None:
    global _default_webhook_sender
    _default_webhook_sender = sender


def reset_webhook_sender() -> None:
    global _default_webhook_sender
    _default_webhook_sender = UnavailableWebhookSender()
