"""Post-build checks for portable export bundles (masking, ordering, reference fields)."""

from __future__ import annotations

import json
from typing import Any

from app.security.secrets import SENSITIVE_FIELD_NAMES

_MASK = "********"

# Non-secret auth/config reference keys that must survive masking (operators re-bind secrets only).
_PRESERVED_AUTH_REFERENCE_KEYS = frozenset(
    {
        "auth_type",
        "oauth2_client_id",
        "oauth2_token_url",
        "oauth2_scope",
        "token_url",
        "token_path",
        "login_url",
        "login_path",
        "vendor",
        "jwt_issuer",
        "jwt_audience",
        "jwt_subject",
        "refresh_token_header_name",
        "refresh_token_header_prefix",
        "access_token_header_prefix",
        "access_token_json_path",
        "username_field",
        "password_field",
        "iam_role_arn",
        "external_id",
        "region",
        "bucket",
        "base_url",
        "path",
        "preflight_method",
        "preflight_path",
        "preflight_url",
        "preflight_enabled",
        "preflight_follow_redirects",
    }
)


def _sensitive_leaf_values(obj: Any, path: str = "") -> list[tuple[str, Any]]:
    """Collect values for dict keys that match sensitive token names (case-insensitive)."""

    out: list[tuple[str, Any]] = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = f"{path}.{k}" if path else str(k)
            lk = str(k).lower()
            if lk in SENSITIVE_FIELD_NAMES:
                out.append((p, v))
            else:
                out.extend(_sensitive_leaf_values(v, p))
    elif isinstance(obj, list):
        for i, item in enumerate(obj):
            out.extend(_sensitive_leaf_values(item, f"{path}[{i}]"))
    return out


def _webhook_headers_leak(cfg: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    headers = cfg.get("headers")
    if not isinstance(headers, dict):
        return issues
    for hk, hv in headers.items():
        if hv in (None, "", _MASK):
            continue
        s = str(hv).strip()
        if s and s != _MASK:
            issues.append(f"destination config_json.headers[{hk!r}] is not masked")
    return issues


def _preflight_headers_leak(auth: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    ph = auth.get("preflight_headers")
    if not isinstance(ph, dict):
        return issues
    for hk, hv in ph.items():
        if hv in (None, "", _MASK):
            continue
        lk = str(hk).lower().replace("_", "-")
        sensitive_name = lk in ("authorization", "cookie", "x-api-key") or "secret" in lk or "token" in lk or "password" in lk
        if sensitive_name and str(hv).strip() and str(hv).strip() != _MASK:
            issues.append(f"source auth_json.preflight_headers[{hk!r}] is not masked")
    return issues


def verify_export_masking(bundle: dict[str, Any]) -> list[str]:
    """Return human-readable issues if any secret-shaped value appears unmasked."""

    issues: list[str] = []
    for i, s in enumerate(bundle.get("sources") or []):
        if not isinstance(s, dict):
            continue
        auth = s.get("auth_json") or {}
        if isinstance(auth, dict):
            for path, val in _sensitive_leaf_values(auth):
                if val not in (None, "", _MASK) and str(val).strip() != _MASK:
                    issues.append(f"sources[{i}] {path} must be masked or empty, got non-mask value")
            issues.extend(f"sources[{i}] {m}" for m in _preflight_headers_leak(auth))
        cfg = s.get("config_json") or {}
        if isinstance(cfg, dict):
            for path, val in _sensitive_leaf_values(cfg):
                if val not in (None, "", _MASK) and str(val).strip() != _MASK:
                    issues.append(f"sources[{i}] config_json {path} must be masked or empty")

    for i, st in enumerate(bundle.get("streams") or []):
        if not isinstance(st, dict):
            continue
        cfg = st.get("config_json") or {}
        if isinstance(cfg, dict):
            for path, val in _sensitive_leaf_values(cfg):
                if val not in (None, "", _MASK) and str(val).strip() != _MASK:
                    issues.append(f"streams[{i}] config_json {path} must be masked or empty")

    for i, d in enumerate(bundle.get("destinations") or []):
        if not isinstance(d, dict):
            continue
        cfg = d.get("config_json") or {}
        if isinstance(cfg, dict):
            issues.extend(f"destinations[{i}] {m}" for m in _webhook_headers_leak(cfg))
            for path, val in _sensitive_leaf_values(cfg):
                if val not in (None, "", _MASK) and str(val).strip() != _MASK:
                    issues.append(f"destinations[{i}] config_json {path} must be masked or empty")

    for i, c in enumerate(bundle.get("checkpoints") or []):
        if not isinstance(c, dict):
            continue
        cp = c.get("checkpoint_value_json") or {}
        if isinstance(cp, dict):
            for path, val in _sensitive_leaf_values(cp):
                if val not in (None, "", _MASK) and str(val).strip() != _MASK:
                    issues.append(f"checkpoints[{i}] checkpoint_value_json {path} must be masked or empty")

    return issues


def verify_credential_reference_preservation(bundle: dict[str, Any]) -> list[str]:
    """Ensure reference-like auth fields were not stripped to empty by mistake (export sanity)."""

    issues: list[str] = []
    for i, s in enumerate(bundle.get("sources") or []):
        if not isinstance(s, dict):
            continue
        auth = s.get("auth_json")
        if not isinstance(auth, dict):
            continue
        for key in _PRESERVED_AUTH_REFERENCE_KEYS:
            if key not in auth:
                continue
            val = auth.get(key)
            if val in (None, ""):
                continue
            if val == _MASK and key in ("oauth2_client_id", "iam_role_arn", "base_url"):
                issues.append(f"sources[{i}] auth_json.{key} must not be masked as a whole secret placeholder")
    return issues


def _ids_monotonic(ids: list[int | None]) -> bool:
    clean = [int(x) for x in ids if x is not None]
    return clean == sorted(clean)


def verify_deterministic_export_ordering(bundle: dict[str, Any]) -> list[str]:
    """Entity arrays should be ordered by ascending primary id for stable diffs."""

    issues: list[str] = []
    for key in ("connectors", "sources", "streams", "mappings", "enrichments", "destinations", "routes", "checkpoints"):
        rows = bundle.get(key) or []
        if not isinstance(rows, list) or not rows:
            continue
        ids: list[int | None] = []
        for r in rows:
            if isinstance(r, dict) and r.get("id") is not None:
                ids.append(int(r["id"]))
        if len(ids) > 1 and not _ids_monotonic(ids):
            issues.append(f"{key} is not ordered by ascending id")
    return issues


def build_export_integrity_report(bundle: dict[str, Any]) -> dict[str, Any]:
    """Structured integrity block embedded in export JSON."""

    masking = verify_export_masking(bundle)
    refs = verify_credential_reference_preservation(bundle)
    ordering = verify_deterministic_export_ordering(bundle)
    all_issues = [*masking, *refs, *ordering]
    hdr_issues = [m for m in masking if "headers[" in m]
    return {
        "secrets_masked": not masking,
        "webhook_headers_masked": not hdr_issues,
        "credential_references_ok": not refs,
        "deterministic_ordering_ok": not ordering,
        "issues": all_issues,
    }


def assert_bundle_json_roundtrip(bundle: dict[str, Any]) -> list[str]:
    """Dry-run friendly: bundle must JSON-serialize deterministically."""

    issues: list[str] = []
    try:
        json.dumps(bundle, sort_keys=True, default=str)
    except (TypeError, ValueError) as exc:
        issues.append(f"bundle JSON serialization failed: {exc}")
    return issues
