"""Route classification stage — reuses existing Classification Engine (M13.4)."""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

from app.classification.engine import classification_enabled, classify_batch
from app.classification.field_keys import stamp_classification_level
from app.classification.levels import max_level
from app.route_classification.config import RouteClassificationConfig, RouteClassificationResult
from app.route_classification.resolver import resolve_route_classification_config
from app.runners.route_context import RouteRuntimeContext, SharedBatchContext
from app.sensitive_detection.context import findings_from_context


LogFn = Callable[[dict[str, Any]], None]


def _findings_from_shared_batch(shared_batch: SharedBatchContext) -> list[dict[str, Any]]:
    ctx = shared_batch.sensitive_detection_result
    if ctx is None:
        return []
    return findings_from_context(ctx)


def _restamp_events(events: list[dict[str, Any]], level: str) -> None:
    for event in events:
        if isinstance(event, dict):
            stamp_classification_level(event, level)


def route_classification_stage(
    route_ctx: RouteRuntimeContext,
    shared_batch: SharedBatchContext,
    *,
    log_fn: LogFn | None = None,
    stream_classification_rules: list[Any] | None = None,
    route_classification_rules: list[Any] | None = None,
    route_overrides: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], RouteClassificationResult | None, RouteClassificationConfig]:
    """Classify post-protection route events using shared findings and dual-read rules."""

    input_events = list(route_ctx.processing_state.current_events)
    config = route_ctx.effective_config.classification
    if config is None:
        config = resolve_route_classification_config(
            route_id=route_ctx.route_id,
            stream_id=route_ctx.stream_id,
            route_classification_rules=route_classification_rules,
            stream_classification_rules=stream_classification_rules,
            route_overrides=route_overrides,
        )
        route_ctx.effective_config.classification = config

    if not classification_enabled():
        return input_events, None, config

    findings = _findings_from_shared_batch(shared_batch)
    engine_rules = config.rules_as_engine_types()

    started = time.monotonic()
    batch_result = classify_batch(
        input_events,
        stream_id=route_ctx.stream_id,
        rules=engine_rules,
        findings=findings,
    )
    effective_level = batch_result.classification_level
    override_applied = False
    if config.override_levels:
        effective_level = max_level([effective_level, *config.override_levels])
        override_applied = effective_level != batch_result.classification_level
        if override_applied:
            _restamp_events(input_events, effective_level)

    duration_ms = max(0, int((time.monotonic() - started) * 1000))

    classification_result = RouteClassificationResult(
        effective_level=effective_level,
        matched_rule_count=batch_result.matched_rule_count,
        persisted_source=config.resolution.persisted_source,
        override_applied=override_applied,
        duration_ms=duration_ms,
    )
    route_ctx.processing_state.classification_result = classification_result

    if log_fn is not None and input_events:
        log_fn(
            {
                "stage": "classification_complete",
                "stream_id": route_ctx.stream_id,
                "route_id": route_ctx.route_id,
                "classification_level": effective_level,
                "matched_rule_count": batch_result.matched_rule_count,
                "persisted_source": config.resolution.persisted_source,
                "override_count": config.resolution.override_count,
                "override_applied": override_applied,
                "duration_ms": duration_ms,
                "processing_time_ms": duration_ms,
                "events_classified": batch_result.events_classified,
            }
        )

    return input_events, classification_result, config
