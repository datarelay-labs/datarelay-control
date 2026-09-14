"""Webhook POST JSON/text delivery."""

from __future__ import annotations

from typing import Any

from app.delivery.webhook_sender import WebhookSender
from app.destinations.adapters.base import DestinationAdapter
from app.formatters.message_prefix import MessagePrefixResolveContext


class WebhookPostDestinationAdapter(DestinationAdapter):
    def __init__(self, sender: WebhookSender | None = None) -> None:
        self._sender = sender or WebhookSender()

    def send(
        self,
        events: list[dict[str, Any]],
        destination_config: dict[str, Any],
        formatter_override: dict[str, Any] | None = None,
        *,
        prefix_context: MessagePrefixResolveContext | None = None,
        idempotency_key: str | None = None,
    ) -> None:
        self._sender.send(
            events,
            destination_config,
            formatter_override=formatter_override,
            prefix_context=prefix_context,
            idempotency_key=idempotency_key,
        )
