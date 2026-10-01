"""Marketplace license / provenance policy (M29.5B).

Platform-derived product decisions for declared package license/provenance
metadata. This is **not** legal advice and does not imply Verified/Official
trust tiers or technical API verification.

Declared license/provenance is metadata only. Packages must not self-assign
``license_decision`` (or related platform-owned fields); those are stripped
and recomputed by this policy.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping

from app.connectors_registry.models import (
    ConnectorManifest,
    LicenseMetadata,
    UpstreamProvenance,
)

# Platform product decisions (not legal conclusions).
LICENSE_DECISION_ALLOW = "ALLOW"
LICENSE_DECISION_REVIEW = "REVIEW"
LICENSE_DECISION_REFERENCE_ONLY = "REFERENCE_ONLY"
LICENSE_DECISION_DENY = "DENY"

LICENSE_DECISIONS: tuple[str, ...] = (
    LICENSE_DECISION_ALLOW,
    LICENSE_DECISION_REVIEW,
    LICENSE_DECISION_REFERENCE_ONLY,
    LICENSE_DECISION_DENY,
)

# Historical charter aliases (AUTO_PORT_CANDIDATE / REVIEW_ADAPT) map here;
# current code uses ALLOW / REVIEW / REFERENCE_ONLY / DENY only.

# Spoofed platform-owned fields ignored from package manifests.
PLATFORM_OWNED_LICENSE_FIELDS: frozenset[str] = frozenset(
    {
        "license_decision",
        "license_decision_code",
        "license_decision_reason",
        "platform_license_decision",
        "license_gate",
        "license_gate_decision",
    }
)

# Conservative SPDX / identifier families (normalized uppercase tokens).
_ALLOW_CANDIDATES: frozenset[str] = frozenset(
    {
        "MIT",
        "APACHE-2.0",
        "APACHE2.0",
        "APACHE-2",
        "APACHE2",
    }
)

_REVIEW_RECIPROCAL: frozenset[str] = frozenset(
    {
        "MPL-2.0",
        "MPL2.0",
        "MPL-2",
        "MPL2",
        "MPL",
        "GPL-2.0",
        "GPL-2.0-ONLY",
        "GPL-2.0-OR-LATER",
        "GPL-3.0",
        "GPL-3.0-ONLY",
        "GPL-3.0-OR-LATER",
        "LGPL-2.1",
        "LGPL-2.1-ONLY",
        "LGPL-2.1-OR-LATER",
        "LGPL-3.0",
        "LGPL-3.0-ONLY",
        "LGPL-3.0-OR-LATER",
        "AGPL-3.0",
        "AGPL-3.0-ONLY",
        "AGPL-3.0-OR-LATER",
    }
)

_REFERENCE_ONLY_MARKERS: frozenset[str] = frozenset(
    {
        "ELV2",
        "ELASTIC-2.0",
        "ELASTIC",
        "BUSL-1.1",
        "BUSL",
        "SSPL-1.0",
        "SSPL",
        "PROPRIETARY",
        "COMMERCIAL",
        "UNLICENSED",
        "ALL-RIGHTS-RESERVED",
        "FAIR-SOURCE",
        "FAIR-CODE",
        "SOURCE-AVAILABLE",
        "SUSTAINABLE-USE",
        "POLYFORM-SHIELD",
        "POLYFORM-NONCOMMERCIAL",
    }
)

_REASON_ALLOW_PERMISSIVE = "PERMISSIVE_ALLOW_CANDIDATE"
_REASON_REVIEW_RECIPROCAL = "RECIPROCAL_OR_COPYLEFT_REVIEW"
_REASON_REFERENCE_SOURCE_AVAILABLE = "SOURCE_AVAILABLE_OR_RESTRICTED"
_REASON_REFERENCE_UNKNOWN = "UNKNOWN_OR_MISSING_LICENSE"
_REASON_REFERENCE_UNCLEAR = "UNCLEAR_LICENSE_IDENTIFIER"
_REASON_DENY_CONFIGURED = "EXPLICIT_POLICY_DENY"
_REASON_SPOOF_IGNORED = "MANIFEST_LICENSE_DECISION_IGNORED"


@dataclass(frozen=True)
class LicensePolicyConfig:
    """Optional administrator deny/allow overrides (no vendor hardcoding)."""

    # Exact normalized SPDX/identifier tokens that are always DENY.
    denied_licenses: frozenset[str] = field(default_factory=frozenset)
    # Exact normalized tokens forced to REVIEW (even if otherwise ALLOW).
    force_review_licenses: frozenset[str] = field(default_factory=frozenset)
    # Exact normalized tokens forced to REFERENCE_ONLY.
    force_reference_only_licenses: frozenset[str] = field(default_factory=frozenset)


@dataclass(frozen=True)
class DeclaredProvenance:
    """Preserved declared provenance / license metadata (no remote fetch)."""

    license_identifier: str | None
    license_source: str | None
    notice_required: bool | None
    upstream_project: str | None
    upstream_url: str | None
    upstream_path: str | None
    upstream_commit_or_version: str | None
    modified_from_upstream: bool | None
    import_method: str | None
    source_evidence: list[dict[str, Any]]


@dataclass(frozen=True)
class LicensePolicyResult:
    """Platform-derived license/provenance decision."""

    decision: str
    decision_code: str
    decision_reason: str
    declared: DeclaredProvenance
    spoofed_fields_ignored: tuple[str, ...] = ()

    @property
    def allows_direct_content_import(self) -> bool:
        """Whether decision is an ALLOW candidate for direct package content import."""

        return self.decision == LICENSE_DECISION_ALLOW


def strip_spoofed_license_decision_fields(raw: dict[str, Any]) -> tuple[dict[str, Any], tuple[str, ...]]:
    """Remove platform-owned license decision fields from a raw manifest dict.

    Returns ``(cleaned_dict, ignored_field_names)``. Mutates a shallow copy only.
    """

    cleaned = dict(raw)
    ignored: list[str] = []
    for key in PLATFORM_OWNED_LICENSE_FIELDS:
        if key in cleaned:
            cleaned.pop(key, None)
            ignored.append(key)
    # Nested license object must not carry a self-declared decision.
    license_value = cleaned.get("license")
    if isinstance(license_value, dict):
        nested = dict(license_value)
        nested_ignored = False
        for key in PLATFORM_OWNED_LICENSE_FIELDS:
            if key in nested:
                nested.pop(key, None)
                nested_ignored = True
        if nested_ignored:
            cleaned["license"] = nested
            ignored.append("license.<platform_decision>")
    return cleaned, tuple(ignored)


def _normalize_license_token(value: str) -> str:
    text = value.strip().upper()
    # SPDX expressions: take first primary token before operators.
    for sep in (" WITH ", " AND ", " OR ", "+"):
        if sep.strip() in text or sep in text:
            # Keep simple: if expression contains OR/AND, treat as unclear unless
            # the whole string is a known single identifier.
            break
    text = text.replace(" ", "")
    text = text.replace("_", "-")
    return text


def _extract_license_identifier(
    license_value: str | LicenseMetadata | dict[str, Any] | None,
    provenance: UpstreamProvenance | Mapping[str, Any] | None,
) -> str | None:
    if isinstance(license_value, str):
        stripped = license_value.strip()
        if stripped:
            return stripped
    elif isinstance(license_value, LicenseMetadata):
        for candidate in (license_value.spdx, license_value.name):
            if candidate and str(candidate).strip():
                return str(candidate).strip()
    elif isinstance(license_value, dict):
        for key in ("spdx", "name", "id", "license"):
            candidate = license_value.get(key)
            if candidate is not None and str(candidate).strip():
                return str(candidate).strip()

    if provenance is None:
        return None
    if isinstance(provenance, UpstreamProvenance):
        detected = provenance.license_spdx_or_detected_license
        return detected.strip() if detected and detected.strip() else None
    if isinstance(provenance, Mapping):
        detected = provenance.get("license_spdx_or_detected_license")
        if detected is not None and str(detected).strip():
            return str(detected).strip()
    return None


def _extract_license_source(
    license_value: str | LicenseMetadata | dict[str, Any] | None,
    provenance: UpstreamProvenance | Mapping[str, Any] | None,
) -> str | None:
    if isinstance(license_value, LicenseMetadata) and license_value.source:
        return license_value.source.strip() or None
    if isinstance(license_value, dict):
        source = license_value.get("source")
        if source is not None and str(source).strip():
            return str(source).strip()
    if isinstance(provenance, UpstreamProvenance) and provenance.license_source:
        return provenance.license_source.strip() or None
    if isinstance(provenance, Mapping):
        source = provenance.get("license_source")
        if source is not None and str(source).strip():
            return str(source).strip()
    return None


def _extract_notice_required(
    license_value: str | LicenseMetadata | dict[str, Any] | None,
    provenance: UpstreamProvenance | Mapping[str, Any] | None,
) -> bool | None:
    if isinstance(license_value, LicenseMetadata) and license_value.notice_required is not None:
        return bool(license_value.notice_required)
    if isinstance(license_value, dict) and "notice_required" in license_value:
        return bool(license_value.get("notice_required"))
    if isinstance(provenance, UpstreamProvenance) and provenance.notice_required is not None:
        return bool(provenance.notice_required)
    if isinstance(provenance, Mapping) and "notice_required" in provenance:
        return bool(provenance.get("notice_required"))
    return None


def _provenance_field(
    provenance: UpstreamProvenance | Mapping[str, Any] | None,
    name: str,
) -> Any:
    if provenance is None:
        return None
    if isinstance(provenance, UpstreamProvenance):
        return getattr(provenance, name, None)
    if isinstance(provenance, Mapping):
        return provenance.get(name)
    return None


def _source_evidence_dicts(
    evidence: Any,
) -> list[dict[str, Any]]:
    if evidence is None:
        return []
    items: list[dict[str, Any]] = []
    if not isinstance(evidence, list):
        return items
    for entry in evidence:
        if hasattr(entry, "model_dump"):
            items.append(dict(entry.model_dump()))
        elif isinstance(entry, Mapping):
            items.append(dict(entry))
    return items


def extract_declared_provenance(
    *,
    license_value: str | LicenseMetadata | dict[str, Any] | None = None,
    upstream_provenance: UpstreamProvenance | Mapping[str, Any] | None = None,
    source_evidence: Any = None,
) -> DeclaredProvenance:
    """Preserve declared license/provenance fields without fetching remote content."""

    return DeclaredProvenance(
        license_identifier=_extract_license_identifier(license_value, upstream_provenance),
        license_source=_extract_license_source(license_value, upstream_provenance),
        notice_required=_extract_notice_required(license_value, upstream_provenance),
        upstream_project=_as_optional_str(_provenance_field(upstream_provenance, "upstream_project")),
        upstream_url=_as_optional_str(_provenance_field(upstream_provenance, "upstream_url")),
        upstream_path=_as_optional_str(_provenance_field(upstream_provenance, "upstream_path")),
        upstream_commit_or_version=_as_optional_str(
            _provenance_field(upstream_provenance, "upstream_commit_or_version")
        ),
        modified_from_upstream=_as_optional_bool(
            _provenance_field(upstream_provenance, "modified_from_upstream")
        ),
        import_method=_as_optional_str(_provenance_field(upstream_provenance, "import_method")),
        source_evidence=_source_evidence_dicts(source_evidence),
    )


def _as_optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _as_optional_bool(value: Any) -> bool | None:
    if value is None:
        return None
    return bool(value)


def _classify_normalized_token(token: str, config: LicensePolicyConfig) -> tuple[str, str]:
    """Return ``(decision, decision_code)`` for a normalized license token."""

    denied = {_normalize_license_token(value) for value in config.denied_licenses}
    forced_reference = {
        _normalize_license_token(value) for value in config.force_reference_only_licenses
    }
    forced_review = {_normalize_license_token(value) for value in config.force_review_licenses}

    if token in denied:
        return LICENSE_DECISION_DENY, _REASON_DENY_CONFIGURED
    if token in forced_reference:
        return LICENSE_DECISION_REFERENCE_ONLY, _REASON_REFERENCE_SOURCE_AVAILABLE
    if token in forced_review:
        return LICENSE_DECISION_REVIEW, _REASON_REVIEW_RECIPROCAL

    if token in _ALLOW_CANDIDATES:
        return LICENSE_DECISION_ALLOW, _REASON_ALLOW_PERMISSIVE
    if token in _REVIEW_RECIPROCAL:
        return LICENSE_DECISION_REVIEW, _REASON_REVIEW_RECIPROCAL
    if token in _REFERENCE_ONLY_MARKERS:
        return LICENSE_DECISION_REFERENCE_ONLY, _REASON_REFERENCE_SOURCE_AVAILABLE

    # Heuristic markers for source-available / proprietary phrasing.
    lowered_markers = (
        "PROPRIETARY",
        "COMMERCIAL",
        "ELV2",
        "ELASTIC",
        "SOURCE-AVAILABLE",
        "FAIR-CODE",
        "FAIR-SOURCE",
        "BUSL",
        "SSPL",
    )
    for marker in lowered_markers:
        if marker in token:
            return LICENSE_DECISION_REFERENCE_ONLY, _REASON_REFERENCE_SOURCE_AVAILABLE

    reciprocal_markers = ("MPL", "GPL", "LGPL", "AGPL", "COPYLEFT")
    for marker in reciprocal_markers:
        if marker in token:
            return LICENSE_DECISION_REVIEW, _REASON_REVIEW_RECIPROCAL

    if token in {"UNKNOWN", "NONE", "N/A", "NA", "NULL"}:
        return LICENSE_DECISION_REFERENCE_ONLY, _REASON_REFERENCE_UNKNOWN

    # Unrecognized identifier → no direct import (REFERENCE_ONLY).
    return LICENSE_DECISION_REFERENCE_ONLY, _REASON_REFERENCE_UNCLEAR


def evaluate_license_policy(
    *,
    license_value: str | LicenseMetadata | dict[str, Any] | None = None,
    upstream_provenance: UpstreamProvenance | Mapping[str, Any] | None = None,
    source_evidence: Any = None,
    spoofed_fields_ignored: Iterable[str] = (),
    config: LicensePolicyConfig | None = None,
) -> LicensePolicyResult:
    """Compute platform-derived license decision from declared metadata only."""

    cfg = config or LicensePolicyConfig()
    declared = extract_declared_provenance(
        license_value=license_value,
        upstream_provenance=upstream_provenance,
        source_evidence=source_evidence,
    )
    spoofed = tuple(spoofed_fields_ignored)

    identifier = declared.license_identifier
    if not identifier:
        reason_suffix = (
            f" (ignored spoofed fields: {', '.join(spoofed)})" if spoofed else ""
        )
        return LicensePolicyResult(
            decision=LICENSE_DECISION_REFERENCE_ONLY,
            decision_code=_REASON_REFERENCE_UNKNOWN,
            decision_reason=(
                "Missing or unknown license: no direct content import; "
                "REFERENCE_ONLY by default."
                + reason_suffix
            ),
            declared=declared,
            spoofed_fields_ignored=spoofed,
        )

    # Compound SPDX expressions with AND/OR are treated as unclear unless the
    # entire string normalizes to a known single-token allow/review set.
    raw_upper = identifier.strip().upper()
    if " AND " in raw_upper or " OR " in raw_upper or " WITH " in raw_upper:
        token = _normalize_license_token(identifier)
        # Still try exact single-token sets after removing spaces.
        if token not in _ALLOW_CANDIDATES and token not in _REVIEW_RECIPROCAL:
            return LicensePolicyResult(
                decision=LICENSE_DECISION_REFERENCE_ONLY,
                decision_code=_REASON_REFERENCE_UNCLEAR,
                decision_reason=(
                    "License expression is unclear for automated gate; "
                    "REFERENCE_ONLY (product decision, not legal advice)."
                ),
                declared=declared,
                spoofed_fields_ignored=spoofed,
            )

    token = _normalize_license_token(identifier)
    decision, code = _classify_normalized_token(token, cfg)

    if decision == LICENSE_DECISION_ALLOW:
        reason = (
            f"License {identifier!r} is an ALLOW candidate subject to required "
            "attribution/notice metadata. Product decision only — not legal approval, "
            "Verified, or Official trust."
        )
    elif decision == LICENSE_DECISION_REVIEW:
        reason = (
            f"License {identifier!r} requires REVIEW before direct content import "
            "(reciprocal or uncertain reusable terms)."
        )
    elif decision == LICENSE_DECISION_DENY:
        reason = (
            f"License {identifier!r} is DENY by explicit platform policy configuration."
        )
    else:
        reason = (
            f"License {identifier!r} is REFERENCE_ONLY by default "
            "(source-available, proprietary, unclear, or non-reusable terms)."
        )

    if spoofed:
        reason = f"{reason} [{_REASON_SPOOF_IGNORED}: {', '.join(spoofed)}]"

    return LicensePolicyResult(
        decision=decision,
        decision_code=code,
        decision_reason=reason,
        declared=declared,
        spoofed_fields_ignored=spoofed,
    )


def evaluate_manifest_license_policy(
    manifest: ConnectorManifest,
    *,
    spoofed_fields_ignored: Iterable[str] = (),
    config: LicensePolicyConfig | None = None,
) -> LicensePolicyResult:
    """Evaluate license policy against a parsed ConnectorManifest."""

    return evaluate_license_policy(
        license_value=manifest.license,
        upstream_provenance=manifest.upstream_provenance,
        source_evidence=manifest.source_evidence,
        spoofed_fields_ignored=spoofed_fields_ignored,
        config=config,
    )


def evaluate_raw_manifest_license_policy(
    raw: Mapping[str, Any],
    *,
    config: LicensePolicyConfig | None = None,
) -> LicensePolicyResult:
    """Evaluate license policy from a raw manifest dict (strips spoofed fields)."""

    cleaned, ignored = strip_spoofed_license_decision_fields(dict(raw))
    return evaluate_license_policy(
        license_value=cleaned.get("license"),  # type: ignore[arg-type]
        upstream_provenance=cleaned.get("upstream_provenance"),  # type: ignore[arg-type]
        source_evidence=cleaned.get("source_evidence"),
        spoofed_fields_ignored=ignored,
        config=config,
    )
