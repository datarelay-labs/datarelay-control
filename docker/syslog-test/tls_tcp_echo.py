#!/usr/bin/env python3
"""TLS-wrapped TCP sink for local SYSLOG_TLS manual tests (dev containers only)."""

from __future__ import annotations

import socket
import ssl
import sys


def _drain_tls_connection(tls: ssl.SSLSocket, addr: object) -> None:
    """Keep a pooled syslog TLS connection open until the client closes it."""

    while True:
        data = tls.recv(65535)
        if not data:
            return
        print(f"TLS {addr!r} bytes={len(data)}", flush=True)


def _serve_tls(*, certfile: str, keyfile: str, host: str = "0.0.0.0", port: int = 6514) -> None:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(certfile=certfile, keyfile=keyfile)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    sock.listen(16)
    print(f"syslog-tls-test listening on {host}:{port}", flush=True)
    while True:
        conn, addr = sock.accept()
        try:
            tls = ctx.wrap_socket(conn, server_side=True)
        except OSError:
            conn.close()
            continue
        try:
            _drain_tls_connection(tls, addr)
        finally:
            try:
                tls.unwrap()
            except Exception:
                pass
            tls.close()


def main() -> None:
    port = 6514
    if len(sys.argv) >= 2:
        port = int(sys.argv[1])
    _serve_tls(certfile="/certs/server.crt", keyfile="/certs/server.key", port=port)


if __name__ == "__main__":
    main()
