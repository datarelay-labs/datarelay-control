"""Helpers for SYSLOG_TLS tests: self-signed cert generation + TLS test receiver.

These helpers are local-only test scaffolding (no production code path). Certificates
are generated in-memory using ``cryptography`` and written to a tmp directory the
caller controls. The receiver is the same shape as :class:`SyslogTcpTestReceiver`
but wraps the accept loop with TLS.
"""

from __future__ import annotations

import datetime
import socket
import ssl
import threading
from dataclasses import dataclass
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


@dataclass(frozen=True)
class IssuedCert:
    cert_path: Path
    key_path: Path
    ca_path: Path | None  # for self-signed, equals cert_path; preserved for clarity


def _make_self_signed(
    common_name: str,
    *,
    not_before: datetime.datetime,
    not_after: datetime.datetime,
    san_dns: list[str] | None = None,
    key_size: int = 2048,
) -> tuple[bytes, bytes]:
    """Return (cert_pem, key_pem) for a self-signed RSA certificate."""

    key = rsa.generate_private_key(public_exponent=65537, key_size=key_size)
    subject = issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])
    builder = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(not_before)
        .not_valid_after(not_after)
    )
    if san_dns:
        builder = builder.add_extension(
            x509.SubjectAlternativeName([x509.DNSName(name) for name in san_dns]),
            critical=False,
        )
    cert = builder.sign(private_key=key, algorithm=hashes.SHA256())
    cert_pem = cert.public_bytes(serialization.Encoding.PEM)
    key_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return cert_pem, key_pem


def write_self_signed_cert(
    out_dir: Path,
    *,
    common_name: str = "localhost",
    san_dns: list[str] | None = None,
    valid: bool = True,
    expired: bool = False,
    name: str = "server",
) -> IssuedCert:
    """Generate a self-signed certificate suitable for the syslog TLS receiver."""

    out_dir.mkdir(parents=True, exist_ok=True)
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    if expired:
        not_before = now - datetime.timedelta(days=30)
        not_after = now - datetime.timedelta(days=1)
    elif not valid:
        not_before = now + datetime.timedelta(days=1)
        not_after = now + datetime.timedelta(days=2)
    else:
        not_before = now - datetime.timedelta(minutes=5)
        not_after = now + datetime.timedelta(days=1)

    cert_pem, key_pem = _make_self_signed(
        common_name=common_name,
        not_before=not_before,
        not_after=not_after,
        san_dns=san_dns or [common_name],
    )
    cert_path = out_dir / f"{name}.crt"
    key_path = out_dir / f"{name}.key"
    cert_path.write_bytes(cert_pem)
    key_path.write_bytes(key_pem)
    return IssuedCert(cert_path=cert_path, key_path=key_path, ca_path=cert_path)


class SyslogTlsTestReceiver:
    """TCP+TLS syslog listener with newline-delimited message capture.

    Mirrors :class:`SyslogTcpTestReceiver` but wraps the accept loop with TLS using
    a server certificate the caller provides. Used only by tests; never imported by
    runtime code.
    """

    def __init__(
        self,
        *,
        certfile: str | Path,
        keyfile: str | Path,
        host: str = "127.0.0.1",
        port: int = 0,
        client_ca: str | Path | None = None,
    ) -> None:
        self._host = host
        self._requested_port = int(port)
        # When set, the receiver requires a client certificate signed by/pinned to this CA
        # (mutual TLS). With TLS 1.3 the client only learns about a rejection from an alert
        # that arrives after its own handshake call has already returned.
        self._client_ca = str(client_ca) if client_ca else None
        self._certfile = str(certfile)
        self._keyfile = str(keyfile)
        self._server_sock: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._messages: list[str] = []
        self._handshake_errors: list[str] = []

    @property
    def host(self) -> str:
        return self._host

    @property
    def port(self) -> int:
        if self._server_sock is None:
            raise RuntimeError("receiver not started")
        return int(self._server_sock.getsockname()[1])

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()

        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=self._certfile, keyfile=self._keyfile)
        if self._client_ca:
            ctx.verify_mode = ssl.CERT_REQUIRED
            ctx.load_verify_locations(cafile=self._client_ca)

        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind((self._host, self._requested_port))
        srv.listen(8)
        srv.settimeout(0.35)
        self._server_sock = srv

        def _handle_client(raw: socket.socket) -> None:
            try:
                tls_conn = ctx.wrap_socket(raw, server_side=True)
            except (ssl.SSLError, OSError) as exc:
                with self._lock:
                    self._handshake_errors.append(str(exc))
                try:
                    raw.close()
                except OSError:
                    pass
                return
            buf = b""
            try:
                tls_conn.settimeout(1.0)
                while True:
                    try:
                        chunk = tls_conn.recv(65536)
                    except TimeoutError:
                        if self._stop.is_set():
                            break
                        continue
                    except ssl.SSLError:
                        break
                    if not chunk:
                        break
                    buf += chunk
                    while b"\n" in buf:
                        raw_line, buf = buf.split(b"\n", 1)
                        line = raw_line.decode("utf-8", errors="replace")
                        with self._lock:
                            self._messages.append(line)
            finally:
                try:
                    tls_conn.close()
                except OSError:
                    pass

        def _run() -> None:
            assert self._server_sock is not None
            while not self._stop.is_set():
                try:
                    client, _addr = self._server_sock.accept()
                except TimeoutError:
                    continue
                except OSError:
                    break
                _handle_client(client)

        self._thread = threading.Thread(target=_run, name="syslog-tls-test-recv", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._server_sock is not None:
            try:
                self._server_sock.close()
            except OSError:
                pass
            self._server_sock = None
        if self._thread is not None:
            self._thread.join(timeout=5.0)
            self._thread = None

    def messages(self) -> list[str]:
        with self._lock:
            return list(self._messages)

    def handshake_errors(self) -> list[str]:
        with self._lock:
            return list(self._handshake_errors)

    def clear(self) -> None:
        with self._lock:
            self._messages.clear()
            self._handshake_errors.clear()
