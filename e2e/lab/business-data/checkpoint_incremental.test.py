#!/usr/bin/env python3
"""Checkpoint / incremental coverage using WireMock stateful + Postgres incremental table."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from typing import Any

WM = os.environ.get("WIREMOCK_BASE_URL", "http://127.0.0.1:28080").rstrip("/")


def _get(path: str) -> tuple[int, Any]:
    req = urllib.request.Request(f"{WM}{path}")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def _reset() -> None:
    req = urllib.request.Request(f"{WM}/__admin/scenarios/reset", method="POST", data=b"")
    with urllib.request.urlopen(req, timeout=15) as resp:
        resp.read()


def _psql(sql: str) -> str:
    proc = subprocess.run(
        [
            "docker",
            "exec",
            "-e",
            "PGPASSWORD=gdc_fixture_pw",
            "gdc-postgres-query-test",
            "psql",
            "-U",
            "gdc_fixture",
            "-d",
            "gdc_query_fixture",
            "-At",
            "-c",
            sql,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr)
    return proc.stdout.strip()


def main() -> int:
    results = []

    def rec(name: str, ok: bool, detail: Any = None) -> None:
        results.append({"name": name, "ok": ok, "detail": detail})
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: {detail}")

    _reset()
    s1, d1 = _get("/shared-business/checkpoint")
    rec("checkpoint_initial", s1 == 200 and len(d1.get("data") or []) == 2, {"n": len((d1 or {}).get("data") or [])})
    s2, d2 = _get("/shared-business/checkpoint")
    rec("checkpoint_no_change", s2 == 200 and len(d2.get("data") or []) == 0, {"n": len((d2 or {}).get("data") or [])})
    s3, d3 = _get("/shared-business/checkpoint")
    rec(
        "checkpoint_new_data",
        s3 == 200 and len(d3.get("data") or []) == 1 and d3["data"][0]["customer_id"] == "customer-005",
        d3.get("data") if isinstance(d3, dict) else d3,
    )

    # Postgres incremental: initial rows, insert new, recount
    try:
        before = int(_psql("SELECT count(*) FROM shared_business_incremental;"))
        _psql(
            "INSERT INTO shared_business_incremental (record_id, customer_id, payload, updated_at) "
            "VALUES ('incr-003', 'customer-003', '{\"note\":\"late\"}'::jsonb, '2026-09-11T00:10:00Z') "
            "ON CONFLICT (record_id) DO NOTHING;"
        )
        after = int(_psql("SELECT count(*) FROM shared_business_incremental;"))
        rec("postgres_incremental_insert", after >= before and after >= 3, {"before": before, "after": after})
        # Restart/recovery proxy: delete + re-seed initial two + keep incr-003 optional
        _psql("DELETE FROM shared_business_incremental WHERE record_id = 'incr-restart';")
        _psql(
            "INSERT INTO shared_business_incremental (record_id, customer_id, payload, updated_at) "
            "VALUES ('incr-restart', 'customer-001', '{\"note\":\"restart\"}'::jsonb, now()) "
            "ON CONFLICT (record_id) DO UPDATE SET updated_at = EXCLUDED.updated_at;"
        )
        got = _psql("SELECT record_id FROM shared_business_incremental WHERE record_id='incr-restart';")
        rec("checkpoint_restart_marker", got == "incr-restart", {"got": got})
    except Exception as exc:  # noqa: BLE001
        rec("postgres_incremental_insert", False, str(exc))
        rec("checkpoint_restart_marker", False, "skipped due to prior failure")

    ok = all(r["ok"] for r in results)
    print(json.dumps({"ok": ok, "results": results}, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
