#!/usr/bin/env python3
"""Minimal TCP/UDP sink for compose isolation (development only; not RFC5424 validation)."""

from __future__ import annotations

import socket
import threading


def _serve_udp() -> None:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("0.0.0.0", 5514))
    while True:
        data, addr = s.recvfrom(65535)
        print(f"UDP {addr!r} bytes={len(data)}", flush=True)


def _drain_tcp_connection(conn: socket.socket, addr: object) -> None:
    """Keep a pooled syslog TCP connection open until the client closes it."""

    while True:
        data = conn.recv(65535)
        if not data:
            return
        print(f"TCP {addr!r} bytes={len(data)}", flush=True)


def _serve_tcp() -> None:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("0.0.0.0", 5514))
    s.listen(16)
    while True:
        conn, addr = s.accept()
        try:
            _drain_tcp_connection(conn, addr)
        finally:
            conn.close()


def main() -> None:
    threading.Thread(target=_serve_udp, daemon=True).start()
    _serve_tcp()


if __name__ == "__main__":
    main()
