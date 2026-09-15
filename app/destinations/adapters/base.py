"""Destination adapter interface — one implementation per ``destination_type``."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from app.formatters.message_prefix import MessagePrefixResolveContext


class DestinationAdapter(ABC):
    """Sends formatted/enriched events to an external sink."""

    @abstractmethod
    def send(
        self,
        events: list[dict[str, Any]],
        destination_config: dict[str, Any],
        formatter_override: dict[str, Any] | None = None,
        *,
        prefix_context: MessagePrefixResolveContext | None = None,
        idempotency_key: str | None = None,
    ) -> None:
        """Deliver events; raise :class:`DestinationSendError` on failure.

        ``idempotency_key`` is best-effort: destinations that support request
        dedupe (e.g. webhook ``Idempotency-Key``) should propagate it. Callers
        must not assume exactly-once delivery when the sink cannot dedupe.
        """
