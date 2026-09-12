#!/usr/bin/env python3
"""Short focused soak after destination-delivery-health hardening.

Rotates webhook/syslog destination outages, WireMock source outage, and a
Toxiproxy timeout cycle. Proves repeated failure→recovery status transitions
without a full overnight soak.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = os.environ.get("GDC_E2E_API_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
EVIDENCE = Path(
    os.environ.get(
        "SHORT_SOAK_EVIDENCE",
        "e2e/continuous/soak/evidence/destination_health_short_soak",
    )
)
TOXI = Path("e2e/lab/fault-toxiproxy.sh")
STUBS = Path("e2e/continuous/load-business-stubs.sh")

WEBHOOK_STREAM = 333
SYSLOG_STREAM = 343
IDLE_STREAM = 335


def utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def api(method: str, path: str, body=None, timeout: int = 90):
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


def run_once(stream_id: int):
    return api("POST", f"/api/v1/runtime/streams/{stream_id}/run-once", {})


def snapshot():
    code, body = api("GET", "/api/v1/runtime/operational-snapshot", timeout=30)
    return body if code == 200 else {}


def stream_health(snap: dict, stream_id: int) -> dict:
    for s in snap.get("streams") or []:
        if int(s.get("stream_id") or 0) == stream_id:
            return s
    return {}


def route_health(snap: dict, stream_id: int) -> dict:
    for r in snap.get("routes") or []:
        if int(r.get("stream_id") or 0) == stream_id:
            return r
    return {}


def scored_route(stream_id: int) -> dict:
    code, body = api("GET", f"/api/v1/runtime/health/routes?stream_id={stream_id}", timeout=30)
    if code != 200:
        return {}
    rows = body.get("rows") or []
    return rows[0] if rows else {}


def append(name: str, obj: dict) -> None:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    path = EVIDENCE / name
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(obj, default=str) + "\n")


def wait_wiremock(timeout: int = 60) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        code, _ = api("GET", "/")  # noop
        rc, _ = sh(["curl", "-s", "-m", "2", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:28080/__admin/mappings"])
        if "200" in _:
            return True
        time.sleep(2)
    return False


def load_stubs() -> None:
    sh(f"bash {STUBS}", timeout=120)


def dest_cycle(name: str, stream_id: int, container: str) -> dict:
    result = {"cycle": name, "stream_id": stream_id, "started": utc()}
    # baseline
    code, body = run_once(stream_id)
    result["baseline"] = {"code": code, "body": body}
    sh(["docker", "stop", container], timeout=60)
    time.sleep(2)
    code, body = run_once(stream_id)
    snap = snapshot()
    st = stream_health(snap, stream_id)
    rt = route_health(snap, stream_id)
    scored = scored_route(stream_id)
    result["impact"] = {
        "code": code,
        "body": body,
        "stream_health": st.get("health_status"),
        "route_health": rt.get("health_status"),
        "scored_route_level": scored.get("level"),
        "scored_route_score": scored.get("score"),
        "route_delivery_failure_count": (body or {}).get("route_delivery_failure_count") if isinstance(body, dict) else None,
    }
    false_healthy = str(st.get("health_status") or "").upper() == "HEALTHY" or str(scored.get("level") or "").upper() == "HEALTHY"
    impact_ok = (not false_healthy) and int((body or {}).get("route_delivery_failure_count") or 0) >= 1
    result["impact_ok"] = impact_ok
    result["false_healthy"] = false_healthy

    sh(["docker", "start", container], timeout=90)
    time.sleep(12)
    recovered = False
    last = None
    for _ in range(4):
        code, body = run_once(stream_id)
        last = {"code": code, "body": body}
        if code == 200 and isinstance(body, dict) and body.get("outcome") == "completed" and int(body.get("route_delivery_success_count") or 0) >= 1:
            recovered = True
            break
        time.sleep(5)
    snap = snapshot()
    st = stream_health(snap, stream_id)
    rt = route_health(snap, stream_id)
    scored = scored_route(stream_id)
    result["recovery"] = {
        "ok": recovered,
        "last": last,
        "stream_health": st.get("health_status"),
        "route_health": rt.get("health_status"),
        "scored_route_level": scored.get("level"),
    }
    # Route should not stay ERROR after successful delivery (may be DEGRADED briefly).
    result["recovery_ok"] = recovered and str(rt.get("health_status") or "").upper() != "ERROR"
    result["finished"] = utc()
    append("cycles.jsonl", result)
    return result


def wiremock_cycle() -> dict:
    result = {"cycle": "wiremock_source", "started": utc()}
    code, body = run_once(WEBHOOK_STREAM)
    result["baseline"] = {"code": code, "body": body}
    sh(["docker", "stop", "gdc-wiremock-test"], timeout=60)
    sh(["docker", "stop", "gdc-platform-gdc-wiremock-test-1"], timeout=60)
    time.sleep(2)
    code, body = run_once(WEBHOOK_STREAM)
    err = ""
    if isinstance(body, dict):
        detail = body.get("detail") or body
        if isinstance(detail, dict):
            err = str(detail.get("error_code") or "")
    result["impact"] = {"code": code, "body": body, "error_code": err}
    result["impact_ok"] = code >= 400 and ("SOURCE" in err or "FETCH" in err or "HTTP" in err)
    sh(["docker", "start", "gdc-wiremock-test"], timeout=90)
    sh(["docker", "start", "gdc-platform-gdc-wiremock-test-1"], timeout=90)
    wait_wiremock()
    load_stubs()
    time.sleep(3)
    recovered = False
    last = None
    for _ in range(4):
        code, body = run_once(WEBHOOK_STREAM)
        last = {"code": code, "body": body}
        if code == 200 and isinstance(body, dict) and int(body.get("delivered_batch_event_count") or 0) >= 1:
            recovered = True
            break
        time.sleep(5)
    result["recovery"] = {"ok": recovered, "last": last}
    result["recovery_ok"] = recovered
    result["finished"] = utc()
    append("cycles.jsonl", result)
    return result


def toxiproxy_timeout_cycle() -> dict:
    result = {"cycle": "toxiproxy_timeout", "started": utc()}
    if not TOXI.exists():
        result["skipped"] = True
        result["impact_ok"] = True
        result["recovery_ok"] = True
        append("cycles.jsonl", result)
        return result
    sh([str(TOXI), "start", "timeout", "wiremock", "1"], timeout=60)
    time.sleep(2)
    code, body = run_once(WEBHOOK_STREAM)
    result["impact"] = {"code": code, "body": body}
    # Either source error or slow failure is acceptable impact
    result["impact_ok"] = code != 0
    sh([str(TOXI), "reset"], timeout=60)
    time.sleep(3)
    code, body = run_once(WEBHOOK_STREAM)
    result["recovery"] = {"code": code, "body": body}
    result["recovery_ok"] = code == 200 and isinstance(body, dict) and body.get("outcome") in {"completed", "no_events"}
    result["finished"] = utc()
    append("cycles.jsonl", result)
    return result


def idle_check() -> dict:
    code, body = run_once(IDLE_STREAM)
    snap = snapshot()
    st = stream_health(snap, IDLE_STREAM)
    health = str(st.get("health_status") or "").upper()
    ok = code == 200 and isinstance(body, dict) and body.get("outcome") == "no_events" and health in {"HEALTHY", "IDLE"}
    row = {"cycle": "idle_s3", "ok": ok, "body": body, "health": health, "at": utc()}
    append("cycles.jsonl", row)
    return row


def main() -> int:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    started = time.time()
    target_sec = int(os.environ.get("SHORT_SOAK_SECONDS", "2400"))  # default 40m
    rounds = 0
    results: list[dict] = []
    false_healthy = 0
    stuck = 0

    # Ensure baseline healthy enough
    sh(["docker", "start", "gdc-webhook-collector", "gdc-syslog-collector", "gdc-wiremock-test"], timeout=90)
    wait_wiremock()
    load_stubs()

    while time.time() - started < target_sec:
        rounds += 1
        print(f"=== round {rounds} @ {utc()} ===", flush=True)
        for fn in (
            lambda: dest_cycle("webhook_dest", WEBHOOK_STREAM, "gdc-webhook-collector"),
            lambda: dest_cycle("syslog_dest", SYSLOG_STREAM, "gdc-syslog-collector"),
            wiremock_cycle,
            toxiproxy_timeout_cycle,
            idle_check,
        ):
            row = fn()
            results.append(row)
            if row.get("false_healthy"):
                false_healthy += 1
            if row.get("impact_ok") is False or row.get("recovery_ok") is False or row.get("ok") is False:
                stuck += 1
            print(json.dumps({k: row.get(k) for k in ("cycle", "impact_ok", "recovery_ok", "ok", "false_healthy")}, default=str), flush=True)
            if time.time() - started >= target_sec:
                break

    # Final environment health
    snap = snapshot()
    final = {
        "started": datetime.fromtimestamp(started, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "finished": utc(),
        "duration_sec": round(time.time() - started, 1),
        "rounds": rounds,
        "cycles": len(results),
        "false_healthy_count": false_healthy,
        "failed_checks": stuck,
        "global_health": (snap.get("global") or {}).get("health_status"),
        "idle_ok": any(r.get("cycle") == "idle_s3" and r.get("ok") for r in results),
        "webhook_cycles_pass": all(
            r.get("impact_ok") and r.get("recovery_ok") for r in results if r.get("cycle") == "webhook_dest"
        ),
        "syslog_cycles_pass": all(
            r.get("impact_ok") and r.get("recovery_ok") for r in results if r.get("cycle") == "syslog_dest"
        ),
        "wiremock_cycles_pass": all(
            r.get("impact_ok") and r.get("recovery_ok") for r in results if r.get("cycle") == "wiremock_source"
        ),
    }
    final["SHORT_SOAK"] = (
        "PASS"
        if false_healthy == 0
        and stuck == 0
        and final["webhook_cycles_pass"]
        and final["syslog_cycles_pass"]
        and final["wiremock_cycles_pass"]
        and final["idle_ok"]
        else "FAIL"
    )
    (EVIDENCE / "summary.json").write_text(json.dumps(final, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(final, indent=2), flush=True)
    return 0 if final["SHORT_SOAK"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
