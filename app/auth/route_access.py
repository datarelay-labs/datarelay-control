"""Centralized HTTP RBAC-lite rules (JWT role + method + path).

This module is the single source of truth for coarse route access used by
``role_guard_middleware``.  Per-route ``Depends(require_roles(...))`` should
only be used for exceptions that cannot be expressed as prefix/method rules
(e.g. retention GET open to VIEWER while POST /run stays operator+admin).
"""

from __future__ import annotations

from dataclasses import dataclass

from app.auth.governance_rbac import (
    ROLE_CONNECTOR_OPERATOR,
    ROLE_VIEWER,
    can_ai_audit_read,
    can_ai_governance_operate,
    can_ai_governance_read,
    can_ai_policy_operate,
    can_ai_policy_read,
    can_audit_read,
    can_connector_operate,
    can_governance_dashboard_read,
    can_governance_operations_access,
    can_governance_read,
    can_governance_write,
    can_policy_activate,
    can_policy_approve,
    can_quarantine_action,
    can_replay_action,
    normalize_platform_role,
)
from app.config import settings

ROLE_ADMINISTRATOR = "ADMINISTRATOR"
ROLE_OPERATOR = "OPERATOR"
ROLE_VIEWER = "VIEWER"

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


@dataclass(frozen=True)
class AccessDenied:
    """Structured denial returned by :func:`evaluate_http_access`."""

    error_code: str
    message: str


def api_prefix() -> str:
    return settings.API_PREFIX.rstrip("/")


def _under(prefix: str, path: str) -> bool:
    return path == prefix or path.startswith(f"{prefix}/")


def is_governance_read_post(path: str) -> bool:
    """Non-persisting governance POST helpers (preview, simulate, impact)."""

    base = api_prefix()
    if not path.startswith(f"{base}/governance"):
        return False
    if path.endswith("/preview") or path.endswith("/simulate"):
        return True
    if "/impact-preview" in path or path.endswith("/impact"):
        return True
    return False


def is_viewer_allowed_post(path: str) -> bool:
    """POST endpoints that are read-only / non-persisting preview helpers."""

    base = api_prefix()
    if path.startswith(f"{base}/runtime/preview/"):
        return True
    if path == f"{base}/runtime/format-preview":
        return True
    if "/runtime/streams/" in path and path.endswith("/pipeline-debug"):
        return True
    return False


def build_capabilities(role: str) -> dict[str, bool]:
    """UI-oriented capability flags derived from the effective platform role."""

    r = (role or "").strip().upper()
    is_admin = r == ROLE_ADMINISTRATOR
    is_viewer = r == ROLE_VIEWER
    can_operate = can_connector_operate(role)
    gov_read = can_governance_read(role)
    gov_dashboard = can_governance_dashboard_read(role)
    gov_operations = can_governance_operations_access(role)
    return {
        "workspace_mutations": can_operate,
        "runtime_stream_control": can_operate,
        "runtime_logs_cleanup": can_operate,
        "backfill_mutations": can_operate,
        "retention_execute": can_operate,
        "validation_mutations": can_operate,
        "backup_import_apply": is_admin,
        "backup_import_preview": can_operate,
        "backup_clone": can_operate,
        "admin_user_management": is_admin,
        "admin_password_changes": is_admin,
        "admin_maintenance_health": is_admin,
        "admin_support_bundle": is_admin,
        "admin_https_write": is_admin,
        "admin_retention_policy_write": is_admin,
        "admin_alert_settings_write": is_admin,
        "admin_config_snapshot_apply": is_admin,
        "administration_apis": is_admin or can_operate,
        "read_only_monitoring": is_admin or can_operate or is_viewer or gov_read,
        "governance_read": gov_read,
        "governance_dashboard_read": gov_dashboard,
        "governance_operations_access": gov_operations,
        "governance_mutations": can_governance_write(role),
        "governance_policy_submit": can_governance_write(role),
        "governance_policy_review": can_policy_approve(role),
        "governance_policy_approve": can_policy_approve(role),
        "governance_policy_activate": can_policy_activate(role),
        "governance_quarantine_action": can_quarantine_action(role),
        "governance_replay_action": can_replay_action(role),
        "governance_audit_read": can_audit_read(role),
        "ai_gateway_read": is_admin or can_operate or is_viewer,
        "ai_gateway_operate": can_operate,
        "ai_gateway_admin": is_admin,
        "ai_policy_read": can_ai_policy_read(role),
        "ai_policy_operate": can_ai_policy_operate(role),
        "ai_audit_read": can_ai_audit_read(role),
        "ai_governance_read": can_ai_governance_read(role),
        "ai_governance_operate": can_ai_governance_operate(role),
        "marketplace_package_lifecycle": can_operate,
        "marketplace_trusted_key_manage": is_admin,
        "marketplace_unsigned_install": is_admin,
    }


def evaluate_http_access(*, role: str, method: str, path: str) -> AccessDenied | None:
    """Return ``AccessDenied`` when the principal must not proceed, else ``None``."""

    m = method.upper()
    base = api_prefix()

    # --- Sensitive administrator surfaces (not even read for non-admins) ---
    admin_exclusive = (
        f"{base}/admin/maintenance/health",
        f"{base}/admin/dev-validation/status",
        f"{base}/admin/support-bundle",
        f"{base}/admin/network-settings",
        f"{base}/admin/users",
    )
    for prefix in admin_exclusive:
        if _under(prefix, path) and role != ROLE_ADMINISTRATOR:
            return AccessDenied(
                "ROLE_FORBIDDEN",
                "This endpoint requires the Administrator role.",
            )

    if _under(f"{base}/admin/password", path) and role != ROLE_ADMINISTRATOR:
        return AccessDenied(
            "ROLE_FORBIDDEN",
            "This endpoint requires the Administrator role.",
        )

    # --- Platform policy writes: Administrator only (GET remains for operators/viewers) ---
    policy_prefixes = (
        f"{base}/admin/https-settings",
        f"{base}/admin/retention-policy",
        f"{base}/admin/alert-settings",
    )
    for prefix in policy_prefixes:
        if _under(prefix, path) and m not in SAFE_METHODS and role != ROLE_ADMINISTRATOR:
            return AccessDenied(
                "ROLE_FORBIDDEN",
                "Only an Administrator may change this platform configuration.",
            )

    # --- Destructive / wide-blast configuration ---
    if path.startswith(f"{base}/backup/import/apply") and m not in SAFE_METHODS and role != ROLE_ADMINISTRATOR:
        return AccessDenied(
            "ROLE_FORBIDDEN",
            "Workspace import apply requires the Administrator role.",
        )

    if (
        "/apply-snapshot" in path
        and path.startswith(f"{base}/admin/config-versions")
        and m not in SAFE_METHODS
        and role != ROLE_ADMINISTRATOR
    ):
        return AccessDenied(
            "ROLE_FORBIDDEN",
            "Applying configuration snapshots requires the Administrator role.",
        )

    # --- Governance control plane (M20 RBAC) ---
    gov_prefix = f"{base}/governance"
    if _under(gov_prefix, path):
        if path.startswith(f"{gov_prefix}/dashboard"):
            if not can_governance_dashboard_read(role):
                return AccessDenied(
                    "GOVERNANCE_DASHBOARD_FORBIDDEN",
                    "Governance dashboard requires an authorized Governance role or Viewer.",
                )
        elif path.startswith(f"{gov_prefix}/operations"):
            if not can_governance_operations_access(role):
                return AccessDenied(
                    "GOVERNANCE_OPERATIONS_FORBIDDEN",
                    "Governance Operations requires Governance Operator role or higher.",
                )
        elif not can_governance_read(role):
            return AccessDenied(
                "GOVERNANCE_READ_FORBIDDEN",
                "Governance access requires an authorized Governance or Connector Operator role.",
            )
        if m not in SAFE_METHODS and not is_viewer_allowed_post(path) and not is_governance_read_post(path):
            if path.endswith("/activate") or ("/approvals/" in path and path.endswith("/activate")):
                if not can_policy_activate(role):
                    return AccessDenied(
                        "GOVERNANCE_ACTIVATE_FORBIDDEN",
                        "Policy activation requires Governance Approver role.",
                    )
            elif "/approvals/" in path and (path.endswith("/approve") or path.endswith("/reject")):
                if not can_policy_approve(role):
                    return AccessDenied(
                        "GOVERNANCE_APPROVAL_FORBIDDEN",
                        "Governance approval requires Governance Reviewer or Approver role.",
                    )
            elif "/quarantine/release" in path or "/quarantine/discard" in path:
                if not can_quarantine_action(role):
                    return AccessDenied(
                        "GOVERNANCE_QUARANTINE_FORBIDDEN",
                        "Quarantine release requires Governance Operator role.",
                    )
            elif "/quarantine/replay" in path:
                if not can_replay_action(role):
                    return AccessDenied(
                        "GOVERNANCE_REPLAY_FORBIDDEN",
                        "Replay execution requires Governance Operator role.",
                    )
            elif "/governance/replay" in path and (
                path.endswith("/execute") or path.endswith("/bulk-execute")
            ):
                if not can_replay_action(role):
                    return AccessDenied(
                        "GOVERNANCE_REPLAY_FORBIDDEN",
                        "Replay execution requires Governance Operator role.",
                    )
            elif not can_governance_write(role):
                return AccessDenied(
                    "GOVERNANCE_WRITE_FORBIDDEN",
                    "Governance write actions require Governance Operator role.",
                )

    # --- Governance-only roles: no connector/workspace mutations ---
    if m not in SAFE_METHODS and not is_viewer_allowed_post(path):
        normalized = normalize_platform_role(role)
        if normalized not in {ROLE_ADMINISTRATOR, ROLE_CONNECTOR_OPERATOR, ROLE_OPERATOR, ROLE_VIEWER}:
            if not _under(gov_prefix, path):
                return AccessDenied(
                    "ROLE_FORBIDDEN",
                    "This role may only access Governance resources.",
                )

    # --- AI Gateway Foundation (M21.2+) — reuse connector operate for mutations ---
    ai_providers_prefix = f"{base}/ai-providers"
    if _under(ai_providers_prefix, path):
        if m not in SAFE_METHODS and not can_connector_operate(role):
            return AccessDenied(
                "ROLE_FORBIDDEN",
                "AI Provider mutations require Connector Operator or Administrator role.",
            )

    ai_streams_prefix = f"{base}/ai-streams"
    if _under(ai_streams_prefix, path):
        if m not in SAFE_METHODS and not can_connector_operate(role):
            return AccessDenied(
                "ROLE_FORBIDDEN",
                "AI Stream mutations require Connector Operator or Administrator role.",
            )

    ai_policy_prefix = f"{base}/ai-policy-rules"
    if _under(ai_policy_prefix, path):
        if m in SAFE_METHODS:
            if not can_ai_policy_read(role):
                return AccessDenied(
                    "ROLE_FORBIDDEN",
                    "AI policy read requires Connector Operator, Viewer, or Administrator role.",
                )
        elif not can_ai_policy_operate(role):
            return AccessDenied(
                "ROLE_FORBIDDEN",
                "AI policy mutations require Connector Operator or Administrator role.",
            )

    ai_traffic_prefix = f"{base}/ai-providers/traffic"
    if _under(ai_traffic_prefix, path):
        if m not in SAFE_METHODS and not can_connector_operate(role):
            return AccessDenied(
                "ROLE_FORBIDDEN",
                "AI traffic metrics are read-only for VIEWER role.",
            )

    ai_audit_prefix = f"{base}/ai-audit-events"
    if _under(ai_audit_prefix, path):
        if m not in SAFE_METHODS:
            return AccessDenied(
                "ROLE_FORBIDDEN",
                "AI audit API is read-only.",
            )
        if not can_ai_audit_read(role):
            return AccessDenied(
                "ROLE_FORBIDDEN",
                "AI audit read requires Connector Operator, Viewer, or Administrator role.",
            )

    ai_governance_prefix = f"{base}/ai-governance"
    if _under(ai_governance_prefix, path):
        if m in SAFE_METHODS:
            if not can_ai_governance_read(role):
                return AccessDenied(
                    "ROLE_FORBIDDEN",
                    "AI governance read requires Connector Operator, Viewer, or Administrator role.",
                )
        elif not can_ai_governance_operate(role):
            return AccessDenied(
                "ROLE_FORBIDDEN",
                "AI governance mutations require Connector Operator or Administrator role.",
            )

    # --- Marketplace trusted signing keys (M29.5A): Administrator write only ---
    trusted_keys_prefix = f"{base}/connectors-registry/trusted-signing-keys"
    if _under(trusted_keys_prefix, path) and m not in SAFE_METHODS and role != ROLE_ADMINISTRATOR:
        return AccessDenied(
            "ROLE_FORBIDDEN",
            "Trusted signing key management requires the Administrator role.",
        )

    # --- Marketplace package lifecycle mutations: Viewer blocked (handled below);
    # Operator may mutate packages but unsigned policy is enforced in lifecycle service. ---
    packages_prefix = f"{base}/connectors-registry/packages"
    if _under(packages_prefix, path) and m not in SAFE_METHODS:
        if role == ROLE_VIEWER:
            return AccessDenied(
                "ROLE_FORBIDDEN",
                "VIEWER role cannot perform Marketplace package lifecycle mutations.",
            )
        if not can_connector_operate(role) and role != ROLE_ADMINISTRATOR:
            return AccessDenied(
                "ROLE_FORBIDDEN",
                "Marketplace package lifecycle requires Connector Operator or Administrator role.",
            )

    # --- VIEWER: read-only monitoring; no mutating verbs except preview POSTs ---
    if role == ROLE_VIEWER and m not in SAFE_METHODS:
        if is_viewer_allowed_post(path):
            return None
        return AccessDenied(
            "ROLE_FORBIDDEN",
            "VIEWER role cannot perform mutating actions.",
        )

    # --- OPERATOR: block legacy administrator-only mutation prefixes ---
    if role == ROLE_OPERATOR and m not in SAFE_METHODS:
        operator_mutation_deny = (
            f"{base}/admin/users",
            f"{base}/admin/password",
            f"{base}/admin/https-settings",
            f"{base}/admin/retention-policy",
            f"{base}/admin/alert-settings",
            f"{base}/connectors-registry/trusted-signing-keys",
        )
        for prefix in operator_mutation_deny:
            if _under(prefix, path):
                return AccessDenied(
                    "ROLE_FORBIDDEN",
                    "OPERATOR role cannot modify administrator-only resources.",
                )

    return None
