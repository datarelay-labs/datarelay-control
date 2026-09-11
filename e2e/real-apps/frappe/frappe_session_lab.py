#!/usr/bin/env python3
"""TEST-ONLY Frappe/ERPNext API-compatible session_login harness.

Implements the Frappe login + resource contract used by Data Relay session_login:
  POST /api/method/login  (form usr/pwd or JSON) → Set-Cookie: sid=...
  GET  /api/resource/<Doctype> with sid cookie → business records

Not a full ERPNext Docker stack. Prefer this when host memory cannot host
full frappe_docker. Still exercises real Data Relay session_login (no bypass).
"""

from __future__ import annotations

import json
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

HOST = "0.0.0.0"
PORT = int(__import__("os").environ.get("FRAPPE_LAB_PORT", "8087"))
USER = __import__("os").environ.get("FRAPPE_USER", "Administrator")
PASSWORD = __import__("os").environ.get("FRAPPE_PASSWORD", "frappe-e2e-pass")
SESSION_TTL_SEC = int(__import__("os").environ.get("FRAPPE_SESSION_TTL_SEC", "3600"))

LOCK = threading.Lock()
SESSIONS: dict[str, float] = {}  # sid -> expires_at

# Small deterministic ERP/CRM fixture
DATA: dict[str, list[dict[str, Any]]] = {
    "Customer": [
        {"name": "CUST-001", "customer_name": "Acme Corp", "modified": "2026-09-11T00:00:00", "territory": "US"},
        {"name": "CUST-002", "customer_name": "Beta LLC", "modified": "2026-09-11T00:01:00", "territory": "EU"},
    ],
    "Item": [
        {"name": "ITEM-001", "item_code": "WIDGET-A", "item_name": "Widget A", "modified": "2026-09-11T00:00:00", "stock_uom": "Nos"},
        {"name": "ITEM-002", "item_code": "WIDGET-B", "item_name": "Widget B", "modified": "2026-09-11T00:01:00", "stock_uom": "Nos"},
    ],
    "Sales Order": [
        {"name": "SO-001", "customer": "CUST-001", "grand_total": 100.0, "modified": "2026-09-11T00:02:00", "status": "To Deliver"},
    ],
    "Sales Invoice": [
        {"name": "SINV-001", "customer": "CUST-001", "grand_total": 100.0, "modified": "2026-09-11T00:03:00", "status": "Unpaid"},
    ],
    "Project": [
        {"name": "PROJ-001", "project_name": "Continuous E2E", "modified": "2026-09-11T00:04:00", "status": "Open"},
    ],
    "Task": [
        {"name": "TASK-001", "subject": "Seed validation", "project": "PROJ-001", "modified": "2026-09-11T00:05:00", "status": "Open"},
    ],
}


def _now() -> float:
    return time.time()


def _purge_expired() -> None:
    now = _now()
    dead = [s for s, exp in SESSIONS.items() if exp < now]
    for s in dead:
        del SESSIONS[s]


def _valid_sid(sid: str | None) -> bool:
    if not sid:
        return False
    _purge_expired()
    exp = SESSIONS.get(sid)
    return exp is not None and exp >= _now()


def _parse_cookie(header: str | None) -> dict[str, str]:
    out: dict[str, str] = {}
    if not header:
        return out
    for part in header.split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def _read_body(handler: BaseHTTPRequestHandler) -> bytes:
    length = int(handler.headers.get("Content-Length") or 0)
    return handler.rfile.read(length) if length else b""


class Handler(BaseHTTPRequestHandler):
    server_version = "FrappeSessionLab/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:  # quieter
        pass

    def _send(self, code: int, body: Any, extra_headers: dict[str, str] | None = None) -> None:
        raw = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        if path in ("/health", "/"):
            self._send(200, {"ok": True, "service": "frappe-session-lab", "sessions": len(SESSIONS)})
            return
        if path.startswith("/api/resource/"):
            doctype = path[len("/api/resource/") :]
            doctype = doctype.replace("%20", " ")
            cookies = _parse_cookie(self.headers.get("Cookie"))
            sid = cookies.get("sid")
            if not _valid_sid(sid):
                self._send(401, {"exc_type": "AuthenticationError", "message": "Not permitted", "exc": "sid invalid"})
                return
            with LOCK:
                rows = list(DATA.get(doctype, []))
            qs = parse_qs(parsed.query)
            # empty result probe: ?empty=1
            if qs.get("empty", ["0"])[0] == "1":
                rows = []
            # checkpoint-ish filter: modified after ISO timestamp
            after = (qs.get("modified_after") or [None])[0]
            if after:
                rows = [r for r in rows if str(r.get("modified", "")) > after]
            self._send(200, {"data": rows})
            return
        self._send(404, {"error": "not_found", "path": path})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        body = _read_body(self)
        ctype = (self.headers.get("Content-Type") or "").lower()

        if path == "/api/method/login":
            usr = pwd = ""
            if "application/json" in ctype:
                try:
                    payload = json.loads(body.decode("utf-8") or "{}")
                except json.JSONDecodeError:
                    payload = {}
                usr = str(payload.get("usr") or payload.get("username") or "")
                pwd = str(payload.get("pwd") or payload.get("password") or "")
            else:
                form = parse_qs(body.decode("utf-8"))
                usr = (form.get("usr") or form.get("username") or [""])[0]
                pwd = (form.get("pwd") or form.get("password") or [""])[0]

            if usr == USER and pwd == PASSWORD:
                sid = secrets.token_hex(16)
                with LOCK:
                    SESSIONS[sid] = _now() + SESSION_TTL_SEC
                self._send(
                    200,
                    {"message": "Logged In", "full_name": "Administrator", "home_page": "/app"},
                    extra_headers={"Set-Cookie": f"sid={sid}; Path=/; HttpOnly"},
                )
                return
            self._send(401, {"message": "Invalid login credentials", "exc_type": "AuthenticationError"})
            return

        if path == "/api/method/logout":
            cookies = _parse_cookie(self.headers.get("Cookie"))
            sid = cookies.get("sid")
            with LOCK:
                SESSIONS.pop(sid or "", None)
            self._send(200, {"message": "Logged Out"})
            return

        # Test helper: append a new Customer after checkpoint
        if path == "/__lab/seed/customer":
            with LOCK:
                n = len(DATA["Customer"]) + 1
                row = {
                    "name": f"CUST-{n:03d}",
                    "customer_name": f"New Customer {n}",
                    "modified": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
                    "territory": "US",
                }
                DATA["Customer"].append(row)
            self._send(200, {"ok": True, "data": row})
            return

        # Test helper: expire all sessions
        if path == "/__lab/expire-sessions":
            with LOCK:
                SESSIONS.clear()
            self._send(200, {"ok": True})
            return

        self._send(404, {"error": "not_found", "path": path})


def main() -> None:
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"frappe-session-lab listening on {HOST}:{PORT} user={USER}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
