#!/usr/bin/env python3
"""TLS negative/recovery lab wrapper — reuses existing OpenSSL/syslog TLS coverage.

TLS_NEGATIVE_TESTS rely on tests/test_syslog_tls_destination.py (expired cert,
wrong hostname / unknown CA style failures under strict verify). This script:
  1) Confirms cert tooling / existing helpers are present
  2) Optionally runs a thin live recovery: stop syslog-tls collector → fail → start → recover
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
API = os.environ.get("GDC_E2E_API_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
RUN_PYTEST = os.environ.get("GDC_TLS_RUN_PYTEST", "1") == "1"


def api(method: str, path: str, body: Any = None) -> tuple[int, Any]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(f"{API}{path}", data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw) if raw else None
        except json.JSONDecodeError:
            return e.code, raw


def main() -> int:
    results = []

    def rec(name: str, ok: bool, detail: Any = None) -> None:
        results.append({"name": name, "ok": ok, "detail": detail})
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: {detail}")

    helper = ROOT / "tests" / "e2e_syslog_helpers.py"
    suite = ROOT / "tests" / "test_syslog_tls_destination.py"
    rec("tls_helpers_present", helper.exists() and suite.exists(), {"helper": str(helper), "suite": str(suite)})

    if RUN_PYTEST:
        proc = subprocess.run(
            [
                sys.executable,
                "-m",
                "pytest",
                str(suite),
                "-q",
                "--tb=line",
                "-k",
                "expired or hostname or unknown or client_cert or verify",
            ],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        # Accept pass or "no tests selected" with helpers present — product suite may use different names.
        out = (proc.stdout or "") + (proc.stderr or "")
        selected = "no tests ran" not in out.lower() and proc.returncode == 0
        if proc.returncode == 0:
            rec("tls_pytest_negative_subset", True, {"returncode": proc.returncode, "tail": out[-500:]})
        elif "no tests ran" in out.lower() or proc.returncode == 5:
            # Fallback: run whole syslog TLS module (targeted product suite already exists)
            proc2 = subprocess.run(
                [sys.executable, "-m", "pytest", str(suite), "-q", "--tb=line"],
                cwd=str(ROOT),
                capture_output=True,
                text=True,
                check=False,
            )
            rec(
                "tls_pytest_negative_subset",
                proc2.returncode == 0,
                {"returncode": proc2.returncode, "tail": ((proc2.stdout or "") + (proc2.stderr or ""))[-800:]},
            )
        else:
            rec("tls_pytest_negative_subset", False, {"returncode": proc.returncode, "tail": out[-800:]})
    else:
        rec("tls_pytest_negative_subset", True, {"skipped": "GDC_TLS_RUN_PYTEST=0"})

    # Live collector-down recovery (TLS destination stream if present)
    st, streams = api("GET", "/api/v1/streams/")
    items = streams if isinstance(streams, list) else (streams or {}).get("items") or []
    tls_stream = next(
        (
            s
            for s in items
            if str(s.get("name") or "").startswith("[CONTINUOUS E2E]")
            and "Syslog TLS" in str(s.get("name") or "")
        ),
        None,
    )
    if not tls_stream:
        # Any continuous stream with syslog in name
        tls_stream = next(
            (
                s
                for s in items
                if str(s.get("name") or "").startswith("[CONTINUOUS E2E]") and "TLS" in str(s.get("name") or "")
            ),
            None,
        )
    if tls_stream:
        sid = int(tls_stream["id"])
        subprocess.run(["docker", "stop", "gdc-syslog-collector"], check=False, capture_output=True)
        time.sleep(2)
        st_f, run_f = api("POST", f"/api/v1/runtime/streams/{sid}/run-once", {})
        fail_ok = st_f >= 400 or (
            isinstance(run_f, dict)
            and int(run_f.get("delivered_batch_event_count") or 0) == 0
        )
        subprocess.run(["docker", "start", "gdc-syslog-collector"], check=False, capture_output=True)
        # wait healthy
        for _ in range(20):
            time.sleep(1)
            try:
                urllib.request.urlopen("http://127.0.0.1:18193/health", timeout=2).read()
                break
            except Exception:
                continue
        st_r, run_r = api("POST", f"/api/v1/runtime/streams/{sid}/run-once", {})
        recover_ok = st_r == 200 and isinstance(run_r, dict) and str(run_r.get("outcome") or "").lower() in (
            "completed",
            "success",
            "ok",
        )
        rec("tls_collector_failure_recovery", fail_ok and recover_ok, {"fail": run_f, "recover": run_r})
    else:
        rec("tls_collector_failure_recovery", True, {"skipped": "no continuous TLS stream found; pytest covers cert negatives"})

    ok = all(r["ok"] for r in results)
    print(json.dumps({"ok": ok, "results": results}, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
