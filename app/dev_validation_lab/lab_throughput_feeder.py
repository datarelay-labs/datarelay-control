"""Continuous fixture feeder for dev-validation / visible E2E lab throughput."""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import httpx

from app.dev_validation_lab.lab_throughput_config import lab_feed_tick_rates
from app.dev_validation_lab.visible_e2e_seed import (
    VISIBLE_E2E_S3_PREFIX,
    VISIBLE_E2E_WEBHOOK_RECEIVER_KEY,
    VISIBLE_E2E_WEBHOOK_SHARED_SECRET,
)

logger = logging.getLogger(__name__)

_FEEDER_THREADS: dict[str, threading.Thread] = {}
_FEEDER_STOP = threading.Event()
_MAX_FEED_FAMILY_WORKERS = 8
_MAX_WEBHOOK_WORKERS = 8
_SEQ = 0
_SEQ_LOCK = threading.Lock()


def lab_throughput_feeder_enabled() -> bool:
    if (os.environ.get("SKIP_LAB_THROUGHPUT_FEEDER") or "").strip() == "1":
        return False
    from app.dev_validation_lab.seeder import lab_effective

    if not lab_effective():
        return False
    from app.config import settings

    return bool(getattr(settings, "ENABLE_LAB_THROUGHPUT_FEEDER", True))


def _next_seq() -> int:
    global _SEQ
    with _SEQ_LOCK:
        _SEQ += 1
        return _SEQ


@dataclass(frozen=True, slots=True)
class FeederEnv:
    api_base_url: str
    wiremock_base_url: str
    minio_endpoint: str
    minio_buckets: tuple[str, ...]
    minio_access_key: str
    minio_secret_key: str
    minio_prefix_visible: str
    minio_prefix_validation: str
    pg_fixture_url: str
    mysql_fixture_url: str
    mariadb_fixture_url: str
    sftp_host: str
    sftp_port: int
    sftp_user: str
    sftp_password: str
    scp_host: str
    scp_port: int
    scp_user: str
    scp_password: str


def _load_feeder_env() -> FeederEnv:
    from app.config import settings

    api = (os.environ.get("LAB_THROUGHPUT_API_BASE_URL") or "http://127.0.0.1:8000").rstrip("/")
    pg = (
        os.environ.get("SOURCE_E2E_PG_FIXTURE_URL")
        or f"postgresql://gdc_fixture:gdc_fixture_pw@{settings.DEV_VALIDATION_PG_QUERY_HOST}:{int(settings.DEV_VALIDATION_PG_QUERY_PORT)}/gdc_query_fixture"
    )
    my_host = str(settings.DEV_VALIDATION_MYSQL_QUERY_HOST).strip()
    my_port = int(settings.DEV_VALIDATION_MYSQL_QUERY_PORT)
    ma_host = str(settings.DEV_VALIDATION_MARIADB_QUERY_HOST).strip()
    ma_port = int(settings.DEV_VALIDATION_MARIADB_QUERY_PORT)
    visible_bucket = (os.environ.get("SOURCE_E2E_MINIO_BUCKET") or "gdc-source-e2e").strip()
    validation_bucket = str(settings.MINIO_BUCKET).strip() or "gdc-test-logs"
    buckets = tuple(dict.fromkeys(b for b in (visible_bucket, validation_bucket) if b))
    return FeederEnv(
        api_base_url=api,
        wiremock_base_url=str(settings.DEV_VALIDATION_WIREMOCK_BASE_URL).rstrip("/"),
        minio_endpoint=str(settings.MINIO_ENDPOINT).rstrip("/"),
        minio_buckets=buckets,
        minio_access_key=str(settings.MINIO_ACCESS_KEY).strip(),
        minio_secret_key=str(settings.MINIO_SECRET_KEY).strip(),
        minio_prefix_visible=VISIBLE_E2E_S3_PREFIX,
        minio_prefix_validation="security/",
        pg_fixture_url=pg,
        mysql_fixture_url=f"mysql+pymysql://gdc_fixture:gdc_fixture_pw@{my_host}:{my_port}/gdc_query_fixture",
        mariadb_fixture_url=f"mysql+pymysql://gdc_fixture:gdc_fixture_pw@{ma_host}:{ma_port}/gdc_query_fixture",
        sftp_host=str(settings.DEV_VALIDATION_SFTP_HOST).strip(),
        sftp_port=int(settings.DEV_VALIDATION_SFTP_PORT),
        sftp_user=str(settings.DEV_VALIDATION_SFTP_USER).strip(),
        sftp_password=str(settings.DEV_VALIDATION_SFTP_PASSWORD or "").strip(),
        scp_host=str(settings.DEV_VALIDATION_SSH_SCP_HOST).strip(),
        scp_port=int(settings.DEV_VALIDATION_SSH_SCP_PORT),
        scp_user=str(settings.DEV_VALIDATION_SSH_SCP_USER).strip(),
        scp_password=str(settings.DEV_VALIDATION_SSH_SCP_PASSWORD or "").strip(),
    )


def _insert_postgres_rows(url: str, *, table: str, count: int) -> None:
    if count <= 0:
        return
    try:
        from sqlalchemy import create_engine, text

        engine = create_engine(url, pool_pre_ping=True)
        now = datetime.now(timezone.utc).isoformat()
        seq = _next_seq()
        with engine.begin() as conn:
            if table == "source_e2e_rows":
                for i in range(count):
                    eid = f"lab-src-{seq}-{i}-{uuid.uuid4().hex[:8]}"
                    conn.execute(
                        text(
                            "INSERT INTO source_e2e_rows (event_id, message, severity, event_ts, ordering_seq) "
                            "VALUES (:event_id, :message, :severity, :event_ts, :ordering_seq)"
                        ),
                        {
                            "event_id": eid,
                            "message": f"lab feeder {eid}",
                            "severity": "low",
                            "event_ts": now,
                            "ordering_seq": seq * 100 + i,
                        },
                    )
            else:
                for i in range(count):
                    eid = f"lab-feed-{seq}-{i}-{uuid.uuid4().hex[:8]}"
                    conn.execute(
                        text(
                            f"INSERT INTO {table} (event_id, message, severity) "
                            "VALUES (:event_id, :message, :severity)"
                        ),
                        {"event_id": eid, "message": f"lab feeder {eid}", "severity": "info"},
                    )
    except Exception as exc:
        logger.debug(
            "%s",
            {"stage": "lab_throughput_feed_pg_failed", "table": table, "error_type": type(exc).__name__, "message": str(exc)},
        )


def _insert_mysql_rows(url: str, *, count: int) -> None:
    if count <= 0:
        return
    try:
        from sqlalchemy import create_engine, text

        engine = create_engine(url, pool_pre_ping=True)
        seq = _next_seq()
        with engine.begin() as conn:
            for i in range(count):
                eid = f"lab-feed-{seq}-{i}-{uuid.uuid4().hex[:8]}"
                conn.execute(
                    text(
                        "INSERT INTO security_events (event_id, message, severity) "
                        "VALUES (:event_id, :message, :severity)"
                    ),
                    {"event_id": eid, "message": f"lab feeder {eid}", "severity": "info"},
                )
    except Exception as exc:
        logger.debug(
            "%s",
            {"stage": "lab_throughput_feed_mysql_failed", "error_type": type(exc).__name__, "message": str(exc)},
        )


def _s3_client(env: FeederEnv):
    import boto3
    from botocore.client import Config as BotoConfig

    session = boto3.session.Session(
        aws_access_key_id=env.minio_access_key,
        aws_secret_access_key=env.minio_secret_key,
        region_name="us-east-1",
    )
    return session.client(
        "s3",
        endpoint_url=env.minio_endpoint,
        use_ssl=env.minio_endpoint.lower().startswith("https://"),
        config=BotoConfig(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


def _upload_s3_ndjson(env: FeederEnv, *, prefix: str, count: int) -> None:
    if count <= 0 or not env.minio_access_key or not env.minio_secret_key:
        return
    try:
        client = _s3_client(env)
        for bucket in env.minio_buckets:
            try:
                client.create_bucket(Bucket=bucket)
            except Exception:
                pass
            seq = _next_seq()
            for i in range(count):
                key = f"{prefix}lab-feed-slot-{i:03d}.ndjson"
                body = json.dumps(
                    {"id": f"s3-{seq}-{i}", "message": f"s3 lab feed {seq}-{i}", "severity": "info"}
                ).encode()
                for j in range(3):
                    body += b"\n" + json.dumps(
                        {"id": f"s3-{seq}-{i}-line-{j}", "message": "ndjson line", "severity": "low"}
                    ).encode()
                client.put_object(Bucket=bucket, Key=key, Body=body, ContentType="application/x-ndjson")
    except Exception as exc:
        logger.debug(
            "%s",
            {"stage": "lab_throughput_feed_s3_failed", "error_type": type(exc).__name__, "message": str(exc)},
        )


def _upload_remote_file(
    env: FeederEnv,
    *,
    host: str,
    port: int,
    username: str,
    password: str,
    remote_directory: str,
    file_pattern_prefix: str,
    parser_suffix: str,
    count: int,
    visible_lines: int = 0,
) -> None:
    if count <= 0 or not password:
        return
    try:
        import paramiko

        seq = _next_seq()
        transport = paramiko.Transport((host, int(port)))
        transport.connect(username=username, password=password)
        sftp = paramiko.SFTPClient.from_transport(transport)
        assert sftp is not None
        try:
            for i in range(count):
                name = f"{file_pattern_prefix}{seq}-{i}-{uuid.uuid4().hex[:6]}{parser_suffix}"
                remote_path = f"{remote_directory.rstrip('/')}/{name}"
                if parser_suffix == ".json":
                    payload = json.dumps(
                        [{"id": f"scp-{seq}-{i}", "message": "lab scp feed", "severity": "info"}]
                    ).encode()
                else:
                    lines = [
                        json.dumps({"id": f"rf-{seq}-{i}-{j}", "message": "lab rf feed", "severity": "info"})
                        for j in range(3)
                    ]
                    payload = ("\n".join(lines) + "\n").encode()
                with sftp.file(remote_path, "w") as fh:
                    fh.write(payload)
        finally:
            sftp.close()
            transport.close()
        # Keep visible E2E single-file path warm with fresh mtime/content.
        if file_pattern_prefix == "lab-" and visible_lines > 0:
            try:
                transport = paramiko.Transport((host, int(port)))
                transport.connect(username=username, password=password)
                sftp = paramiko.SFTPClient.from_transport(transport)
                assert sftp is not None
                lines = [
                    json.dumps(
                        {
                            "id": f"e2e-rf-{seq}-{i}",
                            "message": "visible e2e remote feed",
                            "severity": "info",
                        }
                    )
                    for i in range(visible_lines)
                ]
                payload = ("\n".join(lines) + "\n").encode()
                with sftp.file(f"{remote_directory.rstrip('/')}/e2e-remote.ndjson", "w") as fh:
                    fh.write(payload)
                sftp.close()
                transport.close()
            except Exception:
                pass
    except Exception as exc:
        logger.debug(
            "%s",
            {"stage": "lab_throughput_feed_remote_failed", "error_type": type(exc).__name__, "message": str(exc)},
        )


def _post_webhook_events(env: FeederEnv, *, count: int) -> None:
    if count <= 0:
        return
    url = f"{env.api_base_url}/api/v1/ingest/webhook/{VISIBLE_E2E_WEBHOOK_RECEIVER_KEY}"
    headers = {
        "Content-Type": "application/json",
        "X-GDC-Webhook-Secret": VISIBLE_E2E_WEBHOOK_SHARED_SECRET,
    }
    seq = _next_seq()
    workers = max(1, min(_MAX_WEBHOOK_WORKERS, count))

    def _send_one(client: httpx.Client, i: int) -> bool:
        payload = {
            "id": f"wh-{seq}-{i}-{uuid.uuid4().hex[:8]}",
            "message": f"lab webhook feed {seq}-{i}",
            "severity": "LOW",
        }
        r = client.post(url, headers=headers, json=payload)
        if r.status_code >= 400:
            logger.debug(
                "%s",
                {
                    "stage": "lab_throughput_feed_webhook_failed",
                    "status_code": r.status_code,
                    "body": (r.text or "")[:200],
                },
            )
            return False
        return True

    try:
        with httpx.Client(timeout=15.0) as client:
            with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="lab-feed-webhook") as pool:
                list(pool.map(lambda i: _send_one(client, i), range(count)))
    except Exception as exc:
        logger.debug(
            "%s",
            {"stage": "lab_throughput_feed_webhook_error", "error_type": type(exc).__name__, "message": str(exc)},
        )


def _feed_family_jobs(env: FeederEnv, *, high_volume: bool) -> dict[str, object]:
    rates = lab_feed_tick_rates(high_volume=high_volume)
    db_rows = int(rates["db_rows"])
    s3_count = int(rates["s3_objects"])
    rf_count = int(rates["remote_files"])
    wh_count = int(rates["webhook_events"])
    visible_lines = int(rates["remote_visible_lines"])

    def _postgres_bundle() -> None:
        _insert_postgres_rows(env.pg_fixture_url, table="security_events", count=db_rows)
        _insert_postgres_rows(env.pg_fixture_url, table="source_e2e_rows", count=db_rows)

    def _s3_bundle() -> None:
        _upload_s3_ndjson(env, prefix=env.minio_prefix_visible, count=s3_count)
        _upload_s3_ndjson(env, prefix=env.minio_prefix_validation, count=s3_count)

    jobs: dict[str, object] = {
        "postgres": _postgres_bundle,
        "mysql": partial(_insert_mysql_rows, env.mysql_fixture_url, count=db_rows),
        "mariadb": partial(_insert_mysql_rows, env.mariadb_fixture_url, count=db_rows),
        "s3": _s3_bundle,
        "webhook": partial(_post_webhook_events, env, count=wh_count),
    }
    if env.sftp_password:
        jobs["sftp"] = partial(
            _upload_remote_file,
            env,
            host=env.sftp_host,
            port=env.sftp_port,
            username=env.sftp_user,
            password=env.sftp_password,
            remote_directory="upload",
            file_pattern_prefix="lab-",
            parser_suffix=".ndjson",
            count=rf_count,
            visible_lines=visible_lines,
        )
    if env.scp_password:
        jobs["scp"] = partial(
            _upload_remote_file,
            env,
            host=env.scp_host,
            port=env.scp_port,
            username=env.scp_user,
            password=env.scp_password,
            remote_directory="upload",
            file_pattern_prefix="lab-",
            parser_suffix=".json",
            count=rf_count,
        )
    return jobs


def _remaining_tick_wait(*, tick_seconds: float, elapsed_seconds: float) -> float:
    return max(0.0, float(tick_seconds) - max(0.0, float(elapsed_seconds)))

def run_lab_throughput_feed_tick(*, high_volume: bool = True) -> None:
    """Run one bounded feed cycle with independent fixture families in parallel."""

    env = _load_feeder_env()
    jobs = _feed_family_jobs(env, high_volume=high_volume)
    if not jobs:
        return
    workers = max(1, min(_MAX_FEED_FAMILY_WORKERS, len(jobs)))
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="lab-feed-family") as pool:
        futures = [pool.submit(job) for job in jobs.values()]
        for future in futures:
            future.result()


def _feed_family_loop(*, name: str, job: object, tick_seconds: float) -> None:
    logger.info("%s", {"stage": "lab_throughput_feeder_family_started", "family": name, "tick_seconds": tick_seconds})
    while not _FEEDER_STOP.is_set():
        started = time.monotonic()
        try:
            job()
        except Exception as exc:  # pragma: no cover - individual helpers are fail-open
            logger.warning(
                "%s",
                {
                    "stage": "lab_throughput_feeder_family_tick_failed",
                    "family": name,
                    "error_type": type(exc).__name__,
                    "message": str(exc),
                },
            )
        elapsed = time.monotonic() - started
        wait_seconds = _remaining_tick_wait(tick_seconds=tick_seconds, elapsed_seconds=elapsed)
        if _FEEDER_STOP.wait(timeout=wait_seconds):
            break
    logger.info("%s", {"stage": "lab_throughput_feeder_family_stopped", "family": name})


def _start_feeder_family_threads(*, tick_seconds: float) -> None:
    global _FEEDER_THREADS
    env = _load_feeder_env()
    jobs = _feed_family_jobs(env, high_volume=True)
    _FEEDER_THREADS = {}
    for name, job in jobs.items():
        thread = threading.Thread(
            target=_feed_family_loop,
            kwargs={"name": name, "job": job, "tick_seconds": tick_seconds},
            name=f"lab-throughput-{name}",
            daemon=True,
        )
        _FEEDER_THREADS[name] = thread
        thread.start()


def _feeder_loop() -> None:
    tick = max(0.5, float(os.environ.get("LAB_THROUGHPUT_FEEDER_TICK_SECONDS", "1") or "1"))
    logger.info("%s", {"stage": "lab_throughput_feeder_started", "tick_seconds": tick})
    _start_feeder_family_threads(tick_seconds=tick)
    while not _FEEDER_STOP.wait(timeout=1.0):
        if _FEEDER_THREADS and not any(thread.is_alive() for thread in _FEEDER_THREADS.values()):
            break
    logger.info("%s", {"stage": "lab_throughput_feeder_stopped"})


def start_lab_throughput_feeder_background() -> bool:
    """Start one process-local set of independent daemon family feeders (idempotent)."""

    if not lab_throughput_feeder_enabled():
        logger.info("%s", {"stage": "lab_throughput_feeder_skipped", "reason": "disabled"})
        return False
    if any(thread.is_alive() for thread in _FEEDER_THREADS.values()):
        return True
    _FEEDER_STOP.clear()
    tick = max(0.5, float(os.environ.get("LAB_THROUGHPUT_FEEDER_TICK_SECONDS", "1") or "1"))
    _start_feeder_family_threads(tick_seconds=tick)
    return True


def stop_lab_throughput_feeder_background() -> None:
    global _FEEDER_THREADS
    _FEEDER_STOP.set()
    for thread in list(_FEEDER_THREADS.values()):
        if thread.is_alive():
            thread.join(timeout=5.0)
    _FEEDER_THREADS = {}


def main() -> int:
    import argparse

    p = argparse.ArgumentParser(description="Run continuous lab throughput feeder (foreground).")
    p.add_argument("--once", action="store_true", help="Run a single tick and exit.")
    p.add_argument("--tick-seconds", type=float, default=1.0)
    args = p.parse_args()
    if args.once:
        run_lab_throughput_feed_tick(high_volume=True)
        return 0
    _FEEDER_STOP.clear()
    os.environ["LAB_THROUGHPUT_FEEDER_TICK_SECONDS"] = str(args.tick_seconds)
    _feeder_loop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
