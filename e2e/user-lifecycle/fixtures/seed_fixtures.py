#!/usr/bin/env python3
"""Fixture helpers for Real Browser Operator E2E (disposable fixtures only)."""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT.parent))  # repo root = e2e/../
REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO))
os.chdir(REPO)


def cmd_seed_http(args: argparse.Namespace) -> int:
    import urllib.request

    wm = os.environ.get("WIREMOCK_BASE_URL", "http://127.0.0.1:28080").rstrip("/")
    run_id = args.run_id
    token = args.token or f"FAKE_TOKEN_{run_id}"

    def stub(path: str, body, status=200, bearer=None):
        req = {"method": "GET", "urlPath": path}
        if bearer:
            req["headers"] = {"Authorization": {"equalTo": f"Bearer {bearer}"}}
        payload = {
            "request": req,
            "response": {
                "status": status,
                "headers": {"Content-Type": "application/json"},
                "jsonBody": body,
            },
        }
        data = json.dumps(payload).encode()
        r = urllib.request.Request(f"{wm}/__admin/mappings", data=data, method="POST", headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(r, timeout=15) as resp:
            resp.read()

    # root 403 (auth-check must use stream endpoint)
    stub("/", {"error": "forbidden"}, status=403)
    def items(stream: str, n: int = 12, extra: dict | None = None):
        rows = []
        for i in range(1, n + 1):
            row = {
                "id": i,
                "run_id": run_id,
                "stream": stream,
                "seq": i,
                "sequence": i,
                "message": f"marker-{run_id}-{stream.lower()}-{i}",
                "email": "test@example.invalid",
                "api_key": f"FAKE_API_KEY_{run_id}",
            }
            if extra:
                row.update(extra)
            rows.append(row)
        return rows

    stub(
        f"/ulc/{run_id}/h1",
        {"items": items("H1")},
        bearer=token,
    )
    stub(
        f"/ulc/{run_id}/h2",
        {"data": {"records": items("H2")}},
        bearer=token,
    )
    stub(
        f"/ulc/{run_id}/h3",
        {"items": items("H3", extra={"checkpoint": "cp-1"})},
        bearer=token,
    )
    stub(
        f"/ulc/{run_id}/h4",
        {"items": items("H4")},
        bearer=token,
    )
    stub(
        f"/ulc/{run_id}/h5",
        {"items": items("H5")},
        bearer=token,
    )
    print(json.dumps({"ok": True, "paths": [f"/ulc/{run_id}/h1", f"/ulc/{run_id}/h2", f"/ulc/{run_id}/h3", f"/ulc/{run_id}/h4", f"/ulc/{run_id}/h5"]}))
    return 0


def cmd_seed_s3(args: argparse.Namespace) -> int:
    from tests.e2e_runtime_helpers import put_minio_object

    run_id = args.run_id
    for folder, name in [("a", "a1.ndjson"), ("b", "b1.ndjson")]:
        key = f"{run_id}/{folder}/{name}"
        body = (json.dumps({"run_id": run_id, "folder": folder, "seq": 1}) + "\n").encode()
        put_minio_object(key, body)
        print(json.dumps({"put": key}))
    return 0


def cmd_seed_sftp(args: argparse.Namespace) -> int:
    import subprocess

    from tests.e2e_runtime_helpers import upload_sftp_file

    run_id = args.run_id
    container = os.environ.get("SOURCE_E2E_SFTP_CONTAINER", "gdc-sftp-test")
    for folder in ("a", "b"):
        subprocess.check_call(
            ["docker", "exec", container, "mkdir", "-p", f"/home/gdc/upload/{run_id}/{folder}"],
            timeout=20,
        )
        remote = f"{run_id}/{folder}/file1.ndjson"
        body = (json.dumps({"run_id": run_id, "folder": folder, "seq": 1, "message": f"marker-{run_id}-sftp-{folder}"}) + "\n").encode()
        upload_sftp_file(remote, body)
        print(json.dumps({"put": f"/home/gdc/upload/{remote}"}))
    return 0


def cmd_seed_sftp_event(args: argparse.Namespace) -> int:
    import subprocess

    from tests.e2e_runtime_helpers import upload_sftp_file

    run_id = args.run_id
    folder = args.folder
    marker = args.marker
    filename = args.filename or f"delivery-{marker}.ndjson"
    container = os.environ.get("SOURCE_E2E_SFTP_CONTAINER", "gdc-sftp-test")
    subprocess.check_call(
        ["docker", "exec", container, "mkdir", "-p", f"/home/gdc/upload/{run_id}/{folder}"],
        timeout=20,
    )
    remote = f"{run_id}/{folder}/{filename}"
    body = (json.dumps({"id": int(time.time()), "run_id": run_id, "folder": folder, "message": marker}) + "\n").encode()
    upload_sftp_file(remote, body)
    print(json.dumps({"put": f"/home/gdc/upload/{remote}", "marker": marker}))
    return 0


def cmd_seed_db(args: argparse.Namespace) -> int:
    import subprocess

    run_id = args.run_id
    sql = f"""
CREATE TABLE IF NOT EXISTS source_e2e_orders (
  id SERIAL PRIMARY KEY,
  event_id TEXT NOT NULL,
  message TEXT NOT NULL,
  email TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_e2e_users (
  id SERIAL PRIMARY KEY,
  event_id TEXT NOT NULL,
  message TEXT NOT NULL,
  email TEXT NOT NULL
);
INSERT INTO source_e2e_orders (event_id, message, email) VALUES
 ('{run_id}-ord-1', 'marker-{run_id}-db-orders', 'test@example.invalid');
INSERT INTO source_e2e_users (event_id, message, email) VALUES
 ('{run_id}-usr-1', 'marker-{run_id}-db-users', 'test@example.invalid');
"""
    container = os.environ.get("SOURCE_E2E_PG_FIXTURE_CONTAINER", "gdc-postgres-query-test")
    try:
        subprocess.check_call(
            ["docker", "exec", "-i", container, "psql", "-U", "gdc_fixture", "-d", "gdc_query_fixture", "-v", "ON_ERROR_STOP=1", "-c", sql],
            timeout=20,
        )
        print(json.dumps({"ok": True, "tables": ["source_e2e_orders", "source_e2e_users"]}))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1


def cmd_seed_db_event(args: argparse.Namespace) -> int:
    import subprocess

    table = args.table
    if table not in {"source_e2e_orders", "source_e2e_users"}:
        print(json.dumps({"ok": False, "error": "invalid table"}))
        return 1
    sql = (
        f"INSERT INTO {table} (event_id, message, email) VALUES "
        f"('{args.event_id}', '{args.marker}', 'test@example.invalid');"
    )
    container = os.environ.get("SOURCE_E2E_PG_FIXTURE_CONTAINER", "gdc-postgres-query-test")
    try:
        subprocess.check_call(
            [
                "docker",
                "exec",
                "-i",
                container,
                "psql",
                "-U",
                "gdc_fixture",
                "-d",
                "gdc_query_fixture",
                "-v",
                "ON_ERROR_STOP=1",
                "-c",
                sql,
            ],
            timeout=20,
        )
        print(json.dumps({"ok": True, "table": table, "marker": args.marker}))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1


def cmd_echo_has(args: argparse.Namespace) -> int:
    import subprocess
    import re

    logs = subprocess.check_output(
        ["docker", "logs", "--tail", "8000", "gdc-webhook-receiver-test"],
        stderr=subprocess.STDOUT,
        text=True,
        timeout=20,
    )
    found = args.marker in logs and args.path in logs
    # tighter: same block
    if found:
        key = f'"path": "{args.path}"'
        ok = False
        for m in re.finditer(re.escape(key), logs):
            end = logs.find('\n{\n    "path": ', m.end())
            block = logs[m.start() : end if end >= 0 else len(logs)]
            if args.marker in block:
                ok = True
                break
        found = ok
    print(json.dumps({"found": found}))
    return 0 if found else 1


def main() -> int:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("seed-http")
    s.add_argument("--run-id", required=True)
    s.add_argument("--token", default="")
    s.set_defaults(func=cmd_seed_http)
    s = sub.add_parser("seed-s3")
    s.add_argument("--run-id", required=True)
    s.set_defaults(func=cmd_seed_s3)
    s = sub.add_parser("seed-sftp")
    s.add_argument("--run-id", required=True)
    s.set_defaults(func=cmd_seed_sftp)
    s = sub.add_parser("seed-sftp-event")
    s.add_argument("--run-id", required=True)
    s.add_argument("--folder", default="a")
    s.add_argument("--marker", required=True)
    s.add_argument("--filename", default="")
    s.set_defaults(func=cmd_seed_sftp_event)
    s = sub.add_parser("seed-db")
    s.add_argument("--run-id", required=True)
    s.set_defaults(func=cmd_seed_db)
    s = sub.add_parser("seed-db-event")
    s.add_argument("--table", default="source_e2e_orders")
    s.add_argument("--event-id", required=True)
    s.add_argument("--marker", required=True)
    s.set_defaults(func=cmd_seed_db_event)
    s = sub.add_parser("echo-has")
    s.add_argument("--marker", required=True)
    s.add_argument("--path", required=True)
    s.set_defaults(func=cmd_echo_has)
    args = p.parse_args()
    return int(args.func(args) or 0)


if __name__ == "__main__":
    raise SystemExit(main())
