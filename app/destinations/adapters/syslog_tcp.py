"""Syslog over TCP."""

from __future__ import annotations

from typing import Any

from app.delivery.syslog_sender import SyslogSender
from app.destinations.adapters.base import DestinationAdapter
from app.formatters.message_prefix import MessagePrefixResolveContext


class SyslogTcpDestinationAdapter(DestinationAdapter):
    def __init__(self, sender: SyslogSender | None = None) -> None:
        self._sender = sender or SyslogSender()

    def send(
        self,
        events: list[dict[str, Any]],
        destination_config: dict[str, Any],
        formatter_override: dict[str, Any] | None = None,
        *,
        prefix_context: MessagePrefixResolveContext | None = None,
        idempotency_key: str | None = None,
    ) -> None:
        _ = idempotency_key  # syslog has no request-level dedupe header
        self._sender.send(
            events,
            destination_config,
            formatter_override=formatter_override,
            destination_type="SYSLOG_TCP",
            prefix_context=prefix_context,
        )
