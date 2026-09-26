"""Stream governance document read/write and effective protection view."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.config_concurrency import require_fresh_updated_at
from app.destinations.models import Destination
from app.protection.models import (
    PROTECTION_MODE_DROP_FIELD,
    PROTECTION_MODE_FULL_MASK,
    PROTECTION_MODE_HASH,
    PROTECTION_MODE_PARTIAL_MASK,
    PROTECTION_MODE_TOKENIZATION,
    StreamProtectionRule,
)
from app.route_protection.resolver import map_protection_action_to_mode, resolve_route_protection_config
from app.routes.models import Route
from app.stream_governance.schemas import (
    EffectiveFieldStreamDefault,
    EffectivePerRouteField,
    EffectiveProtectionAction,
    EffectiveProtectionField,
    EffectiveProtectionResponse,
    EffectiveProtectionRouteRef,
    EffectiveProtectionSummary,
    EffectiveRouteOverrideRef,
    GovernanceRouteOverride,
    GovernanceRule,
    StreamGovernanceResponse,
    StreamGovernanceWrite,
)
from app.stream_governance.validation import (
    flatten_route_overrides,
    normalize_governance_rules,
    validate_route_ids_belong_to_stream,
)
from app.streams.models import Stream

_PROTECTION_MODE_TO_ACTION = {
    PROTECTION_MODE_PARTIAL_MASK: "mask_partial",
    PROTECTION_MODE_FULL_MASK: "mask_full",
    PROTECTION_MODE_TOKENIZATION: "tokenize",
    PROTECTION_MODE_HASH: "hash",
    PROTECTION_MODE_DROP_FIELD: "drop_field",
}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _load_governance_dict(stream: Stream) -> dict[str, Any]:
    config = stream.config_json if isinstance(stream.config_json, dict) else {}
    governance = config.get("governance")
    return dict(governance) if isinstance(governance, dict) else {}


def _governance_to_response(
    stream_id: int,
    governance: dict[str, Any],
    updated_at: datetime | None,
) -> StreamGovernanceResponse:
    rules_raw = governance.get("rules") if isinstance(governance.get("rules"), list) else []
    overrides_raw = governance.get("route_overrides") if isinstance(governance.get("route_overrides"), list) else []
    rules = [GovernanceRule.model_validate(item) for item in rules_raw if isinstance(item, dict)]
    overrides = [
        GovernanceRouteOverride.model_validate(item) for item in overrides_raw if isinstance(item, dict)
    ]
    return StreamGovernanceResponse(
        stream_id=stream_id,
        updated_at=updated_at,
        enabled=bool(governance.get("enabled", True)),
        rules=rules,
        route_overrides=overrides,
    )


def get_stream_governance(db: Session, stream_id: int) -> StreamGovernanceResponse | None:
    stream = db.query(Stream).filter(Stream.id == stream_id).first()
    if stream is None:
        return None
    return _governance_to_response(stream_id, _load_governance_dict(stream), stream.updated_at)


def put_stream_governance(
    db: Session,
    stream_id: int,
    payload: StreamGovernanceWrite,
) -> StreamGovernanceResponse | None:
    stream = db.query(Stream).filter(Stream.id == stream_id).with_for_update().first()
    if stream is None:
        return None
    require_fresh_updated_at(
        entity_label="Stream governance",
        error_code="GOVERNANCE_STALE_WRITE",
        current_updated_at=stream.updated_at,
        expected_updated_at=payload.expected_updated_at,
    )

    routes = db.query(Route).filter(Route.stream_id == stream_id).all()
    valid_route_ids = {int(route.id) for route in routes}

    rules_payload = [rule.model_dump() for rule in payload.rules]
    flat_payload = [item.model_dump() for item in payload.route_overrides]

    normalized_rules = normalize_governance_rules(rules_payload)
    flat_overrides = flatten_route_overrides(normalized_rules, flat_payload)
    validate_route_ids_belong_to_stream(flat_overrides, valid_route_ids=valid_route_ids)

    config = dict(stream.config_json or {})
    governance = dict(_load_governance_dict(stream))
    governance["enabled"] = payload.enabled
    governance["rules"] = normalized_rules
    governance["route_overrides"] = flat_overrides
    config["governance"] = governance
    stream.config_json = config
    stream.updated_at = _utc_now()
    db.add(stream)
    db.commit()
    db.refresh(stream)
    return _governance_to_response(stream_id, _load_governance_dict(stream), stream.updated_at)


def _protection_mode_to_action(mode: str | None) -> str | None:
    if mode is None:
        return None
    return _PROTECTION_MODE_TO_ACTION.get(str(mode))


def _stream_default_for_field(
    governance_rules: list[dict[str, Any]],
    protection_rules: list[StreamProtectionRule],
    field_path: str,
) -> EffectiveFieldStreamDefault | None:
    for rule in governance_rules:
        if not isinstance(rule, dict):
            continue
        if str(rule.get("field_path") or "") != field_path:
            continue
        if not bool(rule.get("enabled", True)):
            continue
        return EffectiveFieldStreamDefault(
            protection_action=str(rule.get("default_protection_action") or "audit"),
            delivery_behavior=str(rule.get("default_delivery_behavior") or "continue"),
            sensitivity_type=rule.get("sensitivity_type"),
        )

    for row in protection_rules:
        if row.field_path == field_path and row.enabled:
            return EffectiveFieldStreamDefault(
                protection_action=_protection_mode_to_action(row.protection_mode) or "audit",
                delivery_behavior="continue",
                sensitivity_type=row.sensitivity_class,
            )
    return None


def _find_override_ref(
    route_overrides: list[dict[str, Any]],
    *,
    route_id: int,
    field_path: str,
) -> EffectiveRouteOverrideRef | None:
    for item in route_overrides:
        if int(item.get("route_id", -1)) != int(route_id):
            continue
        if str(item.get("field_path") or "") != field_path:
            continue
        return EffectiveRouteOverrideRef(
            override_key=item.get("override_key"),
            protection_action=item.get("protection_action"),
            delivery_behavior=item.get("delivery_behavior"),
            enabled=bool(item.get("enabled", True)),
        )
    return None


def _effective_action_for_field_route(
    *,
    field_path: str,
    route_id: int,
    config: Any,
    stream_default: EffectiveFieldStreamDefault | None,
    override_ref: EffectiveRouteOverrideRef | None,
) -> EffectiveProtectionAction:
    delivery_behavior = None
    if override_ref and override_ref.enabled and override_ref.delivery_behavior:
        delivery_behavior = override_ref.delivery_behavior
    elif stream_default:
        delivery_behavior = stream_default.delivery_behavior

    if override_ref and override_ref.enabled:
        action = override_ref.protection_action
        if action == "audit":
            return EffectiveProtectionAction(
                protection_action="audit",
                protection_mode=None,
                delivery_behavior=delivery_behavior,
                source="route_override",
                mutates_field=False,
                enforcement="policy_mvp" if delivery_behavior and delivery_behavior != "continue" else None,
            )
        mode = map_protection_action_to_mode(action)
        return EffectiveProtectionAction(
            protection_action=action,
            protection_mode=mode,
            delivery_behavior=delivery_behavior,
            source="route_override",
            mutates_field=True,
            enforcement="policy_mvp" if delivery_behavior and delivery_behavior != "continue" else None,
        )

    if field_path in config.audit_only_paths:
        return EffectiveProtectionAction(
            protection_action="audit",
            protection_mode=None,
            delivery_behavior=delivery_behavior,
            source="stream_default",
            mutates_field=False,
        )

    rule = next((r for r in config.rules if r.field_path == field_path), None)
    if rule is not None:
        action = _protection_mode_to_action(rule.protection_mode) or "audit"
        source = "route_override" if rule.source == "route_override" else "stream_default"
        return EffectiveProtectionAction(
            protection_action=action,
            protection_mode=rule.protection_mode,
            delivery_behavior=delivery_behavior,
            source=source,
            mutates_field=action != "audit",
        )

    if stream_default is not None:
        action = stream_default.protection_action or "audit"
        mode = map_protection_action_to_mode(action)
        return EffectiveProtectionAction(
            protection_action=action,
            protection_mode=None if action == "audit" else mode,
            delivery_behavior=delivery_behavior,
            source="stream_default",
            mutates_field=action != "audit",
        )

    return EffectiveProtectionAction(
        protection_action=None,
        protection_mode=None,
        delivery_behavior=delivery_behavior,
        source="none",
        mutates_field=False,
    )


def _collect_field_paths(
    governance_rules: list[dict[str, Any]],
    route_overrides: list[dict[str, Any]],
    protection_rules: list[StreamProtectionRule],
) -> list[str]:
    paths: set[str] = set()
    for rule in governance_rules:
        if isinstance(rule, dict) and rule.get("field_path"):
            paths.add(str(rule["field_path"]))
    for item in route_overrides:
        if isinstance(item, dict) and item.get("field_path"):
            paths.add(str(item["field_path"]))
    for row in protection_rules:
        if row.enabled:
            paths.add(row.field_path)
    return sorted(paths)


def build_effective_protection(db: Session, stream_id: int) -> EffectiveProtectionResponse | None:
    stream = db.query(Stream).filter(Stream.id == stream_id).first()
    if stream is None:
        return None

    governance = _load_governance_dict(stream)
    governance_rules = [r for r in (governance.get("rules") or []) if isinstance(r, dict)]
    route_overrides = [o for o in (governance.get("route_overrides") or []) if isinstance(o, dict)]

    routes = db.query(Route).filter(Route.stream_id == stream_id).order_by(Route.id).all()
    protection_rules = (
        db.query(StreamProtectionRule)
        .filter(StreamProtectionRule.stream_id == stream_id, StreamProtectionRule.enabled == True)  # noqa: E712
        .all()
    )

    destination_ids = {int(r.destination_id) for r in routes}
    destinations: dict[int, Destination] = {}
    if destination_ids:
        for dest in db.query(Destination).filter(Destination.id.in_(destination_ids)).all():
            destinations[int(dest.id)] = dest

    configs_by_route = {
        int(route.id): resolve_route_protection_config(
            route_id=int(route.id),
            stream_id=stream_id,
            stream_protection_rules=protection_rules,
            route_overrides=route_overrides,
        )
        for route in routes
    }

    field_paths = _collect_field_paths(governance_rules, route_overrides, protection_rules)
    fields: list[EffectiveProtectionField] = []
    routes_with_divergence: set[int] = set()

    for field_path in field_paths:
        stream_default = _stream_default_for_field(governance_rules, protection_rules, field_path)
        per_route: list[EffectivePerRouteField] = []

        for route in routes:
            route_id = int(route.id)
            override_ref = _find_override_ref(route_overrides, route_id=route_id, field_path=field_path)
            effective = _effective_action_for_field_route(
                field_path=field_path,
                route_id=route_id,
                config=configs_by_route[route_id],
                stream_default=stream_default,
                override_ref=override_ref,
            )
            if (
                stream_default
                and effective.protection_action != stream_default.protection_action
                and effective.source == "route_override"
            ):
                routes_with_divergence.add(route_id)
            per_route.append(
                EffectivePerRouteField(
                    route_id=route_id,
                    effective=effective,
                    override=override_ref,
                )
            )

        fields.append(
            EffectiveProtectionField(
                field_path=field_path,
                stream_default=stream_default,
                per_route=per_route,
            )
        )

    route_refs = [
        EffectiveProtectionRouteRef(
            route_id=int(route.id),
            destination_name=destinations.get(int(route.destination_id)).name
            if int(route.destination_id) in destinations
            else None,
            enabled=bool(route.enabled),
        )
        for route in routes
    ]

    return EffectiveProtectionResponse(
        stream_id=stream_id,
        generated_at=_utc_now(),
        routes=route_refs,
        fields=fields,
        summary=EffectiveProtectionSummary(
            protection_rule_count=len([r for r in governance_rules if r.get("enabled", True)]),
            route_override_count=len([o for o in route_overrides if o.get("enabled", True)]),
            routes_with_divergence=len(routes_with_divergence),
        ),
    )
