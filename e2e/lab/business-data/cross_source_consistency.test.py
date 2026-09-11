#!/usr/bin/env python3
"""Cross-source consistency check for shared business dataset.

Compares logical customer_id / business fields across:
  HTTP (WireMock canonical)
  PostgreSQL shared_business_customers
  S3/MinIO shared-business/customers.ndjson
  SFTP shared-business/customers.ndjson

Allowed differences (documented):
  - transport metadata (e2e_correlation_id, source labels, object keys)
  - row ordering unless sorted by customer_id
  - CSV vs JSON type coercion for numeric fields (N/A for customers)
  - webhook events may be a subset (push sample)
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request
from typing import Any

WM = os.environ.get("WIREMOCK_BASE_URL", "http://127.0.0.1:28080").rstrip("/")
CANONICAL_IDS = [f"customer-{i:03d}" for i in range(1, 6)]
COMPARE_FIELDS = ("customer_id", "name", "email", "tier", "region")


def _http_canonical() -> dict[str, dict[str, Any]]:
    with urllib.request.urlopen(f"{WM}/shared-business/canonical", timeout=15) as resp:
        data = json.loads(resp.read().decode())
    out = {}
    for row in data.get("data") or []:
        out[str(row["customer_id"])] = {k: row.get(k) for k in COMPARE_FIELDS}
    return out


def _pg_customers() -> dict[str, dict[str, Any]]:
    sql = (
        "SELECT customer_id, name, email, tier, region "
        "FROM shared_business_customers WHERE customer_id IN "
        "('customer-001','customer-002','customer-003','customer-004','customer-005') "
        "ORDER BY customer_id;"
    )
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
            "-F",
            "\t",
            "-c",
            sql,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr)
    out: dict[str, dict[str, Any]] = {}
    for line in proc.stdout.strip().splitlines():
        parts = line.split("\t")
        if len(parts) < 5:
            continue
        cid, name, email, tier, region = parts[:5]
        out[cid] = {
            "customer_id": cid,
            "name": name,
            "email": email,
            "tier": tier,
            "region": region,
        }
    return out


def _s3_customers() -> dict[str, dict[str, Any]]:
    proc = subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "gdc-dev-validation",
            "--entrypoint",
            "/bin/sh",
            "minio/mc:latest",
            "-c",
            "mc alias set local http://gdc-minio-test:9000 gdcminioaccess gdcminioaccesssecret12 >/dev/null && "
            "mc cat local/gdc-full-e2e/shared-business/customers.ndjson",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr or proc.stdout)
    out: dict[str, dict[str, Any]] = {}
    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        cid = str(row.get("customer_id") or row.get("id"))
        if cid in CANONICAL_IDS:
            out[cid] = {k: row.get(k) for k in COMPARE_FIELDS}
    return out


def _sftp_customers() -> dict[str, dict[str, Any]]:
    proc = subprocess.run(
        ["docker", "exec", "gdc-sftp-test", "cat", "/home/gdc/upload/shared-business/customers.ndjson"],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr or proc.stdout)
    out: dict[str, dict[str, Any]] = {}
    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        cid = str(row.get("customer_id") or row.get("id"))
        if cid in CANONICAL_IDS:
            out[cid] = {k: row.get(k) for k in COMPARE_FIELDS}
    return out


def main() -> int:
    results: list[dict[str, Any]] = []

    def rec(name: str, ok: bool, detail: Any = None) -> None:
        results.append({"name": name, "ok": ok, "detail": detail})
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: {detail}")

    try:
        http = _http_canonical()
        rec("http_canonical", set(http) == set(CANONICAL_IDS), {"ids": sorted(http)})
    except Exception as exc:  # noqa: BLE001
        rec("http_canonical", False, str(exc))
        http = {}

    try:
        pg = _pg_customers()
        rec("postgres_customers", set(pg) == set(CANONICAL_IDS), {"ids": sorted(pg)})
    except Exception as exc:  # noqa: BLE001
        rec("postgres_customers", False, str(exc))
        pg = {}

    try:
        s3 = _s3_customers()
        rec("s3_customers", set(s3) == set(CANONICAL_IDS), {"ids": sorted(s3)})
    except Exception as exc:  # noqa: BLE001
        rec("s3_customers", False, str(exc))
        s3 = {}

    try:
        sftp = _sftp_customers()
        rec("sftp_customers", set(sftp) == set(CANONICAL_IDS), {"ids": sorted(sftp)})
    except Exception as exc:  # noqa: BLE001
        rec("sftp_customers", False, str(exc))
        sftp = {}

    # Field equality across sources for overlapping IDs
    sources = {"http": http, "postgres": pg, "s3": s3, "sftp": sftp}
    mismatches: list[str] = []
    for cid in CANONICAL_IDS:
        baseline = None
        baseline_name = None
        for sname, smap in sources.items():
            if cid not in smap:
                mismatches.append(f"missing {cid} in {sname}")
                continue
            if baseline is None:
                baseline = smap[cid]
                baseline_name = sname
                continue
            for field in COMPARE_FIELDS:
                if smap[cid].get(field) != baseline.get(field):
                    mismatches.append(
                        f"{cid}.{field}: {baseline_name}={baseline.get(field)!r} {sname}={smap[cid].get(field)!r}"
                    )
    rec("cross_source_field_equality", not mismatches, {"mismatches": mismatches[:20], "count": len(mismatches)})

    # Webhook: optional subset presence
    webhook_path = os.path.join(os.path.dirname(__file__), "webhook", "events.ndjson")
    try:
        lines = open(webhook_path, encoding="utf-8").read().splitlines()
        wh_ids = set()
        for line in lines:
            ev = json.loads(line)
            if ev.get("customer_id"):
                wh_ids.add(ev["customer_id"])
            payload = ev.get("payload") or {}
            if payload.get("customer_id"):
                wh_ids.add(payload["customer_id"])
        rec(
            "webhook_events_subset",
            set(CANONICAL_IDS).issubset(wh_ids) or len(wh_ids) >= 5,
            {"webhook_customer_ids_sample": sorted(list(wh_ids))[:10]},
        )
    except Exception as exc:  # noqa: BLE001
        rec("webhook_events_subset", False, str(exc))

    ok = all(r["ok"] for r in results)
    print(json.dumps({"ok": ok, "results": results}, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
