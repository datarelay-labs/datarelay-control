"""Exact-run evidence already present on the run-once response and delivery trace."""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

from app.runtime.read_service import _assemble_runtime_trace
from app.runtime.schemas import RuntimeStreamRunOnceResponse


def test_run_once_response_keeps_missing_disposition_counts_unknown() -> None:
    body = RuntimeStreamRunOnceResponse(
        stream_id=42,
        outcome="completed",
        route_delivery_success_count=1,
        route_delivery_failure_count=0,
        route_delivery_attempt_count=None,
        route_delivery_blocked_count=0,
        route_delivery_review_count=None,
        route_delivery_quarantine_count=0,
    )
    dumped = body.model_dump()
    assert dumped["route_delivery_attempt_count"] is None
    assert dumped["route_delivery_review_count"] is None
    assert dumped["route_delivery_blocked_count"] == 0
    assert dumped["route_delivery_success_count"] == 1


def test_trace_timeline_exposes_payload_destination_and_dynamic_route_ids() -> None:
    row = SimpleNamespace(
        id=9,
        created_at=datetime(2026, 9, 26, tzinfo=timezone.utc),
        stage="dynamic_route_send_success",
        level="INFO",
        status="OK",
        message="sent",
        route_id=None,
        destination_id=9,
        payload_sample={
            "primary_destination_id": 11,
            "secondary_destination_id": "22",
            "dynamic_route_id": 4,
            "skip_reason": "destination_disabled",
        },
        latency_ms=3,
        retry_count=0,
        http_status=200,
        error_code=None,
        stream_id=None,
    )
    response = _assemble_runtime_trace(
        None,  # type: ignore[arg-type]
        timeline_rows=[row],  # type: ignore[list-item]
        anchor_log_id=9,
        resolved_run_id="run-1",
    )
    entry = response.timeline[0]
    assert entry.destination_id == 9
    assert entry.primary_destination_id == 11
    assert entry.secondary_destination_id == 22
    assert entry.dynamic_route_id == 4
    assert entry.skip_reason == "destination_disabled"
    assert entry.route_id is None
