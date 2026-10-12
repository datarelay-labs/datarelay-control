"""Governance notification Webhook delivery with explicit fail-closed egress policy."""

from __future__ import annotations

import http.client
import ipaddress
import json
import logging
import math
import re
import socket
import ssl
from typing import Any, Protocol
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

_HOST_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")


class WebhookSender(Protocol):
    def send_webhook(self, *, url: str, payload: dict[str, Any]) -> bool:
        """POST payload to webhook URL; return True on success."""


def _allowed_hostname(host: str) -> bool:
    """An explicitly named DNS host, never a literal IP or wildcard."""
    if not host or len(host) > 253 or not host.isascii() or "." not in host:
        return False
    if any(not _HOST_LABEL.fullmatch(label) for label in host.split(".")):
        return False
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return True
    return False


def _validated_target(raw: str, allowed_hosts: frozenset[str]) -> tuple[str, str] | None:
    # Reject control characters *before* urlsplit silently strips tabs/newlines.
    if (not isinstance(raw, str) or len(raw) > 2048 or
            any(ord(ch) < 33 or ord(ch) == 127 for ch in raw) or "\\" in raw):
        return None
    try:
        parsed = urlsplit(raw)
        host = parsed.hostname
        if (parsed.scheme != "https" or not host or
                parsed.username is not None or parsed.password is not None or
                parsed.fragment or parsed.port not in (None, 443) or
                not _allowed_hostname(host) or host not in allowed_hosts):
            return None
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        return host, path
    except ValueError:
        return None


def _public_dns_address(host: str) -> str | None:
    """Reject the entire DNS answer if any address is non-global."""
    records = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    if not records:
        return None
    addresses: list[str] = []
    for family, _type, _proto, _canon, sockaddr in records:
        if family not in (socket.AF_INET, socket.AF_INET6) or not sockaddr:
            return None
        address = ipaddress.ip_address(sockaddr[0])
        if not address.is_global or getattr(address, "ipv4_mapped", None):
            return None
        addresses.append(str(address))
    return addresses[0] if addresses else None


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Physically connect to a validated DNS IP, verify TLS against the host."""

    def __init__(self, hostname: str, *, ip_address: str, timeout_seconds: float):
        super().__init__(
            hostname, 443, timeout=timeout_seconds, context=ssl.create_default_context()
        )
        self._validated_ip = ip_address

    def connect(self) -> None:
        # No environment proxy, no second DNS resolution, and no redirect follow.
        plain_sock = socket.create_connection((self._validated_ip, 443), self.timeout)
        try:
            self.sock = self._context.wrap_socket(plain_sock, server_hostname=self.host)
        except Exception:
            plain_sock.close()
            raise


class HttpWebhookSender:
    """Explicitly scoped transport; NOT configured by production startup.

    The default empty allowlist forbids all egress. A future authorized
    deployment must provide exact DNS hostnames. No wildcard, IP or HTTP
    target is allowed. DNS is checked then the connection is pinned to the
    validated numeric address to prevent DNS-rebinding between checks.
    """

    def __init__(
        self, *, timeout_seconds: float = 10.0, allowed_hosts: tuple[str, ...] | list[str] = ()
    ) -> None:
        if not math.isfinite(timeout_seconds) or not 0 < timeout_seconds <= 30:
            raise ValueError("Webhook timeout must be between 0 and 30 seconds")
        if isinstance(allowed_hosts, str):
            raise ValueError("Webhook allowlist must be a sequence of hostnames")
        normalized = tuple(h.lower() for h in allowed_hosts)
        if any(not _allowed_hostname(h) for h in normalized):
            raise ValueError("Webhook allowlist contains an invalid DNS hostname")
        self.timeout_seconds = timeout_seconds
        self.allowed_hosts = frozenset(normalized)

    def send_webhook(self, *, url: str, payload: dict[str, Any]) -> bool:
        if not self.allowed_hosts:
            return False
        conn: _PinnedHTTPSConnection | None = None
        try:
            target = _validated_target(url, self.allowed_hosts)
            if target is None:
                return False
            hostname, request_target = target
            ip_address = _public_dns_address(hostname)
            if ip_address is None:
                return False
            body = json.dumps(payload, separators=(",", ":"), ensure_ascii=True)
            if len(body.encode("utf-8")) > 64 * 1024:
                return False
            conn = _PinnedHTTPSConnection(
                hostname, ip_address=ip_address, timeout_seconds=self.timeout_seconds
            )
            conn.request(
                "POST", request_target, body,
                {"Content-Type": "application/json", "Accept": "application/json"},
            )
            response = conn.getresponse()
            try:
                # Any redirect is a failure; never follow an unvalidated location.
                return 200 <= response.status < 300
            finally:
                response.close()
        except Exception as exc:
            # Never expose URL/path/query, credential, payload or exception text.
            logger.warning("governance_notification_webhook_failed reason=%s", type(exc).__name__)
            return False
        finally:
            if conn is not None:
                conn.close()


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
