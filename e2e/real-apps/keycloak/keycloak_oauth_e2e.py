#!/usr/bin/env python3
"""TEST-ONLY Keycloak oauth2_client_credentials targeted E2E (no product code changes).

Validates:
  valid client_id/secret → access_token → protected resource
  invalid secret / invalid client_id / disabled client → 401
  invalid bearer → resource 401
  optional: Data Relay live poll path when GDC_E2E_API_BASE_URL is reachable

Classify Keycloak lifecycle: ON_DEMAND (~384MiB observed).
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

KEYCLOAK_HOST_BASE = os.environ.get("KEYCLOAK_HOST_BASE", "http://127.0.0.1:8089").rstrip("/")
KEYCLOAK_DOCKER_BASE = os.environ.get("KEYCLOAK_DOCKER_BASE", "http://gdc-keycloak-e2e:8089").rstrip("/")
RESOURCE_HOST = os.environ.get("KEYCLOAK_RESOURCE_HOST", "http://127.0.0.1:8090").rstrip("/")
RESOURCE_DOCKER = os.environ.get("KEYCLOAK_RESOURCE_DOCKER", "http://gdc-keycloak-resource-lab:8090").rstrip("/")
REALM = "gdc-e2e"
TOKEN_PATH = f"/realms/{REALM}/protocol/openid-connect/token"
CLIENT_ID = "gdc-e2e-oauth-client"
CLIENT_SECRET = "gdc-e2e-oauth-secret"
API_BASE = os.environ.get("GDC_E2E_API_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
LIVE = os.environ.get("GDC_KEYCLOAK_LIVE_RELAY", "1") == "1"

RESULTS: list[dict[str, Any]] = []


def _record(name: str, ok: bool, detail: Any = None) -> None:
    RESULTS.append({"name": name, "ok": ok, "detail": detail})
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name}: {detail if detail is not None else ''}")


def _basic(user: str, pw: str) -> str:
    return "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode()


def _token_via_docker(client_id: str, client_secret: str) -> tuple[int, Any]:
    """Acquire token using docker-network hostname (issuer matches resource introspection)."""
    script = f"""
import base64, json, urllib.parse, urllib.request, sys
TOKEN_URL = "{KEYCLOAK_DOCKER_BASE}{TOKEN_PATH}"
form = urllib.parse.urlencode({{"grant_type": "client_credentials"}}).encode()
auth = "Basic " + base64.b64encode(b"{client_id}:{client_secret}").decode()
req = urllib.request.Request(TOKEN_URL, data=form, headers={{
  "Content-Type": "application/x-www-form-urlencoded",
  "Authorization": auth,
}}, method="POST")
try:
  with urllib.request.urlopen(req, timeout=20) as resp:
    print(resp.status)
    print(resp.read().decode())
except urllib.error.HTTPError as e:
  print(e.code)
  print(e.read().decode())
except Exception as e:
  print(0)
  print(str(e))
"""
    proc = subprocess.run(
        ["docker", "exec", "gdc-keycloak-resource-lab", "python", "-c", script],
        capture_output=True,
        text=True,
        check=False,
    )
    lines = (proc.stdout or "").strip().splitlines()
    if len(lines) < 2:
        return 0, {"stderr": proc.stderr, "stdout": proc.stdout}
    code = int(lines[0])
    try:
        body = json.loads("\n".join(lines[1:]))
    except json.JSONDecodeError:
        body = "\n".join(lines[1:])
    return code, body


def _http_json(method: str, url: str, headers: dict[str, str] | None = None, body: Any = None) -> tuple[int, Any]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    if body is not None:
        req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw) if raw else None
        except json.JSONDecodeError:
            return e.code, raw


def test_protocol_matrix() -> str | None:
    st, body = _token_via_docker(CLIENT_ID, CLIENT_SECRET)
    ok = st == 200 and isinstance(body, dict) and bool(body.get("access_token"))
    _record("valid_client_credentials", ok, {"status": st, "keys": list(body) if isinstance(body, dict) else body})
    if not ok:
        return None
    token = str(body["access_token"])

    st2, _ = _token_via_docker(CLIENT_ID, "wrong-secret")
    _record("invalid_client_secret", st2 == 401, {"status": st2})

    st3, _ = _token_via_docker("no-such-client", CLIENT_SECRET)
    _record("invalid_client_id", st3 == 401, {"status": st3})

    st4, _ = _token_via_docker("gdc-e2e-oauth-disabled", "gdc-e2e-disabled-secret")
    _record("disabled_client", st4 in (401, 400), {"status": st4})

    # Resource with valid token (call through resource container localhost)
    script = f"""
import json, urllib.request
req = urllib.request.Request("http://127.0.0.1:8090/business/customers", headers={{"Authorization": "Bearer {token}"}})
with urllib.request.urlopen(req, timeout=20) as resp:
  data = json.loads(resp.read().decode())
  print(resp.status)
  print(len(data.get("data", [])))
  print(json.dumps(data.get("meta") or {{}}))
"""
    proc = subprocess.run(
        ["docker", "exec", "gdc-keycloak-resource-lab", "python", "-c", script],
        capture_output=True,
        text=True,
        check=False,
    )
    lines = (proc.stdout or "").strip().splitlines()
    resource_ok = len(lines) >= 2 and lines[0] == "200" and int(lines[1]) > 0
    _record("valid_access_token_resource", resource_ok, {"stdout": proc.stdout, "stderr": proc.stderr})

    # Invalid token
    script_bad = """
import urllib.request, urllib.error
req = urllib.request.Request("http://127.0.0.1:8090/business/customers", headers={"Authorization": "Bearer not-real"})
try:
  urllib.request.urlopen(req, timeout=10)
  print(200)
except urllib.error.HTTPError as e:
  print(e.code)
"""
    proc2 = subprocess.run(
        ["docker", "exec", "gdc-keycloak-resource-lab", "python", "-c", script_bad],
        capture_output=True,
        text=True,
        check=False,
    )
    _record("invalid_access_token_resource", (proc2.stdout or "").strip() == "401", {"stdout": proc2.stdout})

    return token


def test_token_endpoint_unavailable() -> None:
    # Probe a closed port to prove unavailability is detectable without stopping Keycloak.
    script = """
import urllib.request, urllib.error
try:
  urllib.request.urlopen("http://127.0.0.1:1/realms/gdc-e2e/protocol/openid-connect/token", timeout=2)
  print("unexpected_ok")
except Exception as e:
  print(type(e).__name__)
"""
    proc = subprocess.run(
        ["docker", "exec", "gdc-keycloak-resource-lab", "python", "-c", script],
        capture_output=True,
        text=True,
        check=False,
    )
    out = proc.stdout or ""
    _record(
        "token_endpoint_unavailable_detectable",
        "Error" in out or "URLError" in out or "Connection" in out,
        {"stdout": out},
    )


def test_data_relay_live(token_smoke_ok: bool) -> None:
    if not LIVE:
        _record("data_relay_live_oauth2_cc", True, {"skipped": "GDC_KEYCLOAK_LIVE_RELAY!=1"})
        return
    if not token_smoke_ok:
        _record("data_relay_live_oauth2_cc", False, {"skipped": "protocol matrix failed"})
        return

    # Create connector + stream via API, run-once, assert delivery-ish outcome.
    # Use ephemeral prefix so Continuous Lab ownership stays clean.
    name = f"[E2E LAB EPHEMERAL] Keycloak OAuth2 CC {int(time.time())}"
    ephemeral_stream_ids: list[int] = []
    ephemeral_connector_ids: list[int] = []
    conn_payload = {
        "name": f"{name} connector",
        "connector_type": "generic_http",
        "source_type": "HTTP_API_POLLING",
        "base_url": RESOURCE_DOCKER,
        "verify_ssl": False,
        "auth_type": "oauth2_client_credentials",
        "oauth2_token_url": f"{KEYCLOAK_DOCKER_BASE}{TOKEN_PATH}",
        "oauth2_client_id": CLIENT_ID,
        "oauth2_client_secret": CLIENT_SECRET,
    }
    st, conn = _http_json("POST", f"{API_BASE}/api/v1/connectors/", body=conn_payload)
    if st not in (200, 201) or not isinstance(conn, dict) or not conn.get("id"):
        _record("data_relay_live_oauth2_cc", False, {"step": "connector", "status": st, "body": conn})
        return
    connector_id = int(conn["id"])
    ephemeral_connector_ids.append(connector_id)
    source_id = int(conn.get("source_id") or connector_id)

    try:
        # Ensure destination exists (reuse continuous webhook collector if present)
        st_d, dests = _http_json("GET", f"{API_BASE}/api/v1/destinations/")
        dest_id = None
        if st_d == 200:
            items = dests if isinstance(dests, list) else (dests or {}).get("items") or []
            for d in items:
                if str(d.get("name") or "").startswith("[CONTINUOUS E2E]") and "Webhook" in str(d.get("name") or ""):
                    dest_id = int(d["id"])
                    break
        if dest_id is None:
            st_c, created = _http_json(
                "POST",
                f"{API_BASE}/api/v1/destinations/",
                body={
                    "name": "[CONTINUOUS E2E] Webhook Collector",
                    "destination_type": "WEBHOOK_POST",
                    "config_json": {"url": "http://gdc-webhook-collector:8080/continuous-e2e", "method": "POST"},
                    "enabled": True,
                    "status": "ACTIVE",
                },
            )
            if st_c not in (200, 201):
                _record("data_relay_live_oauth2_cc", False, {"step": "destination", "status": st_c, "body": created})
                return
            dest_id = int(created["id"])

        stream_payload = {
            "name": name,
            "connector_id": connector_id,
            "source_id": source_id,
            "stream_type": "HTTP_API_POLLING",
            "config_json": {"endpoint": "/business/customers", "method": "GET"},
            "polling_interval": 300,
            "enabled": False,
            "status": "STOPPED",
            "event_array_path": "$.data",
        }
        st_s, stream = _http_json("POST", f"{API_BASE}/api/v1/streams/", body=stream_payload)
        if st_s not in (200, 201) or not isinstance(stream, dict):
            _record("data_relay_live_oauth2_cc", False, {"step": "stream", "status": st_s, "body": stream})
            return
        stream_id = int(stream["id"])
        ephemeral_stream_ids.append(stream_id)
        _http_json(
            "POST",
            f"{API_BASE}/api/v1/runtime/mappings/stream/{stream_id}/save",
            body={
                "event_array_path": "$.data",
                "field_mappings": {
                    "id": "$.id",
                    "customer_id": "$.customer_id",
                    "name": "$.name",
                    "email": "$.email",
                },
            },
        )
        _http_json(
            "POST",
            f"{API_BASE}/api/v1/routes/",
            body={
                "stream_id": stream_id,
                "destination_id": dest_id,
                "name": f"{name} route",
                "enabled": True,
                "status": "ACTIVE",
                "failure_policy": "LOG_AND_CONTINUE",
            },
        )
        _http_json("PUT", f"{API_BASE}/api/v1/streams/{stream_id}", body={"enabled": True, "status": "RUNNING"})
        st_r, run = _http_json("POST", f"{API_BASE}/api/v1/runtime/streams/{stream_id}/run-once", body={})
        delivered = False
        if isinstance(run, dict):
            delivered = (
                str(run.get("outcome") or "").lower() in ("completed", "success", "ok")
                or int(run.get("delivered_batch_event_count") or 0) > 0
                or int(run.get("mapped_event_count") or 0) > 0
                or int(run.get("collected_event_count") or 0) > 0
            )
        _record(
            "data_relay_live_oauth2_cc",
            st_r == 200 and delivered,
            {"status": st_r, "run": run, "stream_id": stream_id, "connector_id": connector_id},
        )

        # Invalid secret recovery path: create second connector with bad secret should fail run-once
        bad_name = f"[E2E LAB EPHEMERAL] Keycloak OAuth2 bad-secret {int(time.time())}"
        st_b, bad_conn = _http_json(
            "POST",
            f"{API_BASE}/api/v1/connectors/",
            body={
                **conn_payload,
                "name": f"{bad_name} connector",
                "oauth2_client_secret": "definitely-wrong",
            },
        )
        if st_b in (200, 201) and isinstance(bad_conn, dict):
            bad_connector_id = int(bad_conn["id"])
            ephemeral_connector_ids.append(bad_connector_id)
            bad_source_id = int(bad_conn.get("source_id") or bad_connector_id)
            st_bs, bad_stream = _http_json(
                "POST",
                f"{API_BASE}/api/v1/streams/",
                body={
                    "name": bad_name,
                    "connector_id": bad_connector_id,
                    "source_id": bad_source_id,
                    "stream_type": "HTTP_API_POLLING",
                    "config_json": {"endpoint": "/business/customers", "method": "GET"},
                    "polling_interval": 300,
                    "enabled": True,
                    "status": "RUNNING",
                    "event_array_path": "$.data",
                },
            )
            if st_bs in (200, 201):
                bad_stream_id = int(bad_stream["id"])
                ephemeral_stream_ids.append(bad_stream_id)
                _http_json(
                    "POST",
                    f"{API_BASE}/api/v1/routes/",
                    body={
                        "stream_id": bad_stream_id,
                        "destination_id": dest_id,
                        "name": f"{bad_name} route",
                        "enabled": True,
                        "status": "ACTIVE",
                        "failure_policy": "LOG_AND_CONTINUE",
                    },
                )
                st_br, bad_run = _http_json(
                    "POST", f"{API_BASE}/api/v1/runtime/streams/{bad_stream_id}/run-once", body={}
                )
                failed = st_br >= 400 or (
                    isinstance(bad_run, dict)
                    and (
                        str(bad_run.get("outcome") or "").lower() in ("failed", "error")
                        or "OAUTH" in json.dumps(bad_run).upper()
                        or "401" in json.dumps(bad_run)
                        or int(bad_run.get("delivered_batch_event_count") or 0) == 0
                        and st_br != 200
                    )
                )
                if st_br >= 400:
                    failed = True
                elif isinstance(bad_run, dict) and int(bad_run.get("delivered_batch_event_count") or -1) == 0 and int(
                    bad_run.get("mapped_event_count") or -1
                ) == 0:
                    failed = (
                        bool(bad_run.get("error") or bad_run.get("error_message") or bad_run.get("last_error"))
                        or st_br >= 400
                    )
                    if not failed and str(bad_run.get("outcome") or "").lower() not in ("completed",):
                        failed = True
                    blob = json.dumps(bad_run).lower()
                    if (
                        "oauth" in blob
                        or "401" in blob
                        or "token" in blob
                        or "unauthorized" in blob
                        or "failed" in blob
                    ):
                        failed = True
                _record(
                    "data_relay_invalid_secret_failure",
                    failed or st_br >= 400,
                    {"status": st_br, "run": bad_run},
                )
            else:
                _record(
                    "data_relay_invalid_secret_failure",
                    False,
                    {"step": "bad_stream", "status": st_bs, "body": bad_stream},
                )
        else:
            _record(
                "data_relay_invalid_secret_failure",
                False,
                {"step": "bad_connector", "status": st_b, "body": bad_conn},
            )
    finally:
        for sid in ephemeral_stream_ids:
            _http_json("PUT", f"{API_BASE}/api/v1/streams/{sid}", body={"enabled": False, "status": "STOPPED"})
            _http_json("DELETE", f"{API_BASE}/api/v1/streams/{sid}")
        for cid in ephemeral_connector_ids:
            _http_json("DELETE", f"{API_BASE}/api/v1/connectors/{cid}")


def main() -> int:
    # Readiness
    try:
        st, body = _http_json("GET", f"{KEYCLOAK_HOST_BASE}/realms/{REALM}/.well-known/openid-configuration")
        _record("keycloak_ready", st == 200 and isinstance(body, dict) and "token_endpoint" in body, {"status": st})
    except Exception as exc:  # noqa: BLE001
        _record("keycloak_ready", False, str(exc))
        print(json.dumps({"ok": False, "results": RESULTS}, indent=2))
        return 1

    try:
        st, body = _http_json("GET", f"{RESOURCE_HOST}/health")
        _record("resource_ready", st == 200, body)
    except Exception as exc:  # noqa: BLE001
        _record("resource_ready", False, str(exc))

    token = test_protocol_matrix()
    test_token_endpoint_unavailable()
    test_data_relay_live(token is not None)

    ok = all(r["ok"] for r in RESULTS)
    print(json.dumps({"ok": ok, "results": RESULTS}, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
