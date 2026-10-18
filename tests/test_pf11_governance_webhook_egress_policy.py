"""PF-11A Governance Webhook egress policy: pure test doubles, never a live request."""

from __future__ import annotations

import json
import logging
import socket

import pytest

from app.governance_notifications import webhook_sender as module


PUBLIC_DNS = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]
PRIVATE_DNS = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]


def test_webhook_egress_is_unavailable_without_exact_host_allowlist(monkeypatch):
    lookups = []
    monkeypatch.setattr(module.socket, "getaddrinfo", lambda *a, **kw: lookups.append(a))
    sender = module.HttpWebhookSender()
    assert sender.send_webhook(url="https://hooks.example.com/alert", payload={"k": 1}) is False
    assert lookups == []


@pytest.mark.parametrize(
    "url",
    [
        "http://hooks.example.com/alert",
        "https://hooks.example.com.evil.test/alert",
        "https://127.0.0.1/alert",
        "https://[::1]/alert",
        "https://hooks.example.com:8443/alert",
        "https://user:secret@hooks.example.com/alert",
        "https://hooks.example.com/alert#fragment",
        "https://hooks.example.com./alert",
        "https://hooks.example.com\\@evil.test/alert",
        "https://hooks.example.com/alert\nX-Test: injected",
        "https://unicode-☃.example.com/alert",
        "file:///etc/passwd",
    ],
)
def test_webhook_url_rejects_non_allowlisted_or_non_https_targets_before_dns(monkeypatch, url):
    lookups = []
    monkeypatch.setattr(module.socket, "getaddrinfo", lambda *a, **kw: lookups.append(a))
    sender = module.HttpWebhookSender(allowed_hosts=["hooks.example.com"])
    assert sender.send_webhook(url=url, payload={"event": "test"}) is False
    assert lookups == []


@pytest.mark.parametrize(
    "addresses",
    [
        PRIVATE_DNS,
        [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.1.2.3", 443))],
        [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("169.254.169.254", 443))],
        [(socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("::1", 443, 0, 0))],
        PUBLIC_DNS + PRIVATE_DNS,
        [],
    ],
)
def test_webhook_rejects_private_mixed_or_empty_dns_without_connect(monkeypatch, addresses):
    calls = []
    monkeypatch.setattr(module.socket, "getaddrinfo", lambda *a, **kw: addresses)
    monkeypatch.setattr(module, "_PinnedHTTPSConnection", lambda *a, **kw: calls.append((a, kw)))
    sender = module.HttpWebhookSender(allowed_hosts=["hooks.example.com"])
    assert sender.send_webhook(url="https://hooks.example.com/alert", payload={"event": "test"}) is False
    assert calls == []


class RecordingConnection:
    instances = []
    response_status = 204
    raise_message = ""

    def __init__(self, hostname, *, ip_address, timeout_seconds):
        self.hostname = hostname
        self.ip_address = ip_address
        self.timeout_seconds = timeout_seconds
        self.requests = []
        self.closed = False
        self.instances.append(self)

    def request(self, method, path, body, headers):
        if self.raise_message:
            raise OSError(self.raise_message)
        self.requests.append((method, path, body, headers))

    def getresponse(self):
        return type("Response", (), {"status": self.response_status, "close": lambda self: None})()

    def close(self):
        self.closed = True


@pytest.mark.parametrize("status, accepted", [(204, True), (299, True), (302, False), (400, False)])
def test_explicit_allowlist_validated_public_dns_https_post_no_redirect(monkeypatch, status, accepted):
    RecordingConnection.instances = []
    RecordingConnection.response_status = status
    RecordingConnection.raise_message = ""
    monkeypatch.setattr(module.socket, "getaddrinfo", lambda *a, **kw: PUBLIC_DNS)
    monkeypatch.setattr(module, "_PinnedHTTPSConnection", RecordingConnection)
    sender = module.HttpWebhookSender(allowed_hosts=["hooks.example.com"])
    assert sender.send_webhook(
        url="https://hooks.example.com/notify?token=private",
        payload={"event": "approval"},
    ) is accepted
    assert len(RecordingConnection.instances) == 1
    conn = RecordingConnection.instances[0]
    assert (conn.hostname, conn.ip_address) == ("hooks.example.com", "8.8.8.8")
    assert conn.timeout_seconds <= 30
    assert len(conn.requests) == 1
    method, path, body, headers = conn.requests[0]
    assert method == "POST" and path == "/notify?token=private"
    assert json.loads(body) == {"event": "approval"}
    assert headers["Content-Type"] == "application/json"
    assert conn.closed is True


def test_egress_exception_never_logs_url_or_payload_secret(monkeypatch, caplog):
    RecordingConnection.instances = []
    RecordingConnection.raise_message = "token-do-not-log"
    monkeypatch.setattr(module.socket, "getaddrinfo", lambda *a, **kw: PUBLIC_DNS)
    monkeypatch.setattr(module, "_PinnedHTTPSConnection", RecordingConnection)
    with caplog.at_level(logging.WARNING):
        assert module.HttpWebhookSender(allowed_hosts=["hooks.example.com"]).send_webhook(
            url="https://hooks.example.com/secret-in-url",
            payload={"password": "secret-in-body"},
        ) is False
    assert "token-do-not-log" not in caplog.text
    assert "secret-in-url" not in caplog.text
    assert "secret-in-body" not in caplog.text
    assert RecordingConnection.instances[0].closed is True
    RecordingConnection.raise_message = ""


def test_https_connection_pins_numeric_peer_but_verifies_original_hostname(monkeypatch):
    connections = []
    tls_hosts = []

    class FakeSocket:
        def close(self):
            pass

    class FakeTLS:
        def wrap_socket(self, sock, *, server_hostname):
            tls_hosts.append(server_hostname)
            return sock

    monkeypatch.setattr(module.socket, "create_connection", lambda address, timeout: (
        connections.append((address, timeout)) or FakeSocket()
    ))
    monkeypatch.setattr(module.ssl, "create_default_context", lambda: FakeTLS())
    conn = module._PinnedHTTPSConnection("hooks.example.com", ip_address="8.8.8.8", timeout_seconds=7)
    conn.connect()
    assert connections == [(("8.8.8.8", 443), 7)]
    assert tls_hosts == ["hooks.example.com"]
    conn.close()
