"""Assemble a read-only ZIP of JSON diagnostics for production support (no raw secrets)."""

from __future__ import annotations

import json
import zipfile
from datetime import datetime, timezone
from io import BytesIO
from typing import Any
from urllib.parse import urlparse

from sqlalchemy import desc, select, text
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.config import settings
from app.connectors.models import Connector
from app.destinations.models import Destination
from app.logs.models import DeliveryLog
from app.platform_admin.alert_service import mask_webhook_url
from app.platform_admin.health_summary import build_admin_health_summary
from app.platform_admin.models import PlatformHttpsConfig, PlatformRetentionPolicy
from app.platform_admin.repository import (
    count_config_versions,
    get_alert_settings_row,
    get_https_config_row,
    get_retention_policy_row,
    list_audit_events,
    list_config_versions,
)
from app.routes.models import Route
from app.security.secrets import (
    mask_secrets_and_pem,
    mask_source_auth_json,
    mask_source_config_json,
    redact_pem_literals,
)
from app.sources.models import Source
from app.streams.models import Stream

_DELIVERY_LOG_LIMIT = 200
_AUDIT_LOG_LIMIT = 100
_CONFIG_VERSION_SUMMARY_LIMIT = 40

_SENSITIVE_SETTINGS_FIELDS = frozenset(
    {
        "SECRET_KEY",
        "JWT_SECRET_KEY",
        "ENCRYPTION_KEY",
        "MINIO_SECRET_KEY",
        "MINIO_ACCESS_KEY",
        "GDC_PROXY_RELOAD_TOKEN",
        "VALIDATION_ECHO_QUERY_KEY",
        "VALIDATION_ECHO_HEADER_VALUE",
        "VALIDATION_ALERT_NOTIFY_GENERIC_URLS",
        "VALIDATION_ALERT_NOTIFY_SLACK_URLS",
        "VALIDATION_ALERT_NOTIFY_PAGERDUTY_ROUTING_KEYS",
        # Dev/lab connector credentials (must never appear verbatim in exports).
        "DEV_VALIDATION_SFTP_PASSWORD",
        "DEV_VALIDATION_SSH_SCP_PASSWORD",
    }
)


def _mask_database_url(url: str) -> str:
    try:
        p = urlparse(url)
        if p.password:
            netloc = p.netloc.replace(f":{p.password}@", ":****@")
            return p._replace(netloc=netloc).geturl()
    except Exception:
        pass
    return "****"


def _safe_text(value: str | None) -> str | None:
    """Strip PEM material from free-text fields that might echo TLS or key material."""

    if value is None:
        return None
    redacted = redact_pem_literals(value)
    return redacted if isinstance(redacted, str) else str(redacted)


def _json_safe_dt(obj: Any) -> Any:
    if isinstance(obj, datetime):
        return obj.isoformat()
    return obj


def _dump_json(data: Any) -> bytes:
    return json.dumps(data, indent=2, default=_json_safe_dt, sort_keys=True).encode("utf-8")


def _fastapi_version() -> str:
    from app.main import app as fastapi_app

    return str(getattr(fastapi_app, "version", None) or "0.1.0")


def _backend_settings_metadata() -> dict[str, Any]:
    """Non-secret snapshot of pydantic settings (passwords and keys omitted or masked)."""

    out: dict[str, Any] = {}
    for name in sorted(type(settings).model_fields.keys()):
        if name in _SENSITIVE_SETTINGS_FIELDS:
            raw = getattr(settings, name, None)
            if raw in (None, ""):
                out[name] = raw
            else:
                out[name] = "********"
            continue
        if name == "DATABASE_URL":
            out["DATABASE_URL_masked"] = _mask_database_url(str(getattr(settings, "DATABASE_URL", "") or ""))
            continue
        try:
            out[name] = getattr(settings, name)
        except Exception:
            out[name] = "<unreadable>"
    return out


def _retention_summary_row(row: PlatformRetentionPolicy) -> dict[str, Any]:
    def block(cat: str) -> dict[str, Any]:
        return {
            "retention_days": int(getattr(row, f"{cat}_retention_days")),
            "enabled": bool(getattr(row, f"{cat}_enabled")),
            "last_cleanup_at": getattr(row, f"{cat}_last_cleanup_at"),
            "next_cleanup_at": getattr(row, f"{cat}_next_cleanup_at"),
            "last_deleted_count": getattr(row, f"{cat}_last_deleted_count", None),
            "last_duration_ms": getattr(row, f"{cat}_last_duration_ms", None),
            "last_status": getattr(row, f"{cat}_last_status", None),
        }

    return {
        "logs": block("logs"),
        "runtime_metrics": block("runtime_metrics"),
        "preview_cache": block("preview_cache"),
        "backup_temp": block("backup_temp"),
        "cleanup_scheduler_enabled": bool(row.cleanup_scheduler_enabled),
        "cleanup_interval_minutes": int(row.cleanup_interval_minutes or 60),
        "cleanup_batch_size": int(row.cleanup_batch_size or 5000),
    }


def _https_public_summary(row: PlatformHttpsConfig) -> dict[str, Any]:
    return {
        "enabled": bool(row.enabled),
        "certificate_ip_addresses": list(row.certificate_ip_addresses or []),
        "certificate_dns_names": list(row.certificate_dns_names or []),
        "redirect_http_to_https": bool(row.redirect_http_to_https),
        "certificate_valid_days": int(row.certificate_valid_days or 365),
        "cert_not_after": row.cert_not_after,
        "cert_generated_at": row.cert_generated_at,
        "proxy_last_reload_at": getattr(row, "proxy_last_reload_at", None),
        "proxy_last_reload_ok": getattr(row, "proxy_last_reload_ok", None),
        "proxy_last_reload_detail": getattr(row, "proxy_last_reload_detail", None),
        "proxy_last_https_effective": getattr(row, "proxy_last_https_effective", None),
    }


def _alert_settings_summary(db: Session) -> dict[str, Any]:
    row = get_alert_settings_row(db)
    wh = mask_webhook_url((row.webhook_url or "").strip() or None)
    sl = mask_webhook_url((row.slack_webhook_url or "").strip() or None)
    return {
        "rules_json": mask_secrets_and_pem(list(row.rules_json or [])),
        "webhook_url_masked": wh,
        "slack_webhook_url_masked": sl,
        "email_to_configured": bool((row.email_to or "").strip()),
        "cooldown_seconds": int(getattr(row, "cooldown_seconds", 600) or 600),
        "monitor_enabled": bool(getattr(row, "monitor_enabled", True)),
    }


def build_support_bundle_zip_bytes(db: Session) -> tuple[bytes, str]:
    """Return ZIP bytes and a suggested filename. Read-only on ``db`` (SELECT only)."""

    generated_at = datetime.now(timezone.utc)
    stamp = generated_at.strftime("%Y%m%dT%H%M%SZ")
    filename = f"gdc-support-bundle-{stamp}.zip"

    files: dict[str, bytes] = {}

    # --- app / version / config ---
    db_reachable = True
    db_version: str | None = None
    try:
        db.execute(text("SELECT 1"))
        db_version = str(db.execute(text("SELECT version()")).scalar() or "")
    except Exception:
        db_reachable = False

    files["app_version_config.json"] = _dump_json(
        {
            "generated_at_utc": generated_at.isoformat(),
            "api_openapi_version": _fastapi_version(),
            "app_name": settings.APP_NAME,
            "app_env": settings.APP_ENV,
            "api_prefix": settings.API_PREFIX,
            "require_auth": settings.REQUIRE_AUTH,
            "auth_dev_header_trust": settings.AUTH_DEV_HEADER_TRUST,
            "database_reachable": db_reachable,
            "database_version": db_version,
            "database_url_masked": _mask_database_url(settings.DATABASE_URL),
            "python_platform": __import__("platform").platform(),
        }
    )

    files["runtime_health.json"] = _dump_json(build_admin_health_summary(db))

    # --- entity summaries (masked JSON columns) ---
    connectors = db.scalars(select(Connector).order_by(Connector.id)).all()
    files["connectors.json"] = _dump_json(
        [
            {
                "id": c.id,
                "name": c.name,
                "description": _safe_text(c.description),
                "status": c.status,
                "created_at": c.created_at,
                "updated_at": c.updated_at,
            }
            for c in connectors
        ]
    )

    sources = db.scalars(select(Source).order_by(Source.id)).all()
    files["sources.json"] = _dump_json(
        [
            {
                "id": s.id,
                "connector_id": s.connector_id,
                "source_type": s.source_type,
                "enabled": s.enabled,
                "created_at": s.created_at,
                "updated_at": s.updated_at,
                "config_json": redact_pem_literals(mask_source_config_json(s.source_type, dict(s.config_json or {}))),
                "auth_json": redact_pem_literals(mask_source_auth_json(s.source_type, dict(s.auth_json or {}))),
            }
            for s in sources
        ]
    )

    streams = db.scalars(select(Stream).order_by(Stream.id)).all()
    files["streams.json"] = _dump_json(
        [
            {
                "id": st.id,
                "connector_id": st.connector_id,
                "source_id": st.source_id,
                "name": st.name,
                "stream_type": st.stream_type,
                "enabled": st.enabled,
                "status": st.status,
                "polling_interval": st.polling_interval,
                "created_at": st.created_at,
                "updated_at": st.updated_at,
                "config_json": mask_secrets_and_pem(dict(st.config_json or {})),
                "rate_limit_json": mask_secrets_and_pem(dict(st.rate_limit_json or {})),
            }
            for st in streams
        ]
    )

    destinations = db.scalars(select(Destination).order_by(Destination.id)).all()
    files["destinations.json"] = _dump_json(
        [
            {
                "id": d.id,
                "name": d.name,
                "destination_type": d.destination_type,
                "enabled": d.enabled,
                "created_at": d.created_at,
                "updated_at": d.updated_at,
                "last_connectivity_test_at": d.last_connectivity_test_at,
                "last_connectivity_test_success": d.last_connectivity_test_success,
                "last_connectivity_test_latency_ms": d.last_connectivity_test_latency_ms,
                "last_connectivity_test_message": _safe_text(d.last_connectivity_test_message),
                "config_json": mask_secrets_and_pem(dict(d.config_json or {})),
                "rate_limit_json": mask_secrets_and_pem(dict(d.rate_limit_json or {})),
            }
            for d in destinations
        ]
    )

    routes = db.scalars(select(Route).order_by(Route.id)).all()
    files["routes.json"] = _dump_json(
        [
            {
                "id": r.id,
                "stream_id": r.stream_id,
                "destination_id": r.destination_id,
                "enabled": r.enabled,
                "failure_policy": r.failure_policy,
                "status": r.status,
                "disable_reason": _safe_text(r.disable_reason),
                "created_at": r.created_at,
                "updated_at": r.updated_at,
                "formatter_config_json": mask_secrets_and_pem(dict(r.formatter_config_json or {})),
                "rate_limit_json": mask_secrets_and_pem(dict(r.rate_limit_json or {})),
            }
            for r in routes
        ]
    )

    # --- delivery logs ---
    dlogs = db.scalars(
        select(DeliveryLog).order_by(desc(DeliveryLog.created_at)).limit(_DELIVERY_LOG_LIMIT)
    ).all()
    files["delivery_logs_recent.json"] = _dump_json(
        [
            {
                "id": lg.id,
                "connector_id": lg.connector_id,
                "stream_id": lg.stream_id,
                "route_id": lg.route_id,
                "destination_id": lg.destination_id,
                "stage": lg.stage,
                "level": lg.level,
                "status": lg.status,
                "message": _safe_text(lg.message) or "",
                "payload_sample": mask_secrets_and_pem(dict(lg.payload_sample or {})),
                "retry_count": lg.retry_count,
                "http_status": lg.http_status,
                "latency_ms": lg.latency_ms,
                "error_code": lg.error_code,
                "run_id": lg.run_id,
                "created_at": lg.created_at,
            }
            for lg in dlogs
        ]
    )

    # --- audit ---
    audit_rows = list_audit_events(db, limit=_AUDIT_LOG_LIMIT, offset=0)
    files["audit_logs_recent.json"] = _dump_json(
        [
            {
                "id": ev.id,
                "created_at": ev.created_at,
                "actor_username": ev.actor_username,
                "action": ev.action,
                "entity_type": ev.entity_type,
                "entity_id": ev.entity_id,
                "entity_name": _safe_text(ev.entity_name),
                "details_json": mask_secrets_and_pem(dict(ev.details_json or {})),
            }
            for ev in audit_rows
        ]
    )

    # --- retention + config version summary ---
    ret_row = get_retention_policy_row(db)
    cv_total = count_config_versions(db)
    cv_recent = list_config_versions(db, limit=_CONFIG_VERSION_SUMMARY_LIMIT, offset=0)
    files["retention_and_config_versions.json"] = _dump_json(
        {
            "retention_policy": _retention_summary_row(ret_row),
            "config_versions_total": cv_total,
            "config_versions_recent": [
                {
                    "id": int(r.id),
                    "version": int(r.version),
                    "entity_type": str(r.entity_type),
                    "entity_id": int(r.entity_id),
                    "entity_name": r.entity_name,
                    "changed_by": str(r.changed_by),
                    "changed_at": r.created_at,
                    "summary": r.summary,
                }
                for r in cv_recent
            ],
        }
    )

    # --- checkpoints ---
    cps = db.scalars(select(Checkpoint).order_by(Checkpoint.stream_id)).all()
    files["checkpoints.json"] = _dump_json(
        [
            {
                "id": cp.id,
                "stream_id": cp.stream_id,
                "checkpoint_type": cp.checkpoint_type,
                "checkpoint_value_json": mask_secrets_and_pem(dict(cp.checkpoint_value_json or {})),
                "updated_at": cp.updated_at,
            }
            for cp in cps
        ]
    )

    # --- backend / frontend metadata ---
    https_row = get_https_config_row(db)
    files["backend_frontend_metadata.json"] = _dump_json(
        {
            "backend_settings_metadata": _backend_settings_metadata(),
            "https_settings_public": _https_public_summary(https_row),
            "alert_settings_summary": _alert_settings_summary(db),
            "frontend_static_bundle_notes": {
                "vite_environment_variables_documented": [
                    "VITE_API_BASE_URL",
                    "VITE_DATARELAY_INSTANCE_LABEL",
                ],
                "note": (
                    "Client-side build-time values are not included here; compare the deployed "
                    "static asset environment with compose/Kubernetes manifests."
                ),
            },
        }
    )

    manifest = {
        "generated_at_utc": generated_at.isoformat(),
        "bundle_format": "gdc-support-bundle-v1",
        "files": sorted(files.keys()),
        "limits": {
            "delivery_logs": _DELIVERY_LOG_LIMIT,
            "audit_logs": _AUDIT_LOG_LIMIT,
            "config_version_rows": _CONFIG_VERSION_SUMMARY_LIMIT,
        },
    }
    files["manifest.json"] = _dump_json(manifest)

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, content in sorted(files.items()):
            zf.writestr(name, content, compress_type=zipfile.ZIP_DEFLATED)
    return buf.getvalue(), filename
