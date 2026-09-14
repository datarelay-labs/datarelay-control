"""Shared helpers for external-service runtime E2E (StreamRunner via run-once / webhook ingest)."""

from __future__ import annotations

import os
import socket
import time
import uuid
from pathlib import Path
from collections.abc import Callable
from typing import Any

import boto3
import httpx
import paramiko
import psycopg2
from botocore.client import Config as BotoConfig
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.logs.models import DeliveryLog
from app.templates.registry import clear_template_cache
from tests.e2e_wiremock_helpers import (
    create_webhook_destination,
    delivery_log_stages,
    delivery_logs_by_stage,
    enable_stream_for_run,
    ensure_source_e2e_webhook_stub,
    reset_wiremock_journal,
    wiremock_received_json_bodies,
    wiremock_reachable,
)

WIREMOCK_BASE = os.getenv("WIREMOCK_BASE_URL", "http://127.0.0.1:28080").rstrip("/")
MINIO_ENDPOINT = os.getenv("SOURCE_E2E_MINIO_ENDPOINT", "http://127.0.0.1:59000").rstrip("/")
MINIO_BUCKET = os.getenv("SOURCE_E2E_MINIO_BUCKET", "gdc-source-e2e")
MINIO_ACCESS_KEY = os.getenv("SOURCE_E2E_MINIO_ACCESS_KEY", "gdcminioaccess")
MINIO_SECRET_KEY = os.getenv("SOURCE_E2E_MINIO_SECRET_KEY", "gdcminioaccesssecret12")
PG_FIXTURE_URL = os.getenv(
    "SOURCE_E2E_PG_FIXTURE_URL",
    "postgresql://gdc_fixture:gdc_fixture_pw@127.0.0.1:55433/gdc_query_fixture",
)
SFTP_HOST = os.getenv("SOURCE_E2E_SFTP_HOST", "127.0.0.1")
SFTP_PORT = int(os.getenv("SOURCE_E2E_SFTP_PORT", "22222"))
SFTP_USER = os.getenv("SOURCE_E2E_SFTP_USER", "gdc")
SFTP_PASSWORD = os.getenv("SOURCE_E2E_SFTP_PASSWORD", "devlab123")
WEBHOOK_ECHO_URL = os.getenv("E2E_WEBHOOK_ECHO_URL", "http://127.0.0.1:18091").rstrip("/")

POLL_INTERVAL_SEC = float(os.getenv("E2E_POLL_INTERVAL_SEC", "0.25"))
POLL_TIMEOUT_SEC = float(os.getenv("E2E_POLL_TIMEOUT_SEC", "30"))


def tcp_open(host: str, port: int, timeout: float = 0.5) -> bool:
    try:
        with socket.create_connection((host, int(port)), timeout=timeout):
            return True
    except OSError:
        return False


def minio_reachable() -> bool:
    host = os.getenv("SOURCE_E2E_MINIO_HOST", "127.0.0.1")
    port = int(os.getenv("SOURCE_E2E_MINIO_PORT", "59000"))
    return tcp_open(host, port)


def pg_fixture_reachable() -> bool:
    host = os.getenv("SOURCE_E2E_PG_FIXTURE_HOST", "127.0.0.1")
    port = int(os.getenv("SOURCE_E2E_PG_FIXTURE_PORT", "55433"))
    return tcp_open(host, port)


def sftp_reachable() -> bool:
    return tcp_open(SFTP_HOST, SFTP_PORT)


def wiremock_ok() -> bool:
    return wiremock_reachable(WIREMOCK_BASE)


def wait_until(
    predicate: Callable[[], bool],
    *,
    timeout_sec: float = POLL_TIMEOUT_SEC,
    interval_sec: float = POLL_INTERVAL_SEC,
    label: str = "condition",
) -> None:
    deadline = time.monotonic() + timeout_sec
    last_err: str | None = None
    while time.monotonic() < deadline:
        try:
            if predicate():
                return
        except Exception as exc:  # noqa: BLE001 — poll helper
            last_err = str(exc)
        time.sleep(interval_sec)
    detail = f" (last error: {last_err})" if last_err else ""
    raise TimeoutError(f"Timed out waiting for {label} after {timeout_sec}s{detail}")


def checkpoint_snapshot(db: Session, stream_id: int) -> dict[str, Any]:
    db.expire_all()
    row = db.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).first()
    if row is None:
        return {}
    data = row.checkpoint_value_json
    return dict(data) if isinstance(data, dict) else {}


def wait_for_checkpoint_change(
    db: Session,
    stream_id: int,
    before: dict[str, Any],
    *,
    timeout_sec: float = POLL_TIMEOUT_SEC,
) -> dict[str, Any]:
    def _changed() -> bool:
        cur = checkpoint_snapshot(db, stream_id)
        return cur != before

    wait_until(_changed, timeout_sec=timeout_sec, label=f"checkpoint change stream_id={stream_id}")
    return checkpoint_snapshot(db, stream_id)


def wait_for_delivery_log_stage(
    db: Session,
    stream_id: int,
    stage: str,
    *,
    min_count: int = 1,
    timeout_sec: float = POLL_TIMEOUT_SEC,
) -> list[DeliveryLog]:
    def _has_rows() -> bool:
        db.expire_all()
        rows = delivery_logs_by_stage(db, stream_id, stage)
        return len(rows) >= min_count

    wait_until(_has_rows, timeout_sec=timeout_sec, label=f"delivery_log stage={stage}")
    return delivery_logs_by_stage(db, stream_id, stage)


def ensure_checkpoint(db: Session, stream_id: int) -> None:
    row = db.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).first()
    if row is None:
        db.add(
            Checkpoint(
                stream_id=stream_id,
                checkpoint_type="CUSTOM_FIELD",
                checkpoint_value_json={},
            )
        )
        db.commit()


def save_mapping_enrichment(client: TestClient, stream_id: int, *, vendor: str = "ExternalRuntimeE2E") -> None:
    mr = client.post(
        f"/api/v1/runtime/mappings/stream/{stream_id}/save",
        json={
            "field_mappings": {
                "event_id": "$.id",
                "message": "$.message",
                "severity": "$.severity",
            },
        },
    )
    assert mr.status_code == 200, mr.text
    er = client.post(
        f"/api/v1/runtime/enrichments/stream/{stream_id}/save",
        json={
            "enrichment": {"vendor": vendor},
            "override_policy": "fill_missing",
            "enabled": True,
        },
    )
    assert er.status_code == 200, er.text


def _minio_client():
    session = boto3.session.Session(
        aws_access_key_id=MINIO_ACCESS_KEY,
        aws_secret_access_key=MINIO_SECRET_KEY,
        region_name="us-east-1",
    )
    return session.client(
        "s3",
        endpoint_url=MINIO_ENDPOINT,
        use_ssl=MINIO_ENDPOINT.lower().startswith("https://"),
        config=BotoConfig(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


def put_minio_object(key: str, body: bytes, *, content_type: str = "application/octet-stream") -> None:
    client = _minio_client()
    try:
        client.create_bucket(Bucket=MINIO_BUCKET)
    except Exception:
        pass
    client.put_object(Bucket=MINIO_BUCKET, Key=key, Body=body, ContentType=content_type)


def isolated_s3_prefix(suffix: str) -> str:
    """Per-test MinIO prefix (avoids shared e2e-s3/ lab-feed pollution)."""

    return f"e2e-runtime/{suffix}/"


def seed_isolated_s3_objects(suffix: str, files: dict[str, bytes]) -> str:
    """Upload objects under an isolated prefix and return that prefix."""

    prefix = isolated_s3_prefix(suffix)
    for name, body in files.items():
        key = name if name.startswith(prefix) else f"{prefix}{name.lstrip('/')}"
        put_minio_object(key, body)
    return prefix


def delete_minio_prefix(prefix: str) -> None:
    """Best-effort delete of objects under ``prefix`` (test cleanup only)."""

    client = _minio_client()
    continuation: str | None = None
    try:
        while True:
            kwargs: dict[str, Any] = {"Bucket": MINIO_BUCKET, "Prefix": prefix}
            if continuation:
                kwargs["ContinuationToken"] = continuation
            resp = client.list_objects_v2(**kwargs)
            keys = [{"Key": obj["Key"]} for obj in resp.get("Contents") or [] if obj.get("Key")]
            if keys:
                client.delete_objects(Bucket=MINIO_BUCKET, Delete={"Objects": keys, "Quiet": True})
            if not resp.get("IsTruncated"):
                break
            continuation = resp.get("NextContinuationToken")
    except Exception:
        pass


def reset_pg_fixture_seed() -> None:
    """Restore deterministic source_e2e_rows (same as scripts/testing/source-e2e/seed-fixtures.sh)."""

    conn = psycopg2.connect(PG_FIXTURE_URL)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                DELETE FROM source_e2e_rows;
                INSERT INTO source_e2e_rows (event_id, message, severity, event_ts, ordering_seq) VALUES
                 ('e2e-db-1', 'first row', 'low', '2020-01-01T00:00:00Z', 1),
                 ('e2e-db-2', 'second row', 'medium', '2020-01-01T00:00:01Z', 1),
                 ('e2e-db-3', 'third row', 'high', '2020-01-01T00:00:02Z', 1);
                """
            )
        conn.commit()
    finally:
        conn.close()


def insert_pg_fixture_rows(rows: list[tuple[str, str, str, str, int]]) -> None:
    """Insert rows into source_e2e_rows: (event_id, message, severity, event_ts_iso, ordering_seq)."""

    conn = psycopg2.connect(PG_FIXTURE_URL)
    try:
        with conn.cursor() as cur:
            for event_id, message, severity, event_ts, ordering_seq in rows:
                cur.execute(
                    """
                    INSERT INTO source_e2e_rows (event_id, message, severity, event_ts, ordering_seq)
                    VALUES (%s, %s, %s, %s::timestamptz, %s)
                    """,
                    (event_id, message, severity, event_ts, ordering_seq),
                )
        conn.commit()
    finally:
        conn.close()


def _sftp_fixture_container() -> str:
    """Resolve the compose SFTP container name (honors GDC_TEST_CONTAINER_PREFIX)."""

    explicit = (os.getenv("SOURCE_E2E_SFTP_CONTAINER") or "").strip()
    if explicit:
        return explicit
    prefix = (os.getenv("GDC_TEST_CONTAINER_PREFIX") or "gdc").strip() or "gdc"
    return f"{prefix}-sftp-test"


def upload_sftp_file(remote_name: str, content: bytes, *, remote_directory: str = "upload") -> None:
    """Upload into the atmoz/sftp fixture (docker cp; SFTP write is read-only in the test image)."""

    import subprocess
    import tempfile

    container = _sftp_fixture_container()
    with tempfile.NamedTemporaryFile(delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name
    remote_path = f"/home/gdc/{remote_directory.rstrip('/')}/{remote_name}"
    result = subprocess.run(
        ["docker", "cp", tmp_path, f"{container}:{remote_path}"],
        capture_output=True,
        text=True,
        check=False,
    )
    Path(tmp_path).unlink(missing_ok=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"SFTP fixture upload failed ({container}:{remote_path}): {result.stderr or result.stdout}"
        )
    subprocess.run(
        ["docker", "exec", container, "chmod", "644", remote_path],
        capture_output=True,
        check=False,
    )


def post_webhook_ingest(
    client: TestClient,
    receiver_key: str,
    *,
    json_body: dict[str, Any] | None = None,
    raw_content: str | bytes | None = None,
    headers: dict[str, str] | None = None,
) -> Any:
    path = f"/api/v1/ingest/webhook/{receiver_key}"
    hdrs = dict(headers or {})
    if raw_content is not None:
        return client.post(path, content=raw_content, headers=hdrs)
    return client.post(path, json=json_body or {}, headers=hdrs)


def create_s3_connector_and_stream(
    client: TestClient,
    *,
    name_suffix: str,
    prefix: str,
    stream_config: dict[str, Any],
    source_extras: dict[str, Any] | None = None,
) -> tuple[int, int, int]:
    payload: dict[str, Any] = {
        "name": f"e2e-s3-{name_suffix}",
        "source_type": "S3_OBJECT_POLLING",
        "auth_type": "no_auth",
        "endpoint_url": MINIO_ENDPOINT,
        "bucket": MINIO_BUCKET,
        "region": "us-east-1",
        "access_key": MINIO_ACCESS_KEY,
        "secret_key": MINIO_SECRET_KEY,
        "prefix": prefix,
        "path_style_access": True,
        "use_ssl": False,
    }
    if source_extras:
        payload.update(source_extras)
    cr = client.post("/api/v1/connectors/", json=payload)
    assert cr.status_code == 201, cr.text
    body = cr.json()
    connector_id = int(body["id"])
    source_id = int(body["source_id"])
    sr = client.post(
        "/api/v1/streams/",
        json={
            "name": f"e2e-s3-stream-{name_suffix}",
            "connector_id": connector_id,
            "source_id": source_id,
            "stream_type": "S3_OBJECT_POLLING",
            "config_json": stream_config,
            "polling_interval": 60,
            "enabled": False,
            "status": "STOPPED",
            "rate_limit_json": {"max_requests": 100, "per_seconds": 60},
        },
    )
    assert sr.status_code == 201, sr.text
    return connector_id, source_id, int(sr.json()["id"])


def create_db_query_connector_and_stream(
    client: TestClient,
    *,
    name_suffix: str,
    stream_config: dict[str, Any],
) -> tuple[int, int, int]:
    cr = client.post(
        "/api/v1/connectors/",
        json={
            "name": f"e2e-db-{name_suffix}",
            "source_type": "DATABASE_QUERY",
            "auth_type": "no_auth",
            "db_type": "POSTGRESQL",
            "host": os.getenv("SOURCE_E2E_PG_FIXTURE_HOST", "127.0.0.1"),
            "port": int(os.getenv("SOURCE_E2E_PG_FIXTURE_PORT", "55433")),
            "database": "gdc_query_fixture",
            "db_username": "gdc_fixture",
            "db_password": "gdc_fixture_pw",
            "ssl_mode": "DISABLE",
            "connection_timeout_seconds": 15,
        },
    )
    assert cr.status_code == 201, cr.text
    body = cr.json()
    connector_id = int(body["id"])
    source_id = int(body["source_id"])
    sr = client.post(
        "/api/v1/streams/",
        json={
            "name": f"e2e-db-stream-{name_suffix}",
            "connector_id": connector_id,
            "source_id": source_id,
            "stream_type": "DATABASE_QUERY",
            "config_json": stream_config,
            "polling_interval": 60,
            "enabled": False,
            "status": "STOPPED",
            "rate_limit_json": {"max_requests": 100, "per_seconds": 60},
        },
    )
    assert sr.status_code == 201, sr.text
    return connector_id, source_id, int(sr.json()["id"])


def create_remote_file_connector_and_stream(
    client: TestClient,
    *,
    name_suffix: str,
    stream_config: dict[str, Any],
) -> tuple[int, int, int]:
    cr = client.post(
        "/api/v1/connectors/",
        json={
            "name": f"e2e-sftp-{name_suffix}",
            "source_type": "REMOTE_FILE_POLLING",
            "auth_type": "no_auth",
            "host": SFTP_HOST,
            "port": SFTP_PORT,
            "remote_username": SFTP_USER,
            "remote_password": SFTP_PASSWORD,
            "remote_file_protocol": "sftp",
            "known_hosts_policy": "insecure_skip_verify",
            "connection_timeout_seconds": 25,
        },
    )
    assert cr.status_code == 201, cr.text
    body = cr.json()
    connector_id = int(body["id"])
    source_id = int(body["source_id"])
    sr = client.post(
        "/api/v1/streams/",
        json={
            "name": f"e2e-rf-stream-{name_suffix}",
            "connector_id": connector_id,
            "source_id": source_id,
            "stream_type": "REMOTE_FILE_POLLING",
            "config_json": stream_config,
            "polling_interval": 60,
            "enabled": False,
            "status": "STOPPED",
            "rate_limit_json": {"max_requests": 100, "per_seconds": 60},
        },
    )
    assert sr.status_code == 201, sr.text
    return connector_id, source_id, int(sr.json()["id"])


def create_webhook_receiver_stack(
    client: TestClient,
    db: Session,
    *,
    name_suffix: str,
    receiver_key: str,
    webhook_auth_mode: str = "shared_secret_header",
    shared_secret: str = "runtime-e2e-secret",
    enabled_stream: bool = True,
) -> dict[str, Any]:
    cr = client.post(
        "/api/v1/connectors/",
        json={
            "name": f"e2e-wh-{name_suffix}",
            "source_type": "WEBHOOK_RECEIVER",
            "auth_type": "no_auth",
            "receiver_key": receiver_key,
            "webhook_auth_mode": webhook_auth_mode,
            "webhook_shared_secret": shared_secret,
            "webhook_auth_header_name": "X-GDC-Webhook-Secret",
            "max_request_bytes": 1_048_576,
        },
    )
    assert cr.status_code == 201, cr.text
    connector_id = int(cr.json()["id"])
    source_id = int(cr.json()["source_id"])
    sr = client.post(
        "/api/v1/streams/",
        json={
            "name": f"e2e-wh-stream-{name_suffix}",
            "connector_id": connector_id,
            "source_id": source_id,
            "stream_type": "WEBHOOK_RECEIVER",
            "config_json": {},
            "polling_interval": 60,
            "enabled": enabled_stream,
            "rate_limit_json": {"max_requests": 1000, "per_seconds": 60},
        },
    )
    assert sr.status_code == 201, sr.text
    stream_id = int(sr.json()["id"])
    if enabled_stream:
        enable_stream_for_run(client, stream_id)
    save_mapping_enrichment(client, stream_id, vendor="WebhookRuntimeE2E")
    ensure_checkpoint(db, stream_id)
    return {
        "connector_id": connector_id,
        "source_id": source_id,
        "stream_id": stream_id,
        "receiver_key": receiver_key,
        "shared_secret": shared_secret,
    }


def wiremock_route(
    client: TestClient,
    stream_id: int,
    wm_path: str,
    *,
    failure_policy: str = "LOG_AND_CONTINUE",
    retry_count: int = 0,
) -> int:
    url = f"{WIREMOCK_BASE}{wm_path}"
    dest = client.post(
        "/api/v1/destinations/",
        json={
            "name": f"wm-dest-{uuid.uuid4().hex[:8]}",
            "destination_type": "WEBHOOK_POST",
            "config_json": {
                "url": url,
                "retry_count": retry_count,
                "retry_backoff_seconds": 0.01,
            },
            "rate_limit_json": {"max_events": 1000, "per_seconds": 1},
        },
    )
    assert dest.status_code == 201, dest.text
    dest_id = int(dest.json()["id"])
    rr = client.post(
        "/api/v1/routes/",
        json={
            "stream_id": stream_id,
            "destination_id": dest_id,
            "failure_policy": failure_policy,
        },
    )
    assert rr.status_code == 201, rr.text
    return dest_id


def route_to_destination(
    client: TestClient,
    stream_id: int,
    dest_id: int,
    *,
    failure_policy: str = "LOG_AND_CONTINUE",
) -> None:
    rr = client.post(
        "/api/v1/routes/",
        json={
            "stream_id": stream_id,
            "destination_id": dest_id,
            "failure_policy": failure_policy,
        },
    )
    assert rr.status_code == 201, rr.text


def prepare_wiremock_run(client: TestClient, stream_id: int, wm_path: str) -> None:
    ensure_source_e2e_webhook_stub(WIREMOCK_BASE)
    reset_wiremock_journal(WIREMOCK_BASE)
    wiremock_route(client, stream_id, wm_path)
    enable_stream_for_run(client, stream_id)


def run_once(client: TestClient, stream_id: int) -> dict[str, Any]:
    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    return run.json()


def assert_observability_after_success(
    client: TestClient,
    db: Session,
    stream_id: int,
    *,
    expect_checkpoint_update: bool = True,
) -> str:
    from tests.e2e_wiremock_helpers import assert_run_observability_core

    wait_for_delivery_log_stage(db, stream_id, "run_complete")
    run_id = assert_run_observability_core(db, stream_id, expect_checkpoint_update=expect_checkpoint_update)
    metrics = client.get(f"/api/v1/runtime/streams/{stream_id}/metrics?window=24h")
    assert metrics.status_code == 200, metrics.text
    kpis = metrics.json().get("kpis") or {}
    assert int(kpis.get("events_last_hour") or 0) >= 1 or int(kpis.get("delivered_last_hour") or 0) >= 1
    health = client.get(f"/api/v1/runtime/health/streams/{stream_id}?window=24h")
    assert health.status_code == 200, health.text
    assert "score" in health.json()
    logs_page = client.get(f"/api/v1/runtime/logs/page?stream_id={stream_id}&limit=20")
    assert logs_page.status_code == 200, logs_page.text
    page_body = logs_page.json()
    items = page_body.get("items") or page_body.get("logs") or []
    assert items, "expected recent delivery_logs on logs/page"
    return run_id


__all__ = [
    "WIREMOCK_BASE",
    "checkpoint_snapshot",
    "create_db_query_connector_and_stream",
    "create_remote_file_connector_and_stream",
    "create_s3_connector_and_stream",
    "create_webhook_destination",
    "create_webhook_receiver_stack",
    "delivery_log_stages",
    "ensure_checkpoint",
    "insert_pg_fixture_rows",
    "minio_reachable",
    "pg_fixture_reachable",
    "post_webhook_ingest",
    "prepare_wiremock_run",
    "put_minio_object",
    "run_once",
    "save_mapping_enrichment",
    "sftp_reachable",
    "upload_sftp_file",
    "wait_for_checkpoint_change",
    "wait_for_delivery_log_stage",
    "wiremock_ok",
    "wiremock_received_json_bodies",
    "wiremock_route",
]
