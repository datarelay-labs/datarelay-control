"""Control PF-11 product-native transport truth: no live SMTP or Webhook in this test."""
from __future__ import annotations

import logging
import smtplib
import ssl

import pytest

from app.governance_notifications.email_sender import (
    MockEmailSender,
    SmtpEmailSender,
    get_email_sender,
    reset_email_sender,
)
from app.governance_notifications.webhook_sender import (
    MockWebhookSender,
    get_webhook_sender,
    reset_webhook_sender,
)


@pytest.fixture(autouse=True)
def _reset_transport(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("GDC_NOTIFICATION_SMTP_ENABLED", raising=False)
    for name in ("HOST", "PORT", "FROM", "USERNAME", "PASSWORD", "TLS_MODE", "TIMEOUT_SECONDS"):
        monkeypatch.delenv(f"GDC_NOTIFICATION_SMTP_{name}", raising=False)
    reset_email_sender()
    reset_webhook_sender()
    yield
    # Clear the test's explicit relay opt-in before reinitializing module
    # globals, even if pytest tears down monkeypatch environment later.
    monkeypatch.delenv("GDC_NOTIFICATION_SMTP_ENABLED", raising=False)
    for name in ("HOST", "PORT", "FROM", "USERNAME", "PASSWORD", "TLS_MODE", "TIMEOUT_SECONDS"):
        monkeypatch.delenv(f"GDC_NOTIFICATION_SMTP_{name}", raising=False)
    reset_email_sender()
    reset_webhook_sender()


def test_real_notification_service_does_not_claim_delivery_without_transports(monkeypatch):
    from types import SimpleNamespace

    from app.governance_notifications.service import NotificationService

    config = SimpleNamespace(
        email_enabled=True,
        email_recipients_json=["ops@example.com"],
        webhook_enabled=True,
        webhook_url="https://hooks.example.com/alert",
    )
    monkeypatch.setattr(
        NotificationService, "get_or_create_config", staticmethod(lambda _db: config),
    )
    email = NotificationService.test_notification(None, channel="email")
    webhook = NotificationService.test_notification(None, channel="webhook")
    assert email.success is False
    assert webhook.success is False
    assert "not accepted" in email.message
    assert "not accepted" in webhook.message


def test_test_send_response_distinguishes_relay_acceptance_from_delivery(monkeypatch):
    from types import SimpleNamespace

    from app.governance_notifications.service import NotificationService

    config = SimpleNamespace(
        email_enabled=True,
        email_recipients_json=["ops@example.com"],
        webhook_enabled=True,
        webhook_url="https://hooks.example.com/alert",
    )
    monkeypatch.setattr(
        NotificationService, "get_or_create_config", staticmethod(lambda _db: config),
    )
    accepted = NotificationService.test_notification(
        None, channel="email", email_sender=MockEmailSender(),
    )
    assert accepted.success is True
    assert "inbox delivery is not verified" in accepted.message
    returned = NotificationService.test_notification(
        None, channel="webhook", webhook_sender=MockWebhookSender(),
    )
    assert returned.success is True
    assert "downstream processing is not verified" in returned.message


def test_default_transports_fail_closed_instead_of_reporting_mock_delivery():
    email = get_email_sender()
    webhook = get_webhook_sender()
    assert not isinstance(email, MockEmailSender)
    assert not isinstance(webhook, MockWebhookSender)
    assert email.send_email(recipients=["ops@example.com"], subject="Health", body="Alert") is False
    assert webhook.send_webhook(url="https://hooks.example.com/alert", payload={"event": "test"}) is False


@pytest.mark.parametrize(
    "settings",
    [
        {"GDC_NOTIFICATION_SMTP_ENABLED": "yes"},
        {"GDC_NOTIFICATION_SMTP_ENABLED": "true", "GDC_NOTIFICATION_SMTP_HOST": "relay.example.com"},
        {"GDC_NOTIFICATION_SMTP_ENABLED": "true", "GDC_NOTIFICATION_SMTP_HOST": "relay.example.com", "GDC_NOTIFICATION_SMTP_FROM": "noreply@example.com", "GDC_NOTIFICATION_SMTP_TLS_MODE": "none"},
        {"GDC_NOTIFICATION_SMTP_ENABLED": "true", "GDC_NOTIFICATION_SMTP_HOST": "relay.example.com", "GDC_NOTIFICATION_SMTP_FROM": "noreply@example.com", "GDC_NOTIFICATION_SMTP_PORT": "0"},
        {"GDC_NOTIFICATION_SMTP_ENABLED": "true", "GDC_NOTIFICATION_SMTP_HOST": "relay.example.com", "GDC_NOTIFICATION_SMTP_FROM": "noreply@example.com", "GDC_NOTIFICATION_SMTP_USERNAME": "mailuser"},
    ],
)
def test_incomplete_or_insecure_mail_configuration_cannot_send(monkeypatch, settings):
    for key, val in settings.items():
        monkeypatch.setenv(key, val)
    reset_email_sender()
    assert get_email_sender().send_email(recipients=["ops@example.com"], subject="test", body="x") is False


class FakeSmtp:
    def __init__(self, *args, **kwargs):
        self.host = args[0]
        self.port = args[1]
        self.timeout = kwargs.get("timeout")
        self.context = kwargs.get("context")
        self.messages = []
        self.login_args = None
        self.ehlo_count = 0
        self.starttls_context = None
        self.refused = {}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def ehlo(self):
        self.ehlo_count += 1

    def starttls(self, *, context):
        self.starttls_context = context

    def login(self, user, password):
        self.login_args = (user, password)

    def send_message(self, message):
        self.messages.append(message)
        return self.refused


def _configure(monkeypatch, mode="implicit_tls"):
    monkeypatch.setenv("GDC_NOTIFICATION_SMTP_ENABLED", "true")
    monkeypatch.setenv("GDC_NOTIFICATION_SMTP_HOST", "relay.example.com")
    monkeypatch.setenv("GDC_NOTIFICATION_SMTP_FROM", "noreply@example.com")
    monkeypatch.setenv("GDC_NOTIFICATION_SMTP_TLS_MODE", mode)
    monkeypatch.setenv("GDC_NOTIFICATION_SMTP_USERNAME", "ops-relay")
    monkeypatch.setenv("GDC_NOTIFICATION_SMTP_PASSWORD", "not-a-real-secret")
    reset_email_sender()


@pytest.mark.parametrize("mode", ["implicit_tls", "starttls"])
def test_explicit_smtp_config_sends_only_over_verified_tls(monkeypatch, mode):
    sessions = []
    def factory(*args, **kwargs):
        session = FakeSmtp(*args, **kwargs)
        sessions.append(session)
        return session

    monkeypatch.setattr(smtplib, "SMTP_SSL", factory)
    monkeypatch.setattr(smtplib, "SMTP", factory)
    _configure(monkeypatch, mode)
    sender = get_email_sender()
    assert isinstance(sender, SmtpEmailSender)
    assert sender.send_email(recipients=["ops@example.com"], subject="Health", body="Payload") is True
    assert len(sessions) == 1
    session = sessions[0]
    assert session.host == "relay.example.com"
    tls = session.context or session.starttls_context
    assert isinstance(tls, ssl.SSLContext)
    assert tls.check_hostname is True
    assert tls.verify_mode == ssl.CERT_REQUIRED
    assert session.login_args == ("ops-relay", "not-a-real-secret")
    assert str(session.messages[0]["To"]) == "ops@example.com"
    assert session.messages[0].get_content().strip() == "Payload"
    if mode == "starttls":
        assert session.ehlo_count == 2
    else:
        assert session.ehlo_count == 0


def test_rejects_header_injection_and_invalid_recipient_before_opening_socket(monkeypatch):
    sockets = []
    monkeypatch.setattr(smtplib, "SMTP_SSL", lambda *a, **kw: sockets.append((a, kw)))
    _configure(monkeypatch)
    sender = get_email_sender()
    assert sender.send_email(recipients=["ops@example.com\r\nBcc: steal@example.net"], subject="Status", body="test") is False
    assert sender.send_email(recipients=["ops@example.com"], subject="Hello\nBcc: fake", body="test") is False
    assert sender.send_email(recipients=["badaddress"], subject="Status", body="test") is False
    assert sockets == []


def test_rejected_recipients_cannot_be_reported_as_accepted(monkeypatch):
    instance = FakeSmtp("relay.example.com", 465)
    instance.refused = {"ops@example.com": (550, b"reject")}
    monkeypatch.setattr(smtplib, "SMTP_SSL", lambda *args, **kwargs: instance)
    _configure(monkeypatch)
    assert get_email_sender().send_email(recipients=["ops@example.com"], subject="Test", body="Alert") is False


def test_webhook_transport_failure_logs_no_endpoint_secrets(monkeypatch, caplog):
    import httpx

    from app.governance_notifications.webhook_sender import HttpWebhookSender

    def failed_http(*_args, **_kwargs):
        raise httpx.ConnectError("https://hooks.example.com/secret-token-value")
    monkeypatch.setattr(httpx, "post", failed_http)
    with caplog.at_level(logging.WARNING):
        assert HttpWebhookSender().send_webhook(
            url="https://hooks.example.com/secret-token-value", payload={"event": "test"}
        ) is False
    assert "secret-token-value" not in caplog.text


def test_smtp_transport_errors_do_not_log_credentials(monkeypatch, caplog):
    def fail(*_args, **_kwargs):
        raise smtplib.SMTPException("password=not-a-real-secret")
    monkeypatch.setattr(smtplib, "SMTP_SSL", fail)
    _configure(monkeypatch)
    with caplog.at_level(logging.WARNING):
        assert get_email_sender().send_email(recipients=["ops@example.com"], subject="Test", body="Alert") is False
    assert "not-a-real-secret" not in caplog.text
