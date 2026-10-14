"""End-to-end tests for S3_OBJECT_POLLING, DATABASE_QUERY, and REMOTE_FILE_POLLING (local fixtures).

Exercises WEBHOOK_POST (WireMock) and direct SYSLOG_UDP / SYSLOG_TCP / SYSLOG_TLS delivery.

Requires docker-compose.test.yml services (see docs/testing/source-adapter-e2e.md).
Run: ./scripts/test/run-source-e2e-tests.sh or pytest -m source_e2e
"""

from __future__ import annotations

import os
import socket
import uuid
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.database import get_db
from app.logs.models import DeliveryLog
from app.main import app
from app.templates.registry import clear_template_cache
from tests.e2e_syslog_helpers import (
    create_syslog_tcp_destination,
    create_syslog_tls_destination,
    create_syslog_udp_destination,
    wait_for_syslog_json_duck,
    wait_for_syslog_message,
)
from tests.e2e_runtime_helpers import seed_isolated_s3_objects, upload_sftp_file
from tests.e2e_wiremock_helpers import (
    assert_run_observability_core,
    create_webhook_destination,
    delivery_log_stages,
    enable_stream_for_run,
    ensure_source_e2e_webhook_stub,
    reset_wiremock_journal,
    wiremock_received_json_bodies,
    wiremock_reachable,
)
from tests.syslog_tls_helpers import SyslogTlsTestReceiver, write_self_signed_cert

pytestmark = pytest.mark.source_e2e

WIREMOCK_BASE = os.getenv("WIREMOCK_BASE_URL", "http://127.0.0.1:28080").rstrip("/")

skip_no_wiremock = pytest.mark.skipif(
    not wiremock_reachable(WIREMOCK_BASE),
    reason=f"WireMock not reachable at {WIREMOCK_BASE}",
)


def _tcp_open(host: str, port: int, timeout: float = 0.5) -> bool:
    try:
        with socket.create_connection((host, int(port)), timeout=timeout):
            return True
    except OSError:
        return False


def _minio_ok() -> bool:
    host = os.getenv("SOURCE_E2E_MINIO_HOST", "127.0.0.1")
    port = int(os.getenv("SOURCE_E2E_MINIO_PORT", "59000"))
    return _tcp_open(host, port)


def _pg_fixture_ok() -> bool:
    host = os.getenv("SOURCE_E2E_PG_FIXTURE_HOST", "127.0.0.1")
    port = int(os.getenv("SOURCE_E2E_PG_FIXTURE_PORT", "55433"))
    return _tcp_open(host, port)


def _sftp_ok() -> bool:
    host = os.getenv("SOURCE_E2E_SFTP_HOST", "127.0.0.1")
    port = int(os.getenv("SOURCE_E2E_SFTP_PORT", "22222"))
    return _tcp_open(host, port)


skip_no_minio = pytest.mark.skipif(not _minio_ok(), reason="MinIO fixture port not open (start minio-test)")
skip_no_pg_fixture = pytest.mark.skipif(not _pg_fixture_ok(), reason="postgres-query-test port not open")
skip_no_sftp = pytest.mark.skipif(not _sftp_ok(), reason="sftp-test port not open")


@pytest.fixture
def client(db_session: Session) -> TestClient:
    clear_template_cache()

    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)
        clear_template_cache()


def _ensure_checkpoint(db: Session, stream_id: int) -> None:
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


def _save_mapping_enrichment(client: TestClient, stream_id: int) -> None:
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
        json={"enrichment": {"vendor": "SourceAdapterE2E"}, "override_policy": "fill_missing", "enabled": True},
    )
    assert er.status_code == 200, er.text


def _create_s3_connector_and_stream(
    client: TestClient,
    *,
    name_suffix: str,
    prefix: str,
    stream_config: dict[str, Any],
) -> tuple[int, int, int]:
    endpoint = os.getenv("SOURCE_E2E_MINIO_ENDPOINT", "http://127.0.0.1:59000").rstrip("/")
    bucket = os.getenv("SOURCE_E2E_MINIO_BUCKET", "gdc-source-e2e")
    ak = os.getenv("SOURCE_E2E_MINIO_ACCESS_KEY", "gdcminioaccess")
    sk = os.getenv("SOURCE_E2E_MINIO_SECRET_KEY", "gdcminioaccesssecret12")
    cr = client.post(
        "/api/v1/connectors/",
        json={
            "name": f"e2e-s3-{name_suffix}",
            "source_type": "S3_OBJECT_POLLING",
            "auth_type": "no_auth",
            "endpoint_url": endpoint,
            "bucket": bucket,
            "region": "us-east-1",
            "access_key": ak,
            "secret_key": sk,
            "prefix": prefix,
            "path_style_access": True,
            "use_ssl": False,
        },
    )
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
    stream_id = int(sr.json()["id"])
    return connector_id, source_id, stream_id


def _create_db_query_connector_and_stream(
    client: TestClient,
    *,
    name_suffix: str,
    stream_config: dict[str, Any],
) -> tuple[int, int, int]:
    pg_url = os.getenv(
        "SOURCE_E2E_PG_FIXTURE_URL",
        "postgresql://gdc_fixture:gdc_fixture_pw@127.0.0.1:55433/gdc_query_fixture",
    )
    cr = client.post(
        "/api/v1/connectors/",
        json={
            "name": f"e2e-db-{name_suffix}",
            "source_type": "DATABASE_QUERY",
            "auth_type": "no_auth",
            "db_type": "POSTGRESQL",
            "host": "127.0.0.1",
            "port": 55433,
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
    stream_id = int(sr.json()["id"])
    return connector_id, source_id, stream_id


def _seed_isolated_sftp_ndjson(suffix: str) -> tuple[str, int]:
    """Upload a per-test NDJSON file so external_e2e tests cannot clobber shared paths."""

    filename = f"e2e-rf-{suffix}.ndjson"
    upload_sftp_file(
        filename,
        b'{"id":"e2e-rf-1","message":"remote ndjson one","severity":"info"}\n'
        b'{"id":"e2e-rf-2","message":"remote ndjson two","severity":"low"}\n',
    )
    return filename, 2


def _create_remote_file_connector_and_stream(
    client: TestClient,
    *,
    name_suffix: str,
    stream_config: dict[str, Any],
) -> tuple[int, int, int]:
    host = os.getenv("SOURCE_E2E_SFTP_HOST", "127.0.0.1")
    port = int(os.getenv("SOURCE_E2E_SFTP_PORT", "22222"))
    cr = client.post(
        "/api/v1/connectors/",
        json={
            "name": f"e2e-sftp-{name_suffix}",
            "source_type": "REMOTE_FILE_POLLING",
            "auth_type": "no_auth",
            "host": host,
            "port": port,
            "remote_username": "gdc",
            "remote_password": "devlab123",
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
    stream_id = int(sr.json()["id"])
    return connector_id, source_id, stream_id


def _wirehook_and_route(
    client: TestClient,
    stream_id: int,
    *,
    wm_path: str,
    failure_policy: str = "LOG_AND_CONTINUE",
) -> int:
    dest_id = create_webhook_destination(client, WIREMOCK_BASE, path=wm_path)
    _route_to_destination(client, stream_id, dest_id, failure_policy=failure_policy)
    return dest_id


def _route_to_destination(
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


def _run_once_syslog_delivery_ok(
    client: TestClient,
    db_session: Session,
    stream_id: int,
    receiver: Any,
    *,
    expect_min_extracted: int,
    vendor: str = "SourceAdapterE2E",
) -> None:
    """run-once → syslog receives enriched payload → delivery_logs + checkpoint-after-success."""

    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    body = run.json()
    assert body.get("checkpoint_updated") is True
    assert int(body.get("extracted_event_count") or 0) >= expect_min_extracted

    pred = lambda ev: ev.get("vendor") == vendor
    if isinstance(receiver, SyslogTlsTestReceiver):
        wait_for_syslog_json_duck(receiver, pred)
    else:
        wait_for_syslog_message(receiver, pred)

    db_session.expire_all()
    assert_run_observability_core(db_session, stream_id, expect_checkpoint_update=True)
    assert "route_send_success" in delivery_log_stages(db_session, stream_id)


@skip_no_wiremock
@skip_no_minio
def test_s3_prefix_ndjson_and_array_checkpoint_etag(
    client: TestClient, db_session: Session
) -> None:
    ensure_source_e2e_webhook_stub(WIREMOCK_BASE)
    reset_wiremock_journal(WIREMOCK_BASE)
    suffix = uuid.uuid4().hex[:8]
    prefix = seed_isolated_s3_objects(
        suffix,
        {
            "aaa.ndjson": b'{"id":"e2e-s3-a1","message":"aaa first","severity":"info"}\n',
            "bbb.ndjson": b'{"id":"e2e-s3-b1","message":"bbb second","severity":"info"}\n',
            "array.json": b'[{"id":"e2e-arr-1","message":"from array","severity":"info"}]',
        },
    )
    _, _, stream_id = _create_s3_connector_and_stream(
        client,
        name_suffix=suffix,
        prefix=prefix,
        stream_config={"max_objects_per_run": 10},
    )
    _save_mapping_enrichment(client, stream_id)
    _wirehook_and_route(client, stream_id, wm_path="/source-e2e/recv-s3")
    _ensure_checkpoint(db_session, stream_id)
    enable_stream_for_run(client, stream_id)

    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    assert run.json().get("checkpoint_updated") is True
    assert int(run.json().get("extracted_event_count") or 0) >= 3

    db_session.expire_all()
    assert_run_observability_core(db_session, stream_id, expect_checkpoint_update=True)
    assert "route_send_success" in delivery_log_stages(db_session, stream_id)

    cp = db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).first()
    assert cp is not None
    data = dict(cp.checkpoint_value_json or {})
    assert data.get("last_processed_key")
    assert data.get("last_processed_last_modified")
    assert data.get("last_processed_etag")

    bodies = wiremock_received_json_bodies(WIREMOCK_BASE, path_contains="/source-e2e/recv-s3")
    assert bodies, "expected webhook bodies in WireMock"
    vendors = {str(b.get("vendor")) for b in bodies}
    assert "SourceAdapterE2E" in vendors


@skip_no_wiremock
@skip_no_minio
def test_s3_max_objects_watermark_advances_across_runs(
    client: TestClient, db_session: Session
) -> None:
    ensure_source_e2e_webhook_stub(WIREMOCK_BASE)
    reset_wiremock_journal(WIREMOCK_BASE)
    suffix = uuid.uuid4().hex[:8]
    prefix = seed_isolated_s3_objects(
        suffix,
        {
            "aaa.ndjson": b'{"id":"e2e-s3-a1","message":"aaa first","severity":"info"}\n',
            "bbb.ndjson": b'{"id":"e2e-s3-b1","message":"bbb second","severity":"info"}\n',
        },
    )
    _, _, stream_id = _create_s3_connector_and_stream(
        client,
        name_suffix=suffix,
        prefix=prefix,
        stream_config={"max_objects_per_run": 1},
    )
    _save_mapping_enrichment(client, stream_id)
    _wirehook_and_route(client, stream_id, wm_path="/source-e2e/recv-s3-wm")
    _ensure_checkpoint(db_session, stream_id)
    enable_stream_for_run(client, stream_id)

    r1 = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert r1.status_code == 200, r1.text
    assert r1.json().get("checkpoint_updated") is True
    db_session.expire_all()
    row_a = db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).first()
    assert row_a is not None
    cp1 = dict(row_a.checkpoint_value_json or {})
    k1 = str(cp1.get("last_processed_key") or "")

    r2 = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert r2.status_code == 200, r2.text
    assert r2.json().get("checkpoint_updated") is True
    db_session.expire_all()
    row_b = db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).first()
    assert row_b is not None
    cp2 = dict(row_b.checkpoint_value_json or {})
    k2 = str(cp2.get("last_processed_key") or "")
    assert k1 and k2 and k1 != k2


@skip_no_wiremock
@skip_no_minio
def test_s3_lenient_ndjson_skips_malformed_line(
    client: TestClient, db_session: Session
) -> None:
    ensure_source_e2e_webhook_stub(WIREMOCK_BASE)
    reset_wiremock_journal(WIREMOCK_BASE)
    suffix = uuid.uuid4().hex[:8]
    prefix = seed_isolated_s3_objects(
        suffix,
        {
            "mixed.ndjson": (
                b'{"id":"e2e-s3-ok","message":"valid","severity":"low"}\n'
                b"NOT_JSON_LINE\n"
                b'{"id":"e2e-s3-ok2","message":"after skip","severity":"low"}\n'
            ),
        },
    )
    _, _, stream_id = _create_s3_connector_and_stream(
        client,
        name_suffix=suffix,
        prefix=prefix,
        stream_config={"max_objects_per_run": 20},
    )
    _save_mapping_enrichment(client, stream_id)
    _wirehook_and_route(client, stream_id, wm_path=f"/source-e2e/recv-s3-mix-{suffix}")
    _ensure_checkpoint(db_session, stream_id)
    enable_stream_for_run(client, stream_id)

    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    bodies = wiremock_received_json_bodies(
        WIREMOCK_BASE, path_contains=f"/source-e2e/recv-s3-mix-{suffix}"
    )
    ids = [str(b.get("event_id") or b.get("id") or "") for b in bodies]
    assert any("e2e-s3-ok" in i for i in ids)
    assert any("e2e-s3-ok2" in i for i in ids)


@skip_no_minio
def test_s3_strict_json_lines_malformed_source_fetch_error(
    client: TestClient, db_session: Session
) -> None:
    suffix = uuid.uuid4().hex[:8]
    _, _, stream_id = _create_s3_connector_and_stream(
        client,
        name_suffix=suffix,
        prefix="e2e-s3-strict/",
        stream_config={"max_objects_per_run": 5, "strict_json_lines": True},
    )
    _save_mapping_enrichment(client, stream_id)
    dest = client.post(
        "/api/v1/destinations/",
        json={
            "name": f"e2e-dummy-{suffix}",
            "destination_type": "WEBHOOK_POST",
            "config_json": {"url": "http://127.0.0.1:18091/anything"},
            "rate_limit_json": {"max_events": 1000, "per_seconds": 1},
        },
    )
    assert dest.status_code == 201, dest.text
    dest_id = int(dest.json()["id"])
    rr = client.post(
        "/api/v1/routes/",
        json={"stream_id": stream_id, "destination_id": dest_id, "failure_policy": "LOG_AND_CONTINUE"},
    )
    assert rr.status_code == 201, rr.text
    _ensure_checkpoint(db_session, stream_id)
    enable_stream_for_run(client, stream_id)

    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 502, run.text
    detail = run.json().get("detail")
    if isinstance(detail, dict):
        assert detail.get("error_code") == "SOURCE_FETCH_FAILED"


@skip_no_pg_fixture
def test_database_query_discovery_lists_real_fixture_metadata(
    client: TestClient, db_session: Session
) -> None:
    suffix = uuid.uuid4().hex[:8]
    connector_id, _, _ = _create_db_query_connector_and_stream(
        client,
        name_suffix=suffix,
        stream_config={
            "query": "SELECT id, event_id, message FROM source_e2e_rows",
            "checkpoint_mode": "NONE",
            "query_timeout_seconds": 30,
        },
    )

    response = client.post(
        "/api/v1/runtime/api-test/database-discovery",
        json={"connector_id": connector_id},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    assert body["db_type"] == "POSTGRESQL"
    assert body["database"] == "gdc_query_fixture"
    assert "public" in body["schemas"]

    relation = next(
        item
        for item in body["tables"]
        if item["schema_name"] == "public" and item["table_name"] == "source_e2e_rows"
    )
    column_names = [item["name"] for item in relation["columns"]]
    assert "id" in column_names
    assert "event_id" in column_names
    assert "event_ts" in column_names


@skip_no_wiremock
@skip_no_pg_fixture
def test_database_query_incremental_checkpoint_second_run_empty(
    client: TestClient, db_session: Session
) -> None:
    ensure_source_e2e_webhook_stub(WIREMOCK_BASE)
    reset_wiremock_journal(WIREMOCK_BASE)
    suffix = uuid.uuid4().hex[:8]
    _, _, stream_id = _create_db_query_connector_and_stream(
        client,
        name_suffix=suffix,
        stream_config={
            "query": "SELECT id, event_id, message, severity, event_ts, ordering_seq FROM source_e2e_rows",
            "max_rows_per_run": 50,
            "checkpoint_mode": "COMPOSITE_ORDER",
            "checkpoint_column": "event_ts",
            "checkpoint_order_column": "ordering_seq",
            "query_timeout_seconds": 30,
        },
    )
    _save_mapping_enrichment(client, stream_id)
    _wirehook_and_route(client, stream_id, wm_path="/source-e2e/recv-db")
    _ensure_checkpoint(db_session, stream_id)
    enable_stream_for_run(client, stream_id)

    r1 = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert r1.status_code == 200, r1.text
    assert r1.json().get("checkpoint_updated") is True
    assert int(r1.json().get("extracted_event_count") or 0) == 3

    db_session.expire_all()
    assert_run_observability_core(db_session, stream_id, expect_checkpoint_update=True)

    r2 = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert r2.status_code == 200, r2.text
    assert r2.json().get("outcome") == "no_events"
    assert r2.json().get("checkpoint_updated") is False


@skip_no_wiremock
@skip_no_sftp
def test_remote_file_sftp_ndjson_delivery_and_checkpoint_meta(
    client: TestClient, db_session: Session
) -> None:
    ensure_source_e2e_webhook_stub(WIREMOCK_BASE)
    reset_wiremock_journal(WIREMOCK_BASE)
    suffix = uuid.uuid4().hex[:8]
    ndjson_file, expected_events = _seed_isolated_sftp_ndjson(suffix)
    _, _, stream_id = _create_remote_file_connector_and_stream(
        client,
        name_suffix=suffix,
        stream_config={
            "remote_directory": "upload",
            "file_pattern": ndjson_file,
            "recursive": False,
            "parser_type": "NDJSON",
            "max_files_per_run": 5,
            "max_file_size_mb": 5,
        },
    )
    _save_mapping_enrichment(client, stream_id)
    _wirehook_and_route(client, stream_id, wm_path="/source-e2e/recv-rf")
    _ensure_checkpoint(db_session, stream_id)
    enable_stream_for_run(client, stream_id)

    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    assert run.json().get("checkpoint_updated") is True
    assert int(run.json().get("extracted_event_count") or 0) == expected_events

    bodies = wiremock_received_json_bodies(WIREMOCK_BASE, path_contains="/source-e2e/recv-rf")
    assert len(bodies) >= 2

    db_session.expire_all()
    cp = db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).first()
    assert cp is not None
    cj = dict(cp.checkpoint_value_json or {})
    assert cj.get("last_processed_offset") is not None
    assert cj.get("last_processed_hash")


@skip_no_wiremock
@skip_no_sftp
def test_remote_file_csv_parser(client: TestClient, db_session: Session) -> None:
    ensure_source_e2e_webhook_stub(WIREMOCK_BASE)
    reset_wiremock_journal(WIREMOCK_BASE)
    suffix = uuid.uuid4().hex[:8]
    _, _, stream_id = _create_remote_file_connector_and_stream(
        client,
        name_suffix=suffix,
        stream_config={
            "remote_directory": "upload",
            "file_pattern": "e2e-remote.csv",
            "recursive": False,
            "parser_type": "CSV",
            "csv_delimiter": ",",
            "max_files_per_run": 5,
            "max_file_size_mb": 5,
        },
    )
    client.post(
        f"/api/v1/runtime/mappings/stream/{stream_id}/save",
        json={
            "field_mappings": {
                "event_id": "$.event_id",
                "message": "$.message",
                "severity": "$.severity",
            },
        },
    )
    client.post(
        f"/api/v1/runtime/enrichments/stream/{stream_id}/save",
        json={"enrichment": {"vendor": "SourceAdapterE2E"}, "override_policy": "fill_missing", "enabled": True},
    )
    _wirehook_and_route(client, stream_id, wm_path="/source-e2e/recv-csv")
    _ensure_checkpoint(db_session, stream_id)
    _ensure_checkpoint(db_session, stream_id)
    enable_stream_for_run(client, stream_id)

    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    bodies = wiremock_received_json_bodies(WIREMOCK_BASE, path_contains="/source-e2e/recv-csv")
    msgs = {str(b.get("message") or "") for b in bodies}
    assert "csv row one" in msgs or any("csv row one" in str(b) for b in bodies)


@skip_no_minio
def test_s3_ndjson_to_syslog_udp(
    client: TestClient, db_session: Session, syslog_udp_receiver: Any
) -> None:
    suffix = uuid.uuid4().hex[:8]
    prefix = seed_isolated_s3_objects(
        suffix,
        {
            "aaa.ndjson": b'{"id":"e2e-s3-a1","message":"aaa first","severity":"info"}\n',
            "bbb.ndjson": b'{"id":"e2e-s3-b1","message":"bbb second","severity":"info"}\n',
            "array.json": b'[{"id":"e2e-arr-1","message":"from array","severity":"info"}]',
        },
    )
    _, _, stream_id = _create_s3_connector_and_stream(
        client,
        name_suffix=suffix,
        prefix=prefix,
        stream_config={"max_objects_per_run": 10},
    )
    _save_mapping_enrichment(client, stream_id)
    dest_id = create_syslog_udp_destination(
        client,
        syslog_udp_receiver.host,
        syslog_udp_receiver.port,
        name=f"e2e-s3-syslog-udp-{suffix}",
    )
    _route_to_destination(client, stream_id, dest_id)
    _ensure_checkpoint(db_session, stream_id)
    enable_stream_for_run(client, stream_id)
    _run_once_syslog_delivery_ok(
        client, db_session, stream_id, syslog_udp_receiver, expect_min_extracted=3
    )


@skip_no_minio
def test_s3_ndjson_to_syslog_tcp(
    client: TestClient, db_session: Session, syslog_tcp_receiver: Any
) -> None:
    suffix = uuid.uuid4().hex[:8]
    prefix = seed_isolated_s3_objects(
        suffix,
        {
            "aaa.ndjson": b'{"id":"e2e-s3-a1","message":"aaa first","severity":"info"}\n',
            "bbb.ndjson": b'{"id":"e2e-s3-b1","message":"bbb second","severity":"info"}\n',
            "array.json": b'[{"id":"e2e-arr-1","message":"from array","severity":"info"}]',
        },
    )
    _, _, stream_id = _create_s3_connector_and_stream(
        client,
        name_suffix=suffix,
        prefix=prefix,
        stream_config={"max_objects_per_run": 10},
    )
    _save_mapping_enrichment(client, stream_id)
    dest_id = create_syslog_tcp_destination(
        client,
        syslog_tcp_receiver.host,
        syslog_tcp_receiver.port,
        name=f"e2e-s3-syslog-tcp-{suffix}",
    )
    _route_to_destination(client, stream_id, dest_id)
    _ensure_checkpoint(db_session, stream_id)
    enable_stream_for_run(client, stream_id)
    _run_once_syslog_delivery_ok(
        client, db_session, stream_id, syslog_tcp_receiver, expect_min_extracted=3
    )


@skip_no_minio
def test_s3_ndjson_to_syslog_tls(client: TestClient, db_session: Session, tmp_path: Path) -> None:
    cert = write_self_signed_cert(
        tmp_path / "s3-syslog-tls",
        common_name="localhost",
        san_dns=["localhost"],
    )
    recv = SyslogTlsTestReceiver(certfile=cert.cert_path, keyfile=cert.key_path)
    recv.start()
    try:
        suffix = uuid.uuid4().hex[:8]
        prefix = seed_isolated_s3_objects(
            suffix,
            {
                "aaa.ndjson": b'{"id":"e2e-s3-a1","message":"aaa first","severity":"info"}\n',
                "bbb.ndjson": b'{"id":"e2e-s3-b1","message":"bbb second","severity":"info"}\n',
                "array.json": b'[{"id":"e2e-arr-1","message":"from array","severity":"info"}]',
            },
        )
        _, _, stream_id = _create_s3_connector_and_stream(
            client,
            name_suffix=suffix,
            prefix=prefix,
            stream_config={"max_objects_per_run": 10},
        )
        _save_mapping_enrichment(client, stream_id)
        dest_id = create_syslog_tls_destination(
            client,
            recv.host,
            recv.port,
            name=f"e2e-s3-syslog-tls-{suffix}",
        )
        _route_to_destination(client, stream_id, dest_id)
        _ensure_checkpoint(db_session, stream_id)
        enable_stream_for_run(client, stream_id)
        _run_once_syslog_delivery_ok(client, db_session, stream_id, recv, expect_min_extracted=3)
    finally:
        recv.stop()


@skip_no_pg_fixture
def test_database_query_to_syslog_udp(
    client: TestClient, db_session: Session, syslog_udp_receiver: Any
) -> None:
    suffix = uuid.uuid4().hex[:8]
    _, _, stream_id = _create_db_query_connector_and_stream(
        client,
        name_suffix=suffix,
        stream_config={
            "query": "SELECT id, event_id, message, severity, event_ts, ordering_seq FROM source_e2e_rows",
            "max_rows_per_run": 50,
            "checkpoint_mode": "COMPOSITE_ORDER",
            "checkpoint_column": "event_ts",
            "checkpoint_order_column": "ordering_seq",
            "query_timeout_seconds": 30,
        },
    )
    _save_mapping_enrichment(client, stream_id)
    dest_id = create_syslog_udp_destination(
        client,
        syslog_udp_receiver.host,
        syslog_udp_receiver.port,
        name=f"e2e-db-syslog-udp-{suffix}",
    )
    _route_to_destination(client, stream_id, dest_id)
    _ensure_checkpoint(db_session, stream_id)
    enable_stream_for_run(client, stream_id)
    _run_once_syslog_delivery_ok(
        client, db_session, stream_id, syslog_udp_receiver, expect_min_extracted=3
    )


@skip_no_pg_fixture
def test_database_query_to_syslog_tcp(
    client: TestClient, db_session: Session, syslog_tcp_receiver: Any
) -> None:
    suffix = uuid.uuid4().hex[:8]
    _, _, stream_id = _create_db_query_connector_and_stream(
        client,
        name_suffix=suffix,
        stream_config={
            "query": "SELECT id, event_id, message, severity, event_ts, ordering_seq FROM source_e2e_rows",
            "max_rows_per_run": 50,
            "checkpoint_mode": "COMPOSITE_ORDER",
            "checkpoint_column": "event_ts",
            "checkpoint_order_column": "ordering_seq",
            "query_timeout_seconds": 30,
        },
    )
    _save_mapping_enrichment(client, stream_id)
    dest_id = create_syslog_tcp_destination(
        client,
        syslog_tcp_receiver.host,
        syslog_tcp_receiver.port,
        name=f"e2e-db-syslog-tcp-{suffix}",
    )
    _route_to_destination(client, stream_id, dest_id)
    _ensure_checkpoint(db_session, stream_id)
    enable_stream_for_run(client, stream_id)
    _run_once_syslog_delivery_ok(
        client, db_session, stream_id, syslog_tcp_receiver, expect_min_extracted=3
    )


@skip_no_pg_fixture
def test_database_query_to_syslog_tls(client: TestClient, db_session: Session, tmp_path: Path) -> None:
    cert = write_self_signed_cert(
        tmp_path / "db-syslog-tls",
        common_name="localhost",
        san_dns=["localhost"],
    )
    recv = SyslogTlsTestReceiver(certfile=cert.cert_path, keyfile=cert.key_path)
    recv.start()
    try:
        suffix = uuid.uuid4().hex[:8]
        _, _, stream_id = _create_db_query_connector_and_stream(
            client,
            name_suffix=suffix,
            stream_config={
                "query": "SELECT id, event_id, message, severity, event_ts, ordering_seq FROM source_e2e_rows",
                "max_rows_per_run": 50,
                "checkpoint_mode": "COMPOSITE_ORDER",
                "checkpoint_column": "event_ts",
                "checkpoint_order_column": "ordering_seq",
                "query_timeout_seconds": 30,
            },
        )
        _save_mapping_enrichment(client, stream_id)
        dest_id = create_syslog_tls_destination(
            client,
            recv.host,
            recv.port,
            name=f"e2e-db-syslog-tls-{suffix}",
        )
        _route_to_destination(client, stream_id, dest_id)
        _ensure_checkpoint(db_session, stream_id)
        enable_stream_for_run(client, stream_id)
        _run_once_syslog_delivery_ok(client, db_session, stream_id, recv, expect_min_extracted=3)
    finally:
        recv.stop()


@skip_no_sftp
def test_remote_file_ndjson_to_syslog_udp(
    client: TestClient, db_session: Session, syslog_udp_receiver: Any
) -> None:
    suffix = uuid.uuid4().hex[:8]
    ndjson_file, expected_events = _seed_isolated_sftp_ndjson(suffix)
    _, _, stream_id = _create_remote_file_connector_and_stream(
        client,
        name_suffix=suffix,
        stream_config={
            "remote_directory": "upload",
            "file_pattern": ndjson_file,
            "recursive": False,
            "parser_type": "NDJSON",
            "max_files_per_run": 5,
            "max_file_size_mb": 5,
        },
    )
    _save_mapping_enrichment(client, stream_id)
    dest_id = create_syslog_udp_destination(
        client,
        syslog_udp_receiver.host,
        syslog_udp_receiver.port,
        name=f"e2e-rf-syslog-udp-{suffix}",
    )
    _route_to_destination(client, stream_id, dest_id)
    _ensure_checkpoint(db_session, stream_id)
    enable_stream_for_run(client, stream_id)
    _run_once_syslog_delivery_ok(
        client, db_session, stream_id, syslog_udp_receiver, expect_min_extracted=expected_events
    )


@skip_no_sftp
def test_remote_file_ndjson_to_syslog_tcp(
    client: TestClient, db_session: Session, syslog_tcp_receiver: Any
) -> None:
    suffix = uuid.uuid4().hex[:8]
    ndjson_file, expected_events = _seed_isolated_sftp_ndjson(suffix)
    _, _, stream_id = _create_remote_file_connector_and_stream(
        client,
        name_suffix=suffix,
        stream_config={
            "remote_directory": "upload",
            "file_pattern": ndjson_file,
            "recursive": False,
            "parser_type": "NDJSON",
            "max_files_per_run": 5,
            "max_file_size_mb": 5,
        },
    )
    _save_mapping_enrichment(client, stream_id)
    dest_id = create_syslog_tcp_destination(
        client,
        syslog_tcp_receiver.host,
        syslog_tcp_receiver.port,
        name=f"e2e-rf-syslog-tcp-{suffix}",
    )
    _route_to_destination(client, stream_id, dest_id)
    _ensure_checkpoint(db_session, stream_id)
    enable_stream_for_run(client, stream_id)
    _run_once_syslog_delivery_ok(
        client, db_session, stream_id, syslog_tcp_receiver, expect_min_extracted=expected_events
    )


@skip_no_sftp
def test_remote_file_ndjson_to_syslog_tls(client: TestClient, db_session: Session, tmp_path: Path) -> None:
    cert = write_self_signed_cert(
        tmp_path / "rf-syslog-tls",
        common_name="localhost",
        san_dns=["localhost"],
    )
    recv = SyslogTlsTestReceiver(certfile=cert.cert_path, keyfile=cert.key_path)
    recv.start()
    try:
        suffix = uuid.uuid4().hex[:8]
        ndjson_file, expected_events = _seed_isolated_sftp_ndjson(suffix)
        _, _, stream_id = _create_remote_file_connector_and_stream(
            client,
            name_suffix=suffix,
            stream_config={
                "remote_directory": "upload",
                "file_pattern": ndjson_file,
                "recursive": False,
                "parser_type": "NDJSON",
                "max_files_per_run": 5,
                "max_file_size_mb": 5,
            },
        )
        _save_mapping_enrichment(client, stream_id)
        dest_id = create_syslog_tls_destination(
            client,
            recv.host,
            recv.port,
            name=f"e2e-rf-syslog-tls-{suffix}",
        )
        _route_to_destination(client, stream_id, dest_id)
        _ensure_checkpoint(db_session, stream_id)
        enable_stream_for_run(client, stream_id)
        _run_once_syslog_delivery_ok(
            client, db_session, stream_id, recv, expect_min_extracted=expected_events
        )
    finally:
        recv.stop()


@skip_no_minio
def test_s3_destination_unreachable_pause_no_checkpoint(
    client: TestClient, db_session: Session
) -> None:
    reset_wiremock_journal(WIREMOCK_BASE)
    suffix = uuid.uuid4().hex[:8]
    prefix = seed_isolated_s3_objects(
        suffix,
        {"fail.ndjson": b'{"id":"fail-1","message":"dest fail","severity":"info"}\n'},
    )
    _, _, stream_id = _create_s3_connector_and_stream(
        client,
        name_suffix=suffix,
        prefix=prefix,
        stream_config={"max_objects_per_run": 5},
    )
    _save_mapping_enrichment(client, stream_id)
    dest = client.post(
        "/api/v1/destinations/",
        json={
            "name": f"e2e-bad-url-{suffix}",
            "destination_type": "WEBHOOK_POST",
            "config_json": {
                "url": "http://127.0.0.1:1/nope",
                "retry_count": 0,
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
            "failure_policy": "PAUSE_STREAM_ON_FAILURE",
        },
    )
    assert rr.status_code == 201, rr.text
    _ensure_checkpoint(db_session, stream_id)
    ck_row = db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).first()
    assert ck_row is not None
    ck_before = dict(ck_row.checkpoint_value_json or {})
    log_n = db_session.query(DeliveryLog).filter(DeliveryLog.stream_id == stream_id).count()
    enable_stream_for_run(client, stream_id)

    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    assert run.json().get("checkpoint_updated") is False

    db_session.expire_all()
    ck_row2 = db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).first()
    assert ck_row2 is not None
    ck_after = dict(ck_row2.checkpoint_value_json or {})
    assert ck_after == ck_before
    assert db_session.query(DeliveryLog).filter(DeliveryLog.stream_id == stream_id).count() > log_n
    assert "route_send_failed" in delivery_log_stages(db_session, stream_id)


def test_database_query_unreachable_host_structured_error(
    client: TestClient, db_session: Session
) -> None:
    suffix = uuid.uuid4().hex[:8]
    cr = client.post(
        "/api/v1/connectors/",
        json={
            "name": f"e2e-db-bad-{suffix}",
            "source_type": "DATABASE_QUERY",
            "auth_type": "no_auth",
            "db_type": "POSTGRESQL",
            "host": "127.0.0.1",
            "port": 59999,
            "database": "none",
            "db_username": "none",
            "db_password": "none",
            "ssl_mode": "DISABLE",
            "connection_timeout_seconds": 2,
        },
    )
    assert cr.status_code == 201, cr.text
    source_id = int(cr.json()["source_id"])
    connector_id = int(cr.json()["id"])
    sr = client.post(
        "/api/v1/streams/",
        json={
            "name": f"e2e-db-bad-stream-{suffix}",
            "connector_id": connector_id,
            "source_id": source_id,
            "stream_type": "DATABASE_QUERY",
            "config_json": {
                "query": "SELECT 1 AS id, 'x' AS event_id, 'm' AS message, 'low' AS severity, NOW() AS event_ts, 1 AS ordering_seq",
                "max_rows_per_run": 5,
                "checkpoint_mode": "NONE",
            },
            "polling_interval": 60,
            "enabled": False,
            "status": "STOPPED",
            "rate_limit_json": {"max_requests": 100, "per_seconds": 60},
        },
    )
    assert sr.status_code == 201, sr.text
    stream_id = int(sr.json()["id"])
    _save_mapping_enrichment(client, stream_id)
    dest = client.post(
        "/api/v1/destinations/",
        json={
            "name": f"e2e-dummy2-{suffix}",
            "destination_type": "WEBHOOK_POST",
            "config_json": {"url": "http://127.0.0.1:18091/anything"},
            "rate_limit_json": {"max_events": 1000, "per_seconds": 1},
        },
    )
    assert dest.status_code == 201, dest.text
    client.post(
        "/api/v1/routes/",
        json={
            "stream_id": stream_id,
            "destination_id": int(dest.json()["id"]),
            "failure_policy": "LOG_AND_CONTINUE",
        },
    )
    _ensure_checkpoint(db_session, stream_id)
    enable_stream_for_run(client, stream_id)

    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 502, run.text
    detail = run.json().get("detail")
    if isinstance(detail, dict):
        assert detail.get("error_code") == "SOURCE_FETCH_FAILED"
