"""Shared TLS context construction for SYSLOG_TLS sender + connectivity probe.

This module never opens connections by itself; it only normalizes destination
config keys into a configured ``ssl.SSLContext`` and a small dataclass with the
non-secret resolved fields used by the runtime sender and the probe. Sender
and probe both rely on this helper so verification semantics stay identical.
"""

from __future__ import annotations

import select
import ssl
import time
from dataclasses import dataclass
from typing import Any

DEFAULT_VERIFY_MODE = "strict"
DEFAULT_CONNECT_TIMEOUT = 5.0
DEFAULT_WRITE_TIMEOUT = 5.0
# TLS 1.3 completes the client-side handshake before the server has validated the client
# certificate; a rejection only arrives as an alert on the first read/write. After a fresh
# handshake we therefore listen for this long before trusting the connection.
DEFAULT_POST_HANDSHAKE_CHECK_SECONDS = 0.3
MAX_POST_HANDSHAKE_CHECK_SECONDS = 10.0


@dataclass(frozen=True)
class SyslogTlsConfig:
    host: str
    port: int
    verify_mode: str
    server_name: str
    connect_timeout: float
    write_timeout: float
    ca_cert_path: str | None
    client_cert_path: str | None
    client_key_path: str | None
    post_handshake_check_seconds: float = DEFAULT_POST_HANDSHAKE_CHECK_SECONDS


class TlsPeerRejectedError(ssl.SSLError):
    """The receiver completed the TLS handshake but then rejected the connection.

    Typical cause: TLS 1.3 receiver requires a client certificate that was missing or
    untrusted. The alert is only visible on the first read after the handshake.
    """


def normalize_syslog_tls_config(config: dict[str, Any]) -> SyslogTlsConfig:
    """Convert ``destinations.config_json`` into a normalized TLS config dataclass."""

    host = str(config.get("host", "")).strip()
    if not host:
        raise ValueError("SYSLOG_TLS destination requires host")

    port_raw = config.get("port")
    try:
        port = int(port_raw)
    except (TypeError, ValueError) as exc:
        raise ValueError("SYSLOG_TLS destination requires numeric port") from exc

    raw_mode = config.get("tls_verify_mode") or DEFAULT_VERIFY_MODE
    verify_mode = str(raw_mode).strip().lower() or DEFAULT_VERIFY_MODE
    if verify_mode not in ("strict", "insecure_skip_verify"):
        raise ValueError(f"Unsupported tls_verify_mode: {raw_mode!r}")

    server_name = str(config.get("tls_server_name") or host).strip() or host

    def _coerce_timeout(value: Any, default: float) -> float:
        if value is None:
            return default
        try:
            out = float(value)
        except (TypeError, ValueError) as exc:
            raise ValueError("TLS timeout values must be numeric") from exc
        if out <= 0:
            raise ValueError("TLS timeout values must be positive")
        return out

    connect_timeout = _coerce_timeout(config.get("connect_timeout"), DEFAULT_CONNECT_TIMEOUT)
    write_timeout = _coerce_timeout(config.get("write_timeout"), DEFAULT_WRITE_TIMEOUT)

    check_raw = config.get("post_handshake_check_seconds")
    if check_raw is None:
        post_handshake_check = DEFAULT_POST_HANDSHAKE_CHECK_SECONDS
    else:
        try:
            post_handshake_check = float(check_raw)
        except (TypeError, ValueError) as exc:
            raise ValueError("post_handshake_check_seconds must be numeric") from exc
        if post_handshake_check < 0 or post_handshake_check > MAX_POST_HANDSHAKE_CHECK_SECONDS:
            raise ValueError(
                f"post_handshake_check_seconds must be between 0 and {MAX_POST_HANDSHAKE_CHECK_SECONDS:g}"
            )

    ca_cert_path = config.get("tls_ca_cert_path") or None
    client_cert_path = config.get("tls_client_cert_path") or None
    client_key_path = config.get("tls_client_key_path") or None

    return SyslogTlsConfig(
        host=host,
        port=port,
        verify_mode=verify_mode,
        server_name=server_name,
        connect_timeout=connect_timeout,
        write_timeout=write_timeout,
        ca_cert_path=str(ca_cert_path) if ca_cert_path else None,
        client_cert_path=str(client_cert_path) if client_cert_path else None,
        client_key_path=str(client_key_path) if client_key_path else None,
        post_handshake_check_seconds=post_handshake_check,
    )


def build_syslog_tls_context(cfg: SyslogTlsConfig) -> ssl.SSLContext:
    """Build an ``ssl.SSLContext`` honoring verify mode + optional CA/client cert."""

    if cfg.verify_mode == "insecure_skip_verify":
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    else:
        ctx = ssl.create_default_context(cafile=cfg.ca_cert_path) if cfg.ca_cert_path else ssl.create_default_context()
        ctx.check_hostname = True
        ctx.verify_mode = ssl.CERT_REQUIRED

    if cfg.client_cert_path and cfg.client_key_path:
        ctx.load_cert_chain(certfile=cfg.client_cert_path, keyfile=cfg.client_key_path)

    return ctx


def check_peer_rejection(
    tls_sock: Any,
    window_seconds: float,
    *,
    eof_is_rejection: bool,
) -> BaseException | None:
    """Detect a post-handshake rejection by the receiver.

    A syslog receiver never sends application data, so any fatal alert, reset or (when
    ``eof_is_rejection``) orderly close seen within ``window_seconds`` means the receiver
    refused this connection even though ``wrap_socket`` succeeded. TLS 1.3 session tickets
    are consumed internally by ``recv`` (``SSLWantReadError``) and are not a rejection.

    Returns the exception describing the rejection, or ``None`` for a healthy connection.
    Only real :class:`ssl.SSLSocket` objects are inspected (fakes are always healthy).
    """

    if not isinstance(tls_sock, ssl.SSLSocket):
        return None
    previous_timeout = tls_sock.gettimeout()
    deadline = time.monotonic() + max(0.0, window_seconds)
    try:
        tls_sock.settimeout(0.0)
        while True:
            remaining = max(0.0, deadline - time.monotonic())
            try:
                readable, _, _ = select.select([tls_sock], [], [], remaining)
            except (OSError, ValueError) as exc:
                return exc
            if not readable and not tls_sock.pending():
                return None
            try:
                data = tls_sock.recv(4096)
            except (ssl.SSLWantReadError, ssl.SSLWantWriteError, BlockingIOError):
                if remaining <= 0.0:
                    return None
                continue
            except ssl.SSLError as exc:
                return TlsPeerRejectedError(
                    f"receiver rejected the connection after the TLS handshake "
                    f"(a client certificate may be required or untrusted): {exc}"
                )
            except OSError as exc:
                return exc
            if data == b"":
                if eof_is_rejection:
                    return TlsPeerRejectedError(
                        "receiver closed the connection right after the TLS handshake "
                        "(a client certificate may be required or untrusted)"
                    )
                return None
            # Unsolicited application data from a syslog receiver is ignored.
            if remaining <= 0.0:
                return None
    finally:
        try:
            tls_sock.settimeout(previous_timeout)
        except OSError:
            pass
