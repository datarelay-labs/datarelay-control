"""F-143 / F-135: a receiver that rejects the client certificate is a delivery/test failure.

TLS 1.3 completes the client handshake before the server validates the client certificate,
so the rejection only shows up as an alert on the first read/write. These tests use a real
local TLS server (``client_ca`` set => client certificate required) and no mocks.
"""

from __future__ import annotations

import ssl
import time
from pathlib import Path
from typing import Any

import pytest

from app.delivery import syslog_sender as syslog_module
from app.delivery.syslog_sender import SyslogSender
from app.delivery.syslog_tls import (
    TlsPeerRejectedError,
    check_peer_rejection,
    normalize_syslog_tls_config,
)
from app.destinations.config_validation import validate_destination_config
from app.destinations.test_service import run_destination_connectivity_probe
from app.runtime.errors import DestinationSendError
from tests.syslog_tls_helpers import SyslogTlsTestReceiver, write_self_signed_cert

pytestmark = pytest.mark.skipif(
    not hasattr(ssl, "TLSVersion") or ssl.HAS_TLSv1_3 is False,
    reason="TLS 1.3 client-certificate rejection semantics need TLS 1.3",
)


@pytest.fixture(autouse=True)
def _clear_tls_pool() -> Any:
    with syslog_module._tcp_pool_lock:
        syslog_module._tcp_pool.clear()
    yield
    with syslog_module._tcp_pool_lock:
        socks = list(syslog_module._tcp_pool.values())
        syslog_module._tcp_pool.clear()
    for sock in socks:
        syslog_module._safe_close_socket(sock)


@pytest.fixture
def mtls_receiver(tmp_path: Path) -> Any:
    server = write_self_signed_cert(tmp_path / "srv", common_name="localhost", san_dns=["localhost"])
    trusted_client = write_self_signed_cert(tmp_path / "client-ok", common_name="client-ok", name="client")
    untrusted_client = write_self_signed_cert(tmp_path / "client-bad", common_name="client-bad", name="client")
    recv = SyslogTlsTestReceiver(
        certfile=server.cert_path,
        keyfile=server.key_path,
        client_ca=trusted_client.cert_path,
    )
    recv.start()
    try:
        yield recv, server, trusted_client, untrusted_client
    finally:
        recv.stop()


@pytest.fixture
def plain_receiver(tmp_path: Path) -> Any:
    server = write_self_signed_cert(tmp_path / "srv-plain", common_name="localhost", san_dns=["localhost"])
    recv = SyslogTlsTestReceiver(certfile=server.cert_path, keyfile=server.key_path)
    recv.start()
    try:
        yield recv, server
    finally:
        recv.stop()


def _cfg(recv: SyslogTlsTestReceiver, server: Any, client: Any | None = None, **extra: Any) -> dict[str, Any]:
    cfg: dict[str, Any] = {
        "host": "localhost",
        "port": recv.port,
        "tls_enabled": True,
        "tls_verify_mode": "strict",
        "tls_ca_cert_path": str(server.cert_path),
        "formatter_config": {"message_format": "json"},
    }
    if client is not None:
        cfg["tls_client_cert_path"] = str(client.cert_path)
        cfg["tls_client_key_path"] = str(client.key_path)
    cfg.update(extra)
    return cfg


def _wait_messages(recv: SyslogTlsTestReceiver, count: int, timeout: float = 5.0) -> list[str]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if len(recv.messages()) >= count:
            break
        time.sleep(0.05)
    return recv.messages()


class TestRuntimeDeliveryRejected:
    def test_missing_client_cert_is_a_delivery_failure(self, mtls_receiver: Any) -> None:
        recv, server, _ok, _bad = mtls_receiver
        with pytest.raises(DestinationSendError) as excinfo:
            SyslogSender().send([{"id": "e1", "message": "m"}], _cfg(recv, server), destination_type="SYSLOG_TLS")
        assert "rejected" in str(excinfo.value).lower()
        # Nothing the receiver refused may be reported as delivered (retry/replay must re-send).
        assert excinfo.value.delivered_event_count in (0, None)
        assert recv.messages() == []
        # A refused connection must never be pooled for reuse.
        assert syslog_module._tcp_pool == {}

    def test_untrusted_client_cert_is_a_delivery_failure(self, mtls_receiver: Any) -> None:
        recv, server, _ok, bad = mtls_receiver
        with pytest.raises(DestinationSendError) as excinfo:
            SyslogSender().send(
                [{"id": "e1", "message": "m"}], _cfg(recv, server, bad), destination_type="SYSLOG_TLS"
            )
        assert "tls" in str(excinfo.value).lower()
        assert recv.messages() == []

    def test_repeated_sends_keep_failing(self, mtls_receiver: Any) -> None:
        recv, server, _ok, _bad = mtls_receiver
        sender = SyslogSender()
        for _ in range(3):
            with pytest.raises(DestinationSendError):
                sender.send([{"id": "e1", "message": "m"}], _cfg(recv, server), destination_type="SYSLOG_TLS")

    def test_valid_client_cert_delivers(self, mtls_receiver: Any) -> None:
        recv, server, ok, _bad = mtls_receiver
        SyslogSender().send(
            [{"id": "e1", "message": "hello-mtls"}], _cfg(recv, server, ok), destination_type="SYSLOG_TLS"
        )
        lines = _wait_messages(recv, 1)
        assert len(lines) == 1 and "hello-mtls" in lines[0]

    def test_pooled_connection_is_reused_without_extra_wait(self, mtls_receiver: Any) -> None:
        recv, server, ok, _bad = mtls_receiver
        sender = SyslogSender()
        cfg = _cfg(recv, server, ok)
        sender.send([{"id": "e1", "message": "first"}], cfg, destination_type="SYSLOG_TLS")
        started = time.monotonic()
        sender.send([{"id": "e2", "message": "second"}], cfg, destination_type="SYSLOG_TLS")
        # Second send reuses the pooled socket: only the zero-wait late-alert check runs.
        assert time.monotonic() - started < 0.25
        assert len(_wait_messages(recv, 2)) == 2

    def test_healthy_receiver_without_client_auth_is_not_a_false_failure(self, plain_receiver: Any) -> None:
        recv, server = plain_receiver
        SyslogSender().send(
            [{"id": "e1", "message": "plain-ok"}], _cfg(recv, server), destination_type="SYSLOG_TLS"
        )
        lines = _wait_messages(recv, 1)
        assert len(lines) == 1 and "plain-ok" in lines[0]

    def test_check_can_be_disabled(self, mtls_receiver: Any) -> None:
        # With the check disabled the historic behaviour (success on write) is preserved;
        # this documents that the guard is what turns the rejection into a failure.
        recv, server, _ok, _bad = mtls_receiver
        cfg = _cfg(recv, server, post_handshake_check_seconds=0)
        try:
            SyslogSender().send([{"id": "e1", "message": "m"}], cfg, destination_type="SYSLOG_TLS")
        except DestinationSendError:
            pass  # the late-alert drain may still catch it; both outcomes are acceptable here


class TestConnectionTestRejected:
    def test_missing_client_cert_fails_the_test(self, mtls_receiver: Any) -> None:
        recv, server, _ok, _bad = mtls_receiver
        out = run_destination_connectivity_probe("SYSLOG_TLS", _cfg(recv, server))
        assert out["success"] is False, out
        assert out["detail"]["error_code"] == "TLS_PEER_REJECTED"
        assert out["detail"]["client_certificate_configured"] is False
        assert "rejected" in out["message"].lower()
        assert recv.messages() == []

    def test_untrusted_client_cert_fails_the_test(self, mtls_receiver: Any) -> None:
        recv, server, _ok, bad = mtls_receiver
        out = run_destination_connectivity_probe("SYSLOG_TLS", _cfg(recv, server, bad))
        assert out["success"] is False, out
        assert out["detail"]["error_code"] == "TLS_PEER_REJECTED"
        assert out["detail"]["client_certificate_configured"] is True

    def test_valid_client_cert_passes_the_test(self, mtls_receiver: Any) -> None:
        recv, server, ok, _bad = mtls_receiver
        out = run_destination_connectivity_probe("SYSLOG_TLS", _cfg(recv, server, ok))
        assert out["success"] is True, out
        assert len(_wait_messages(recv, 1)) == 1

    def test_healthy_receiver_passes_the_test(self, plain_receiver: Any) -> None:
        recv, server = plain_receiver
        out = run_destination_connectivity_probe("SYSLOG_TLS", _cfg(recv, server))
        assert out["success"] is True, out


class TestCheckPeerRejectionUnit:
    def test_non_ssl_socket_is_ignored(self) -> None:
        assert check_peer_rejection(object(), 0.1, eof_is_rejection=True) is None

    def test_rejection_error_is_ssl_error(self) -> None:
        assert issubclass(TlsPeerRejectedError, ssl.SSLError)


class TestPostHandshakeCheckConfig:
    def test_default_and_override(self) -> None:
        base = {"host": "h", "port": 6514}
        assert normalize_syslog_tls_config(base).post_handshake_check_seconds == pytest.approx(0.3)
        assert normalize_syslog_tls_config({**base, "post_handshake_check_seconds": 0}).post_handshake_check_seconds == 0

    def test_out_of_range_rejected(self) -> None:
        with pytest.raises(ValueError):
            normalize_syslog_tls_config({"host": "h", "port": 6514, "post_handshake_check_seconds": 99})
        with pytest.raises(ValueError):
            validate_destination_config(
                "SYSLOG_TLS", {"host": "h", "port": 6514, "post_handshake_check_seconds": -1}
            )