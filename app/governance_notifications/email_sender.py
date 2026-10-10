"""Product-owned SMTP transport for Governance notifications (PF-11 / M20.2).

Default is unavailable, not an in-memory sender pretending to deliver.
Real network dispatch is possible only after an operator deliberately opts in
via server-side environment configuration and a later authorized deployment.
A successful return means SMTP relay acceptance, NOT inbox delivery.
"""
from __future__ import annotations

import logging
import os
import smtplib
import ssl
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import parseaddr
from typing import Mapping, Protocol

logger = logging.getLogger(__name__)


class EmailSender(Protocol):
    def send_email(self, *, recipients: list[str], subject: str, body: str) -> bool:
        """Return True only after the configured mail relay accepts the message."""


class UnavailableEmailSender:
    """Explicit fail-closed fallback for unconfigured real SMTP transport."""

    def send_email(self, *, recipients: list[str], subject: str, body: str) -> bool:
        return False


@dataclass(frozen=True)
class SmtpSettings:
    host: str
    port: int
    from_address: str
    tls_mode: str
    timeout_seconds: float
    username: str | None = None
    password: str | None = None


def _is_mailbox(value: str) -> bool:
    if not value or any(ord(ch) < 33 or ord(ch) == 127 for ch in value):
        return False
    name, address = parseaddr(value)
    if name or address != value or address.count("@") != 1:
        return False
    local, domain = address.rsplit("@", 1)
    return bool(local and domain and "." in domain and not domain.startswith(".") and not domain.endswith("."))


def _load_settings(environ: Mapping[str, str]) -> SmtpSettings | None:
    if environ.get("GDC_NOTIFICATION_SMTP_ENABLED", "").strip().lower() != "true":
        return None

    prefix = "GDC_NOTIFICATION_SMTP_"
    host = environ.get(prefix + "HOST", "").strip()
    from_address = environ.get(prefix + "FROM", "").strip()
    tls_mode = environ.get(prefix + "TLS_MODE", "implicit_tls").strip().lower()
    username = environ.get(prefix + "USERNAME", "").strip() or None
    password = environ.get(prefix + "PASSWORD", "") or None

    if (
        not host or any(ch in host for ch in "\r\n\t /@?#")
        or not _is_mailbox(from_address)
        or tls_mode not in {"implicit_tls", "starttls"}
        or bool(username) != bool(password)
    ):
        raise ValueError("Invalid SMTP settings")
    try:
        port = int(environ.get(prefix + "PORT", "465" if tls_mode == "implicit_tls" else "587"))
        timeout_seconds = float(environ.get(prefix + "TIMEOUT_SECONDS", "10"))
    except (TypeError, ValueError) as exc:
        raise ValueError("Invalid SMTP settings") from exc
    if not 1 <= port <= 65535 or not 1 <= timeout_seconds <= 30:
        raise ValueError("Invalid SMTP port or timeout")
    return SmtpSettings(host, port, from_address, tls_mode, timeout_seconds, username, password)


class SmtpEmailSender:
    """Strict verified-TLS SMTP only; no insecure/plaintext downgrade."""

    def __init__(self, settings: SmtpSettings) -> None:
        self.settings = settings

    def send_email(self, *, recipients: list[str], subject: str, body: str) -> bool:
        if not recipients or len(recipients) > 100 or any(not _is_mailbox(value) for value in recipients):
            return False
        if not subject or any(char in subject for char in "\r\n\x00"):
            return False
        if any(char in body for char in "\x00"):
            return False
        message = EmailMessage()
        message["From"] = self.settings.from_address
        message["To"] = ", ".join(recipients)
        message["Subject"] = subject
        message.set_content(body)
        tls_context = ssl.create_default_context()
        try:
            if self.settings.tls_mode == "implicit_tls":
                session = smtplib.SMTP_SSL(
                    self.settings.host, self.settings.port,
                    timeout=self.settings.timeout_seconds, context=tls_context,
                )
            else:
                session = smtplib.SMTP(
                    self.settings.host, self.settings.port, timeout=self.settings.timeout_seconds,
                )
            with session as smtp:
                if self.settings.tls_mode == "starttls":
                    smtp.ehlo()
                    smtp.starttls(context=tls_context)
                    smtp.ehlo()
                if self.settings.username is not None:
                    smtp.login(self.settings.username, self.settings.password)
                # Nonempty refusal map means not every intended recipient was accepted.
                return not bool(smtp.send_message(message))
        except (smtplib.SMTPException, OSError, ValueError) as exc:
            # Server errors can echo credentials/recipient addresses. Log type only.
            logger.warning("governance_smtp_delivery_failed reason=%s", type(exc).__name__)
            return False


class MockEmailSender:
    """In-memory test double only; never the default runtime mail sender."""

    def __init__(self) -> None:
        self.sent: list[dict[str, object]] = []
        self.should_fail = False

    def send_email(self, *, recipients: list[str], subject: str, body: str) -> bool:
        if self.should_fail:
            return False
        self.sent.append({"recipients": list(recipients), "subject": subject, "body": body})
        return True


def _configured_sender() -> EmailSender:
    try:
        settings = _load_settings(os.environ)
    except ValueError:
        # Fail closed and do not log env values (they may contain a secret).
        logger.warning("governance_smtp_unavailable invalid_configuration")
        return UnavailableEmailSender()
    return SmtpEmailSender(settings) if settings is not None else UnavailableEmailSender()


_default_email_sender: EmailSender = _configured_sender()


def get_email_sender() -> EmailSender:
    return _default_email_sender


def set_email_sender(sender: EmailSender) -> None:
    global _default_email_sender
    _default_email_sender = sender


def reset_email_sender() -> None:
    global _default_email_sender
    _default_email_sender = _configured_sender()
