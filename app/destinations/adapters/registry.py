"""Registry dispatch for :class:`DestinationAdapter` by ``destination_type``."""

from __future__ import annotations

from typing import Any

from app.delivery.syslog_sender import SyslogSender
from app.delivery.webhook_sender import WebhookSender
from app.destinations.adapters.base import DestinationAdapter
from app.destinations.adapters.ai_provider_post import AiProviderPostDestinationAdapter
from app.destinations.adapters.syslog_tcp import SyslogTcpDestinationAdapter
from app.destinations.adapters.syslog_tls import SyslogTlsDestinationAdapter
from app.destinations.adapters.syslog_udp import SyslogUdpDestinationAdapter
from app.destinations.adapters.webhook_post import WebhookPostDestinationAdapter
from app.formatters.message_prefix import MessagePrefixResolveContext
from app.runtime.errors import DestinationSendError


class _SyslogDynamicDestinationAdapter(DestinationAdapter):
    """Preserves legacy behavior for ``SYSLOG_*`` kinds beyond UDP/TCP (e.g. future TLS)."""

    def __init__(self, sender: SyslogSender, destination_type: str) -> None:
        self._sender = sender
        self._destination_type = str(destination_type or "").strip().upper()

    def send(
        self,
        events: list[dict[str, Any]],
        destination_config: dict[str, Any],
        formatter_override: dict[str, Any] | None = None,
        *,
        prefix_context: MessagePrefixResolveContext | None = None,
        idempotency_key: str | None = None,
    ) -> None:
        _ = idempotency_key
        self._sender.send(
            events,
            destination_config,
            formatter_override=formatter_override,
            destination_type=self._destination_type,
            prefix_context=prefix_context,
        )


class DestinationAdapterRegistry:
    """Maps normalized destination type strings to adapters."""

    def __init__(
        self,
        *,
        syslog_sender: SyslogSender | None = None,
        webhook_sender: WebhookSender | None = None,
    ) -> None:
        self._syslog = syslog_sender or SyslogSender()
        webhook = webhook_sender or WebhookSender()
        self._webhook = WebhookPostDestinationAdapter(webhook)
        self._ai_provider_post = AiProviderPostDestinationAdapter()
        self._syslog_udp = SyslogUdpDestinationAdapter(self._syslog)
        self._syslog_tcp = SyslogTcpDestinationAdapter(self._syslog)
        self._syslog_tls = SyslogTlsDestinationAdapter(self._syslog)

    def get(self, destination_type: str) -> DestinationAdapter:
        key = str(destination_type or "").strip().upper()
        if key == "WEBHOOK_POST":
            return self._webhook
        if key == "AI_PROVIDER_POST":
            return self._ai_provider_post
        if key.startswith("SYSLOG"):
            if key == "SYSLOG_TCP":
                return self._syslog_tcp
            if key == "SYSLOG_UDP":
                return self._syslog_udp
            if key == "SYSLOG_TLS":
                return self._syslog_tls
            return _SyslogDynamicDestinationAdapter(self._syslog, key)
        raise DestinationSendError(f"Unsupported destination type: {destination_type}")
