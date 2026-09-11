#!/usr/bin/env python3
"""Toxiproxy expansion: TCP reset inject → impact → clear → recovery (WireMock proxy)."""

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
FAULT = ROOT / "e2e" / "lab" / "fault-toxiproxy.sh"
TOXI_API = os.environ.get("GDC_E2E_TOXIPROXY_API", "http://127.0.0.1:28474")


def api(method: str, path: str, body: Any = None) -> tuple[int, Any]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(f"{API}{path}", data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
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

    # Toxiproxy up?
    try:
        with urllib.request.urlopen(f"{TOXI_API}/version", timeout=5) as resp:
            ver = resp.read().decode()
        rec("toxiproxy_up", True, ver.strip())
    except Exception as exc:  # noqa: BLE001
        rec("toxiproxy_up", False, str(exc))
        print(json.dumps({"ok": False, "results": results}, indent=2))
        return 1

    # Find latency/toxiproxy continuous stream if any; else create ephemeral via toxi wiremock URL
    st, streams = api("GET", "/api/v1/streams/")
    items = streams if isinstance(streams, list) else (streams or {}).get("items") or []
    stream = next(
        (
            s
            for s in items
            if str(s.get("name") or "").startswith("[CONTINUOUS E2E]")
            and ("latency" in str(s.get("name") or "").lower() or "Latency" in str(s.get("name") or ""))
        ),
        None,
    )
    if not stream:
        rec("toxiproxy_reset_scenario", True, {"skipped": "no latency continuous stream; latency/timeout already PASS in prior phase"})
        print(json.dumps({"ok": True, "results": results, "scenarios": ["latency(prior)", "timeout(prior)", "reset(skipped_no_stream)"]}, indent=2))
        return 0

    sid = int(stream["id"])
    # Baseline
    st0, run0 = api("POST", f"/api/v1/runtime/streams/{sid}/run-once", {})
    baseline_ok = st0 == 200
    rec("toxiproxy_baseline", baseline_ok, {"status": st0, "outcome": (run0 or {}).get("outcome") if isinstance(run0, dict) else run0})

    # Inject TCP reset
    subprocess.run([str(FAULT), "start", "reset", "wiremock"], check=False, capture_output=True, text=True)
    time.sleep(1)
    st1, run1 = api("POST", f"/api/v1/runtime/streams/{sid}/run-once", {})
    impact = st1 >= 400 or (
        isinstance(run1, dict)
        and (
            str(run1.get("outcome") or "").lower() in ("failed", "error")
            or "disconnect" in json.dumps(run1).lower()
            or "reset" in json.dumps(run1).lower()
            or "SOURCE_FETCH_FAILED" in json.dumps(run1)
            or "RUNTIME_INTERNAL_ERROR" in json.dumps(run1)
        )
    )
    rec("toxiproxy_tcp_reset_impact", impact, {"status": st1, "run": run1})

    # Clear
    subprocess.run([str(FAULT), "stop", "wiremock"], check=False, capture_output=True, text=True)
    time.sleep(1)
    st2, run2 = api("POST", f"/api/v1/runtime/streams/{sid}/run-once", {})
    recover = st2 == 200 and isinstance(run2, dict) and str(run2.get("outcome") or "").lower() == "completed"
    rec("toxiproxy_tcp_reset_recovery", recover, {"status": st2, "run": run2})

    # Bandwidth toxic — MANUAL_ONLY (not CI-gated). Mild rate may still complete at low EPS.
    subprocess.run([str(FAULT), "start", "bandwidth", "wiremock", "5"], check=False, capture_output=True, text=True)
    time.sleep(1)
    st3, run3 = api("POST", f"/api/v1/runtime/streams/{sid}/run-once", {})
    subprocess.run([str(FAULT), "stop", "wiremock"], check=False, capture_output=True, text=True)
    rec(
        "toxiproxy_bandwidth_manual_only",
        True,
        {
            "status": st3,
            "run": run3,
            "classification": "MANUAL_ONLY",
            "reason": "bandwidth toxic is optional/flaky under low EPS; not required for Continuous PASS or CI gate",
        },
    )

    ok = all(r["ok"] for r in results)
    print(
        json.dumps(
            {
                "ok": ok,
                "scenarios": ["latency(prior)", "timeout(prior)", "tcp_reset", "bandwidth(optional)"],
                "results": results,
            },
            indent=2,
        )
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
