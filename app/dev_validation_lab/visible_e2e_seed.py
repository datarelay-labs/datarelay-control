"""Idempotent seed for UI-visible ``[DEV E2E]`` platform entities (PostgreSQL ORM only).

Safe usage: loopback catalog DB, allow-listed database names, no deletes of non-lab rows.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.dev_validation_lab.lab_throughput_config import (
    LAB_HTTP_HIGH_PATH,
    apply_lab_http_throughput_config,
    lab_polling_interval_for_title,
    lab_webhook_destination_config_patch,
)
from app.connectors.models import Connector
from app.connectors.router import (
    _build_auth_json,
    _build_config_json,
    _build_database_query_config_json,
    _build_remote_file_config_json,
    _build_s3_config_json,
    _build_webhook_receiver_auth_json,
    _build_webhook_receiver_config_json,
)
from app.connectors.schemas import ConnectorCreate
from app.destinations.config_validation import validate_destination_config
from app.destinations.models import Destination
from app.enrichments.models import Enrichment
from app.mappings.models import Mapping
from app.routes.models import Route
from app.sources.models import Source
from app.streams.models import Stream

PREFIX = "[DEV E2E] "

# Fixed receiver key for operator docs and ingest smoke (not a production secret).
VISIBLE_E2E_WEBHOOK_RECEIVER_KEY = "dev-visible-e2e"
VISIBLE_E2E_WEBHOOK_SHARED_SECRET = "visible-dev-e2e-secret"

_COMPOSE_CATALOG_HOSTS = frozenset({"postgres", "gdc-platform-postgres"})
_COMPOSE_SERVICE_HOSTS = frozenset(
    {
        "gdc-wiremock-test",
        "gdc-platform-wiremock-test",
        "gdc-webhook-receiver-test",
        "gdc-syslog-test",
        "gdc-minio-test",
        "gdc-postgres-query-test",
        "gdc-sftp-test",
        "gdc-ssh-scp-test",
    }
)

DESCRIPTION = (
    "Local dev UI-visible E2E fixture (WireMock, MinIO, fixture PostgreSQL, SFTP, webhook/syslog). "
    "Seeded by scripts/dev-validation/seed-visible-e2e-fixtures.sh — not for production."
)

DEFAULT_FIELD_MAPPINGS: dict[str, str] = {
    "event_id": "$.id",
    "message": "$.message",
    "severity": "$.severity",
}

DB_FIELD_MAPPINGS: dict[str, str] = {
    "event_id": "$.event_id",
    "message": "$.message",
    "severity": "$.severity",
}

_PROD_HOST_HINTS = re.compile(
    r"(amazonaws\.com|rds\.|azure\.|database\.azure|neon\.tech|supabase\.co|"
    r"elephantsql|cockroachlabs\.cloud|planetscale\.com|render\.com|herokuapp\.com)",
    re.I,
)


@dataclass(frozen=True, slots=True)
class VisibleSeedEnv:
    wiremock_base_url: str
    webhook_base_url: str
    syslog_host: str
    syslog_plain_port: int
    syslog_tls_port: int
    minio_endpoint: str
    minio_bucket: str
    minio_access_key: str
    minio_secret_key: str
    minio_prefix: str
    pg_fixture_host: str
    pg_fixture_port: int
    pg_fixture_database: str
    pg_fixture_user: str
    pg_fixture_password: str
    sftp_host: str
    sftp_port: int
    sftp_user: str
    sftp_password: str


def _env(name: str, default: str) -> str:
    return (os.environ.get(name) or default).strip()


def _env_int(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return int(default)
    return int(raw)


def apply_visible_e2e_env_from_settings(settings_obj: Any) -> None:
    """Populate SOURCE_E2E / GDC_VISIBLE_E2E env vars from app settings (Docker-aware)."""

    wiremock = str(getattr(settings_obj, "DEV_VALIDATION_WIREMOCK_BASE_URL", "") or "").strip()
    if wiremock:
        os.environ.setdefault("WIREMOCK_BASE_URL", wiremock.rstrip("/"))

    webhook = str(getattr(settings_obj, "DEV_VALIDATION_WEBHOOK_BASE_URL", "") or "").strip()
    if webhook:
        os.environ.setdefault("GDC_VISIBLE_E2E_WEBHOOK_BASE_URL", webhook.rstrip("/"))

    syslog_host = str(getattr(settings_obj, "DEV_VALIDATION_SYSLOG_HOST", "") or "").strip()
    if syslog_host:
        os.environ.setdefault("GDC_VISIBLE_E2E_SYSLOG_HOST", syslog_host)
    syslog_port = getattr(settings_obj, "DEV_VALIDATION_SYSLOG_PORT", None)
    if syslog_port is not None:
        os.environ.setdefault("GDC_VISIBLE_E2E_SYSLOG_PLAIN_PORT", str(int(syslog_port)))

    minio = str(getattr(settings_obj, "MINIO_ENDPOINT", "") or "").strip()
    if minio:
        os.environ.setdefault("SOURCE_E2E_MINIO_ENDPOINT", minio.rstrip("/"))
    os.environ.setdefault("SOURCE_E2E_MINIO_BUCKET", "gdc-source-e2e")
    access = str(getattr(settings_obj, "MINIO_ACCESS_KEY", "") or "").strip()
    if access:
        os.environ.setdefault("SOURCE_E2E_MINIO_ACCESS_KEY", access)
    secret = str(getattr(settings_obj, "MINIO_SECRET_KEY", "") or "").strip()
    if secret:
        os.environ.setdefault("SOURCE_E2E_MINIO_SECRET_KEY", secret)

    pg_host = str(getattr(settings_obj, "DEV_VALIDATION_PG_QUERY_HOST", "") or "").strip()
    if pg_host:
        os.environ.setdefault("SOURCE_E2E_PG_FIXTURE_HOST", pg_host)
    pg_port = getattr(settings_obj, "DEV_VALIDATION_PG_QUERY_PORT", None)
    if pg_port is not None:
        os.environ.setdefault("SOURCE_E2E_PG_FIXTURE_PORT", str(int(pg_port)))

    sftp_host = str(getattr(settings_obj, "DEV_VALIDATION_SFTP_HOST", "") or "").strip()
    if sftp_host:
        os.environ.setdefault("SOURCE_E2E_SFTP_HOST", sftp_host)
    sftp_port = getattr(settings_obj, "DEV_VALIDATION_SFTP_PORT", None)
    if sftp_port is not None:
        os.environ.setdefault("SOURCE_E2E_SFTP_PORT", str(int(sftp_port)))
    sftp_pw = str(getattr(settings_obj, "DEV_VALIDATION_SFTP_PASSWORD", "") or "").strip()
    if sftp_pw:
        os.environ.setdefault("SOURCE_E2E_SFTP_PASSWORD", sftp_pw)


def assert_safe_database_url(*, local_dev_mode: bool, allow_compose_catalog_host: bool = False) -> None:
    """Abort unless DATABASE_URL targets an allow-listed local PostgreSQL catalog."""

    raw = (os.environ.get("DATABASE_URL") or "").strip()
    if not raw:
        raise SystemExit("DATABASE_URL is not set.")

    app_env = (os.environ.get("APP_ENV") or "").strip().lower()
    if app_env in {"production", "prod"}:
        raise SystemExit(f"Refusing to seed: APP_ENV={app_env!r} looks like production.")

    u = urlparse(raw)
    if u.scheme not in ("postgresql", "postgres"):
        raise SystemExit(f"DATABASE_URL must be postgresql:// (got scheme={u.scheme!r}).")

    host = (u.hostname or "").lower()
    if host and _PROD_HOST_HINTS.search(host):
        raise SystemExit(f"Refusing to seed: DATABASE_URL host looks non-local ({host!r}).")

    if _PROD_HOST_HINTS.search(raw):
        raise SystemExit("Refusing to seed: DATABASE_URL looks like a managed/cloud connection string.")

    port = u.port
    user = (u.username or "").strip()
    db_name = (u.path or "").lstrip("/").split("/")[0]

    loopback_hosts = ("127.0.0.1", "localhost", "::1")
    if host not in loopback_hosts:
        if not (allow_compose_catalog_host and host in _COMPOSE_CATALOG_HOSTS):
            raise SystemExit(f"DATABASE_URL host must be loopback (got {host!r}).")

    if user != "gdc":
        raise SystemExit(f"DATABASE_URL user must be 'gdc' for this seed (got {user!r}).")

    allowed = {"gdc", "gdc_e2e_test", "gdc_pytest"}
    if local_dev_mode:
        allowed = allowed | {"datarelay"}
    is_local_dev_catalog = bool(local_dev_mode and re.fullmatch(r"gdc_dev_[a-z0-9_]+", db_name))

    if db_name not in allowed and not is_local_dev_catalog:
        raise SystemExit(
            f"DATABASE_URL database must be one of {sorted(allowed)} (got {db_name!r}). "
            "Use --local-dev-mode only for legacy disposable local catalogs."
        )

    if db_name == "gdc_pytest":
        if port not in (5432, 55432, 55441, 55442):
            raise SystemExit(
                f"DATABASE_URL port must be 5432, 55432, 55441, or 55442 for gdc_pytest (got {port!r})."
            )
    elif db_name == "gdc":
        if port not in (5432, 55432, 55442):
            raise SystemExit(
                f"DATABASE_URL port must be 5432, 55432, or 55442 for dev database 'gdc' (got {port!r})."
            )
    elif db_name == "gdc_e2e_test":
        if port != 55432:
            raise SystemExit(f"DATABASE_URL port must be 55432 for gdc_e2e_test (got {port!r}).")
    elif is_local_dev_catalog:
        if port not in (5432, 55432):
            raise SystemExit(
                f"Local development catalog {db_name!r} requires --local-dev-mode on port 5432 or 55432 (got {port!r})."
            )
    elif db_name == "datarelay":
        if port != 55432 or not local_dev_mode:
            raise SystemExit("Legacy database name 'datarelay' requires --local-dev-mode on port 55432.")


def _load_env() -> VisibleSeedEnv:
    return VisibleSeedEnv(
        wiremock_base_url=_env("WIREMOCK_BASE_URL", "http://127.0.0.1:28080").rstrip("/"),
        webhook_base_url=_env("GDC_VISIBLE_E2E_WEBHOOK_BASE_URL", "http://127.0.0.1:18091").rstrip("/"),
        syslog_host=_env("GDC_VISIBLE_E2E_SYSLOG_HOST", "127.0.0.1"),
        syslog_plain_port=_env_int("GDC_VISIBLE_E2E_SYSLOG_PLAIN_PORT", 15514),
        syslog_tls_port=_env_int("GDC_VISIBLE_E2E_SYSLOG_TLS_PORT", 16514),
        minio_endpoint=_env("SOURCE_E2E_MINIO_ENDPOINT", "http://127.0.0.1:59000").rstrip("/"),
        minio_bucket=_env("SOURCE_E2E_MINIO_BUCKET", "gdc-source-e2e"),
        minio_access_key=_env("SOURCE_E2E_MINIO_ACCESS_KEY", "gdcminioaccess"),
        minio_secret_key=_env("SOURCE_E2E_MINIO_SECRET_KEY", "gdcminioaccesssecret12"),
        minio_prefix="e2e-s3/",
        pg_fixture_host=_env("SOURCE_E2E_PG_FIXTURE_HOST", "127.0.0.1"),
        pg_fixture_port=_env_int("SOURCE_E2E_PG_FIXTURE_PORT", 55433),
        pg_fixture_database=_env("SOURCE_E2E_PG_FIXTURE_DB", "gdc_query_fixture"),
        pg_fixture_user=_env("SOURCE_E2E_PG_FIXTURE_USER", "gdc_fixture"),
        pg_fixture_password=_env("SOURCE_E2E_PG_FIXTURE_PASSWORD", "gdc_fixture_pw"),
        sftp_host=_env("SOURCE_E2E_SFTP_HOST", "127.0.0.1"),
        sftp_port=_env_int("SOURCE_E2E_SFTP_PORT", 22222),
        sftp_user=_env("SOURCE_E2E_SFTP_USER", "gdc"),
        sftp_password=_env("SOURCE_E2E_SFTP_PASSWORD", "devlab123"),
    )


def _host_allowed_for_seed(host: str, *, allow_compose_service_hosts: bool) -> bool:
    h = (host or "").strip().lower()
    if not h:
        return True
    if h in ("127.0.0.1", "localhost", "::1"):
        return True
    return bool(allow_compose_service_hosts and h in _COMPOSE_SERVICE_HOSTS)


def _assert_local_service_urls(env: VisibleSeedEnv, *, allow_compose_service_hosts: bool = False) -> None:
    """Refuse hostnames that could leave the machine (belt-and-suspenders)."""

    for label, url in (
        ("WIREMOCK_BASE_URL", env.wiremock_base_url),
        ("webhook", env.webhook_base_url),
        ("MINIO", env.minio_endpoint),
    ):
        h = urlparse(url).hostname or ""
        if h and not _host_allowed_for_seed(h, allow_compose_service_hosts=allow_compose_service_hosts):
            raise SystemExit(f"{label} must use loopback or compose fixture host for this seed (got {url!r}).")

    if not _host_allowed_for_seed(env.syslog_host, allow_compose_service_hosts=allow_compose_service_hosts):
        raise SystemExit(f"Syslog host must be loopback or compose fixture host (got {env.syslog_host!r}).")

    if not _host_allowed_for_seed(env.pg_fixture_host, allow_compose_service_hosts=allow_compose_service_hosts):
        raise SystemExit(f"Fixture PostgreSQL host must be loopback or compose fixture host (got {env.pg_fixture_host!r}).")

    if not _host_allowed_for_seed(env.sftp_host, allow_compose_service_hosts=allow_compose_service_hosts):
        raise SystemExit(f"SFTP host must be loopback or compose fixture host (got {env.sftp_host!r}).")


def _upsert_destination(
    db: Session,
    *,
    name: str,
    destination_type: str,
    config_json: dict[str, Any],
    rate_limit_json: dict[str, Any],
) -> Destination:
    full = f"{PREFIX}{name}" if not name.startswith(PREFIX) else name
    validate_destination_config(destination_type, config_json)
    row = db.query(Destination).filter(Destination.name == full).first()
    if row is None:
        row = Destination(
            name=full,
            destination_type=destination_type,
            config_json=dict(config_json),
            rate_limit_json=dict(rate_limit_json),
            enabled=True,
        )
        db.add(row)
        db.flush()
        return row
    if not str(row.name).startswith(PREFIX):
        raise RuntimeError(f"refuse to modify non-lab destination id={row.id} name={row.name!r}")
    row.destination_type = destination_type
    row.config_json = dict(config_json)
    row.rate_limit_json = dict(rate_limit_json)
    row.enabled = True
    db.add(row)
    db.flush()
    return row


def _upsert_http_connector(db: Session, env: VisibleSeedEnv) -> tuple[Connector, Source]:
    name = f"{PREFIX}HTTP API Connector"
    row = db.query(Connector).filter(Connector.name == name).first()
    payload = ConnectorCreate.model_validate(
        {
            "name": name,
            "description": DESCRIPTION,
            "auth_type": "no_auth",
            "host": env.wiremock_base_url,
            "verify_ssl": False,
        }
    )
    if row is None:
        row = Connector(name=name, description=DESCRIPTION, status="RUNNING")
        db.add(row)
        db.flush()
        src = Source(
            connector_id=row.id,
            source_type="HTTP_API_POLLING",
            config_json=_build_config_json(payload, partial=False),
            auth_json=_build_auth_json(payload, partial=False),
            enabled=True,
        )
        db.add(src)
        db.flush()
        return row, src

    if not str(row.name).startswith(PREFIX):
        raise RuntimeError("refuse to modify connector without lab prefix")
    row.description = DESCRIPTION
    row.status = "RUNNING"
    db.add(row)
    src = (
        db.query(Source)
        .filter(Source.connector_id == int(row.id), Source.source_type == "HTTP_API_POLLING")
        .order_by(Source.id.asc())
        .first()
    )
    if src is None:
        src = Source(
            connector_id=row.id,
            source_type="HTTP_API_POLLING",
            config_json=_build_config_json(payload, partial=False),
            auth_json=_build_auth_json(payload, partial=False),
            enabled=True,
        )
        db.add(src)
    else:
        src.config_json = _build_config_json(payload, partial=False)
        src.auth_json = _build_auth_json(payload, partial=False)
        src.enabled = True
    db.add(src)
    db.flush()
    return row, src


def _upsert_s3_connector(db: Session, env: VisibleSeedEnv) -> tuple[Connector, Source]:
    name = f"{PREFIX}S3 Object Connector"
    row = db.query(Connector).filter(Connector.name == name).first()
    payload = ConnectorCreate.model_validate(
        {
            "name": name,
            "description": DESCRIPTION,
            "source_type": "S3_OBJECT_POLLING",
            "auth_type": "no_auth",
            "endpoint_url": env.minio_endpoint,
            "bucket": env.minio_bucket,
            "region": "us-east-1",
            "access_key": env.minio_access_key,
            "secret_key": env.minio_secret_key,
            "prefix": env.minio_prefix,
            "path_style_access": True,
            "use_ssl": env.minio_endpoint.lower().startswith("https://"),
        }
    )
    cfg = _build_s3_config_json(payload, partial=False)
    if row is None:
        row = Connector(name=name, description=DESCRIPTION, status="RUNNING")
        db.add(row)
        db.flush()
        src = Source(
            connector_id=row.id,
            source_type="S3_OBJECT_POLLING",
            config_json=cfg,
            auth_json={"auth_type": "no_auth"},
            enabled=True,
        )
        db.add(src)
        db.flush()
        return row, src

    row.description = DESCRIPTION
    row.status = "RUNNING"
    db.add(row)
    src = (
        db.query(Source)
        .filter(Source.connector_id == int(row.id), Source.source_type == "S3_OBJECT_POLLING")
        .order_by(Source.id.asc())
        .first()
    )
    if src is None:
        src = Source(
            connector_id=row.id,
            source_type="S3_OBJECT_POLLING",
            config_json=cfg,
            auth_json={"auth_type": "no_auth"},
            enabled=True,
        )
        db.add(src)
    else:
        src.config_json = cfg
        src.enabled = True
    db.add(src)
    db.flush()
    return row, src


def _upsert_database_connector(db: Session, env: VisibleSeedEnv) -> tuple[Connector, Source]:
    name = f"{PREFIX}Database Query Connector"
    row = db.query(Connector).filter(Connector.name == name).first()
    payload = ConnectorCreate.model_validate(
        {
            "name": name,
            "description": DESCRIPTION,
            "source_type": "DATABASE_QUERY",
            "auth_type": "no_auth",
            "db_type": "POSTGRESQL",
            "host": env.pg_fixture_host,
            "port": env.pg_fixture_port,
            "database": env.pg_fixture_database,
            "db_username": env.pg_fixture_user,
            "db_password": env.pg_fixture_password,
            "ssl_mode": "DISABLE",
            "connection_timeout_seconds": 30,
        }
    )
    cfg = _build_database_query_config_json(payload, partial=False)
    if row is None:
        row = Connector(name=name, description=DESCRIPTION, status="RUNNING")
        db.add(row)
        db.flush()
        src = Source(
            connector_id=row.id,
            source_type="DATABASE_QUERY",
            config_json=cfg,
            auth_json={"auth_type": "no_auth"},
            enabled=True,
        )
        db.add(src)
        db.flush()
        return row, src

    row.description = DESCRIPTION
    row.status = "RUNNING"
    db.add(row)
    src = (
        db.query(Source)
        .filter(Source.connector_id == int(row.id), Source.source_type == "DATABASE_QUERY")
        .order_by(Source.id.asc())
        .first()
    )
    if src is None:
        src = Source(
            connector_id=row.id,
            source_type="DATABASE_QUERY",
            config_json=cfg,
            auth_json={"auth_type": "no_auth"},
            enabled=True,
        )
        db.add(src)
    else:
        src.config_json = cfg
        src.enabled = True
    db.add(src)
    db.flush()
    return row, src


def _upsert_remote_file_connector(db: Session, env: VisibleSeedEnv) -> tuple[Connector, Source]:
    name = f"{PREFIX}Remote File Connector"
    row = db.query(Connector).filter(Connector.name == name).first()
    payload = ConnectorCreate.model_validate(
        {
            "name": name,
            "description": DESCRIPTION,
            "source_type": "REMOTE_FILE_POLLING",
            "auth_type": "no_auth",
            "host": env.sftp_host,
            "port": env.sftp_port,
            "remote_username": env.sftp_user,
            "remote_password": env.sftp_password,
            "remote_file_protocol": "sftp",
            "known_hosts_policy": "insecure_skip_verify",
            "connection_timeout_seconds": 25,
        }
    )
    cfg = _build_remote_file_config_json(payload, partial=False)
    if row is None:
        row = Connector(name=name, description=DESCRIPTION, status="RUNNING")
        db.add(row)
        db.flush()
        src = Source(
            connector_id=row.id,
            source_type="REMOTE_FILE_POLLING",
            config_json=cfg,
            auth_json={"auth_type": "no_auth"},
            enabled=True,
        )
        db.add(src)
        db.flush()
        return row, src

    row.description = DESCRIPTION
    row.status = "RUNNING"
    db.add(row)
    src = (
        db.query(Source)
        .filter(Source.connector_id == int(row.id), Source.source_type == "REMOTE_FILE_POLLING")
        .order_by(Source.id.asc())
        .first()
    )
    if src is None:
        src = Source(
            connector_id=row.id,
            source_type="REMOTE_FILE_POLLING",
            config_json=cfg,
            auth_json={"auth_type": "no_auth"},
            enabled=True,
        )
        db.add(src)
    else:
        src.config_json = cfg
        src.enabled = True
    db.add(src)
    db.flush()
    return row, src


def _upsert_webhook_receiver_connector(db: Session) -> tuple[Connector, Source]:
    name = f"{PREFIX}Webhook Receiver Connector"
    row = db.query(Connector).filter(Connector.name == name).first()
    payload = ConnectorCreate.model_validate(
        {
            "name": name,
            "description": DESCRIPTION,
            "source_type": "WEBHOOK_RECEIVER",
            "auth_type": "no_auth",
            "receiver_key": VISIBLE_E2E_WEBHOOK_RECEIVER_KEY,
            "webhook_auth_mode": "shared_secret_header",
            "webhook_shared_secret": VISIBLE_E2E_WEBHOOK_SHARED_SECRET,
            "webhook_auth_header_name": "X-GDC-Webhook-Secret",
            "max_request_bytes": 1_048_576,
        }
    )
    cfg = _build_webhook_receiver_config_json(payload, partial=False)
    auth = _build_webhook_receiver_auth_json(payload, partial=False)
    if row is None:
        row = Connector(name=name, description=DESCRIPTION, status="RUNNING")
        db.add(row)
        db.flush()
        src = Source(
            connector_id=row.id,
            source_type="WEBHOOK_RECEIVER",
            config_json=cfg,
            auth_json=auth,
            enabled=True,
        )
        db.add(src)
        db.flush()
        return row, src

    if not str(row.name).startswith(PREFIX):
        raise RuntimeError("refuse to modify connector without lab prefix")
    row.description = DESCRIPTION
    row.status = "RUNNING"
    db.add(row)
    src = (
        db.query(Source)
        .filter(Source.connector_id == int(row.id), Source.source_type == "WEBHOOK_RECEIVER")
        .order_by(Source.id.asc())
        .first()
    )
    if src is None:
        src = Source(
            connector_id=row.id,
            source_type="WEBHOOK_RECEIVER",
            config_json=cfg,
            auth_json=auth,
            enabled=True,
        )
        db.add(src)
    else:
        src.config_json = cfg
        src.auth_json = auth
        src.enabled = True
    db.add(src)
    db.flush()
    return row, src


def _upsert_stream(
    db: Session,
    *,
    connector: Connector,
    source: Source,
    stream_name: str,
    stream_type: str,
    config_json: dict[str, Any],
    polling_interval: int | None = None,
) -> Stream:
    row = db.query(Stream).filter(Stream.name == stream_name).first()
    st = str(stream_type).strip().upper()
    desired_polling = int(
        polling_interval
        if polling_interval is not None
        else lab_polling_interval_for_title(stream_name, prefix=PREFIX)
    )
    cfg = apply_lab_http_throughput_config(dict(config_json), stream_title=stream_name, prefix=PREFIX)
    if row is None:
        row = Stream(
            name=stream_name,
            connector_id=connector.id,
            source_id=source.id,
            stream_type=st,
            config_json=cfg,
            polling_interval=desired_polling,
            enabled=True,
            status="RUNNING",
            rate_limit_json={"max_requests": 120, "per_seconds": 60},
        )
        db.add(row)
        db.flush()
        return row

    if not str(row.name).startswith(PREFIX):
        raise RuntimeError(f"refuse to modify stream without lab prefix: {row.name!r}")
    row.connector_id = int(connector.id)
    row.source_id = int(source.id)
    row.stream_type = st
    row.config_json = cfg
    row.polling_interval = desired_polling
    row.enabled = True
    row.status = "RUNNING"
    row.rate_limit_json = {"max_requests": 120, "per_seconds": 60}
    db.add(row)
    db.flush()
    return row


def _upsert_mapping(
    db: Session,
    stream_id: int,
    *,
    event_array_path: str | None,
    event_root_path: str | None,
    field_mappings_json: dict[str, str],
) -> None:
    row = db.query(Mapping).filter(Mapping.stream_id == int(stream_id)).first()
    if row is None:
        db.add(
            Mapping(
                stream_id=int(stream_id),
                event_array_path=event_array_path,
                event_root_path=event_root_path,
                field_mappings_json=dict(field_mappings_json),
                raw_payload_mode="JSON",
            )
        )
        db.flush()
        return

    s = db.query(Stream).filter(Stream.id == int(row.stream_id)).first()
    if s is None or not str(s.name).startswith(PREFIX):
        raise RuntimeError("refuse to modify mapping for non-lab stream")
    row.event_array_path = event_array_path
    row.event_root_path = event_root_path
    row.field_mappings_json = dict(field_mappings_json)
    row.raw_payload_mode = "JSON"
    db.add(row)
    db.flush()


def _upsert_enrichment(db: Session, stream_id: int, *, tag: str) -> None:
    row = db.query(Enrichment).filter(Enrichment.stream_id == int(stream_id)).first()
    ej = {
        "vendor": "VisibleDevE2E",
        "product": "LocalLab",
        "log_type": f"visible_dev_e2e_{tag}",
        "event_source": "visible_dev_e2e",
        "collector_name": "visible-dev-e2e-seed",
        "tenant": "lab",
    }
    if row is None:
        db.add(
            Enrichment(
                stream_id=int(stream_id),
                enrichment_json=ej,
                override_policy="KEEP_EXISTING",
                enabled=True,
            )
        )
        db.flush()
        return

    s = db.query(Stream).filter(Stream.id == int(stream_id)).first()
    if s is None or not str(s.name).startswith(PREFIX):
        raise RuntimeError("refuse to modify enrichment for non-lab stream")
    row.enrichment_json = ej
    row.override_policy = "KEEP_EXISTING"
    row.enabled = True
    db.add(row)
    db.flush()


def _upsert_checkpoint(db: Session, stream_id: int) -> None:
    row = db.query(Checkpoint).filter(Checkpoint.stream_id == int(stream_id)).first()
    if row is None:
        db.add(
            Checkpoint(
                stream_id=int(stream_id),
                checkpoint_type="CUSTOM_FIELD",
                checkpoint_value_json={"last_cursor": None, "last_seen_id": None},
            )
        )
        db.flush()
        return

    s = db.query(Stream).filter(Stream.id == int(stream_id)).first()
    if s is None or not str(s.name).startswith(PREFIX):
        raise RuntimeError("refuse to modify checkpoint for non-lab stream")
    return


def _upsert_route(
    db: Session,
    *,
    stream_id: int,
    destination_id: int,
    failure_policy: str = "LOG_AND_CONTINUE",
) -> None:
    row = (
        db.query(Route)
        .filter(Route.stream_id == int(stream_id), Route.destination_id == int(destination_id))
        .first()
    )
    fmt = {"message_format": "json"}
    if row is None:
        db.add(
            Route(
                stream_id=int(stream_id),
                destination_id=int(destination_id),
                enabled=True,
                failure_policy=failure_policy,
                formatter_config_json=dict(fmt),
                rate_limit_json={"max_events": 2000, "per_seconds": 1},
                status="ENABLED",
            )
        )
        db.flush()
        return

    st = db.query(Stream).filter(Stream.id == int(stream_id)).first()
    de = db.query(Destination).filter(Destination.id == int(destination_id)).first()
    if st is None or not str(st.name).startswith(PREFIX):
        raise RuntimeError("refuse to modify route for non-lab stream")
    if de is None or not str(de.name).startswith(PREFIX):
        raise RuntimeError("refuse to modify route to non-lab destination")
    row.enabled = True
    row.failure_policy = failure_policy
    row.formatter_config_json = dict(fmt)
    row.rate_limit_json = {"max_events": 2000, "per_seconds": 1}
    row.status = "ENABLED"
    db.add(row)
    db.flush()


def seed_visible_e2e_fixtures(
    db: Session,
    *,
    local_dev_mode: bool,
    allow_compose_catalog_host: bool = False,
    allow_compose_service_hosts: bool = False,
) -> dict[str, Any]:
    assert_safe_database_url(
        local_dev_mode=local_dev_mode,
        allow_compose_catalog_host=allow_compose_catalog_host,
    )
    env = _load_env()
    _assert_local_service_urls(env, allow_compose_service_hosts=allow_compose_service_hosts)

    rl = {"max_events": 2000, "per_seconds": 1}

    dest_wm = _upsert_destination(
        db,
        name="WireMock Destination",
        destination_type="WEBHOOK_POST",
        config_json=lab_webhook_destination_config_patch(
            {
                "url": f"{env.wiremock_base_url}/dev-visible-e2e/webhook",
                "method": "POST",
                "headers": {"Content-Type": "application/json"},
                "timeout_seconds": 30,
                "retry_count": 2,
                "retry_backoff_seconds": 0.05,
            }
        ),
        rate_limit_json=rl,
    )
    dest_wh = _upsert_destination(
        db,
        name="Webhook Destination",
        destination_type="WEBHOOK_POST",
        config_json=lab_webhook_destination_config_patch(
            {
                "url": f"{env.webhook_base_url}/dev-visible-e2e",
                "method": "POST",
                "headers": {"Content-Type": "application/json"},
                "timeout_seconds": 30,
                "retry_count": 2,
                "retry_backoff_seconds": 0.05,
            }
        ),
        rate_limit_json=rl,
    )
    dest_udp = _upsert_destination(
        db,
        name="Syslog UDP Destination",
        destination_type="SYSLOG_UDP",
        config_json={"host": env.syslog_host, "port": env.syslog_plain_port, "timeout_seconds": 5},
        rate_limit_json=rl,
    )
    dest_tcp = _upsert_destination(
        db,
        name="Syslog TCP Destination",
        destination_type="SYSLOG_TCP",
        config_json={"host": env.syslog_host, "port": env.syslog_plain_port, "timeout_seconds": 5},
        rate_limit_json=rl,
    )
    dest_tls = _upsert_destination(
        db,
        name="Syslog TLS Destination",
        destination_type="SYSLOG_TLS",
        config_json={
            "host": env.syslog_host,
            "port": env.syslog_tls_port,
            "tls_enabled": True,
            "tls_verify_mode": "insecure_skip_verify",
            "timeout_seconds": 5,
        },
        rate_limit_json=rl,
    )

    http_c, http_s = _upsert_http_connector(db, env)
    s3_c, s3_s = _upsert_s3_connector(db, env)
    db_c, db_s = _upsert_database_connector(db, env)
    rf_c, rf_s = _upsert_remote_file_connector(db, env)
    wh_c, wh_s = _upsert_webhook_receiver_connector(db)

    st_http = _upsert_stream(
        db,
        connector=http_c,
        source=http_s,
        stream_name=f"{PREFIX}HTTP API Stream",
        stream_type="HTTP_API_POLLING",
        config_json={"endpoint": LAB_HTTP_HIGH_PATH, "method": "GET", "timeout_seconds": 45},
    )
    st_s3 = _upsert_stream(
        db,
        connector=s3_c,
        source=s3_s,
        stream_name=f"{PREFIX}S3 Object Stream",
        stream_type="S3_OBJECT_POLLING",
        config_json={"max_objects_per_run": 25},
    )
    st_db = _upsert_stream(
        db,
        connector=db_c,
        source=db_s,
        stream_name=f"{PREFIX}Database Query Stream",
        stream_type="DATABASE_QUERY",
        config_json={
            "query": (
                "SELECT id, event_id, message, severity, event_ts, ordering_seq "
                "FROM source_e2e_rows ORDER BY id"
            ),
            "max_rows_per_run": 100,
            "checkpoint_mode": "SINGLE_COLUMN",
            "checkpoint_column": "id",
            "query_timeout_seconds": 45,
        },
    )
    st_rf = _upsert_stream(
        db,
        connector=rf_c,
        source=rf_s,
        stream_name=f"{PREFIX}Remote File Stream",
        stream_type="REMOTE_FILE_POLLING",
        config_json={
            "remote_directory": "upload",
            "file_pattern": "e2e-remote.ndjson",
            "recursive": False,
            "parser_type": "NDJSON",
            "max_files_per_run": 15,
            "max_file_size_mb": 8,
        },
        polling_interval=lab_polling_interval_for_title(f"{PREFIX}Remote File Stream", prefix=PREFIX),
    )
    st_wh = _upsert_stream(
        db,
        connector=wh_c,
        source=wh_s,
        stream_name=f"{PREFIX}Webhook Receiver Stream",
        stream_type="WEBHOOK_RECEIVER",
        config_json={},
    )

    _upsert_mapping(
        db,
        st_http.id,
        event_array_path="$.data",
        event_root_path=None,
        field_mappings_json=DEFAULT_FIELD_MAPPINGS,
    )
    _upsert_mapping(db, st_s3.id, event_array_path=None, event_root_path=None, field_mappings_json=DEFAULT_FIELD_MAPPINGS)
    _upsert_mapping(db, st_db.id, event_array_path=None, event_root_path=None, field_mappings_json=DB_FIELD_MAPPINGS)
    _upsert_mapping(db, st_rf.id, event_array_path=None, event_root_path=None, field_mappings_json=DEFAULT_FIELD_MAPPINGS)
    _upsert_mapping(db, st_wh.id, event_array_path=None, event_root_path=None, field_mappings_json=DEFAULT_FIELD_MAPPINGS)

    _upsert_enrichment(db, int(st_http.id), tag="http")
    _upsert_enrichment(db, int(st_s3.id), tag="s3")
    _upsert_enrichment(db, int(st_db.id), tag="db")
    _upsert_enrichment(db, int(st_rf.id), tag="remote")
    _upsert_enrichment(db, int(st_wh.id), tag="webhook")

    for sid in (st_http.id, st_s3.id, st_db.id, st_rf.id, st_wh.id):
        _upsert_checkpoint(db, int(sid))

    for sid in (st_http.id, st_s3.id, st_db.id, st_rf.id):
        _upsert_route(db, stream_id=int(sid), destination_id=int(dest_wh.id))

    _upsert_route(db, stream_id=int(st_wh.id), destination_id=int(dest_wm.id))
    _upsert_route(db, stream_id=int(st_wh.id), destination_id=int(dest_wh.id))

    for dest in (dest_udp, dest_tcp, dest_tls):
        _upsert_route(db, stream_id=int(st_http.id), destination_id=int(dest.id))

    from app.dev_validation_lab.lab_throughput_sync import sync_lab_throughput_tuning

    sync_lab_throughput_tuning(db)
    db.commit()
    return {
        "ok": True,
        "connectors": [http_c.name, s3_c.name, db_c.name, rf_c.name, wh_c.name],
        "streams": [st_http.name, st_s3.name, st_db.name, st_rf.name, st_wh.name],
        "destinations": [dest_wm.name, dest_wh.name, dest_udp.name, dest_tcp.name, dest_tls.name],
        "webhook_receiver_key": VISIBLE_E2E_WEBHOOK_RECEIVER_KEY,
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Seed [DEV E2E] UI-visible fixtures into the platform catalog DB.")
    p.add_argument(
        "--local-dev-mode",
        action="store_true",
        help="Allow explicitly local disposable catalogs, including gdc_dev_* and legacy datarelay, on loopback only.",
    )
    args = p.parse_args(argv)

    from app.database import SessionLocal

    assert_safe_database_url(local_dev_mode=bool(args.local_dev_mode))
    _assert_local_service_urls(_load_env())

    db = SessionLocal()
    try:
        out = seed_visible_e2e_fixtures(db, local_dev_mode=bool(args.local_dev_mode))
        print(out)
        return 0
    except Exception as exc:
        db.rollback()
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
