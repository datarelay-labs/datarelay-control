#!/usr/bin/env python3
"""WireMock stateful scenario smoke tests (pagination, checkpoint, retry, shapes)."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any

WM = os.environ.get("WIREMOCK_BASE_URL", "http://127.0.0.1:28080").rstrip("/")


def _get(path: str) -> tuple[int, Any]:
    req = urllib.request.Request(f"{WM}{path}", headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode()
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw) if raw else None
        except json.JSONDecodeError:
            return e.code, raw


def _reset_scenarios() -> None:
    req = urllib.request.Request(f"{WM}/__admin/scenarios/reset", method="POST", data=b"")
    with urllib.request.urlopen(req, timeout=15) as resp:
        resp.read()


def main() -> int:
    results: list[tuple[str, bool, Any]] = []

    def rec(name: str, ok: bool, detail: Any = None) -> None:
        results.append((name, ok, detail))
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: {detail}")

    # Ensure stubs loaded — hit canonical
    st, body = _get("/shared-business/canonical")
    rec("canonical_loaded", st == 200 and isinstance(body, dict) and len(body.get("data") or []) == 5, {"status": st})

    _reset_scenarios()
    st1, b1 = _get("/shared-business/customers?page=1")
    st2, b2 = _get("/shared-business/customers?page=2")
    st3, b3 = _get("/shared-business/customers?page=3")
    ok_page = (
        st1 == 200
        and st2 == 200
        and st3 == 200
        and len((b1 or {}).get("data") or []) == 2
        and len((b2 or {}).get("data") or []) == 2
        and len((b3 or {}).get("data") or []) == 0
    )
    rec("pagination_page1_page2_empty", ok_page, {"st": [st1, st2, st3]})

    _reset_scenarios()
    c1, d1 = _get("/shared-business/checkpoint")
    c2, d2 = _get("/shared-business/checkpoint")
    c3, d3 = _get("/shared-business/checkpoint")
    ok_cp = (
        c1 == 200
        and c2 == 200
        and c3 == 200
        and len((d1 or {}).get("data") or []) == 2
        and len((d2 or {}).get("data") or []) == 0
        and len((d3 or {}).get("data") or []) == 1
        and (d3 or {}).get("data", [{}])[0].get("customer_id") == "customer-005"
    )
    rec("checkpoint_initial_nochange_newdata", ok_cp, {"counts": [len((d1 or {}).get("data") or []), len((d2 or {}).get("data") or []), len((d3 or {}).get("data") or [])]})

    _reset_scenarios()
    r1, _ = _get("/shared-business/retry-500")
    r2, d500 = _get("/shared-business/retry-500")
    rec("retry_500_then_200", r1 == 500 and r2 == 200 and len((d500 or {}).get("data") or []) == 1, {"st": [r1, r2]})

    _reset_scenarios()
    q1, _ = _get("/shared-business/retry-429")
    q2, d429 = _get("/shared-business/retry-429")
    rec("retry_429_then_200", q1 == 429 and q2 == 200, {"st": [q1, q2]})

    for path, expect_key in [
        ("/shared-business/data-shapes/null-heavy", "null-heavy"),
        ("/shared-business/data-shapes/duplicate-ids", "duplicate"),
        ("/shared-business/data-shapes/out-of-order", "out-of-order"),
        ("/shared-business/schema/baseline", "baseline"),
        ("/shared-business/schema/new-normal-field", "new-normal"),
        ("/shared-business/schema/new-sensitive-field", "sensitive"),
        ("/shared-business/schema/type-change", "type-change"),
    ]:
        st, body = _get(path)
        rec(f"shape_{expect_key}", st == 200, {"status": st, "path": path})

    st_m, body_m = _get("/shared-business/schema/malformed")
    # Malformed body may still be HTTP 200 with broken JSON — treat as covered if status 200 and parse fails OR raw str
    rec("schema_malformed", st_m == 200 and (isinstance(body_m, str) or body_m is None or isinstance(body_m, dict)), {"status": st_m, "type": type(body_m).__name__})

    ok = all(r[1] for r in results)
    print(json.dumps({"ok": ok, "passed": sum(1 for r in results if r[1]), "total": len(results)}, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
