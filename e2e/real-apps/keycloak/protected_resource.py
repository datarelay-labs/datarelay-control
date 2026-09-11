#!/usr/bin/env python3
"""TEST-ONLY protected HTTP resource for Keycloak oauth2_client_credentials E2E.

Validates Authorization: Bearer <access_token> via Keycloak token introspection,
then returns deterministic shared business JSON records.

Full path under test:
  Data Relay → Keycloak token endpoint (client_credentials + HTTP Basic)
  → access_token → this resource (Bearer) → JSON records
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

PORT = int(os.environ.get("RESOURCE_PORT", "8090"))
ISSUER = os.environ.get("KEYCLOAK_ISSUER", "http://gdc-keycloak-e2e:8089/realms/gdc-e2e").rstrip("/")
INTROSPECT_URL = os.environ.get(
    "KEYCLOAK_INTROSPECT_URL",
    f"{ISSUER}/protocol/openid-connect/token/introspect",
)
# Confidential client used only for introspection (same as Data Relay client is fine).
INTROSPECT_CLIENT_ID = os.environ.get("INTROSPECT_CLIENT_ID", "gdc-e2e-oauth-client")
INTROSPECT_CLIENT_SECRET = os.environ.get("INTROSPECT_CLIENT_SECRET", "gdc-e2e-oauth-secret")
DATASET_PATH = os.environ.get("BUSINESS_DATASET_PATH", "/app/business-data/dataset.json")

_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_LOCK = threading.Lock()
CACHE_TTL_SEC = 15.0


def _load_dataset() -> dict[str, Any]:
    try:
        with open(DATASET_PATH, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {
            "customers": [
                {
                    "id": "customer-001",
                    "customer_id": "customer-001",
                    "name": "Acme Corp",
                    "email": "ops@acme.example",
                    "updated_at": "2026-09-11T00:00:00Z",
                }
            ],
            "orders": [],
        }


def _basic_auth_header(client_id: str, client_secret: str) -> str:
    import base64

    raw = f"{client_id}:{client_secret}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def _introspect(token: str) -> dict[str, Any]:
    now = time.time()
    with _LOCK:
        hit = _CACHE.get(token)
        if hit and hit[0] > now:
            return hit[1]

    body = urllib.parse.urlencode({"token": token}).encode("utf-8")
    req = urllib.request.Request(
        INTROSPECT_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": _basic_auth_header(INTROSPECT_CLIENT_ID, INTROSPECT_CLIENT_SECRET),
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise ValueError(f"introspection HTTP {exc.code}: {detail}") from exc
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"introspection failed: {exc}") from exc

    with _LOCK:
        _CACHE[token] = (now + CACHE_TTL_SEC, result)
    return result


class Handler(BaseHTTPRequestHandler):
    server_version = "GdcKeycloakResourceLab/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[keycloak-resource] {self.address_string()} - {fmt % args}")

    def _send(self, code: int, body: dict[str, Any] | list[Any]) -> None:
        raw = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path in ("/health", "/ready"):
            self._send(200, {"status": "ok", "issuer": ISSUER, "introspect": INTROSPECT_URL})
            return

        auth = self.headers.get("Authorization") or ""
        if not auth.startswith("Bearer "):
            self._send(401, {"error": "missing_bearer", "message": "Authorization: Bearer required"})
            return
        token = auth[len("Bearer ") :].strip()
        if not token:
            self._send(401, {"error": "missing_bearer", "message": "empty bearer token"})
            return
        try:
            claims = _introspect(token)
        except Exception as exc:  # noqa: BLE001
            self._send(401, {"error": "introspection_failed", "message": str(exc)})
            return
        if not claims.get("active"):
            self._send(401, {"error": "invalid_token", "message": "token inactive or expired"})
            return

        dataset = _load_dataset()
        if path in ("/business/customers", "/api/v1/customers"):
            self._send(
                200,
                {
                    "data": dataset.get("customers", []),
                    "meta": {
                        "auth_sub": claims.get("sub"),
                        "auth_client_id": claims.get("client_id"),
                        "source": "keycloak-resource-lab",
                    },
                },
            )
            return
        if path in ("/business/orders", "/api/v1/orders"):
            self._send(
                200,
                {
                    "data": dataset.get("orders", [])[:20],
                    "meta": {"source": "keycloak-resource-lab"},
                },
            )
            return
        if path == "/business/checkpoint":
            customers = dataset.get("customers", [])
            self._send(
                200,
                {
                    "data": customers[:2],
                    "checkpoint": {
                        "cursor": "customer-002",
                        "updated_at": "2026-09-11T00:01:00Z",
                    },
                },
            )
            return
        self._send(404, {"error": "not_found", "path": path})


def main() -> None:
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[keycloak-resource] listening on :{PORT} introspect={INTROSPECT_URL}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
