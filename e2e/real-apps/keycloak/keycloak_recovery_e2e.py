#!/usr/bin/env python3
"""Keycloak token-endpoint unavailable → Data Relay failure → restore → recovery."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Any

API = os.environ.get("GDC_E2E_API_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
KEYCLOAK_DOCKER = os.environ.get("KEYCLOAK_DOCKER_BASE", "http://gdc-keycloak-e2e:8089").rstrip("/")
RESOURCE_DOCKER = os.environ.get("KEYCLOAK_RESOURCE_DOCKER", "http://gdc-keycloak-resource-lab:8090").rstrip("/")


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


def wait_keycloak(timeout_sec: int = 180) -> bool:
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        try:
            urllib.request.urlopen(
                "http://127.0.0.1:8089/realms/gdc-e2e/.well-known/openid-configuration",
                timeout=3,
            ).read()
            return True
        except Exception:
            time.sleep(3)
    return False


def main() -> int:
    results = []

    def rec(name: str, ok: bool, detail: Any = None) -> None:
        results.append({"name": name, "ok": ok, "detail": detail})
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: {detail}")

    st, dests = api("GET", "/api/v1/destinations/")
    items = dests if isinstance(dests, list) else (dests or {}).get("items") or []
    dest_id = next(
        (
            int(d["id"])
            for d in items
            if str(d.get("name") or "").startswith("[CONTINUOUS E2E]") and "Webhook" in str(d.get("name") or "")
        ),
        None,
    )
    if dest_id is None:
        _, created = api(
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

    name = f"[E2E LAB EPHEMERAL] Keycloak recovery {int(time.time())}"
    stream_id = None
    connector_id = None
    try:
        _, conn = api(
            "POST",
            "/api/v1/connectors/",
            {
                "name": f"{name} connector",
                "connector_type": "generic_http",
                "source_type": "HTTP_API_POLLING",
                "base_url": RESOURCE_DOCKER,
                "verify_ssl": False,
                "auth_type": "oauth2_client_credentials",
                "oauth2_token_url": f"{KEYCLOAK_DOCKER}/realms/gdc-e2e/protocol/openid-connect/token",
                "oauth2_client_id": "gdc-e2e-oauth-client",
                "oauth2_client_secret": "gdc-e2e-oauth-secret",
            },
        )
        connector_id = int(conn["id"])
        source_id = int(conn.get("source_id") or connector_id)
        _, stream = api(
            "POST",
            "/api/v1/streams/",
            {
                "name": name,
                "connector_id": connector_id,
                "source_id": source_id,
                "stream_type": "HTTP_API_POLLING",
                "config_json": {"endpoint": "/business/customers", "method": "GET"},
                "polling_interval": 300,
                "enabled": True,
                "status": "RUNNING",
                "event_array_path": "$.data",
            },
        )
        stream_id = int(stream["id"])
        api(
            "POST",
            f"/api/v1/runtime/mappings/stream/{stream_id}/save",
            {"event_array_path": "$.data", "field_mappings": {"id": "$.id", "customer_id": "$.customer_id"}},
        )
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

        st0, run0 = api("POST", f"/api/v1/runtime/streams/{stream_id}/run-once", {})
        baseline = st0 == 200 and isinstance(run0, dict) and int(run0.get("delivered_batch_event_count") or 0) > 0
        rec("keycloak_recovery_baseline", baseline, {"status": st0, "run": run0})

        subprocess.run(["docker", "stop", "gdc-keycloak-e2e"], check=False, capture_output=True)
        time.sleep(2)
        st1, run1 = api("POST", f"/api/v1/runtime/streams/{stream_id}/run-once", {})
        failed = (
            st1 >= 400
            or "token" in json.dumps(run1).lower()
            or "SOURCE_FETCH_FAILED" in json.dumps(run1)
            or "OAUTH" in json.dumps(run1).upper()
        )
        rec("keycloak_token_unavailable_failure", failed, {"status": st1, "run": run1})

        subprocess.run(["docker", "start", "gdc-keycloak-e2e"], check=False, capture_output=True)
        ready = wait_keycloak(180)
        rec("keycloak_restored_ready", ready, None)
        time.sleep(2)
        st2, run2 = api("POST", f"/api/v1/runtime/streams/{stream_id}/run-once", {})
        recovered = st2 == 200 and isinstance(run2, dict) and (
            int(run2.get("delivered_batch_event_count") or 0) > 0
            or str(run2.get("outcome") or "").lower() == "completed"
        )
        rec("keycloak_recovery_delivery", recovered, {"status": st2, "run": run2})
    finally:
        # Always restore Keycloak and remove ephemeral resources
        subprocess.run(["docker", "start", "gdc-keycloak-e2e"], check=False, capture_output=True)
        if stream_id is not None:
            api("PUT", f"/api/v1/streams/{stream_id}", {"enabled": False, "status": "STOPPED"})
            api("DELETE", f"/api/v1/streams/{stream_id}")
        if connector_id is not None:
            api("DELETE", f"/api/v1/connectors/{connector_id}")

    ok = all(r["ok"] for r in results)
    print(json.dumps({"ok": ok, "results": results}, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
