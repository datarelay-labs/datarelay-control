#!/usr/bin/env python3
"""DNS failure/recovery using OS resolver (no CoreDNS).

DNS_TOOL_DECISION=REUSE_EXISTING — NXDOMAIN via .invalid TLD is deterministic.
Flow: connector host no-such-host.e2e.invalid → source failure → repair URL → recovery.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any

API = os.environ.get("GDC_E2E_API_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
WM_DOCKER = os.environ.get("GDC_CONTINUOUS_WIREMOCK_URL", "http://gdc-wiremock-test:8080").rstrip("/")


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

    # Ensure a webhook destination
    st, dests = api("GET", "/api/v1/destinations/")
    dest_id = None
    items = dests if isinstance(dests, list) else (dests or {}).get("items") or []
    for d in items:
        if str(d.get("name") or "").startswith("[CONTINUOUS E2E]") and "Webhook" in str(d.get("name") or ""):
            dest_id = int(d["id"])
            break
    if dest_id is None:
        st, created = api(
            "POST",
            "/api/v1/destinations/",
            {
                "name": "[CONTINUOUS E2E] Webhook Collector",
                "destination_type": "WEBHOOK_POST",
                "config_json": {"url": "http://gdc-webhook-collector:8080/continuous-e2e", "method": "POST"},
                "enabled": True,
                "status": "ACTIVE",
            },
        )
        dest_id = int(created["id"])

    name = f"[E2E LAB EPHEMERAL] DNS fail-recover {int(time.time())}"
    connector_id = None
    stream_id = None
    try:
        st, conn = api(
            "POST",
            "/api/v1/connectors/",
            {
                "name": f"{name} connector",
                "connector_type": "generic_http",
                "source_type": "HTTP_API_POLLING",
                "base_url": "http://no-such-host.e2e.invalid:8080",
                "verify_ssl": False,
                "auth_type": "no_auth",
            },
        )
        if st not in (200, 201):
            rec("dns_connector_create", False, {"status": st, "body": conn})
            print(json.dumps({"ok": False, "results": results}, indent=2))
            return 1
        connector_id = int(conn["id"])
        source_id = int(conn.get("source_id") or connector_id)
        st, stream = api(
            "POST",
            "/api/v1/streams/",
            {
                "name": name,
                "connector_id": connector_id,
                "source_id": source_id,
                "stream_type": "HTTP_API_POLLING",
                "config_json": {"endpoint": "/shared-business/canonical", "method": "GET"},
                "polling_interval": 300,
                "enabled": True,
                "status": "RUNNING",
                "event_array_path": "$.data",
            },
        )
        stream_id = int(stream["id"])
        api(
            "POST",
            "/api/v1/routes/",
            {
                "stream_id": stream_id,
                "destination_id": dest_id,
                "name": f"{name} route",
                "enabled": True,
                "status": "ACTIVE",
                "failure_policy": "LOG_AND_CONTINUE",
            },
        )
        st_fail, run_fail = api("POST", f"/api/v1/runtime/streams/{stream_id}/run-once", {})
        fail_ok = st_fail >= 400 or (
            isinstance(run_fail, dict)
            and (
                "NAME" in json.dumps(run_fail).upper()
                or "RESOLV" in json.dumps(run_fail).upper()
                or "SOURCE_FETCH_FAILED" in json.dumps(run_fail)
                or "getaddrinfo" in json.dumps(run_fail).lower()
                or "nodename" in json.dumps(run_fail).lower()
                or st_fail >= 400
            )
        )
        rec("dns_failure_observed", fail_ok, {"status": st_fail, "run": run_fail})

        # Repair connector URL to WireMock
        st_u, _ = api(
            "PUT",
            f"/api/v1/connectors/{connector_id}",
            {
                "name": f"{name} connector",
                "connector_type": "generic_http",
                "source_type": "HTTP_API_POLLING",
                "base_url": WM_DOCKER,
                "verify_ssl": False,
                "auth_type": "no_auth",
            },
        )
        time.sleep(1)
        st_ok, run_ok = api("POST", f"/api/v1/runtime/streams/{stream_id}/run-once", {})
        recover_ok = st_ok == 200 and isinstance(run_ok, dict) and (
            int(run_ok.get("delivered_batch_event_count") or 0) > 0
            or int(run_ok.get("mapped_event_count") or 0) > 0
            or str(run_ok.get("outcome") or "").lower() == "completed"
        )
        rec("dns_recovery_observed", recover_ok, {"status": st_ok, "run": run_ok, "connector_update": st_u})
    finally:
        if stream_id is not None:
            api("PUT", f"/api/v1/streams/{stream_id}", {"enabled": False, "status": "STOPPED"})
            api("DELETE", f"/api/v1/streams/{stream_id}")
        if connector_id is not None:
            api("DELETE", f"/api/v1/connectors/{connector_id}")

    ok = all(r["ok"] for r in results)
    print(json.dumps({"ok": ok, "dns_tool_decision": "REUSE_EXISTING", "results": results}, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
