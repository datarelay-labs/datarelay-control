"""Marketplace package validation entry point (M29.4 / M29.5A / M29.5B).

Consolidates M29.1/M29.3 validation used during acquire/install into one path.

Categories covered here (behavior-preserving wrappers / orchestration):

- manifest validation (MAN-001..MAN-013)
- package_id / pack_version identity
- package_kind support
- requires / dependency declaration + stream_extension resolution
- archive structure / package-root resolution
- path safety / duplicate paths / special files (via staged extract caller)
- installed package collision
- platform compatibility metadata shape (parse only)
- M29.5B license/provenance policy (platform-derived; no trust auto-promotion)
- M29.5B declared external URL policy checks (no network fetch)

M29.5A security layers (secret scan, canonical digest, signature verify) run
from the staging/lifecycle path.

Invariant: validators MUST NOT fetch arbitrary URLs. Manifest
``source_evidence`` URLs, auth/token endpoints, Git remotes, and remote
registry URLs are metadata only and are never contacted here. Actual network
acquisition belongs to M29.6 / M29.9 consumers of the shared policy modules.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.connectors_registry.acquisition_url_policy import (
    AcquisitionUrlPolicyError,
    NetworkAcquisitionPolicyConfig,
    looks_like_absolute_url,
    validate_url,
)
from app.connectors_registry.lifecycle_dependencies import validate_stream_extension_requires
from app.connectors_registry.lifecycle_errors import LifecycleError
from app.connectors_registry.license_policy import (
    LicensePolicyResult,
    evaluate_manifest_license_policy,
    strip_spoofed_license_decision_fields,
)
from app.connectors_registry.loader import (
    _MANIFEST_FILENAMES,
    _read_manifest_file,
    _read_yaml_or_json,
)
from app.connectors_registry.models import ConnectorManifest
from app.connectors_registry.normalize import SUPPORTED_PACKAGE_KINDS
from app.connectors_registry.roots import is_path_within_root
from app.connectors_registry.validator import validate_manifest_dict

_RUNTIME_URL_FIELD_NAMES = frozenset(
    {
        "base_url",
        "token_url",
        "oauth2_token_url",
        "authorization_url",
        "auth_url",
        "endpoint_url",
        "issuer_url",
    }
)

_PLATFORM_OWNED_SPOOF_KEYS = (
    "installed_from",
    "origin",
    "trust_tier",
    "validation_status",
    "install_status",
    "signature_status",
    "signing_key_id",
    "digest",
    "signature",
    # M29.5B — license decision is platform-derived only
    "license_decision",
    "license_decision_code",
    "license_decision_reason",
    "platform_license_decision",
    "license_gate",
    "license_gate_decision",
)


@dataclass(frozen=True)
class ValidatedMarketplacePackage:
    """Result of Marketplace package validation against an extracted staging tree."""

    package_root: Path
    manifest_path: Path
    manifest: ConnectorManifest
    package_id: str
    package_kind: str
    pack_version: str
    digest: str
    # Platform-derived license/provenance decision (M29.5B). Never trust-tier.
    license_policy: LicensePolicyResult | None = None


def _reject(code: str, message: str) -> None:
    raise LifecycleError(message, error_code=code)


def _find_package_roots(staging_root: Path) -> list[Path]:
    """Locate package roots that contain a manifest (top-level or single nested dir)."""

    roots: list[Path] = []

    def has_manifest(directory: Path) -> bool:
        return any((directory / name).is_file() for name in _MANIFEST_FILENAMES)

    if has_manifest(staging_root):
        roots.append(staging_root)

    try:
        children = sorted(p for p in staging_root.iterdir() if p.is_dir() and not p.name.startswith("."))
    except OSError:
        children = []

    for child in children:
        if has_manifest(child):
            roots.append(child)

    return roots


def validate_platform_compatibility_metadata(
    raw: dict[str, Any],
    *,
    connector_id: str | None,
    manifest_path: str,
) -> list[str]:
    """Validate optional platform compatibility metadata shape (parse only).

    Returns human-readable issue messages (empty when valid). Does not enforce
    runtime capability matrices — that remains outside M29.4.
    """

    issues: list[str] = []
    for key in ("min_platform_version", "max_platform_version"):
        hint = raw.get(key)
        if hint is not None and (not isinstance(hint, str) or not hint.strip()):
            issues.append(f"{key} must be a non-blank string when set")

    value = raw.get("platform_compatibility")
    if value is None:
        return issues
    if not isinstance(value, dict):
        issues.append("platform_compatibility must be an object")
        return issues

    # Known optional hints when present must be well-typed.
    for key in ("min_platform_version", "max_platform_version"):
        hint = value.get(key)
        if hint is not None and (not isinstance(hint, str) or not hint.strip()):
            issues.append(f"platform_compatibility.{key} must be a non-blank string when set")
    supported = value.get("supported_source_types")
    if supported is not None and not isinstance(supported, list):
        issues.append("platform_compatibility.supported_source_types must be a list when set")
    return issues


def validate_package_identity(manifest: ConnectorManifest) -> tuple[str, str, str]:
    """Require package_id / pack_version / supported package_kind after normalization."""

    package_id = (manifest.package_id or manifest.id or "").strip()
    pack_version = (manifest.pack_version or manifest.version or "").strip()
    package_kind = (manifest.package_kind or "source").strip()
    if not package_id:
        _reject("MANIFEST_INVALID", "package_id is required after normalization")
    if not pack_version:
        _reject("MANIFEST_INVALID", "pack_version is required after normalization")
    if package_kind not in SUPPORTED_PACKAGE_KINDS:
        _reject("MANIFEST_INVALID", f"unsupported package_kind: {package_kind!r}")
    return package_id, package_kind, pack_version


def validate_manifest_resource_paths(package_root: Path, manifest: ConnectorManifest) -> None:
    """Reject manifest resource references that resolve outside the package root."""

    refs: list[tuple[str, str]] = []
    if manifest.auth.schema_ref:
        refs.append(("auth.schema_ref", manifest.auth.schema_ref))
    for index, stream_ref in enumerate(manifest.streams):
        for attr in ("template", "default_mapping", "default_enrichment"):
            value = getattr(stream_ref, attr, None)
            if value:
                refs.append((f"streams[{index}].{attr}", value))

    for field, raw_ref in refs:
        ref = Path(raw_ref)
        candidate = package_root / ref
        if ref.is_absolute() or not is_path_within_root(candidate, package_root):
            _reject(
                "MANIFEST_RESOURCE_ESCAPE",
                f"{field} must resolve inside the package root: {raw_ref!r}",
            )


def collect_runtime_default_urls(
    package_root: Path,
    manifest: ConnectorManifest,
) -> list[str]:
    """Collect URL defaults that can become runtime HTTP/auth targets."""

    schema_ref = manifest.auth.schema_ref
    if not schema_ref:
        return []
    schema_path = package_root / schema_ref
    if not schema_path.is_file():
        return []
    try:
        data = _read_yaml_or_json(schema_path)
    except Exception:
        # Resource parse validity remains owned by the existing registry loader.
        return []
    if not isinstance(data, dict):
        return []

    fields = data.get("fields")
    if not isinstance(fields, list):
        return []

    urls: list[str] = []
    for field in fields:
        if not isinstance(field, dict):
            continue
        name = str(field.get("name") or "").strip().lower().replace("-", "_")
        default = field.get("default")
        if (
            (name in _RUNTIME_URL_FIELD_NAMES or name.endswith("_url"))
            and isinstance(default, str)
            and looks_like_absolute_url(default)
        ):
            urls.append(default.strip())
    return list(dict.fromkeys(urls))


def collect_declared_external_urls(raw: dict[str, Any], manifest: ConnectorManifest) -> list[str]:
    """Collect absolute URLs declared in license/provenance/evidence metadata."""

    urls: list[str] = []
    provenance = raw.get("upstream_provenance")
    if isinstance(provenance, dict):
        upstream_url = provenance.get("upstream_url")
        if isinstance(upstream_url, str) and looks_like_absolute_url(upstream_url):
            urls.append(upstream_url.strip())
        license_source = provenance.get("license_source")
        if isinstance(license_source, str) and looks_like_absolute_url(license_source):
            urls.append(license_source.strip())

    if manifest.upstream_provenance is not None:
        up = manifest.upstream_provenance
        if up.upstream_url and looks_like_absolute_url(up.upstream_url):
            urls.append(up.upstream_url.strip())
        if up.license_source and looks_like_absolute_url(up.license_source):
            urls.append(up.license_source.strip())

    license_value = raw.get("license")
    if isinstance(license_value, dict):
        source = license_value.get("source")
        if isinstance(source, str) and looks_like_absolute_url(source):
            urls.append(source.strip())

    evidence = raw.get("source_evidence")
    if isinstance(evidence, list):
        for item in evidence:
            if not isinstance(item, dict):
                continue
            ref = item.get("ref")
            if isinstance(ref, str) and looks_like_absolute_url(ref):
                urls.append(ref.strip())

    if manifest.source_evidence:
        for item in manifest.source_evidence:
            if item.ref and looks_like_absolute_url(item.ref):
                urls.append(item.ref.strip())

    seen: set[str] = set()
    unique: list[str] = []
    for url in urls:
        if url not in seen:
            seen.add(url)
            unique.append(url)
    return unique


def validate_declared_external_url_policy(
    urls: list[str],
    *,
    config: NetworkAcquisitionPolicyConfig | None = None,
) -> None:
    """Apply acquisition URL policy to declared metadata URLs (no fetch)."""

    cfg = config or NetworkAcquisitionPolicyConfig()
    for url in urls:
        try:
            validate_url(url, config=cfg)
        except AcquisitionUrlPolicyError as exc:
            _reject(
                "DECLARED_URL_POLICY",
                f"declared external URL failed acquisition policy ({exc.code}): {exc.message}",
            )


def validate_extracted_marketplace_package(
    staging_root: Path,
    *,
    digest: str,
    network_policy: NetworkAcquisitionPolicyConfig | None = None,
) -> ValidatedMarketplacePackage:
    """Validate archive structure + manifest for an already-extracted staging tree.

    Callers are responsible for path-safety / duplicate / special-file checks during
    extraction (see ``lifecycle_archive.extract_tar_gz_to_staging``).
    """

    roots = _find_package_roots(staging_root)
    if not roots:
        _reject("MANIFEST_MISSING", "archive does not contain a package manifest")
    if len(roots) > 1:
        _reject(
            "PACKAGE_ROOT_AMBIGUOUS",
            "archive contains multiple package roots with manifests",
        )

    package_root = roots[0]
    manifest_path: Path | None = None
    for name in _MANIFEST_FILENAMES:
        candidate = package_root / name
        if candidate.is_file():
            manifest_path = candidate
            break
    if manifest_path is None:
        _reject("MANIFEST_MISSING", "archive does not contain a package manifest")

    try:
        raw = _read_manifest_file(manifest_path)
    except (OSError, ValueError) as exc:
        _reject("MANIFEST_INVALID", f"manifest parse failed: {exc}")

    # Strip spoofed platform-owned fields before validation/normalization.
    # Track license-decision spoofs before the generic strip so policy reporting
    # can record that a package attempted to self-declare a decision.
    raw, license_spoof_ignored = strip_spoofed_license_decision_fields(raw)
    for spoof_key in _PLATFORM_OWNED_SPOOF_KEYS:
        if spoof_key in raw:
            # Already counted via license strip when overlapping.
            raw.pop(spoof_key, None)

    compat_issues = validate_platform_compatibility_metadata(
        raw,
        connector_id=str(raw.get("id") or "") or None,
        manifest_path=str(manifest_path),
    )
    if compat_issues:
        _reject("MANIFEST_INVALID", "; ".join(compat_issues))

    manifest, issues = validate_manifest_dict(raw, manifest_path=str(manifest_path))
    if issues or manifest is None:
        messages = "; ".join(f"{i.rule_id}: {i.message}" for i in issues) or "manifest invalid"
        _reject("MANIFEST_INVALID", messages)

    assert manifest is not None
    package_id, package_kind, pack_version = validate_package_identity(manifest)
    validate_manifest_resource_paths(package_root, manifest)

    # M29.5B: policy-check declared absolute URLs; never fetch them.
    declared_urls = collect_declared_external_urls(raw, manifest)
    runtime_default_urls = collect_runtime_default_urls(package_root, manifest)
    validate_declared_external_url_policy(
        [*declared_urls, *runtime_default_urls],
        config=network_policy,
    )

    # License decision is platform-derived metadata only; it never auto-promotes
    # trust tiers. Local upload install does not hard-fail on REFERENCE_ONLY —
    # import gates (M29.6+) consume this result.
    license_policy = evaluate_manifest_license_policy(
        manifest,
        spoofed_fields_ignored=license_spoof_ignored,
    )

    return ValidatedMarketplacePackage(
        package_root=package_root,
        manifest_path=manifest_path,
        manifest=manifest,
        package_id=package_id,
        package_kind=package_kind,
        pack_version=pack_version,
        digest=digest,
        license_policy=license_policy,
    )


def validate_marketplace_package(
    staging_root: Path,
    *,
    digest: str,
    network_policy: NetworkAcquisitionPolicyConfig | None = None,
) -> ValidatedMarketplacePackage:
    """Marketplace package validation entry point (M29.4 / M29.5B)."""

    return validate_extracted_marketplace_package(
        staging_root,
        digest=digest,
        network_policy=network_policy,
    )


def validate_install_package_collision(
    *,
    package_id: str,
    builtin_package_ids: set[str],
    existing_installed: bool,
    active_path_exists: bool,
    active_path: str | None = None,
    existing_pack_version: str | None = None,
) -> None:
    """Reject installs that shadow builtins or collide with an installed package."""

    if package_id in builtin_package_ids:
        raise LifecycleError(
            f"cannot install package that shadows builtin package_id={package_id!r}",
            error_code="BUILTIN_SHADOW_FORBIDDEN",
            details={"package_id": package_id},
        )

    if existing_installed:
        raise LifecycleError(
            f"package already installed: {package_id}",
            error_code="PACKAGE_ALREADY_INSTALLED",
            details={"package_id": package_id, "pack_version": existing_pack_version},
        )

    if active_path_exists:
        raise LifecycleError(
            f"package already present on filesystem: {package_id}",
            error_code="PACKAGE_ALREADY_INSTALLED",
            details={"package_id": package_id, "path": active_path},
        )


def validate_package_dependencies(
    manifest: ConnectorManifest,
    *,
    available_versions: dict[str, str],
) -> None:
    """Resolve stream_extension requires against currently available packages."""

    validate_stream_extension_requires(manifest, available_versions=available_versions)
