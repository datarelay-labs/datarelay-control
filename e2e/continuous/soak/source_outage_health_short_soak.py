#!/usr/bin/env python3
"""Focused source-outage health hardening validation (30–60m class).

Live Continuous E2E only — no Real SaaS. Evidence under:
e2e/continuous/soak/evidence/source_outage_health_short_soak/
"""

from __future__ import annotations

import json
import subprocess
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = ROOT / "e2e/continuous/soak/evidence/source_outage_health_short_soak"
API = "http://127.0.0.1:8000"
PREFIX = "[CONTINUOUS E2E]"
TOXI = ROOT / "e2e/lab/fault-toxiproxy.sh"


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def api(method: str, path: str, body: Any = None, timeout: int = 90) -> tuple[int, Any]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(f"{API}{path}", data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw) if raw else None
        except json.JSONDecodeError:
            return e.code, raw
    except Exception as e:  # noqa: BLE001
        return 0, {"error": str(e)}


def sh(cmd: list[str] | str, timeout: int = 120) -> tuple[int, str]:
    if isinstance(cmd, str):
        proc = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout, check=False)
    else:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def append_jsonl(path: Path, obj: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(obj, default=str) + "\n")


def continuous_streams(snap: dict[str, Any]) -> list[dict[str, Any]]:
    streams = snap.get("streams") or []
    return [s for s in streams if str(s.get("stream_name") or s.get("name") or "").startswith(PREFIX)]


def _stream_id(s: dict[str, Any]) -> int:
    return int(s.get("stream_id") or s.get("id") or 0)


def _stream_name(s: dict[str, Any]) -> str:
    return str(s.get("stream_name") or s.get("name") or "")


def find_stream(snap: dict[str, Any], needle: str) -> dict[str, Any] | None:
    for s in continuous_streams(snap):
        if needle.lower() in _stream_name(s).lower():
            return s
    return None


def stream_health(snap: dict[str, Any], stream_id: int) -> str:
    for s in continuous_streams(snap):
        if _stream_id(s) == int(stream_id):
            return str(s.get("health_status") or "").upper()
    return ""


def wait_wiremock(timeout: int = 90) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        code, _ = sh(
            [
                "curl",
                "-s",
                "-m",
                "2",
                "-o",
                "/dev/null",
                "-w",
                "%{http_code}",
                "http://127.0.0.1:28080/__admin/mappings",
            ],
            timeout=10,
        )
        # curl writes code to stdout via -w
        out = _.strip()
        if out.endswith("200") or out == "200":
            return True
        time.sleep(2)
    return False


def load_business_stubs() -> None:
    sh(f"bash {ROOT}/e2e/continuous/load-business-stubs.sh", timeout=120)


def refresh_snap() -> dict[str, Any]:
    code, snap = api("GET", "/api/v1/runtime/operational-snapshot")
    if code != 200 or not isinstance(snap, dict):
        return {}
    return snap


def run_once(stream_id: int) -> tuple[int, Any, float]:
    t0 = time.time()
    code, body = api("POST", f"/api/v1/runtime/streams/{stream_id}/run-once", {})
    return code, body, (time.time() - t0) * 1000.0


def ensure_up(*containers: str) -> None:
    for c in containers:
        sh(["docker", "start", c], timeout=90)


def cycle_container_fault(
    *,
    name: str,
    stream_needle: str,
    containers: list[str],
    cycles: int,
    recover_extra: Any | None = None,
) -> dict[str, Any]:
    results = []
    false_healthy = 0
    stuck = 0
    for i in range(cycles):
        snap = refresh_snap()
        stream = find_stream(snap, stream_needle)
        if not stream:
            results.append({"cycle": i + 1, "ok": False, "error": f"stream not found: {stream_needle}"})
            continue
        sid = _stream_id(stream)
        baseline_health = str(stream.get("health_status") or "")
        # Inject
        for c in containers:
            sh(["docker", "stop", c], timeout=60)
        time.sleep(2)
        code, body, fail_ms = run_once(sid)
        snap_mid = refresh_snap()
        health_mid = stream_health(snap_mid, sid)
        if health_mid == "HEALTHY":
            false_healthy += 1
        # Recover
        for c in containers:
            sh(["docker", "start", c], timeout=90)
        if recover_extra:
            recover_extra()
        else:
            time.sleep(3)
        time.sleep(3)
        # retry recovery a few times
        recover_ok = False
        health_post = ""
        recover_body = None
        recover_ms = 0.0
        for _ in range(8):
            rcode, recover_body, recover_ms = run_once(sid)
            snap_post = refresh_snap()
            health_post = stream_health(snap_post, sid)
            if rcode == 200 and health_post in {"HEALTHY", "IDLE"}:
                recover_ok = True
                break
            # Idle S3 may return no_events while remaining HEALTHY/IDLE
            if (
                rcode == 200
                and isinstance(recover_body, dict)
                and str(recover_body.get("outcome") or "") in {"completed", "no_events"}
                and health_post in {"HEALTHY", "IDLE"}
            ):
                recover_ok = True
                break
            time.sleep(4)
        if not recover_ok and health_post in {"ERROR", "DEGRADED"}:
            stuck += 1
        detail = body.get("detail") if isinstance(body, dict) else None
        ok = (
            code >= 400
            and health_mid not in {"", "HEALTHY"}
            and recover_ok
        )
        row = {
            "cycle": i + 1,
            "name": name,
            "stream_id": sid,
            "stream": _stream_name(stream),
            "baseline_health": baseline_health,
            "fail_http": code,
            "fail_error_code": detail.get("error_code") if isinstance(detail, dict) else None,
            "health_during_fault": health_mid,
            "fail_ms": fail_ms,
            "recover_ok": recover_ok,
            "health_after": health_post,
            "recover_ms": recover_ms,
            "ok": ok,
        }
        results.append(row)
        append_jsonl(EVIDENCE / "cycles.jsonl", {"ts": utc_now(), **row})
        print(json.dumps(row))
    return {
        "name": name,
        "cycles": results,
        "false_healthy": false_healthy,
        "stuck": stuck,
        "pass": all(r.get("ok") for r in results) and false_healthy == 0,
    }


def toxiproxy_timeout_cycle(stream_needle: str = "latency") -> dict[str, Any]:
    snap = refresh_snap()
    stream = find_stream(snap, stream_needle)
    if not stream:
        return {"name": "toxiproxy_timeout", "pass": False, "error": "stream missing"}
    sid = _stream_id(stream)
    sh([str(TOXI), "stop", "wiremock"], timeout=30)
    sh([str(TOXI), "start", "timeout", "wiremock", "1"], timeout=30)
    time.sleep(2)
    code, body, fail_ms = run_once(sid)
    snap_mid = refresh_snap()
    health_mid = stream_health(snap_mid, sid)
    sh([str(TOXI), "stop", "wiremock"], timeout=30)
    time.sleep(3)
    recover_ok = False
    health_post = ""
    for _ in range(8):
        rcode, _, _ = run_once(sid)
        health_post = stream_health(refresh_snap(), sid)
        if rcode == 200 and health_post == "HEALTHY":
            recover_ok = True
            break
        time.sleep(3)
    row = {
        "name": "toxiproxy_timeout",
        "stream_id": sid,
        "fail_http": code,
        "health_during_fault": health_mid,
        "recover_ok": recover_ok,
        "health_after": health_post,
        "fail_ms": fail_ms,
        "ok": code >= 400 and health_mid not in {"", "HEALTHY"} and recover_ok,
    }
    append_jsonl(EVIDENCE / "cycles.jsonl", {"ts": utc_now(), **row})
    print(json.dumps(row))
    return {
        "name": "toxiproxy_timeout",
        "pass": bool(row["ok"]),
        "detail": row,
        "false_healthy": int(health_mid == "HEALTHY"),
    }


def destination_regression() -> dict[str, Any]:
    snap = refresh_snap()
    # Prefer syslog TLS stream for destination stop
    stream = find_stream(snap, "Syslog TLS") or find_stream(snap, "CRM contacts")
    if not stream:
        return {"name": "destination_regression", "pass": False, "error": "no stream"}
    sid = _stream_id(stream)
    collector = "gdc-syslog-collector" if "Syslog" in _stream_name(stream) else "gdc-webhook-collector"
    sh(["docker", "stop", collector], timeout=60)
    time.sleep(2)
    code, body, _ = run_once(sid)
    health_mid = stream_health(refresh_snap(), sid)
    sh(["docker", "start", collector], timeout=90)
    # Syslog collector TLS handshake / bind can take several seconds after start.
    time.sleep(12)
    recover_ok = False
    health_post = ""
    for _ in range(12):
        rcode, rbody, _ = run_once(sid)
        health_post = stream_health(refresh_snap(), sid)
        route_fail = int((rbody or {}).get("route_delivery_failure_count") or 0) if isinstance(rbody, dict) else 1
        if rcode == 200 and route_fail == 0 and health_post == "HEALTHY":
            recover_ok = True
            break
        time.sleep(4)
    # During fault: expect non-HEALTHY (PR #30) — destination total failure
    fault_ok = health_mid in {"ERROR", "DEGRADED", "UNHEALTHY"}
    row = {
        "name": "destination_regression",
        "stream_id": sid,
        "collector": collector,
        "run_once_http": code,
        "route_fail": int((body or {}).get("route_delivery_failure_count") or 0) if isinstance(body, dict) else None,
        "health_during_fault": health_mid,
        "health_after": health_post,
        "recover_ok": recover_ok,
        "ok": fault_ok and recover_ok,
    }
    append_jsonl(EVIDENCE / "cycles.jsonl", {"ts": utc_now(), **row})
    print(json.dumps(row))
    return {"name": "destination_regression", "pass": bool(row["ok"]), "detail": row}


def idle_s3_no_data_check() -> dict[str, Any]:
    ensure_up("gdc-minio-test")
    time.sleep(2)
    snap = refresh_snap()
    stream = find_stream(snap, "Idle / no-new-data S3")
    if not stream:
        return {"name": "idle_s3", "pass": False, "error": "missing"}
    sid = _stream_id(stream)
    code, body, _ = run_once(sid)
    health = stream_health(refresh_snap(), sid)
    ok = code == 200 and health in {"HEALTHY", "IDLE"} and health != "ERROR"
    row = {
        "name": "idle_s3_no_data",
        "stream_id": sid,
        "http": code,
        "outcome": (body or {}).get("outcome") if isinstance(body, dict) else None,
        "health": health,
        "ok": ok,
    }
    append_jsonl(EVIDENCE / "cycles.jsonl", {"ts": utc_now(), **row})
    print(json.dumps(row))
    return {"name": "idle_s3", "pass": ok, "detail": row}


def http_500_stub_cycle() -> dict[str, Any]:
    """WireMock 500 then restore for CRM contacts."""

    snap = refresh_snap()
    stream = find_stream(snap, "Healthy CRM contacts")
    if not stream:
        return {"name": "http_500", "pass": False, "error": "missing"}
    sid = _stream_id(stream)
    crm_stub_id = "b1000001-0001-4000-8000-000000000001"
    # Replace healthy stub with 500 (same id / priority).
    stub = {
        "id": crm_stub_id,
        "priority": 1,
        "request": {"method": "GET", "urlPath": "/business/crm/contacts"},
        "response": {"status": 500, "body": "injected-500", "headers": {"Content-Type": "text/plain"}},
    }
    sh(["curl", "-sS", "-X", "DELETE", f"http://127.0.0.1:28080/__admin/mappings/{crm_stub_id}"], timeout=30)
    sh(
        [
            "curl",
            "-sS",
            "-X",
            "POST",
            "http://127.0.0.1:28080/__admin/mappings",
            "-H",
            "Content-Type: application/json",
            "-d",
            json.dumps(stub),
        ],
        timeout=30,
    )
    time.sleep(1)
    code, body, fail_ms = run_once(sid)
    health_mid = stream_health(refresh_snap(), sid)
    load_business_stubs()
    time.sleep(2)
    recover_ok = False
    health_post = ""
    for _ in range(8):
        rcode, _, _ = run_once(sid)
        health_post = stream_health(refresh_snap(), sid)
        if rcode == 200 and health_post == "HEALTHY":
            recover_ok = True
            break
        time.sleep(3)
    row = {
        "name": "http_500",
        "stream_id": sid,
        "fail_http": code,
        "health_during_fault": health_mid,
        "recover_ok": recover_ok,
        "health_after": health_post,
        "fail_ms": fail_ms,
        "ok": code >= 400 and health_mid not in {"", "HEALTHY"} and recover_ok,
    }
    append_jsonl(EVIDENCE / "cycles.jsonl", {"ts": utc_now(), **row})
    print(json.dumps(row))
    return {
        "name": "http_500",
        "pass": bool(row["ok"]),
        "detail": row,
        "false_healthy": int(health_mid == "HEALTHY"),
    }


def main() -> int:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    started = utc_now()
    t0 = time.time()
    # Ensure dependencies up before starting
    ensure_up(
        "gdc-wiremock-test",
        "gdc-platform-gdc-wiremock-test-1",
        "gdc-postgres-query-test",
        "gdc-minio-test",
        "gdc-sftp-test",
        "gdc-webhook-collector",
        "gdc-syslog-collector",
    )
    wait_wiremock(90)
    load_business_stubs()

    results: list[dict[str, Any]] = []

    results.append(http_500_stub_cycle())
    results.append(
        cycle_container_fault(
            name="http_source_stop",
            stream_needle="Healthy CRM contacts",
            containers=["gdc-wiremock-test", "gdc-platform-gdc-wiremock-test-1"],
            cycles=3,
            recover_extra=lambda: (wait_wiremock(90), load_business_stubs()),
        )
    )
    results.append(
        cycle_container_fault(
            name="postgres_source_stop",
            stream_needle="ITSM tickets (PostgreSQL)",
            containers=["gdc-postgres-query-test"],
            cycles=1,
        )
    )
    results.append(
        cycle_container_fault(
            name="s3_source_stop",
            stream_needle="Idle / no-new-data S3",
            containers=["gdc-minio-test"],
            cycles=1,
        )
    )
    results.append(
        cycle_container_fault(
            name="sftp_source_stop",
            stream_needle="finance invoices (SFTP)",
            containers=["gdc-sftp-test"],
            cycles=1,
        )
    )
    results.append(toxiproxy_timeout_cycle("latency"))
    results.append(idle_s3_no_data_check())
    results.append(destination_regression())

    # Final environment restore
    ensure_up(
        "gdc-wiremock-test",
        "gdc-platform-gdc-wiremock-test-1",
        "gdc-postgres-query-test",
        "gdc-minio-test",
        "gdc-sftp-test",
        "gdc-webhook-collector",
        "gdc-syslog-collector",
    )
    sh([str(TOXI), "stop", "wiremock"], timeout=30)
    wait_wiremock(60)
    load_business_stubs()

    false_healthy = sum(int(r.get("false_healthy") or 0) for r in results)
    stuck = sum(int(r.get("stuck") or 0) for r in results)
    all_pass = all(bool(r.get("pass")) for r in results) and false_healthy == 0 and stuck == 0
    summary = {
        "started": started,
        "ended": utc_now(),
        "duration_sec": round(time.time() - t0, 1),
        "pass": all_pass,
        "false_healthy": false_healthy,
        "stuck_error_or_degraded": stuck,
        "results": results,
    }
    (EVIDENCE / "summary.json").write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")
    print("SUMMARY", json.dumps({"pass": all_pass, "false_healthy": false_healthy, "stuck": stuck, "duration_sec": summary["duration_sec"]}))
    return 0 if all_pass else 1


if __name__ == "__main__":
    raise SystemExit(main())
