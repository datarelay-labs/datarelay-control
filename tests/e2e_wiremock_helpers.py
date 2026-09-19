"""Shared WireMock + HTTP client helpers for template and regression E2E tests."""

from __future__ import annotations

import base64
import json
import os
import socket
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.logs.models import DeliveryLog

WIREMOCK_ENV = "WIREMOCK_BASE_URL"
# Align with scripts/testing/_env.sh (GDC_TEST_WIREMOCK_HOST_PORT=28080).
# Host :18080 is the platform reverse-proxy (HTTP→HTTPS 301), not WireMock.
DEFAULT_WIREMOCK = os.getenv(WIREMOCK_ENV, "http://127.0.0.1:28080")


def wiremock_reachable(base: str | None = None) -> bool:
    url = base or DEFAULT_WIREMOCK
    try:
        p = urlparse(url)
        host = p.hostname or "127.0.0.1"
        port = p.port or (443 if p.scheme == "https" else 80)
        with socket.create_connection((host, port), timeout=0.5):
            return True
    except OSError:
        return False


def reset_wiremock_journal(base: str) -> None:
    r = httpx.delete(f"{base.rstrip('/')}/__admin/requests", timeout=5.0)
    r.raise_for_status()


def reset_wiremock_scenarios(base: str) -> None:
    r = httpx.post(f"{base.rstrip('/')}/__admin/scenarios/reset", timeout=5.0)
    r.raise_for_status()


def ensure_template_wiremock_mappings(base: str) -> None:
    """Register template E2E stubs via WireMock admin (runtime reload; see specs/014)."""

    root = Path(__file__).resolve().parent / "wiremock" / "mappings"
    for path in sorted(root.glob("template-*.json")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        mid = doc.get("id")
        if not mid:
            continue
        httpx.delete(f"{base.rstrip('/')}/__admin/mappings/{mid}", timeout=5.0)
        r = httpx.post(f"{base.rstrip('/')}/__admin/mappings", json=doc, timeout=15.0)
        if r.status_code not in (200, 201):
            raise AssertionError(f"WireMock mapping failed for {path.name}: {r.status_code} {r.text}")


def ensure_source_e2e_webhook_stub(base: str) -> None:
    """Register a permissive 200 OK stub for POST /source-e2e/* (used by source adapter E2E)."""

    mid = "c4a8d6b0-1111-4222-8333-444455556666"
    doc: dict[str, Any] = {
        "id": mid,
        "name": "source-e2e-webhook-receiver",
        "request": {"method": "POST", "urlPathPattern": "/source-e2e/.*"},
        "response": {"status": 200, "body": "OK", "headers": {"Content-Type": "text/plain"}},
    }
    httpx.delete(f"{base.rstrip('/')}/__admin/mappings/{mid}", timeout=5.0)
    r = httpx.post(f"{base.rstrip('/')}/__admin/mappings", json=doc, timeout=15.0)
    if r.status_code not in (200, 201):
        raise AssertionError(f"WireMock source-e2e stub failed: {r.status_code} {r.text}")


def ensure_functional_regression_webhook_stub(base: str) -> None:
    """Register a permissive 200 OK stub for POST /functional-regression/* receivers."""

    mid = "d5b9e7c1-2222-4333-9444-555566667777"
    doc: dict[str, Any] = {
        "id": mid,
        "name": "functional-regression-webhook-receiver",
        "request": {"method": "POST", "urlPathPattern": "/functional-regression/.*"},
        "response": {"status": 200, "body": "OK", "headers": {"Content-Type": "text/plain"}},
    }
    httpx.delete(f"{base.rstrip('/')}/__admin/mappings/{mid}", timeout=5.0)
    r = httpx.post(f"{base.rstrip('/')}/__admin/mappings", json=doc, timeout=15.0)
    if r.status_code not in (200, 201):
        raise AssertionError(f"WireMock functional-regression stub failed: {r.status_code} {r.text}")


def wiremock_received_json_bodies(base: str, *, path_contains: str) -> list[Any]:
    r = httpx.get(f"{base.rstrip('/')}/__admin/requests", timeout=10.0)
    r.raise_for_status()
    out: list[Any] = []
    for entry in r.json().get("requests", []):
        req = entry.get("request") or {}
        url = str(req.get("absoluteUrl") or req.get("url") or "")
        if path_contains not in url:
            continue
        body_b64 = req.get("bodyAsBase64")
        body_raw = req.get("body")
        if body_b64:
            raw = base64.b64decode(body_b64).decode("utf-8", errors="replace")
        elif isinstance(body_raw, str) and body_raw:
            raw = body_raw
        else:
            continue
        try:
            out.append(json.loads(raw))
        except json.JSONDecodeError:
            continue
    return out


def create_webhook_destination(client: TestClient, base: str, *, path: str, retry_count: int = 2) -> int:
    url = f"{base.rstrip('/')}{path}"
    dest = client.post(
        "/api/v1/destinations/",
        json={
            "name": f"wm-e2e-{uuid.uuid4().hex[:10]}",
            "destination_type": "WEBHOOK_POST",
            "config_json": {
                "url": url,
                "retry_count": retry_count,
                "retry_backoff_seconds": 0.01,
            },
            "rate_limit_json": {"max_events": 1000, "per_seconds": 1},
        },
    )
    assert dest.status_code == 201, dest.text
    return int(dest.json()["id"])


def enable_stream_for_run(client: TestClient, stream_id: int) -> None:
    """Start a stream via the canonical control API (enabled + RUNNING).

    Stream PUT no longer accepts ``status`` and requires ``expected_updated_at``.
    """
    r = client.post(f"/api/v1/streams/{stream_id}/start")
    assert r.status_code == 200, r.text


def delivery_log_stages(db: Session, stream_id: int) -> set[str]:
    rows = db.query(DeliveryLog).filter(DeliveryLog.stream_id == stream_id).all()
    return {str(r.stage) for r in rows}


def delivery_logs_by_stage(db: Session, stream_id: int, stage: str) -> list[DeliveryLog]:
    return (
        db.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == stream_id)
        .filter(DeliveryLog.stage == stage)
        .order_by(DeliveryLog.id.asc())
        .all()
    )


def assert_checkpoint_last_success_fields(db: Session, stream_id: int, **expect: Any) -> dict[str, Any]:
    db.expire_all()
    cp = db.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).first()
    assert cp is not None
    data = cp.checkpoint_value_json or {}
    assert isinstance(data, dict)
    assert "last_success_event" in data
    ev = data["last_success_event"]
    assert isinstance(ev, dict)
    for k, v in expect.items():
        assert ev.get(k) == v, (k, ev.get(k), v)
    return ev


def assert_run_observability_core(
    db: Session,
    stream_id: int,
    *,
    expect_checkpoint_update: bool,
) -> str:
    """Assert run_id correlation, run_started, run_complete, and checkpoint_update presence rules."""

    db.expire_all()
    started = delivery_logs_by_stage(db, stream_id, "run_started")
    assert started, "expected run_started delivery_log"
    run_id = started[-1].run_id
    assert run_id and len(str(run_id)) >= 8, "expected non-empty run_id on run_started"

    complete = delivery_logs_by_stage(db, stream_id, "run_complete")
    assert complete, "expected run_complete delivery_log"
    assert complete[-1].run_id == run_id

    ck_rows = delivery_logs_by_stage(db, stream_id, "checkpoint_update")
    if expect_checkpoint_update:
        assert ck_rows, "expected checkpoint_update when checkpoint should advance"
        assert ck_rows[-1].run_id == run_id
    else:
        assert not ck_rows, "did not expect checkpoint_update rows"

    return str(run_id)


def json_blob_excludes_secrets(blob: Any, secrets: tuple[str, ...]) -> None:
    raw = json.dumps(blob, default=str)
    for s in secrets:
        if s and s in raw:
            raise AssertionError(f"secret substring leaked in serialized payload: {s[:3]}***")


def assert_connector_api_masks_common_secrets(conn_body: dict[str, Any]) -> None:
    """ConnectorRead.auth must not expose raw secrets (masked as ********)."""

    auth = conn_body.get("auth") or {}
    for key in (
        "bearer_token",
        "basic_password",
        "api_key_value",
        "oauth2_client_secret",
        "api_key",
        "login_password",
    ):
        if key in auth and auth[key] not in ("", None, "********"):
            raise AssertionError(f"expected masked or empty {key} in connector API response")
