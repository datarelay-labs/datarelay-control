"""Connectivity tests for saved destinations (isolated from runtime delivery path)."""

from __future__ import annotations

import json
import socket
import ssl
import time
from datetime import datetime, timezone
from typing import Any

import httpx
from sqlalchemy.orm import Session

from app.http.outbound_httpx_timeout import outbound_httpx_timeout
from app.delivery.syslog_tls import build_syslog_tls_context, normalize_syslog_tls_config
from app.ai_providers.adapters.registry import get_ai_provider_adapter_registry
from app.ai_providers.destination_config import resolve_ai_provider_destination_config
from app.destinations.models import Destination
from app.formatters.config_resolver import resolve_formatter_config
from app.formatters.syslog_formatter import format_syslog


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _test_payload() -> dict[str, Any]:
    return {
        "datarelay": True,
        "message": "DataRelay Control destination test",
        "timestamp": _iso_now(),
    }


def run_destination_connectivity_probe(destination_type: str, config_json: dict[str, Any]) -> dict[str, Any]:
    """Execute a connectivity probe from type + config without requiring a persisted row."""

    started = time.perf_counter()
    dtype = str(destination_type or "")
    cfg = dict(config_json or {})

    if dtype == "SYSLOG_UDP":
        return _test_syslog_udp(cfg, started)
    if dtype == "SYSLOG_TCP":
        return _test_syslog_tcp(cfg, started)
    if dtype == "SYSLOG_TLS":
        return _test_syslog_tls(cfg, started)
    if dtype == "WEBHOOK_POST":
        return _test_webhook_post(cfg, started)
    if dtype == "AI_PROVIDER_POST":
        return _test_ai_provider_post(cfg, started)

    return {
        "success": False,
        "latency_ms": round((time.perf_counter() - started) * 1000.0, 3),
        "message": f"Unsupported destination_type for test: {dtype}",
        "detail": None,
        "tested_at": _iso_now(),
    }


def run_destination_connectivity_test(destination: Destination, *, db: Session | None = None) -> dict[str, Any]:
    """Execute a one-off connectivity probe for a persisted destination row."""

    cfg = dict(destination.config_json or {})
    dtype = str(destination.destination_type or "")
    if dtype == "AI_PROVIDER_POST" and db is not None:
        try:
            cfg = resolve_ai_provider_destination_config(db, cfg)
        except ValueError as exc:
            return {
                "success": False,
                "latency_ms": 0.0,
                "message": str(exc),
                "detail": None,
                "tested_at": _iso_now(),
            }
    return run_destination_connectivity_probe(dtype, cfg)


def _test_syslog_udp(cfg: dict[str, Any], started: float) -> dict[str, Any]:
    host = str(cfg.get("host", "")).strip()
    port = int(cfg.get("port", 514))
    timeout = float(cfg.get("timeout_seconds", 5))
    if not host:
        return {
            "success": False,
            "latency_ms": round((time.perf_counter() - started) * 1000.0, 3),
            "message": "Syslog destination requires host",
            "detail": None,
            "tested_at": _iso_now(),
        }

    try:
        formatter_cfg = resolve_formatter_config(cfg, None)
        line = format_syslog(_test_payload(), formatter_cfg)
        payload = line.encode("utf-8")
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(timeout)
            sock.sendto(payload, (host, port))
    except OSError as exc:
        return {
            "success": False,
            "latency_ms": round((time.perf_counter() - started) * 1000.0, 3),
            "message": str(exc),
            "detail": None,
            "tested_at": _iso_now(),
        }

    latency_ms = round((time.perf_counter() - started) * 1000.0, 3)
    return {
        "success": True,
        "latency_ms": latency_ms,
        "message": "UDP send attempted; receiver acknowledgement is not available.",
        "detail": {"protocol": "udp", "host": host, "port": port},
        "tested_at": _iso_now(),
    }


def _test_syslog_tcp(cfg: dict[str, Any], started: float) -> dict[str, Any]:
    host = str(cfg.get("host", "")).strip()
    port = int(cfg.get("port", 514))
    timeout = float(cfg.get("timeout_seconds", 5))
    if not host:
        return {
            "success": False,
            "latency_ms": round((time.perf_counter() - started) * 1000.0, 3),
            "message": "Syslog destination requires host",
            "detail": None,
            "tested_at": _iso_now(),
        }

    try:
        formatter_cfg = resolve_formatter_config(cfg, None)
        line = format_syslog(_test_payload(), formatter_cfg)
        payload = (line + "\n").encode("utf-8")
        with socket.create_connection((host, port), timeout=timeout) as sock:
            sock.settimeout(timeout)
            sock.sendall(payload)
    except OSError as exc:
        return {
            "success": False,
            "latency_ms": round((time.perf_counter() - started) * 1000.0, 3),
            "message": str(exc),
            "detail": None,
            "tested_at": _iso_now(),
        }

    latency_ms = round((time.perf_counter() - started) * 1000.0, 3)
    return {
        "success": True,
        "latency_ms": latency_ms,
        "message": "TCP connection opened and test syslog message sent.",
        "detail": {"protocol": "tcp", "host": host, "port": port},
        "tested_at": _iso_now(),
    }


def _classify_tls_failure(exc: Exception) -> tuple[str, str]:
    """Map a TLS exception to (short message, error_code) for operators."""

    if isinstance(exc, ssl.SSLCertVerificationError):
        reason = (getattr(exc, "verify_message", None) or "").lower()
        if "expired" in reason or "expired" in str(exc).lower():
            return ("Certificate verification failed: certificate expired", "TLS_CERT_EXPIRED")
        if "hostname" in reason or "ip address mismatch" in reason or "subject" in reason:
            return ("Certificate verification failed: hostname mismatch", "TLS_HOSTNAME_MISMATCH")
        return (f"Certificate verification failed: {exc.verify_message or exc}", "TLS_CERT_VERIFY_FAILED")
    if isinstance(exc, ssl.CertificateError):
        return (f"TLS certificate error: {exc}", "TLS_CERT_ERROR")
    if isinstance(exc, ssl.SSLError):
        return (f"TLS handshake failed: {exc}", "TLS_HANDSHAKE_FAILED")
    if isinstance(exc, TimeoutError):
        return ("TLS connect timed out", "TLS_CONNECT_TIMEOUT")
    if isinstance(exc, ConnectionRefusedError):
        return (f"TLS connect refused: {exc}", "TLS_CONNECT_REFUSED")
    if isinstance(exc, OSError):
        return (f"TLS connect failed: {exc}", "TLS_CONNECT_FAILED")
    return (f"TLS error: {exc}", "TLS_ERROR")


def _test_syslog_tls(cfg: dict[str, Any], started: float) -> dict[str, Any]:
    """Open a TLS connection, send one test line, and report verification details.

    Never persists any runtime state; never affects checkpoints or delivery_logs.
    """

    try:
        tls_cfg = normalize_syslog_tls_config(cfg)
    except ValueError as exc:
        return {
            "success": False,
            "latency_ms": round((time.perf_counter() - started) * 1000.0, 3),
            "message": str(exc),
            "detail": {"protocol": "tls", "error_code": "TLS_CONFIG_INVALID"},
            "tested_at": _iso_now(),
        }

    try:
        ctx = build_syslog_tls_context(tls_cfg)
    except (FileNotFoundError, ssl.SSLError, OSError) as exc:
        return {
            "success": False,
            "latency_ms": round((time.perf_counter() - started) * 1000.0, 3),
            "message": f"TLS context error: {exc}",
            "detail": {"protocol": "tls", "error_code": "TLS_CONTEXT_ERROR"},
            "tested_at": _iso_now(),
        }

    try:
        formatter_cfg = resolve_formatter_config(cfg, None)
        line = format_syslog(_test_payload(), formatter_cfg)
        payload = (line + "\n").encode("utf-8")
    except Exception as exc:
        return {
            "success": False,
            "latency_ms": round((time.perf_counter() - started) * 1000.0, 3),
            "message": f"Formatter error: {exc}",
            "detail": {"protocol": "tls", "error_code": "TLS_FORMAT_ERROR"},
            "tested_at": _iso_now(),
        }

    raw_sock: socket.socket | None = None
    tls_sock: ssl.SSLSocket | None = None
    try:
        raw_sock = socket.create_connection((tls_cfg.host, tls_cfg.port), timeout=tls_cfg.connect_timeout)
        try:
            tls_sock = ctx.wrap_socket(raw_sock, server_hostname=tls_cfg.server_name)
        except Exception as handshake_exc:
            short, code = _classify_tls_failure(handshake_exc)
            return {
                "success": False,
                "latency_ms": round((time.perf_counter() - started) * 1000.0, 3),
                "message": short,
                "detail": {
                    "protocol": "tls",
                    "host": tls_cfg.host,
                    "port": tls_cfg.port,
                    "verify_mode": tls_cfg.verify_mode,
                    "server_name": tls_cfg.server_name,
                    "error_code": code,
                },
                "tested_at": _iso_now(),
            }

        try:
            tls_sock.settimeout(tls_cfg.write_timeout)
            tls_sock.sendall(payload)
        except OSError as exc:
            short, code = _classify_tls_failure(exc)
            return {
                "success": False,
                "latency_ms": round((time.perf_counter() - started) * 1000.0, 3),
                "message": f"TLS write failed: {exc}",
                "detail": {
                    "protocol": "tls",
                    "host": tls_cfg.host,
                    "port": tls_cfg.port,
                    "verify_mode": tls_cfg.verify_mode,
                    "server_name": tls_cfg.server_name,
                    "error_code": code,
                },
                "tested_at": _iso_now(),
            }

        negotiated_version = tls_sock.version()
        try:
            cipher_tuple = tls_sock.cipher()
        except (ValueError, OSError):
            cipher_tuple = None
        cipher_name = cipher_tuple[0] if cipher_tuple else None
        cipher_protocol = cipher_tuple[1] if cipher_tuple else None
    except (TimeoutError, OSError) as exc:
        short, code = _classify_tls_failure(exc)
        return {
            "success": False,
            "latency_ms": round((time.perf_counter() - started) * 1000.0, 3),
            "message": short,
            "detail": {
                "protocol": "tls",
                "host": tls_cfg.host,
                "port": tls_cfg.port,
                "verify_mode": tls_cfg.verify_mode,
                "server_name": tls_cfg.server_name,
                "error_code": code,
            },
            "tested_at": _iso_now(),
        }
    finally:
        if tls_sock is not None:
            try:
                tls_sock.close()
            except OSError:  # pragma: no cover - defensive close path
                pass
        elif raw_sock is not None:
            try:
                raw_sock.close()
            except OSError:  # pragma: no cover - defensive close path
                pass

    latency_ms = round((time.perf_counter() - started) * 1000.0, 3)
    return {
        "success": True,
        "latency_ms": latency_ms,
        "message": (
            "TLS handshake completed and test syslog message sent."
            if tls_cfg.verify_mode == "strict"
            else "TLS handshake completed (insecure_skip_verify) and test syslog message sent."
        ),
        "detail": {
            "protocol": "tls",
            "host": tls_cfg.host,
            "port": tls_cfg.port,
            "verify_mode": tls_cfg.verify_mode,
            "server_name": tls_cfg.server_name,
            "negotiated_tls_version": negotiated_version,
            "cipher": cipher_name,
            "cipher_protocol": cipher_protocol,
        },
        "tested_at": _iso_now(),
    }


def _test_webhook_post(cfg: dict[str, Any], started: float) -> dict[str, Any]:
    url = str(cfg.get("url", "")).strip()
    if not url:
        return {
            "success": False,
            "latency_ms": round((time.perf_counter() - started) * 1000.0, 3),
            "message": "Webhook destination requires url",
            "detail": None,
            "tested_at": _iso_now(),
        }

    headers = dict(cfg.get("headers", {}) or {})
    timeout_seconds = float(cfg.get("timeout_seconds", 10))
    method = str(cfg.get("method", "POST")).upper()
    if method not in {"POST", "PUT", "PATCH"}:
        method = "POST"

    body = _test_payload()
    try:
        httpx_timeout = outbound_httpx_timeout(timeout_seconds)
        with httpx.Client(timeout=httpx_timeout) as client:
            resp = client.request(method, url, headers=headers, json=body)
    except httpx.HTTPError as exc:
        return {
            "success": False,
            "latency_ms": round((time.perf_counter() - started) * 1000.0, 3),
            "message": str(exc),
            "detail": None,
            "tested_at": _iso_now(),
        }

    latency_ms = round((time.perf_counter() - started) * 1000.0, 3)
    ok = 200 <= resp.status_code < 300
    text = (resp.text or "")[:512]
    summary = text.replace("\n", " ").strip()
    if len(summary) > 240:
        summary = summary[:237] + "..."
    return {
        "success": ok,
        "latency_ms": latency_ms,
        "message": f"HTTP {resp.status_code}" + (f" · {summary}" if summary else ""),
        "detail": {
            "http_status": resp.status_code,
            "response_preview": summary or None,
            "method": method,
        },
        "tested_at": _iso_now(),
    }


def _test_ai_provider_post(cfg: dict[str, Any], started: float) -> dict[str, Any]:
    provider_bundle = dict(cfg.get("_provider") or {})
    if not provider_bundle:
        return {
            "success": False,
            "latency_ms": round((time.perf_counter() - started) * 1000.0, 3),
            "message": "AI_PROVIDER_POST probe requires resolved provider config",
            "detail": None,
            "tested_at": _iso_now(),
        }
    provider_type = str(provider_bundle.get("provider_type") or "")
    timeout_seconds = float(cfg.get("timeout_seconds") or provider_bundle.get("timeout_seconds") or 120)
    try:
        adapter = get_ai_provider_adapter_registry().get(provider_type)
        result = adapter.health_check(
            provider_bundle,
            dict(provider_bundle.get("auth_json") or {}),
            timeout_seconds=timeout_seconds,
        )
    except Exception as exc:
        return {
            "success": False,
            "latency_ms": round((time.perf_counter() - started) * 1000.0, 3),
            "message": str(exc),
            "detail": None,
            "tested_at": _iso_now(),
        }
    return {
        "success": bool(result.ok),
        "latency_ms": float(result.latency_ms or round((time.perf_counter() - started) * 1000.0, 3)),
        "message": str(result.message),
        "detail": {"provider_type": provider_type, "http_status": result.http_status},
        "tested_at": _iso_now(),
    }


