"""Regression: compose syslog sinks must support pooled multi-frame connections."""

from __future__ import annotations

import importlib.util
import socket
import threading
import time
from pathlib import Path


def _load(name: str, relative: str):
    path = Path(__file__).resolve().parents[1] / relative
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _prove_connection_stays_open(drain) -> None:
    server, client = socket.socketpair()
    thread = threading.Thread(target=drain, args=(server, ("local", 0)), daemon=True)
    thread.start()
    try:
        client.sendall(b"first\n")
        time.sleep(0.05)
        assert thread.is_alive(), "fixture closed the pooled connection after the first frame"
        client.sendall(b"second\n")
        client.shutdown(socket.SHUT_WR)
        thread.join(timeout=1.0)
        assert not thread.is_alive(), "fixture did not finish after client EOF"
    finally:
        client.close()
        server.close()


def test_plain_tcp_fixture_keeps_pooled_connection_open() -> None:
    module = _load("gdc_syslog_tcp_fixture", "docker/syslog-test/tcp_udp_echo.py")
    _prove_connection_stays_open(module._drain_tcp_connection)


def test_tls_fixture_keeps_pooled_connection_open() -> None:
    module = _load("gdc_syslog_tls_fixture", "docker/syslog-test/tls_tcp_echo.py")
    _prove_connection_stays_open(module._drain_tls_connection)
