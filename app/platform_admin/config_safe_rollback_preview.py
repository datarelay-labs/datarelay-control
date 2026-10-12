"""PF-12A Control-owned, secret-free configuration rollback readiness preview.

Source of revision truth remains platform_config_versions and live Control
configuration. Only a small, explicitly product-owned allowlist of safe
scalars reaches the immutable Product Foundation contract. This is read-only.
"""

from __future__ import annotations

from typing import Any, get_args

from datarelay_onprem_security import (
    ConfigField,
    ConfigRevision,
    RollbackEvidence,
    diff_configurations,
    preview_config_rollback,
)

from app.routes.schemas import RouteFailurePolicy

_PRODUCT_REF = "datarelay.control"
_SAFE_FIELDS: dict[str, dict[str, type]] = {
    "STREAM_CONFIG": {"enabled": bool, "polling_interval": int},
    "ROUTE_CONFIG": {"enabled": bool, "failure_policy": str},
    "DESTINATION_CONFIG": {"enabled": bool},
}
_ROUTE_POLICIES = frozenset(get_args(RouteFailurePolicy))


def _safe_fields(entity_type: str, snapshot: dict[str, Any]) -> tuple[ConfigField, ...]:
    spec = _SAFE_FIELDS.get(entity_type)
    if spec is None:
        raise ValueError("Unsupported entity type for safe rollback preview")
    if not isinstance(snapshot, dict) or snapshot.get("kind", entity_type) != entity_type:
        raise ValueError("Invalid snapshot for safe rollback preview")
    safe: list[ConfigField] = []
    for field, expected_type in sorted(spec.items()):
        if field not in snapshot:
            raise ValueError("Incomplete snapshot for safe rollback preview")
        value = snapshot[field]
        if type(value) is not expected_type:
            raise ValueError("Unsafe configuration scalar type")
        if field == "failure_policy" and value not in _ROUTE_POLICIES:
            raise ValueError("Unsupported Route failure policy")
        if field == "polling_interval" and not 1 <= value <= 2**31 - 1:
            raise ValueError("Invalid polling interval")
        safe.append(ConfigField(path=field, value=value))
    return tuple(safe)


def build_safe_rollback_readiness(
    *, entity_type: str, current_version: int, expected_version: int,
    target_version: int, target_side: str,
    current_snapshot: dict[str, Any], target_snapshot: dict[str, Any],
    current_created_at: int, target_created_at: int,
    actor_authorized: bool, recent_mfa_verified: bool,
) -> dict[str, Any]:
    """Review safe existing history without permitting or performing mutation.

    Backup, recovery, audit and product-native atomic rollback have not been
    qualified for this adapter, so never fabricate positive authority facts.
    """
    for value in (current_version, expected_version, target_version):
        if type(value) is not int or value < 1:
            raise ValueError("Invalid configuration revision reference")
    if target_version > current_version:
        raise ValueError("Future target revision is not historical")
    if target_side not in ("before", "after"):
        raise ValueError("Invalid history snapshot side")
    if type(actor_authorized) is not bool or type(recent_mfa_verified) is not bool:
        raise ValueError("Invalid authorization evidence")
    allowlisted = frozenset(_SAFE_FIELDS.get(entity_type, {}))
    if not allowlisted:
        raise ValueError("Unsupported entity type for safe rollback preview")
    current = ConfigRevision(
        product_ref=_PRODUCT_REF,
        revision_ref=f"v{current_version}",
        actor_ref="control.observed",
        created_at=current_created_at,
        fields=_safe_fields(entity_type, current_snapshot),
    )
    target = ConfigRevision(
        product_ref=_PRODUCT_REF,
        revision_ref=f"v{target_version}" if target_side == "after" else f"v{target_version}.before",
        actor_ref="control.history",
        created_at=target_created_at,
        fields=_safe_fields(entity_type, target_snapshot),
    )
    diff = diff_configurations(target, current, allowlisted_paths=allowlisted)
    evidence = RollbackEvidence(
        expected_current_revision=f"v{expected_version}",
        target_revision_available=True,
        actor_authorized=actor_authorized,
        recent_mfa_verified=recent_mfa_verified,
        # Existing generic apply-snapshot is NOT qualified as a PF-12A native
        # rollback path. Do not elevate that legacy action by this preview.
        product_rollback_supported=False,
        backup_verified=False,
        rollback_path_verified=False,
        out_of_band_recovery=False,
        audit_ready=False,
    )
    result = preview_config_rollback(
        current, target, allowlisted_paths=allowlisted,
        reversible_paths=frozenset(), evidence=evidence,
    )
    return {
        "entity_type": entity_type,
        "current_version": current_version,
        "source_version": target_version,
        "expected_version": expected_version,
        "changed_fields": [
            {"path": c.path, "before": c.before, "after": c.after}
            for c in diff.changes
        ],
        "from_fingerprint": diff.from_fingerprint,
        "to_fingerprint": diff.to_fingerprint,
        "blockers": [b.value for b in result.blockers],
        "may_submit_to_product_authority": result.may_submit_to_product_authority,
        "product_apply_required": result.product_apply_required,
    }
