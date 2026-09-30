"""Route-scoped classification operator API (M13.4 P2)."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.classification.models import StreamClassificationRule
from app.route_classification.models import RouteClassificationRule
from app.route_classification.operator_workflow import _load_route
from app.route_classification.resolver import resolve_route_classification_config
from app.route_classification.schemas import RouteClassificationEffectiveResponse
from app.runtime.route_processing_status import (
    compute_route_processing_status,
    has_classification_governance_override_for_route,
    load_governance_route_overrides,
)


def build_route_classification_effective(
    *,
    route_id: int,
    stream_id: int,
    route_rule_rows: list[Any],
    stream_rule_rows: list[Any],
    route_overrides: list[dict[str, Any]] | None,
) -> RouteClassificationEffectiveResponse:
    """Assemble classification effective response from preloaded rows (no DB I/O)."""

    config = resolve_route_classification_config(
        route_id=route_id,
        stream_id=stream_id,
        route_classification_rules=route_rule_rows,
        stream_classification_rules=stream_rule_rows,
        route_overrides=route_overrides,
    )

    persisted = config.resolution.persisted_source
    api_persisted: str = "stream" if persisted in ("stream", "empty") else "route"
    fallback_used = bool(config.resolution.fallback_used)

    processing_status = compute_route_processing_status(
        persisted_source=persisted,
        route_rule_rows=route_rule_rows,
        has_governance_override=has_classification_governance_override_for_route(
            route_overrides,
            route_id=route_id,
        ),
    )

    effective_rows = [*route_rule_rows, *stream_rule_rows]
    latest_rule_updated_at = max((getattr(row, 'updated_at', None) for row in effective_rows if getattr(row, 'updated_at', None) is not None), default=None)

    return RouteClassificationEffectiveResponse(
        route_id=route_id,
        stream_id=stream_id,
        persisted_source=api_persisted,  # type: ignore[arg-type]
        fallback_used=fallback_used,
        rule_count=len(config.rules),
        processing_status=processing_status,  # type: ignore[arg-type]
        latest_rule_updated_at=latest_rule_updated_at,
        message="Route classification effective config resolved successfully",
    )


def get_route_classification_effective(db: Session, route_id: int) -> RouteClassificationEffectiveResponse:
    route = _load_route(db, route_id)
    stream_id = int(route.stream_id)

    route_rule_rows = list(
        db.execute(select(RouteClassificationRule).where(RouteClassificationRule.route_id == route_id)).scalars()
    )
    stream_rule_rows = list(
        db.execute(
            select(StreamClassificationRule).where(StreamClassificationRule.stream_id == stream_id)
        ).scalars()
    )

    route_overrides = load_governance_route_overrides(db, stream_id)
    return build_route_classification_effective(
        route_id=route_id,
        stream_id=stream_id,
        route_rule_rows=route_rule_rows,
        stream_rule_rows=stream_rule_rows,
        route_overrides=route_overrides,
    )
