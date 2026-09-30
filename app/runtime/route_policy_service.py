"""Route-scoped policy operator API (M13.5 P2)."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.protection.models import StreamPolicyRule
from app.route_policy.models import RoutePolicyRule
from app.route_policy.operator_workflow import _load_route
from app.route_policy.resolver import resolve_route_policy_config
from app.route_policy.schemas import RoutePolicyEffectiveResponse
from app.runtime.route_processing_status import (
    compute_route_processing_status,
    has_policy_governance_override_for_route,
    load_governance_route_overrides,
)


def build_route_policy_effective(
    *,
    route_id: int,
    stream_id: int,
    route_rule_rows: list[Any],
    stream_rule_rows: list[Any],
    route_overrides: list[dict[str, Any]] | None,
) -> RoutePolicyEffectiveResponse:
    """Assemble policy effective response from preloaded rows (no DB I/O)."""

    config = resolve_route_policy_config(
        route_id=route_id,
        stream_id=stream_id,
        route_policy_rules=route_rule_rows,
        stream_policy_rules=stream_rule_rows,
        route_overrides=route_overrides,
    )

    persisted = config.resolution.persisted_source
    api_persisted: str = "stream" if persisted in ("stream", "empty") else "route"
    fallback_used = bool(config.resolution.fallback_used)

    processing_status = compute_route_processing_status(
        persisted_source=persisted,
        route_rule_rows=route_rule_rows,
        has_governance_override=has_policy_governance_override_for_route(
            route_overrides,
            route_id=route_id,
        ),
    )

    effective_rows = [*route_rule_rows, *stream_rule_rows]
    latest_rule_updated_at = max((getattr(row, 'updated_at', None) for row in effective_rows if getattr(row, 'updated_at', None) is not None), default=None)

    return RoutePolicyEffectiveResponse(
        route_id=route_id,
        stream_id=stream_id,
        persisted_source=api_persisted,  # type: ignore[arg-type]
        fallback_used=fallback_used,
        rule_count=len(config.rules),
        processing_status=processing_status,  # type: ignore[arg-type]
        latest_rule_updated_at=latest_rule_updated_at,
    )


def get_route_policy_effective(db: Session, route_id: int) -> RoutePolicyEffectiveResponse:
    route = _load_route(db, route_id)
    stream_id = int(route.stream_id)

    route_rule_rows = list(
        db.execute(select(RoutePolicyRule).where(RoutePolicyRule.route_id == route_id)).scalars()
    )
    stream_rule_rows = list(
        db.execute(select(StreamPolicyRule).where(StreamPolicyRule.stream_id == stream_id)).scalars()
    )

    route_overrides = load_governance_route_overrides(db, stream_id)
    return build_route_policy_effective(
        route_id=route_id,
        stream_id=stream_id,
        route_rule_rows=route_rule_rows,
        stream_rule_rows=stream_rule_rows,
        route_overrides=route_overrides,
    )
