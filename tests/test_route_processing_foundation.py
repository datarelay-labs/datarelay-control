"""M13.1 Route Processing Foundation tests."""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session

from app.config import settings
from app.logs.models import DeliveryLog
from app.runners.route_context import RouteEffectiveConfig, RouteRuntimeContext, RouteTransformConfig, SharedBatchContext, dual_read
from app.runners.route_context_builder import build_route_runtime_contexts, build_shared_batch_context
from app.runners.route_stage import process_route, process_routes
from app.runners.stream_loader import load_stream_context
from tests.test_stream_runner_e2e import (
    _FakePoller,
    _FakeWebhookSender,
    _build_runner,
    _seed_stream_runtime,
)


def _default_effective_config() -> RouteEffectiveConfig:
    return RouteEffectiveConfig(
        transform=RouteTransformConfig(
            field_mappings={},
            enrichment={},
            override_policy="KEEP_EXISTING",
            mapping_source="stream",
            enrichment_source="stream",
        )
    )


def test_dual_read_route_first() -> None:
    assert dual_read({"a": 1}, {"b": 2}) == {"a": 1}
    assert dual_read(None, {"b": 2}) == {"b": 2}
    assert dual_read({}, {"b": 2}) == {"b": 2}
    assert dual_read("", "stream") == "stream"


def test_build_shared_batch_context() -> None:
    runtime_stream = {
        "id": 1,
        "event_root_path": "$.event",
        "stream_config": {
            "union_schema": [{"path": "id", "type": "string"}],
            "observed_schema": {"fields": ["id"]},
        },
    }
    events = [{"id": "1", "message": "hello"}]
    ctx = build_shared_batch_context(
        stream_id=1,
        batch_id="batch-1",
        runtime_stream=runtime_stream,
        extracted_events=events,
        schema_observation={"observed_schema": {"fields": ["id"]}},
        sensitive_detection_result=None,
        checkpoint_cursor_before=None,
        shared_runtime_data={"extracted_event_count": 1},
    )
    assert ctx.stream_id == 1
    assert ctx.batch_id == "batch-1"
    assert ctx.event_root == "$.event"
    assert len(ctx.union_schema) == 1
    assert ctx.observed_schema == {"fields": ["id"]}
    assert ctx.shared_runtime_data["extracted_event_count"] == 1
    assert ctx.extracted_events == events


def test_build_shared_batch_context_dict_union_schema() -> None:
    runtime_stream = {
        "id": 1,
        "event_root_path": "$.event",
        "stream_config": {
            "union_schema": {
                "total_events": 2,
                "fields": [
                    {"field_path": "$.id", "field_type": "string", "occurrence_count": 2, "sample_values": ["1"]},
                ],
            },
        },
    }
    ctx = build_shared_batch_context(
        stream_id=1,
        batch_id="batch-dict",
        runtime_stream=runtime_stream,
        extracted_events=[{"id": "1"}],
        sensitive_detection_result=None,
        checkpoint_cursor_before=None,
    )
    assert len(ctx.union_schema) == 1
    assert ctx.union_schema[0]["field_path"] == "$.id"


def test_build_route_runtime_contexts_dual_read_metadata() -> None:
    runtime_stream = {
        "id": 10,
        "stream_config": {"metadata": {"team": "platform", "env": "prod"}},
        "field_mappings": {"message": "$.message"},
        "enrichment": {},
        "override_policy": "KEEP_EXISTING",
        "routes": [
            {
                "id": 100,
                "enabled": True,
                "failure_policy": "LOG_AND_CONTINUE",
                "formatter_config_json": {"prefix": "r1"},
                "rate_limit_json": {},
                "metadata": {"team": "security"},
                "destination": {
                    "id": 200,
                    "name": "webhook-primary",
                    "destination_type": "WEBHOOK_POST",
                },
            },
            {
                "id": 101,
                "enabled": True,
                "failure_policy": "PAUSE_STREAM_ON_FAILURE",
                "formatter_config_json": {},
                "rate_limit_json": {},
                "destination": {
                    "id": 201,
                    "name": "syslog-backup",
                    "destination_type": "SYSLOG_UDP",
                },
            },
        ],
    }
    contexts, metrics = build_route_runtime_contexts(runtime_stream)
    assert metrics.route_count == 2
    assert metrics.route_context_build_time_ms >= 0

    assert contexts[0].route_id == 100
    assert contexts[0].stream_id == 10
    assert contexts[0].destination_id == 200
    assert contexts[0].route_name == "webhook-primary"
    assert contexts[0].route_type == "WEBHOOK_POST"
    assert contexts[0].formatter == {"prefix": "r1"}
    assert contexts[0].delivery_policy == "LOG_AND_CONTINUE"
    assert contexts[0].metadata["team"] == "security"
    assert contexts[0].metadata["_route_protection_rules"] == []
    assert contexts[0].metadata["_route_classification_rules"] == []

    assert contexts[1].route_id == 101
    assert contexts[1].metadata["team"] == "platform"
    assert contexts[1].metadata["env"] == "prod"


def test_process_route_transforms_from_extracted_events() -> None:
    events = [{"id": "x", "message": "m"}]
    shared = SharedBatchContext(
        stream_id=1,
        batch_id="b",
        event_root=None,
        union_schema=[],
        extracted_events=events,
        schema_observation={},
        sensitive_detection_result=None,
        checkpoint_cursor_before=None,
        shared_runtime_data={},
    )
    route_ctx = RouteRuntimeContext(
        route_id=1,
        stream_id=1,
        destination_id=2,
        route_name="r1",
        route_type="WEBHOOK_POST",
        formatter={},
        delivery_policy="LOG_AND_CONTINUE",
        rate_limit={},
        metadata={},
        effective_config=RouteEffectiveConfig(
            transform=RouteTransformConfig(
                field_mappings={"message": "$.message"},
                enrichment={},
                override_policy="KEEP_EXISTING",
                mapping_source="stream",
                enrichment_source="stream",
            )
        ),
    )
    result = process_route(route_ctx, shared)
    assert result.modified is True
    assert result.events[0]["message"] == "m"


def test_process_routes_skips_disabled() -> None:
    events = [{"id": "1"}]
    shared = SharedBatchContext(
        stream_id=1,
        batch_id="b",
        event_root=None,
        union_schema=[],
        extracted_events=events,
        schema_observation={},
        sensitive_detection_result=None,
        checkpoint_cursor_before=None,
        shared_runtime_data={},
    )
    contexts = [
        RouteRuntimeContext(
            1,
            1,
            10,
            "a",
            "WEBHOOK_POST",
            {},
            "LOG_AND_CONTINUE",
            {},
            {},
            _default_effective_config(),
            enabled=False,
        ),
        RouteRuntimeContext(
            2,
            1,
            11,
            "b",
            "WEBHOOK_POST",
            {},
            "LOG_AND_CONTINUE",
            {},
            {},
            _default_effective_config(),
            enabled=True,
        ),
    ]
    pipeline = process_routes(contexts, shared)
    assert len(pipeline.stage_results) == 1
    assert pipeline.stage_results[0].route_id == 2

def test_feature_flag_on_executes_route_loop(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", True)
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    ctx = load_stream_context(db, stream_id)

    payload = {"items": [{"id": "e1", "message": "hello", "vendor": "acme"}]}
    webhook = _FakeWebhookSender()
    runner = _build_runner(poller=_FakePoller(response=payload), webhook_sender=webhook)

    summary = runner.run(ctx, db=db)

    assert summary["outcome"] == "completed"
    assert summary.get("route_count") == 1
    assert summary.get("route_context_build_time_ms") is not None
    assert summary.get("route_transform_count") == 1
    assert webhook.calls

    loop_logs = (
        db.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.stage == "route_processing_loop",
        )
        .all()
    )
    assert loop_logs
    assert loop_logs[0].message == "route processing pipeline complete"
