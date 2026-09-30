"""Route-scoped protection operator API (M13.3 P2)."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.protection.models import StreamProtectionRule
from app.route_protection.models import RouteProtectionRule
from app.route_protection.operator_workflow import _load_route
from app.route_protection.resolver import resolve_route_protection_config
from app.route_protection.schemas import RouteProtectionEffectiveResponse
from app.runtime.control_service import RouteNotFoundError
from app.runtime.route_processing_status import (
    compute_route_processing_status,
    has_protection_governance_override_for_route,
    load_governance_route_overrides,
)


def build_route_protection_effective(
    *,
    route_id: int,
    stream_id: int,
    route_rule_rows: list[Any],
    stream_rule_rows: list[Any],
    route_overrides: list[dict[str, Any]] | None,
) -> RouteProtectionEffectiveResponse:
    """Assemble protection effective response from preloaded rows (no DB I/O)."""

    config = resolve_route_protection_config(
        route_id=route_id,
        stream_id=stream_id,
        route_protection_rules=route_rule_rows,
        stream_protection_rules=stream_rule_rows,
        route_overrides=route_overrides,
    )

    persisted = config.resolution.persisted_source
    api_persisted: str = "stream" if persisted in ("stream", "empty") else "route"
    fallback_used = bool(config.resolution.fallback_used)

    processing_status = compute_route_processing_status(
        persisted_source=persisted,
        route_rule_rows=route_rule_rows,
        has_governance_override=has_protection_governance_override_for_route(
            route_overrides,
            route_id=route_id,
        ),
    )

    effective_rows = [*route_rule_rows, *stream_rule_rows]
    latest_rule_updated_at = max((getattr(row, 'updated_at', None) for row in effective_rows if getattr(row, 'updated_at', None) is not None), default=None)

    return RouteProtectionEffectiveResponse(
        route_id=route_id,
        stream_id=stream_id,
        persisted_source=api_persisted,  # type: ignore[arg-type]
        fallback_used=fallback_used,
        rule_count=len(config.rules),
        processing_status=processing_status,  # type: ignore[arg-type]
        latest_rule_updated_at=latest_rule_updated_at,
        message="Route protection effective config resolved successfully",
    )


def get_route_protection_effective(db: Session, route_id: int) -> RouteProtectionEffectiveResponse:
    route = _load_route(db, route_id)
    stream_id = int(route.stream_id)

    route_rule_rows = list(
        db.execute(select(RouteProtectionRule).where(RouteProtectionRule.route_id == route_id)).scalars()
    )
    stream_rule_rows = list(
        db.execute(
            select(StreamProtectionRule).where(StreamProtectionRule.stream_id == stream_id)
        ).scalars()
    )

    route_overrides = load_governance_route_overrides(db, stream_id)
    return build_route_protection_effective(
        route_id=route_id,
        stream_id=stream_id,
        route_rule_rows=route_rule_rows,
        stream_rule_rows=stream_rule_rows,
        route_overrides=route_overrides,
    )


__all__ = [
    "RouteNotFoundError",
    "build_route_protection_effective",
    "get_route_protection_effective",
]
