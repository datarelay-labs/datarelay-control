"""Route protection config resolution — dual-read + override merge (M13.3)."""

from __future__ import annotations

from typing import Any, Iterable

from app.protection.models import (
    PROTECTION_MODE_DROP_FIELD,
    PROTECTION_MODE_FULL_MASK,
    PROTECTION_MODE_HASH,
    PROTECTION_MODE_PARTIAL_MASK,
    PROTECTION_MODE_TOKENIZATION,
)
from app.route_protection.config import (
    PersistedSource,
    RouteProtectionConfig,
    RouteProtectionResolution,
    RouteProtectionRuleEntry,
)
from app.sensitive_detection.models import SENSITIVITY_CLASS_PII

AUDIT_ONLY_ACTIONS = frozenset({"audit", "audit_only"})


def map_protection_action_to_mode(action: str | None) -> str | None:
    """Map Governance Workspace protection_action to engine mode or audit-only."""

    if action is None:
        return None
    normalized = str(action).strip().lower()
    if normalized in AUDIT_ONLY_ACTIONS:
        return "audit_only"
    mapping = {
        "mask_partial": PROTECTION_MODE_PARTIAL_MASK,
        "partial_mask": PROTECTION_MODE_PARTIAL_MASK,
        "mask_full": PROTECTION_MODE_FULL_MASK,
        "full_mask": PROTECTION_MODE_FULL_MASK,
        "mask": PROTECTION_MODE_PARTIAL_MASK,
        "tokenize": PROTECTION_MODE_TOKENIZATION,
        "tokenization": PROTECTION_MODE_TOKENIZATION,
        "hash": PROTECTION_MODE_HASH,
        "remove": PROTECTION_MODE_DROP_FIELD,
        "drop_field": PROTECTION_MODE_DROP_FIELD,
    }
    return mapping.get(normalized)


def _rule_entry_from_row(
    row: Any,
    *,
    stream_id: int,
    source: PersistedSource | str,
) -> RouteProtectionRuleEntry:
    return RouteProtectionRuleEntry(
        stream_id=stream_id,
        field_path=str(row.field_path),
        protection_mode=str(row.protection_mode),
        sensitivity_class=str(row.sensitivity_class),
        enabled=bool(getattr(row, "enabled", True)),
        source=source,  # type: ignore[arg-type]
        id=int(row.id) if getattr(row, "id", None) is not None else None,
        source_finding_id=getattr(row, "source_finding_id", None),
    )


def _index_rules_by_path(rules: Iterable[RouteProtectionRuleEntry]) -> dict[str, RouteProtectionRuleEntry]:
    indexed: dict[str, RouteProtectionRuleEntry] = {}
    for rule in rules:
        if rule.enabled:
            indexed[rule.field_path] = rule
    return indexed


def apply_route_overrides(
    base_rules: list[RouteProtectionRuleEntry],
    overrides: list[dict[str, Any]],
    *,
    stream_id: int,
) -> tuple[list[RouteProtectionRuleEntry], list[str], dict[str, RouteProtectionRuleEntry]]:
    """Merge route overrides; override wins per field_path."""

    effective = _index_rules_by_path(base_rules)
    audit_only_paths: list[str] = []
    override_rules_by_path: dict[str, RouteProtectionRuleEntry] = {}

    for override in overrides:
        if not bool(override.get("enabled", True)):
            continue
        field_path = str(override.get("field_path") or "").strip()
        if not field_path:
            continue
        action = map_protection_action_to_mode(override.get("protection_action"))
        if action == "audit_only":
            effective.pop(field_path, None)
            audit_only_paths.append(field_path)
            continue
        if action is None:
            continue
        entry = RouteProtectionRuleEntry(
            stream_id=stream_id,
            field_path=field_path,
            protection_mode=action,
            sensitivity_class=str(override.get("sensitivity_class") or SENSITIVITY_CLASS_PII),
            enabled=True,
            source="route_override",
        )
        effective[field_path] = entry
        override_rules_by_path[field_path] = entry

    return list(effective.values()), audit_only_paths, override_rules_by_path


def merge_ephemeral_for_route(
    ephemeral_rules: list[Any] | None,
    config: RouteProtectionConfig,
) -> list[Any]:
    """Filter/adjust shared ephemeral Auto Protect rules for one route."""

    if not ephemeral_rules:
        return []
    persisted_paths = {rule.field_path for rule in config.rules}
    audit_only = set(config.audit_only_paths)
    override_by_path = dict(config.override_rules_by_path)
    merged: list[Any] = []

    for ephemeral in ephemeral_rules:
        field_path = str(getattr(ephemeral, "field_path", "") or "")
        if not field_path:
            continue
        if field_path in audit_only:
            continue
        if field_path in override_by_path:
            override = override_by_path[field_path]
            from app.protection.ephemeral import EphemeralProtectionRule

            merged.append(
                EphemeralProtectionRule(
                    stream_id=int(getattr(ephemeral, "stream_id", override.stream_id)),
                    field_path=field_path,
                    protection_mode=override.protection_mode,
                    sensitivity_class=getattr(ephemeral, "sensitivity_class", None),
                    enabled=True,
                    id=getattr(ephemeral, "id", None),
                )
            )
            continue
        if field_path in persisted_paths:
            continue
        merged.append(ephemeral)

    return merged


def resolve_route_protection_config(
    *,
    route_id: int,
    stream_id: int,
    route_protection_rules: list[Any] | None = None,
    stream_protection_rules: list[Any] | None = None,
    route_overrides: list[dict[str, Any]] | None = None,
    ephemeral_auto_protect_rules: list[Any] | None = None,
) -> RouteProtectionConfig:
    """Dual-read persisted base + override merge; ephemeral counted in resolution metadata."""

    route_rules = [r for r in (route_protection_rules or []) if bool(getattr(r, "enabled", True))]
    stream_rules = [r for r in (stream_protection_rules or []) if bool(getattr(r, "enabled", True))]

    if route_rules:
        persisted_base = [
            _rule_entry_from_row(row, stream_id=stream_id, source="route") for row in route_rules
        ]
        persisted_source: PersistedSource = "route"
    elif stream_rules:
        persisted_base = [
            _rule_entry_from_row(row, stream_id=stream_id, source="stream") for row in stream_rules
        ]
        persisted_source = "stream"
    else:
        persisted_base = []
        persisted_source = "empty"

    ephemeral = list(ephemeral_auto_protect_rules or [])
    filtered_overrides = [
        item
        for item in (route_overrides or [])
        if int(item.get("route_id", -1)) == int(route_id)
    ]
    effective_rules, audit_only_paths, override_rules_by_path = apply_route_overrides(
        persisted_base,
        filtered_overrides,
        stream_id=stream_id,
    )

    return RouteProtectionConfig(
        rules=tuple(effective_rules),
        audit_only_paths=tuple(audit_only_paths),
        resolution=RouteProtectionResolution(
            persisted_source=persisted_source,
            override_count=len(filtered_overrides),
            ephemeral_rule_count=len(ephemeral),
            fallback_used=persisted_source == "stream",
        ),
        override_rules_by_path=override_rules_by_path,
    )
