"""Syslog delivery — UDP / TCP / TLS."""

from __future__ import annotations

import math
import os
import select
import socket
import ssl
import threading
import time
from typing import Any

from app.delivery.syslog_tls import SyslogTlsConfig, build_syslog_tls_context, normalize_syslog_tls_config
from app.formatters.config_resolver import resolve_formatter_config
from app.formatters.message_prefix import MessagePrefixResolveContext, format_delivery_lines_syslog
from app.rate_limit.process_destination_limiter import get_process_destination_rate_limiter
from app.runtime.errors import DestinationSendError


_tcp_pool_lock = threading.Lock()
_tcp_pool: dict[str, socket.socket] = {}


def _safe_close_socket(sock: socket.socket) -> None:
    close = getattr(sock, "close", None)
    if not callable(close):
        return
    try:
        close()
    except OSError:
        pass


def _pooled_socket_is_usable(sock: socket.socket) -> bool:
    """Return False when a pooled TCP/TLS socket should not be reused.

    ``getpeername()`` alone misses half-closed peers (collector idle close). If the
    socket is readable, the peer sent FIN/close_notify or unexpected data — discard it
    so the next send opens a fresh connection instead of silently dropping payloads.
    """

    try:
        sock.getpeername()
    except OSError:
        return False
    try:
        readable, _, errored = select.select([sock], [], [sock], 0)
    except (OSError, ValueError, TypeError):
        return False
    if errored:
        return False
    if not readable:
        return True
    # Any inbound readability on a syslog client socket means the pool entry is stale.
    return False


def _borrow_tcp_socket(*, pool_key: str, host: str, port: int, timeout: float) -> socket.socket:
    with _tcp_pool_lock:
        sock = _tcp_pool.get(pool_key)
        if sock is not None:
            if isinstance(sock, socket.socket) and _pooled_socket_is_usable(sock):
                return sock
            _tcp_pool.pop(pool_key, None)
            _safe_close_socket(sock)
        sock = socket.create_connection((host, port), timeout=timeout)
        _tcp_pool[pool_key] = sock
        return sock


def _borrow_tls_socket(*, pool_key: str, tls_cfg: SyslogTlsConfig, ctx: ssl.SSLContext) -> ssl.SSLSocket:
    with _tcp_pool_lock:
        sock = _tcp_pool.get(pool_key)
        if sock is not None:
            if isinstance(sock, ssl.SSLSocket) and _pooled_socket_is_usable(sock):
                return sock
            _tcp_pool.pop(pool_key, None)
            _safe_close_socket(sock)
        raw_sock = socket.create_connection((tls_cfg.host, tls_cfg.port), timeout=tls_cfg.connect_timeout)
        try:
            tls_sock = ctx.wrap_socket(raw_sock, server_hostname=tls_cfg.server_name)
        except Exception:
            raw_sock.close()
            raise
        _tcp_pool[pool_key] = tls_sock
        return tls_sock


def _invalidate_tcp_socket(pool_key: str) -> None:
    with _tcp_pool_lock:
        sock = _tcp_pool.pop(pool_key, None)
    if sock is not None:
        _safe_close_socket(sock)


def _build_syslog_tls_pool_key(tls_cfg: SyslogTlsConfig) -> str:
    return (
        f"syslog-tls:{tls_cfg.host}:{tls_cfg.port}:"
        f"{tls_cfg.server_name}:{tls_cfg.verify_mode}:{tls_cfg.client_cert_path or ''}"
    )


def resolve_syslog_protocol(config: dict[str, Any], destination_type: str | None = None) -> str:
    """Pick UDP / TCP / TLS for syslog delivery.

    When ``destination_type`` is one of ``SYSLOG_TCP``/``SYSLOG_UDP``/``SYSLOG_TLS`` it is
    authoritative: the UI/DB kind must match the wire protocol (this fixes stale
    ``config_json.protocol`` values from older saves or type changes). Otherwise we fall
    back to ``config['protocol']`` and finally to UDP for backward compatibility.
    """

    dt = str(destination_type or "").upper()
    if dt == "SYSLOG_TCP":
        return "tcp"
    if dt == "SYSLOG_UDP":
        return "udp"
    if dt == "SYSLOG_TLS":
        return "tls"

    raw = config.get("protocol")
    if isinstance(raw, str) and raw.strip():
        p = raw.strip().lower()
        if p in {"udp", "tcp", "tls"}:
            return p
    return "udp"


class SyslogSender:
    """Transmit events to syslog destinations (UDP / TCP / TLS)."""

    def send(
        self,
        events: list[dict[str, Any]],
        config: dict[str, Any],
        formatter_override: dict[str, Any] | None = None,
        destination_type: str | None = None,
        *,
        prefix_context: MessagePrefixResolveContext | None = None,
    ) -> None:
        """Send all events to a syslog endpoint.

        Args:
            events: Enriched events.
            config: Destination config (host, port, optional protocol, formatter_config,
                and TLS keys when ``destination_type`` is ``SYSLOG_TLS``).
            formatter_override: Route-level ``formatter_config_json`` when non-empty.
            destination_type: For ``SYSLOG_*`` kinds, selects UDP/TCP/TLS and
                overrides a conflicting ``config['protocol']`` (stale JSON from older saves).
        """

        # StreamRunner skips calling send when extract_events returns []; keep guard for callers/tests.
        if not events:
            return

        protocol = resolve_syslog_protocol(config, destination_type)
        if protocol not in {"udp", "tcp", "tls"}:
            raise DestinationSendError(f"Unsupported syslog protocol: {protocol}")

        try:
            formatter_cfg = resolve_formatter_config(config, formatter_override)
            message_format = formatter_cfg.get("message_format", "json")
            if message_format != "json":
                raise ValueError(f"Unsupported message_format for syslog delivery: {message_format}")
            # Callers may omit ``destination_type`` (legacy); prefix defaults treat SYSLOG kinds alike.
            dt_for_prefix = str(destination_type or "").strip() or "SYSLOG_UDP"
            lines = format_delivery_lines_syslog(
                events,
                formatter_override,
                dt_for_prefix,
                prefix_context=prefix_context,
            )
        except ValueError as exc:
            raise DestinationSendError(str(exc)) from exc

        payloads = [line.encode("utf-8") for line in lines if str(line).strip()]
        if not payloads:
            raise DestinationSendError("Syslog send produced no non-empty payloads")

        if protocol == "tls":
            self._send_tls(payloads, config)
            return

        host = str(config.get("host", "")).strip()
        port = int(config.get("port", 514))
        timeout = float(config.get("timeout_seconds", 5))
        if not host:
            raise DestinationSendError("Syslog destination requires host")

        # Private, runtime-only Route pacing policy. Keep existing legacy
        # max_events/per_seconds batch gating unchanged and never persist this.
        udp_pacing = config.get("_route_udp_event_rate") if protocol == "udp" else None
        udp_limiter = None
        if udp_pacing is not None:
            try:
                route_id = int(udp_pacing["route_id"])
                per_second = float(udp_pacing["per_second"])
                burst_size = int(udp_pacing["burst_size"])
                if (
                    route_id == 0 or not math.isfinite(per_second) or per_second <= 0 or
                    burst_size <= 0 or float(udp_pacing["burst_size"]) != burst_size
                ):
                    raise ValueError("invalid UDP pacing parameters")
            except (TypeError, KeyError, ValueError, OverflowError) as exc:
                raise DestinationSendError("Invalid UDP Route rate-limit policy") from exc
            udp_limiter = get_process_destination_rate_limiter()

        pool_key = f"syslog-tcp:{host}:{port}"
        try:
            if protocol == "udp":
                # Connected UDP + SO_ERROR: ICMP port-unreachable is asynchronous, so a single
                # send() often returns success even when nothing listens. Unconnected sendto()
                # never surfaces that failure. Without this check, syslog_destination_down
                # drills advance checkpoints into a black hole and leave the collector empty.
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                    sock.settimeout(timeout)
                    sock.connect((host, port))
                    for payload in payloads:
                        if udp_limiter is not None:
                            wait = udp_limiter.reserve_event(
                                route_id,
                                per_second=per_second,
                                burst_size=burst_size,
                                now=time.monotonic(),
                            )
                            if wait > 0:
                                time.sleep(wait)
                        sock.send(payload)
                    time.sleep(min(0.05, max(timeout, 0.0)))
                    err = sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
                    if err:
                        raise OSError(err, os.strerror(err))
                return

            sock = _borrow_tcp_socket(pool_key=pool_key, host=host, port=port, timeout=timeout)
            for payload in payloads:
                sock.sendall(payload + b"\n")
        except OSError as exc:
            if protocol != "udp":
                _invalidate_tcp_socket(pool_key)
            raise DestinationSendError(f"Syslog send failed: {exc}") from exc

    def _send_tls(self, payloads: list[bytes], config: dict[str, Any]) -> None:
        """TLS-wrapped TCP delivery using a per-call ``ssl.SSLContext``.

        Connection or handshake failures map to :class:`DestinationSendError` so that
        the existing route failure policy (PAUSE/DISABLE/RETRY/LOG_AND_CONTINUE) handles
        them identically to plain TCP failures. Checkpoint semantics are unaffected.
        """

        try:
            tls_cfg = normalize_syslog_tls_config(config)
        except ValueError as exc:
            raise DestinationSendError(str(exc)) from exc

        try:
            ctx = build_syslog_tls_context(tls_cfg)
        except (FileNotFoundError, ssl.SSLError, OSError) as exc:
            raise DestinationSendError(f"Syslog TLS context error: {exc}") from exc

        pool_key = _build_syslog_tls_pool_key(tls_cfg)
        try:
            tls_sock = _borrow_tls_socket(pool_key=pool_key, tls_cfg=tls_cfg, ctx=ctx)
            tls_sock.settimeout(tls_cfg.write_timeout)
            for payload in payloads:
                tls_sock.sendall(payload + b"\n")
        except ssl.CertificateError as exc:
            _invalidate_tcp_socket(pool_key)
            raise DestinationSendError(f"Syslog TLS certificate error: {exc}") from exc
        except ssl.SSLError as exc:
            _invalidate_tcp_socket(pool_key)
            raise DestinationSendError(f"Syslog TLS handshake failed: {exc}") from exc
        except OSError as exc:
            _invalidate_tcp_socket(pool_key)
            raise DestinationSendError(f"Syslog TLS send failed: {exc}") from exc
