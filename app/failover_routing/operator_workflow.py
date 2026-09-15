"""M10 failover routing — operator workflow (CRUD + summary)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.destinations.models import Destination
from app.failover_routing.models import FAILOVER_POLICY_ACTIVE_STANDBY, StreamFailoverRoute


class FailoverRouteNotFoundError(Exception):
    def __init__(self, route_id: int) -> None:
        self.route_id = route_id
        super().__init__(f"failover route not found: {route_id}")


class FailoverRouteValidationError(Exception):
    pass


def _rule_entry(
    rule: StreamFailoverRoute,
    *,
    primary_name: str | None = None,
    secondary_name: str | None = None,
) -> dict[str, Any]:
    return {
        "id": rule.id,
        "stream_id": rule.stream_id,
        "primary_destination_id": int(rule.primary_destination_id),
        "primary_destination_name": primary_name,
        "secondary_destination_id": int(rule.secondary_destination_id),
        "secondary_destination_name": secondary_name,
        "enabled": bool(rule.enabled),
        "policy": FAILOVER_POLICY_ACTIVE_STANDBY,
        "created_at": rule.created_at,
        "updated_at": rule.updated_at,
    }


def _validate_destination(db: Session, destination_id: int) -> Destination:
    dest = db.get(Destination, int(destination_id))
    if dest is None:
        raise FailoverRouteValidationError(f"destination not found: {destination_id}")
    return dest


def list_failover_routes(
    db: Session,
    stream_id: int,
    *,
    enabled_only: bool = False,
) -> list[dict[str, Any]]:
    stmt = select(StreamFailoverRoute).where(StreamFailoverRoute.stream_id == stream_id)
    if enabled_only:
        stmt = stmt.where(StreamFailoverRoute.enabled.is_(True))
    stmt = stmt.order_by(StreamFailoverRoute.id.asc())
    rules = list(db.execute(stmt).scalars())
    out: list[dict[str, Any]] = []
    for rule in rules:
        primary = db.get(Destination, int(rule.primary_destination_id))
        secondary = db.get(Destination, int(rule.secondary_destination_id))
        out.append(
            _rule_entry(
                rule,
                primary_name=str(primary.name) if primary is not None else None,
                secondary_name=str(secondary.name) if secondary is not None else None,
            )
        )
    return out


def build_failover_routing_summary(db: Session, stream_id: int) -> dict[str, Any]:
    from app.failover_routing.failover_metrics import load_failover_routing_runtime_metrics

    rows = list(
        db.execute(select(StreamFailoverRoute).where(StreamFailoverRoute.stream_id == stream_id)).scalars()
    )
    runtime_metrics = load_failover_routing_runtime_metrics(db, stream_id, total_failover_routes=len(rows))
    return {
        "stream_id": stream_id,
        "total_failover_routes": len(rows),
        "failover_attempts": int(runtime_metrics["failover_attempts"]),
        "failover_successes": int(runtime_metrics["failover_successes"]),
        "failover_failures": int(runtime_metrics["failover_failures"]),
        "last_evaluated_at": runtime_metrics.get("last_evaluated_at"),
    }


def _assert_primary_on_stream_topology(db: Session, *, stream_id: int, primary_destination_id: int) -> None:
    """Primary must be a destination already attached to the stream via a Route."""

    from app.routes.models import Route

    # Same-transaction route inserts must be visible (tests use autoflush=False).
    db.flush()
    linked = (
        db.query(Route.id)
        .filter(
            Route.stream_id == int(stream_id),
            Route.destination_id == int(primary_destination_id),
        )
        .first()
    )
    if linked is None:
        raise FailoverRouteValidationError(
            f"primary destination {primary_destination_id} is not on stream {stream_id} route topology"
        )


def create_failover_route(
    db: Session,
    *,
    stream_id: int,
    primary_destination_id: int,
    secondary_destination_id: int,
    enabled: bool,
) -> StreamFailoverRoute:
    primary_id = int(primary_destination_id)
    secondary_id = int(secondary_destination_id)
    if primary_id == secondary_id:
        raise FailoverRouteValidationError("primary and secondary destinations must differ")
    _validate_destination(db, primary_id)
    _validate_destination(db, secondary_id)
    _assert_primary_on_stream_topology(db, stream_id=stream_id, primary_destination_id=primary_id)

    existing = db.execute(
        select(StreamFailoverRoute).where(
            StreamFailoverRoute.stream_id == stream_id,
            StreamFailoverRoute.primary_destination_id == primary_id,
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise FailoverRouteValidationError(
            f"failover route already exists for primary destination {primary_id}"
        )

    now = datetime.now(timezone.utc)
    rule = StreamFailoverRoute(
        stream_id=stream_id,
        primary_destination_id=primary_id,
        secondary_destination_id=secondary_id,
        enabled=enabled,
        created_at=now,
        updated_at=now,
    )
    db.add(rule)
    db.flush()
    return rule


def patch_failover_route(
    db: Session,
    *,
    stream_id: int,
    route_id: int,
    primary_destination_id: int | None = None,
    secondary_destination_id: int | None = None,
    enabled: bool | None = None,
) -> StreamFailoverRoute:
    rule = db.get(StreamFailoverRoute, int(route_id))
    if rule is None or int(rule.stream_id) != int(stream_id):
        raise FailoverRouteNotFoundError(route_id)

    new_primary = int(rule.primary_destination_id) if primary_destination_id is None else int(primary_destination_id)
    new_secondary = (
        int(rule.secondary_destination_id) if secondary_destination_id is None else int(secondary_destination_id)
    )
    if new_primary == new_secondary:
        raise FailoverRouteValidationError("primary and secondary destinations must differ")
    if primary_destination_id is not None:
        _validate_destination(db, new_primary)
        _assert_primary_on_stream_topology(db, stream_id=stream_id, primary_destination_id=new_primary)
        conflict = db.execute(
            select(StreamFailoverRoute).where(
                StreamFailoverRoute.stream_id == stream_id,
                StreamFailoverRoute.primary_destination_id == new_primary,
                StreamFailoverRoute.id != int(route_id),
            )
        ).scalar_one_or_none()
        if conflict is not None:
            raise FailoverRouteValidationError(
                f"failover route already exists for primary destination {new_primary}"
            )
        rule.primary_destination_id = new_primary
    if secondary_destination_id is not None:
        _validate_destination(db, new_secondary)
        rule.secondary_destination_id = new_secondary
    if enabled is not None:
        rule.enabled = bool(enabled)
    rule.updated_at = datetime.now(timezone.utc)
    db.flush()
    return rule
