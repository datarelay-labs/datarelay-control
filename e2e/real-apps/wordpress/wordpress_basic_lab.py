#!/usr/bin/env python3
"""TEST-ONLY WordPress REST API-compatible Basic Auth harness.

Implements WP REST shapes used by Data Relay Basic Auth validation:
  GET /wp-json/wp/v2/posts|pages|users|comments|categories
  Authorization: Basic ...

Full WordPress+MySQL Docker is deferred when host memory is constrained.
This is real-application-shaped Basic Auth validation (not WireMock protocol stubs).
"""

from __future__ import annotations

import base64
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

HOST = "0.0.0.0"
PORT = int(__import__("os").environ.get("WP_LAB_PORT", "8088"))
USER = __import__("os").environ.get("WP_USER", "wp-e2e-user")
PASSWORD = __import__("os").environ.get("WP_PASSWORD", "wp-e2e-pass")

DATA: dict[str, list[dict[str, Any]]] = {
    "posts": [
        {"id": 1, "slug": "hello-continuous", "title": {"rendered": "Hello Continuous"}, "status": "publish", "date": "2026-09-11T00:00:00"},
        {"id": 2, "slug": "ops-note", "title": {"rendered": "Ops Note"}, "status": "publish", "date": "2026-09-11T00:01:00"},
    ],
    "pages": [
        {"id": 10, "slug": "about", "title": {"rendered": "About"}, "status": "publish", "date": "2026-09-11T00:00:00"},
    ],
    "users": [
        {"id": 1, "slug": "admin", "name": "Admin", "roles": ["administrator"]},
        {"id": 2, "slug": "editor", "name": "Editor", "roles": ["editor"]},
    ],
    "comments": [
        {"id": 100, "post": 1, "author_name": "reader", "content": {"rendered": "Nice post"}, "date": "2026-09-11T00:02:00"},
    ],
    "categories": [
        {"id": 1, "slug": "news", "name": "News", "count": 1},
        {"id": 2, "slug": "ops", "name": "Ops", "count": 1},
    ],
}


def _check_basic(header: str | None) -> bool:
    if not header or not header.lower().startswith("basic "):
        return False
    try:
        raw = base64.b64decode(header.split(" ", 1)[1].strip()).decode("utf-8")
        user, _, pw = raw.partition(":")
        return user == USER and pw == PASSWORD
    except Exception:
        return False


class Handler(BaseHTTPRequestHandler):
    server_version = "WordpressBasicLab/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        pass

    def _send(self, code: int, body: Any) -> None:
        raw = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path in ("/health", "/"):
            self._send(200, {"ok": True, "service": "wordpress-basic-lab"})
            return
        if not path.startswith("/wp-json/wp/v2/"):
            self._send(404, {"code": "rest_no_route", "message": "No route"})
            return
        if not _check_basic(self.headers.get("Authorization")):
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="WordPress REST API"')
            self.send_header("Content-Type", "application/json")
            raw = json.dumps({"code": "rest_forbidden", "message": "Sorry, you are not allowed."}).encode()
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        resource = path[len("/wp-json/wp/v2/") :]
        if resource not in DATA:
            self._send(404, {"code": "rest_no_route", "message": f"Unknown {resource}"})
            return
        self._send(200, DATA[resource])


def main() -> None:
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"wordpress-basic-lab listening on {HOST}:{PORT} user={USER}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
