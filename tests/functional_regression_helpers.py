"""Shared helpers for functional regression E2E (Record Selection contract → runtime delivery)."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

import httpx
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.logs.models import DeliveryLog
from tests.e2e_wiremock_helpers import (
    create_webhook_destination,
    delivery_log_stages,
    delivery_logs_by_stage,
    enable_stream_for_run,
    ensure_functional_regression_webhook_stub,
    reset_wiremock_journal,
    wiremock_received_json_bodies,
    wiremock_reachable as _wiremock_reachable,
)

FUNCTIONAL_REGRESSION_WIREMOCK_STUB_PREFIX = "template-functional-regression-"
FUNCTIONAL_REGRESSION_WIREMOCK = os.getenv("WIREMOCK_BASE_URL", "http://127.0.0.1:28080").rstrip("/")


def wiremock_reachable() -> bool:
    return _wiremock_reachable(FUNCTIONAL_REGRESSION_WIREMOCK)


def ensure_functional_regression_wiremock_mappings(base: str) -> None:
    """Ensure functional-regression WireMock stubs exist (probe first; admin API fallback)."""

    admin = base.rstrip("/")
    # Receiver path is dynamic per test; always ensure the permissive webhook stub.
    ensure_functional_regression_webhook_stub(admin)
    try:
        probe = httpx.get(f"{admin}/api/v1/functional-regression/records-envelope", timeout=5.0)
        if probe.status_code == 200:
            return
    except httpx.HTTPError:
        pass

    root = Path(__file__).resolve().parent / "wiremock" / "mappings"
    patterns = (
        f"{FUNCTIONAL_REGRESSION_WIREMOCK_STUB_PREFIX}*.json",
        "template-receiver-fail.json",
    )
    for pattern in patterns:
        for path in sorted(root.glob(pattern)):
            doc = json.loads(path.read_text(encoding="utf-8"))
            mid = doc.get("id")
            if not mid:
                continue
            registered = False
            for attempt in range(3):
                try:
                    existing = httpx.get(f"{admin}/__admin/mappings/{mid}", timeout=5.0)
                    if existing.status_code == 200:
                        registered = True
                        break
                    r = httpx.post(f"{admin}/__admin/mappings", json=doc, timeout=15.0)
                    if r.status_code in (200, 201):
                        registered = True
                        break
                except httpx.HTTPError:
                    if attempt < 2:
                        time.sleep(0.15)
            if not registered:
                raise AssertionError(f"WireMock mapping unavailable for {path.name}; restart wiremock-test container")


def create_bearer_http_polling_stack(
    client: TestClient,
    base: str,
    *,
    name_suffix: str,
    endpoint: str,
    bearer_token: str = "functional-regression-bearer",
) -> dict[str, Any]:
    """Create connector, source, and disabled stream for HTTP API polling against WireMock."""

    cr = client.post(
        "/api/v1/connectors/",
        json={
            "name": f"fr-http-{name_suffix}",
            "auth_type": "bearer",
            "base_url": base.rstrip("/"),
            "bearer_token": bearer_token,
        },
    )
    assert cr.status_code == 201, cr.text
    connector_id = int(cr.json()["id"])
    source_id = int(cr.json()["source_id"])

    sr = client.post(
        "/api/v1/streams/",
        json={
            "name": f"fr-stream-{name_suffix}",
            "connector_id": connector_id,
            "source_id": source_id,
            "stream_type": "HTTP_API_POLLING",
            "config_json": {
                "endpoint": endpoint,
                "method": "GET",
                "params": {},
                "pagination": {"type": "none"},
            },
            "polling_interval": 60,
            "enabled": False,
            "status": "STOPPED",
            "rate_limit_json": {"max_requests": 100, "per_seconds": 60},
        },
    )
    assert sr.status_code == 201, sr.text
    stream_id = int(sr.json()["id"])
    return {
        "connector_id": connector_id,
        "source_id": source_id,
        "stream_id": stream_id,
    }


def save_record_selection_mapping(
    client: TestClient,
    stream_id: int,
    *,
    event_array_path: str | None,
    event_root_path: str | None = None,
    field_mappings: dict[str, str],
) -> None:
    """Persist mapping paths relative to extracted events (Record Selection contract)."""

    mr = client.post(
        f"/api/v1/runtime/mappings/stream/{stream_id}/save",
        json={
            "event_array_path": event_array_path,
            "event_root_path": event_root_path,
            "field_mappings": field_mappings,
        },
    )
    assert mr.status_code == 200, mr.text


def save_stream_enrichment(
    client: TestClient,
    stream_id: int,
    *,
    enrichment: dict[str, Any],
    override_policy: str = "fill_missing",
) -> None:
    er = client.post(
        f"/api/v1/runtime/enrichments/stream/{stream_id}/save",
        json={
            "enrichment": enrichment,
            "override_policy": override_policy,
            "enabled": True,
        },
    )
    assert er.status_code == 200, er.text


def attach_webhook_route(
    client: TestClient,
    stream_id: int,
    destination_id: int,
    *,
    failure_policy: str = "LOG_AND_CONTINUE",
) -> int:
    rr = client.post(
        "/api/v1/routes/",
        json={
            "stream_id": stream_id,
            "destination_id": destination_id,
            "enabled": True,
            "failure_policy": failure_policy,
            "formatter_config_json": {"message_format": "json"},
            "rate_limit_json": {"max_events": 500, "per_seconds": 1},
            "status": "ENABLED",
        },
    )
    assert rr.status_code == 201, rr.text
    return int(rr.json()["id"])


def ensure_checkpoint_row(db: Session, stream_id: int) -> None:
    row = db.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).first()
    if row is None:
        db.add(
            Checkpoint(
                stream_id=stream_id,
                checkpoint_type="CUSTOM_FIELD",
                checkpoint_value_json={},
            )
        )
        db.commit()


def prepare_functional_regression_run(
    client: TestClient,
    db: Session,
    stream_id: int,
    *,
    wiremock_base: str,
    receiver_path: str,
    failure_policy: str = "LOG_AND_CONTINUE",
) -> dict[str, Any]:
    """Enable stream, ensure checkpoint row, and attach a webhook capture route."""

    ensure_checkpoint_row(db, stream_id)
    dest_id = create_webhook_destination(client, wiremock_base, path=receiver_path, retry_count=0)
    route_id = attach_webhook_route(client, stream_id, dest_id, failure_policy=failure_policy)
    enable_stream_for_run(client, stream_id)
    return {"destination_id": dest_id, "route_id": route_id}


def run_stream_once(client: TestClient, stream_id: int) -> dict[str, Any]:
    run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert run.status_code == 200, run.text
    return run.json()


def assert_delivery_stages(
    db: Session,
    stream_id: int,
    *,
    expect_success: bool,
    expect_failure: bool = False,
    expect_checkpoint_log: bool | None = None,
) -> None:
    db.expire_all()
    stages = delivery_log_stages(db, stream_id)
    if expect_success:
        assert "route_send_success" in stages
        assert "run_complete" in stages
    if expect_failure:
        assert "route_send_failed" in stages
    if expect_checkpoint_log is True:
        assert "checkpoint_update" in stages
    elif expect_checkpoint_log is False:
        assert "checkpoint_update" not in stages


def captured_webhook_payloads(base: str, path_contains: str) -> list[Any]:
    return wiremock_received_json_bodies(base, path_contains=path_contains)


def checkpoint_value(db: Session, stream_id: int) -> dict[str, Any]:
    db.expire_all()
    row = db.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).first()
    assert row is not None
    data = row.checkpoint_value_json
    return dict(data) if isinstance(data, dict) else {}


def delivery_logs_for_stream(db: Session, stream_id: int) -> list[DeliveryLog]:
    db.expire_all()
    return (
        db.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == stream_id)
        .order_by(DeliveryLog.id.asc())
        .all()
    )


def route_specific_success_logs(db: Session, stream_id: int, route_id: int) -> list[DeliveryLog]:
    return [
        row
        for row in delivery_logs_by_stage(db, stream_id, "route_send_success")
        if int(row.route_id or 0) == int(route_id)
    ]


__all__ = [
    "FUNCTIONAL_REGRESSION_WIREMOCK",
    "FUNCTIONAL_REGRESSION_WIREMOCK_STUB_PREFIX",
    "assert_delivery_stages",
    "captured_webhook_payloads",
    "checkpoint_value",
    "create_bearer_http_polling_stack",
    "delivery_logs_for_stream",
    "ensure_functional_regression_wiremock_mappings",
    "prepare_functional_regression_run",
    "route_specific_success_logs",
    "run_stream_once",
    "save_record_selection_mapping",
    "save_stream_enrichment",
    "wiremock_reachable",
]
