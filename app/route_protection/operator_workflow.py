"""Per-route protection operator workflow (M13.3 P2)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.protection.engine import protection_enabled
from app.protection.models import PROTECTION_MODES
from app.protection.operator_workflow import (
    ProtectionRuleConflictError,
    ProtectionRuleNotFoundError,
    ProtectionRuleValidationError,
    _validate_protection_rule_fields,
)
from app.route_protection.models import RouteProtectionRule
from app.routes.models import Route
from app.runtime.control_service import RouteNotFoundError


class RouteProtectionRuleNotFoundError(Exception):
    def __init__(self, rule_id: int) -> None:
        self.rule_id = rule_id
        super().__init__(f"route protection rule not found: {rule_id}")


def _load_route(db: Session, route_id: int) -> Route:
    route = db.query(Route).filter(Route.id == route_id).first()
    if route is None:
        raise RouteNotFoundError(route_id)
    return route


def _rule_entry(rule: RouteProtectionRule, *, stream_id: int) -> dict[str, Any]:
    return {
        "id": int(rule.id),
        "route_id": int(rule.route_id),
        "stream_id": stream_id,
        "field_path": rule.field_path,
        "sensitivity_class": rule.sensitivity_class,
        "protection_mode": rule.protection_mode,
        "enabled": bool(rule.enabled),
        "source_finding_id": rule.source_finding_id,
        "created_by": rule.created_by,
        "created_at": rule.created_at,
        "updated_at": rule.updated_at,
    }


def list_route_protection_rules(
    db: Session,
    route_id: int,
    *,
    enabled_only: bool = False,
) -> tuple[int, list[dict[str, Any]]]:
    route = _load_route(db, route_id)
    stream_id = int(route.stream_id)
    stmt = select(RouteProtectionRule).where(RouteProtectionRule.route_id == route_id)
    if enabled_only:
        stmt = stmt.where(RouteProtectionRule.enabled.is_(True))
    stmt = stmt.order_by(RouteProtectionRule.field_path)
    rules = list(db.execute(stmt).scalars())
    return stream_id, [_rule_entry(r, stream_id=stream_id) for r in rules]


def create_route_protection_rule(
    db: Session,
    *,
    route_id: int,
    field_path: str,
    sensitivity_class: str,
    protection_mode: str,
    enabled: bool,
    actor_username: str,
    source_finding_id: int | None = None,
) -> RouteProtectionRule:
    _load_route(db, route_id)
    path = _validate_protection_rule_fields(
        field_path=field_path,
        sensitivity_class=sensitivity_class,
        protection_mode=protection_mode,
    )
    now = datetime.now(timezone.utc)
    rule = RouteProtectionRule(
        route_id=route_id,
        field_path=path,
        sensitivity_class=sensitivity_class,
        protection_mode=protection_mode,
        enabled=enabled,
        source_finding_id=source_finding_id,
        created_by=actor_username,
        created_at=now,
        updated_at=now,
    )
    db.add(rule)
    try:
        db.flush()
    except IntegrityError as exc:
        raise ProtectionRuleConflictError(f"rule already exists for path {path!r}") from exc
    return rule


def patch_route_protection_rule(
    db: Session,
    *,
    route_id: int,
    rule_id: int,
    protection_mode: str | None = None,
    enabled: bool | None = None,
    sensitivity_class: str | None = None,
) -> RouteProtectionRule:
    rule = db.execute(
        select(RouteProtectionRule).where(
            RouteProtectionRule.id == rule_id,
            RouteProtectionRule.route_id == route_id,
        )
    ).scalar_one_or_none()
    if rule is None:
        raise RouteProtectionRuleNotFoundError(rule_id)
    if protection_mode is not None:
        if protection_mode not in PROTECTION_MODES:
            raise ProtectionRuleValidationError(f"invalid protection_mode: {protection_mode!r}")
        rule.protection_mode = protection_mode
    if enabled is not None:
        rule.enabled = enabled
    if sensitivity_class is not None:
        rule.sensitivity_class = sensitivity_class
    rule.updated_at = datetime.now(timezone.utc)
    return rule


def replace_route_protection_rules(
    db: Session,
    *,
    route_id: int,
    rules: list[dict[str, Any]],
    actor_username: str,
) -> tuple[int, list[dict[str, Any]]]:
    """Replace the route protection set in the caller's transaction.

    Validates every requested rule before deleting live rows. The caller commits
    only after this returns; any exception leaves the prior rows uncommitted.
    """

    route = db.query(Route).filter(Route.id == route_id).with_for_update().first()
    if route is None:
        raise RouteNotFoundError(route_id)

    validated: list[dict[str, Any]] = []
    seen_paths: set[str] = set()
    for raw in rules:
        path = _validate_protection_rule_fields(
            field_path=str(raw.get("field_path") or ""),
            sensitivity_class=str(raw.get("sensitivity_class") or ""),
            protection_mode=str(raw.get("protection_mode") or ""),
        )
        if path in seen_paths:
            raise ProtectionRuleConflictError(f"duplicate rule for path {path!r}")
        seen_paths.add(path)
        validated.append(
            {
                "field_path": path,
                "sensitivity_class": str(raw["sensitivity_class"]),
                "protection_mode": str(raw["protection_mode"]),
                "enabled": bool(raw.get("enabled", True)),
                "source_finding_id": raw.get("source_finding_id"),
            }
        )

    existing = list(
        db.execute(
            select(RouteProtectionRule)
            .where(RouteProtectionRule.route_id == route_id)
            .with_for_update()
        ).scalars()
    )
    for row in existing:
        db.delete(row)
    db.flush()

    now = datetime.now(timezone.utc)
    for item in validated:
        db.add(
            RouteProtectionRule(
                route_id=route_id,
                field_path=item["field_path"],
                sensitivity_class=item["sensitivity_class"],
                protection_mode=item["protection_mode"],
                enabled=item["enabled"],
                source_finding_id=item["source_finding_id"],
                created_by=actor_username,
                created_at=now,
                updated_at=now,
            )
        )
    db.flush()

    stream_id, entries = list_route_protection_rules(db, route_id)
    if len(entries) != len(validated):
        raise ProtectionRuleValidationError("protection replace read-back count mismatch")
    by_path = {str(entry["field_path"]): entry for entry in entries}
    for item in validated:
        actual = by_path.get(item["field_path"])
        if actual is None:
            raise ProtectionRuleValidationError("protection replace read-back missing rule")
        if (
            actual["protection_mode"] != item["protection_mode"]
            or actual["sensitivity_class"] != item["sensitivity_class"]
            or bool(actual["enabled"]) != item["enabled"]
        ):
            raise ProtectionRuleValidationError("protection replace read-back mismatch")
    return stream_id, entries


def delete_route_protection_rule(db: Session, *, route_id: int, rule_id: int) -> None:
    rule = db.execute(
        select(RouteProtectionRule).where(
            RouteProtectionRule.id == rule_id,
            RouteProtectionRule.route_id == route_id,
        )
    ).scalar_one_or_none()
    if rule is None:
        raise RouteProtectionRuleNotFoundError(rule_id)
    db.delete(rule)
