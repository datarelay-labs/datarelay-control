"""Syslog mid-batch progress: ``DestinationSendError.delivered_event_count`` (R2b).

Syslog writes one payload per event. Before this change a failure part-way through a
batch reported no delivered prefix, so the runner re-sent the whole batch to the Route on
the next poll (duplicates of the events already written). All sockets are fakes; no
network is used.
"""

from __future__ import annotations

import errno
import ssl
import uuid
from typing import Any

import pytest

from app.delivery import syslog_sender as syslog_module
from app.delivery.syslog_sender import SyslogSender
from app.runtime.errors import DestinationSendError


class _FailingStreamSock:
    """TCP/TLS stand-in: ``sendall`` raises on the N-th call (1-based)."""

    def __init__(self, fail_on_call: int, exc: Exception | None = None) -> None:
        self.fail_on_call = fail_on_call
        self.exc = exc or BrokenPipeError(errno.EPIPE, "Broken pipe")
        self.calls = 0
        self.written: list[bytes] = []

    def settimeout(self, _timeout: float) -> None:
        pass

    def sendall(self, data: bytes) -> None:
        self.calls += 1
        if self.calls == self.fail_on_call:
            raise self.exc
        self.written.append(data)

    def close(self) -> None:
        pass


def _events(count: int) -> list[dict[str, Any]]:
    return [{"id": f"e{idx}", "message": f"m{idx}"} for idx in range(count)]


def _tcp_config() -> dict[str, Any]:
    # Unique host per test: the module keeps a process-wide TCP socket pool.
    return {"host": f"tcp-{uuid.uuid4().hex[:8]}.invalid", "port": 5514, "formatter_config": {"message_format": "json"}}


def _tls_config(**formatter: Any) -> dict[str, Any]:
    return {
        "host": f"tls-{uuid.uuid4().hex[:8]}.invalid",
        "port": 6514,
        "tls_enabled": True,
        "tls_verify_mode": "insecure_skip_verify",
        "formatter_config": {"message_format": "json", **formatter},
    }


@pytest.fixture
def tcp_sock(monkeypatch: pytest.MonkeyPatch) -> dict[str, _FailingStreamSock]:
    holder: dict[str, _FailingStreamSock] = {}
    monkeypatch.setattr(
        "app.delivery.syslog_sender.socket.create_connection",
        lambda _addr, timeout=None: holder["sock"],
    )
    return holder


@pytest.fixture
def tls_sock(monkeypatch: pytest.MonkeyPatch) -> dict[str, _FailingStreamSock]:
    holder: dict[str, _FailingStreamSock] = {}
    monkeypatch.setattr("app.delivery.syslog_sender.build_syslog_tls_context", lambda _cfg: object())
    monkeypatch.setattr("app.delivery.syslog_sender._borrow_tls_socket", lambda **_kw: holder["sock"])
    return holder


def test_tcp_failure_mid_batch_reports_events_written_before_failure(tcp_sock: dict[str, Any]) -> None:
    """Old code: ``delivered_event_count`` was None (whole batch retried)."""

    tcp_sock["sock"] = _FailingStreamSock(fail_on_call=3)
    with pytest.raises(DestinationSendError) as err:
        SyslogSender().send(_events(5), _tcp_config(), destination_type="SYSLOG_TCP")

    assert err.value.delivered_event_count == 2
    assert len(tcp_sock["sock"].written) == 2


def test_tcp_failure_on_first_payload_reports_zero(tcp_sock: dict[str, Any]) -> None:
    """Old code: ``delivered_event_count`` was None instead of an explicit 0."""

    tcp_sock["sock"] = _FailingStreamSock(fail_on_call=1)
    with pytest.raises(DestinationSendError) as err:
        SyslogSender().send(_events(3), _tcp_config(), destination_type="SYSLOG_TCP")

    assert err.value.delivered_event_count == 0


def test_tcp_connect_failure_reports_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    """Old code: ``delivered_event_count`` was None instead of an explicit 0."""

    def _refuse(_addr: Any, timeout: Any = None) -> Any:
        raise ConnectionRefusedError(errno.ECONNREFUSED, "Connection refused")

    monkeypatch.setattr("app.delivery.syslog_sender.socket.create_connection", _refuse)
    with pytest.raises(DestinationSendError) as err:
        SyslogSender().send(_events(3), _tcp_config(), destination_type="SYSLOG_TCP")

    assert err.value.delivered_event_count == 0


def test_tcp_blank_lines_are_mapped_back_to_their_events(
    tcp_sock: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Blank lines are not written, so payload N is not event N; count whole events only.

    Old code: ``delivered_event_count`` was None.
    """

    monkeypatch.setattr(
        syslog_module,
        "format_delivery_lines_syslog",
        lambda events, *_a, **_kw: ["line-0", "   ", "line-2", "line-3"],
    )
    # Payloads: [line-0 (event 0), line-2 (event 2), line-3 (event 3)]; the third write fails.
    tcp_sock["sock"] = _FailingStreamSock(fail_on_call=3)
    with pytest.raises(DestinationSendError) as err:
        SyslogSender().send(_events(4), _tcp_config(), destination_type="SYSLOG_TCP")

    # Events 0..2 had all their payloads written (event 1 has none); event 3 did not.
    assert err.value.delivered_event_count == 3


def test_tcp_unknown_line_to_event_mapping_leaves_count_unset(
    tcp_sock: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    """When lines are not 1:1 with events the prefix cannot be derived: stays None (guard)."""

    monkeypatch.setattr(
        syslog_module,
        "format_delivery_lines_syslog",
        lambda events, *_a, **_kw: ["a", "b", "c", "d", "e"],
    )
    tcp_sock["sock"] = _FailingStreamSock(fail_on_call=3)
    with pytest.raises(DestinationSendError) as err:
        SyslogSender().send(_events(2), _tcp_config(), destination_type="SYSLOG_TCP")

    assert err.value.delivered_event_count is None


def test_tls_legacy_failure_mid_batch_reports_events_written_before_failure(tls_sock: dict[str, Any]) -> None:
    """Old code: ``delivered_event_count`` was None (whole batch retried)."""

    tls_sock["sock"] = _FailingStreamSock(fail_on_call=4, exc=ssl.SSLError("bad record mac"))
    with pytest.raises(DestinationSendError) as err:
        SyslogSender().send(_events(6), _tls_config(), destination_type="SYSLOG_TLS")

    assert err.value.delivered_event_count == 3


def test_tls_rfc5425_failure_mid_batch_reports_events_written_before_failure(tls_sock: dict[str, Any]) -> None:
    """RFC 5425 writes one octet-counted frame per event. Old code: None."""

    tls_sock["sock"] = _FailingStreamSock(fail_on_call=2, exc=ConnectionResetError(errno.ECONNRESET, "reset"))
    with pytest.raises(DestinationSendError) as err:
        SyslogSender().send(
            _events(3),
            _tls_config(
                syslog_wire_mode="rfc5425",
                facility="local0",
                severity="info",
                hostname="gdc-test",
                app_name="datarelay",
                tag="event",
            ),
            destination_type="SYSLOG_TLS",
        )

    assert err.value.delivered_event_count == 1


def test_tls_context_error_leaves_count_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    """Nothing was attempted on the wire: unchanged (None) behavior (guard)."""

    def _boom(_cfg: Any) -> Any:
        raise ssl.SSLError("bad context")

    monkeypatch.setattr("app.delivery.syslog_sender.build_syslog_tls_context", _boom)
    with pytest.raises(DestinationSendError) as err:
        SyslogSender().send(_events(2), _tls_config(), destination_type="SYSLOG_TLS")

    assert err.value.delivered_event_count is None


def test_udp_failure_never_reports_a_delivered_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    """UDP has no acknowledgment and ICMP errors refer to earlier datagrams (guard).

    A refused send() on datagram 3 means one of datagrams 1-2 was rejected, so claiming
    them as delivered would drop events. The count must stay unknown (None).
    """

    class _UdpSock:
        def __init__(self) -> None:
            self.calls = 0

        def __enter__(self) -> "_UdpSock":
            return self

        def __exit__(self, *args: object) -> bool:
            return False

        def settimeout(self, _t: float) -> None:
            pass

        def connect(self, _addr: Any) -> None:
            pass

        def send(self, data: bytes) -> int:
            self.calls += 1
            if self.calls == 3:
                raise ConnectionRefusedError(errno.ECONNREFUSED, "Connection refused")
            return len(data)

        def getsockopt(self, _level: int, _opt: int) -> int:
            return 0

    monkeypatch.setattr("app.delivery.syslog_sender.socket.socket", lambda *_a, **_k: _UdpSock())
    with pytest.raises(DestinationSendError) as err:
        SyslogSender().send(_events(4), _tcp_config(), destination_type="SYSLOG_UDP")

    assert err.value.delivered_event_count is None


# --- runner consumes the syslog prefix through the existing mechanism ------------------


def test_runner_send_route_events_uses_syslog_prefix(tcp_sock: dict[str, Any]) -> None:
    """``_send_route_events`` exposes the syslog prefix as ``RouteSendOutcome.delivered_event_count``.

    Old code: 0 (the sender reported None), so ``_deliver_single_route`` recorded nothing
    and the next poll re-sent e0, e1 to this Route.
    """

    from app.runners.stream_runner import StreamRunner

    class _AllowAll:
        def allow(self, *_a: Any, **_k: Any) -> bool:
            return True

    tcp_sock["sock"] = _FailingStreamSock(fail_on_call=3)
    runner = StreamRunner(destination_limiter=_AllowAll())  # type: ignore[arg-type]
    runner._run_id = "syslog-partial"
    route = {
        "id": 1,
        "enabled": True,
        "failure_policy": "LOG_AND_CONTINUE",
        "formatter_config_json": {},
        "rate_limit_json": {},
        "destination": {
            "id": None,
            "enabled": True,
            "destination_type": "SYSLOG_TCP",
            "config": _tcp_config(),
            "rate_limit_json": {},
        },
    }
    stream = {"id": 1, "name": "s", "routes": [route]}

    outcome = runner._send_route_events(stream, route, _events(4))

    assert outcome.success is False
    assert outcome.failure_absorbed is True
    assert outcome.delivered_event_count == 2
