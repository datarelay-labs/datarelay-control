"""Route policy stage — reuses existing Policy Engine with injected rules (M13.5)."""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

from sqlalchemy.orm import Session

from app.protection.policy_engine import PolicyBatchResult, evaluate_injected_policy_batch
from app.quarantine.policy_integration import should_quarantine_batch
from app.quarantine.recording import record_route_policy_quarantine_event
from app.route_policy.config import PolicyDecision, RoutePolicyConfig, RoutePolicyResult
from app.route_policy.decision import delivery_allowed_for_decision, merge_route_policy_decision
from app.route_policy.resolver import resolve_route_policy_config
from app.runners.route_context import RouteRuntimeContext, SharedBatchContext
from app.sensitive_detection.context import findings_from_context


LogFn = Callable[[dict[str, Any]], None]


def _findings_from_shared_batch(shared_batch: SharedBatchContext) -> list[dict[str, Any]]:
    ctx = shared_batch.sensitive_detection_result
    if ctx is None:
        return []
    return findings_from_context(ctx)


def _policy_log_stage(decision: PolicyDecision) -> str:
    if decision == "quarantine":
        return "policy_quarantine"
    if decision == "block":
        return "policy_blocked"
    if decision == "require_review":
        return "policy_review_required"
    if decision == "audit":
        return "policy_complete"
    return "policy_complete"


def route_policy_stage(
    route_ctx: RouteRuntimeContext,
    shared_batch: SharedBatchContext,
    *,
    db: Session | None = None,
    log_fn: LogFn | None = None,
    stream_policy_rules: list[Any] | None = None,
    route_policy_rules: list[Any] | None = None,
    route_overrides: list[dict[str, Any]] | None = None,
    governance_rules: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], RoutePolicyResult, RoutePolicyConfig]:
    """Evaluate policy on post-classification route events; gate delivery per route."""

    input_events = list(route_ctx.processing_state.current_events)
    config = resolve_route_policy_config(
        route_id=route_ctx.route_id,
        stream_id=route_ctx.stream_id,
        route_policy_rules=route_policy_rules,
        stream_policy_rules=stream_policy_rules,
        route_overrides=route_overrides,
        governance_rules=governance_rules,
        schema_drift_policy_result=shared_batch.schema_drift_policy_result,
    )
    route_ctx.effective_config.policy = config

    started = time.monotonic()
    findings = _findings_from_shared_batch(shared_batch)
    engine_rules = config.rules_as_engine_types()

    policy_batch_result = PolicyBatchResult(duration_ms=0)
    if input_events and (engine_rules or not config.empty):
        policy_batch_result = evaluate_injected_policy_batch(
            rules=engine_rules,
            events=input_events,
            findings=findings,
        )

    decision, decision_reason = merge_route_policy_decision(policy_batch_result, config)
    delivery_allowed = delivery_allowed_for_decision(decision)
    quarantine_recorded = False
    quarantine_event_id: int | None = None

    if decision == "quarantine" and db is not None and input_events:
        drift_only = (
            not should_quarantine_batch(policy_batch_result)
            and config.resolution.drift_quarantine_required
        )
        if drift_only:
            from app.schema_drift_policy.orchestrator import merge_schema_drift_quarantine

            drift = shared_batch.schema_drift_policy_result
            policy_type = str(getattr(drift, "quarantine_policy_type", None) or "unknown_normal")
            field_paths = [
                str(getattr(item, "enriched_path", "") or "")
                for item in list(getattr(drift, "unknown_fields", []) or [])
                if str(getattr(item, "applied_policy", "") or "") == "quarantine"
            ]
            if not field_paths and drift is not None:
                field_paths = [
                    str(getattr(item, "enriched_path", "") or "")
                    for item in list(getattr(drift, "unknown_fields", []) or [])
                    if getattr(item, "enriched_path", None)
                ]
            policy_batch_result = merge_schema_drift_quarantine(
                policy_batch_result,
                policy_type=policy_type,
                field_paths=[p for p in field_paths if p],
            )
        row = record_route_policy_quarantine_event(
            db,
            stream_id=route_ctx.stream_id,
            route_id=route_ctx.route_id,
            destination_id=route_ctx.destination_id,
            delivery_events=input_events,
            policy_result=policy_batch_result,
            decision_reason=decision_reason,
            classification_result=route_ctx.processing_state.classification_result,
            override_delivery_behavior=config.override_delivery_behavior,
            drift_quarantine=drift_only,
        )
        quarantine_recorded = row is not None
        if row is not None:
            quarantine_event_id = int(row.id)

    duration_ms = max(0, int((time.monotonic() - started) * 1000))
    output_events = input_events if delivery_allowed else []

    policy_result = RoutePolicyResult(
        decision=decision,
        matched_policy_count=policy_batch_result.matched_policy_count,
        persisted_source=config.resolution.persisted_source,
        delivery_blocked=not delivery_allowed,
        delivery_allowed=delivery_allowed,
        quarantine_recorded=quarantine_recorded,
        review_required=decision == "require_review",
        override_applied=config.override_delivery_behavior is not None,
        decision_reason=decision_reason,
        policy_action=decision,
        duration_ms=duration_ms,
        policy_batch_result=policy_batch_result,
        quarantine_event_id=quarantine_event_id,
    )
    route_ctx.processing_state.policy_result = policy_result

    if log_fn is not None:
        cls_result = route_ctx.processing_state.classification_result
        log_fn(
            {
                "stage": _policy_log_stage(decision),
                "stream_id": route_ctx.stream_id,
                "route_id": route_ctx.route_id,
                "decision": decision,
                "policy_action": decision,
                "decision_reason": decision_reason,
                "matched_policy_count": policy_batch_result.matched_policy_count,
                "persisted_source": config.resolution.persisted_source,
                "delivery_behavior_override": config.override_delivery_behavior,
                "drift_review_required": config.resolution.drift_review_required,
                "drift_quarantine_required": config.resolution.drift_quarantine_required,
                "delivery_allowed": delivery_allowed,
                "classification_level": getattr(cls_result, "effective_level", None) if cls_result else None,
                "duration_ms": duration_ms,
                "processing_time_ms": duration_ms,
            }
        )
        from app.protection.policy_metrics import build_policy_evaluation_complete_payload

        policy_batch_result.duration_ms = duration_ms
        if not getattr(policy_batch_result, "policy_count", None):
            policy_batch_result.policy_count = len(engine_rules)
        log_fn(
            build_policy_evaluation_complete_payload(
                stream_id=route_ctx.stream_id,
                result=policy_batch_result,
            )
        )

    return output_events, policy_result, config
