"""Validate destination ``config_json`` before create/update."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from app.ai_providers.destination_config import validate_ai_provider_destination_config
from app.delivery.webhook_payload_mode import normalize_webhook_payload_mode

TLS_VERIFY_MODES = ("strict", "insecure_skip_verify")

TLS_KEYS = (
    "tls_enabled",
    "tls_verify_mode",
    "tls_ca_cert_path",
    "tls_client_cert_path",
    "tls_client_key_path",
    "tls_server_name",
    "connect_timeout",
    "write_timeout",
)

WEBHOOK_URL_SCHEMES = ("http", "https")


def _validate_webhook_post(cfg: dict[str, Any]) -> None:
    """Require a non-empty http(s) URL for WEBHOOK_POST destinations."""

    raw_url = cfg.get("url")
    if raw_url is None or (isinstance(raw_url, str) and not raw_url.strip()):
        raise ValueError("WEBHOOK_POST destination requires url")
    if not isinstance(raw_url, str):
        raise ValueError("WEBHOOK_POST destination url must be a string")

    url = raw_url.strip()
    parsed = urlparse(url)
    scheme = (parsed.scheme or "").lower()
    if scheme not in WEBHOOK_URL_SCHEMES:
        raise ValueError(
            "WEBHOOK_POST destination url must use http:// or https:// scheme"
        )
    if not parsed.netloc:
        raise ValueError("WEBHOOK_POST destination url must include a host")


def _validate_syslog_tls(cfg: dict[str, Any]) -> None:
    """Enforce required + enum + key shape for SYSLOG_TLS configuration."""

    host = str(cfg.get("host", "")).strip()
    if not host:
        raise ValueError("SYSLOG_TLS destination requires host")

    port = cfg.get("port")
    try:
        port_int = int(port)
    except (TypeError, ValueError) as exc:
        raise ValueError("SYSLOG_TLS destination requires numeric port") from exc
    if not (1 <= port_int <= 65535):
        raise ValueError("SYSLOG_TLS port must be between 1 and 65535")

    tls_enabled = cfg.get("tls_enabled")
    if tls_enabled is not None and not bool(tls_enabled):
        raise ValueError("SYSLOG_TLS destination requires tls_enabled=true")

    raw_mode = cfg.get("tls_verify_mode", "strict")
    mode = str(raw_mode or "").strip().lower() or "strict"
    if mode not in TLS_VERIFY_MODES:
        raise ValueError(
            f"Unsupported tls_verify_mode {raw_mode!r}; expected one of {TLS_VERIFY_MODES}"
        )

    if cfg.get("tls_client_cert_path") and not cfg.get("tls_client_key_path"):
        raise ValueError("tls_client_cert_path requires tls_client_key_path")
    if cfg.get("tls_client_key_path") and not cfg.get("tls_client_cert_path"):
        raise ValueError("tls_client_key_path requires tls_client_cert_path")

    for timeout_key in ("connect_timeout", "write_timeout"):
        if timeout_key not in cfg or cfg[timeout_key] is None:
            continue
        try:
            value = float(cfg[timeout_key])
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{timeout_key} must be a positive number") from exc
        if value <= 0:
            raise ValueError(f"{timeout_key} must be a positive number")


def validate_destination_config(destination_type: str, config_json: dict[str, Any] | None) -> None:
    """Raise ``ValueError`` with a human-readable message when config is invalid."""

    cfg = dict(config_json or {})
    dtype = str(destination_type or "").strip().upper()

    if "payload_mode" in cfg and dtype not in {"WEBHOOK_POST"}:
        raise ValueError("payload_mode is only supported for WEBHOOK_POST destinations")

    if dtype == "WEBHOOK_POST":
        _validate_webhook_post(cfg)
        if "payload_mode" in cfg:
            normalize_webhook_payload_mode(cfg.get("payload_mode"))

    tls_keys_present = [k for k in TLS_KEYS if k in cfg]
    if dtype != "SYSLOG_TLS" and tls_keys_present:
        raise ValueError(
            "TLS fields are only supported for SYSLOG_TLS destinations: "
            + ", ".join(sorted(tls_keys_present))
        )

    if dtype == "SYSLOG_TLS":
        _validate_syslog_tls(cfg)

    if dtype == "AI_PROVIDER_POST":
        validate_ai_provider_destination_config(cfg)
