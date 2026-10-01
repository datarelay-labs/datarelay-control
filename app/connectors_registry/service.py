"""In-memory Connector Registry cache and catalog helpers."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from app.connectors_registry.errors import RegistryError, ValidationIssue
from app.connectors_registry.loader import connectors_root, load_connector_modules
from app.connectors_registry.migration import (
    LEGACY_CATALOG_ENTRIES,
    MODULE_LEGACY_TEMPLATE,
    build_migration_matrix,
    classify_migration_status,
    validate_migration_completeness,
    vendor_migration_label,
)
from app.connectors_registry.models import ConnectorModuleEntry, RegistryLoadResult
from app.connectors_registry.roots import builtin_connectors_root, installed_plugins_root, repo_root
from app.connectors_registry.schemas import (
    ConnectorRegistryDetail,
    ConnectorRegistryReloadResponse,
    ConnectorRegistryResourcesRead,
    ConnectorRegistrySummary,
    ConnectorValidationErrorRead,
    ResolvedConnectorRead,
)

logger = logging.getLogger(__name__)

_registry_cache: dict[str, ConnectorModuleEntry] | None = None
_registry_issues: list[ValidationIssue] = []
_registry_scan_roots: list[Path] = []
_include_legacy_catalog: bool = False


def _canonical_connectors_root() -> Path:
    """Repository ``connectors/`` path (not monkeypatchable)."""

    return builtin_connectors_root()


def clear_registry_cache() -> None:
    """Reset in-process registry cache (tests)."""

    global _registry_cache, _registry_issues, _registry_scan_roots, _include_legacy_catalog
    _registry_cache = None
    _registry_issues = []
    _registry_scan_roots = []
    _include_legacy_catalog = False


def _issue_to_dict(issue: ValidationIssue) -> dict[str, str | None]:
    return {
        "rule_id": issue.rule_id,
        "message": issue.message,
        "connector_id": issue.connector_id,
        "path": issue.path,
    }


def _issue_to_read(issue: ValidationIssue) -> ConnectorValidationErrorRead:
    return ConnectorValidationErrorRead(
        rule_id=issue.rule_id,
        message=issue.message,
        path=issue.path,
    )


def _relative_repo_path(path: Path) -> str:
    root = repo_root()
    try:
        resolved = path.resolve()
    except OSError:
        resolved = path
    if resolved.is_relative_to(root):
        return str(resolved.relative_to(root))
    return str(path)


def _requires_payload(entry: ConnectorModuleEntry) -> Any | None:
    manifest = entry.manifest
    if manifest is None or manifest.requires is None:
        return None
    if isinstance(manifest.requires, list):
        return [item.model_dump() for item in manifest.requires]
    return manifest.requires.model_dump()


def _entry_summary_fields(entry: ConnectorModuleEntry) -> dict[str, Any]:
    manifest = entry.manifest
    if manifest is not None:
        return {
            "name": manifest.name,
            "vendor": manifest.vendor,
            "version": manifest.version,
            "source_type": manifest.source_type,
            "auth_type": manifest.auth.type,
            "stream_count": len(manifest.streams),
            "capabilities": dict(manifest.capabilities),
            "pack_version": manifest.pack_version,
            "package_id": manifest.package_id,
            "package_kind": manifest.package_kind,
            "installed_from": entry.installed_from,
            "requires": _requires_payload(entry),
        }
    return {
        "name": entry.connector_id,
        "vendor": "—",
        "version": "—",
        "source_type": "—",
        "auth_type": "—",
        "stream_count": entry.resources.summary.streams_count,
        "capabilities": {},
        "pack_version": None,
        "package_id": None,
        "package_kind": None,
        "installed_from": entry.installed_from,
        "requires": None,
    }


def _entry_to_resolved(entry: ConnectorModuleEntry) -> ResolvedConnectorRead:
    fields = _entry_summary_fields(entry)
    manifest = entry.manifest
    auth = manifest.auth if manifest is not None else None
    streams = list(manifest.streams) if manifest is not None else []
    capabilities = dict(manifest.capabilities) if manifest is not None else {}

    if auth is None:
        from app.connectors_registry.models import ConnectorAuthManifest

        auth = ConnectorAuthManifest(type="unknown")

    return ResolvedConnectorRead(
        id=entry.connector_id,
        name=str(fields["name"]),
        vendor=str(fields["vendor"]),
        version=str(fields["version"]),
        source_type=str(fields["source_type"]),
        auth=auth,
        auth_schema=entry.resources.auth_schema,
        streams=streams,
        capabilities=capabilities,
        status=entry.status,
        errors=[_issue_to_read(issue) for issue in entry.errors],
        resources=entry.resources.summary,
        module_dir=_relative_repo_path(entry.module_dir),
        manifest_path=_relative_repo_path(entry.manifest_path),
        manifest=manifest,
        pack_version=fields.get("pack_version"),  # type: ignore[arg-type]
        package_id=fields.get("package_id"),  # type: ignore[arg-type]
        package_kind=fields.get("package_kind"),  # type: ignore[arg-type]
        installed_from=fields.get("installed_from"),  # type: ignore[arg-type]
        requires=fields.get("requires"),
    )


def _apply_load_result(
    result: RegistryLoadResult,
    *,
    scan_roots: list[Path],
    include_legacy_catalog: bool = False,
) -> ConnectorRegistryReloadResponse:
    global _registry_cache, _registry_issues, _registry_scan_roots, _include_legacy_catalog
    _registry_cache = result.modules
    _registry_issues = list(result.issues)
    _registry_scan_roots = list(scan_roots)
    _include_legacy_catalog = include_legacy_catalog
    connector_ids = sorted(result.modules.keys())
    logger.info(
        "%s",
        {
            "stage": "connector_registry_loaded",
            "loaded_count": len(connector_ids),
            "issue_count": len(result.issues),
            "scan_roots": [str(path) for path in scan_roots],
        },
    )
    return ConnectorRegistryReloadResponse(
        loaded_count=len(connector_ids),
        connector_ids=connector_ids,
        issue_count=len(result.issues),
        issues=[_issue_to_dict(i) for i in result.issues],
    )


def _should_include_legacy(*, root: Path | None, builtin_scan_root: Path) -> bool:
    if root is not None:
        return False
    canonical = _canonical_connectors_root().resolve()
    try:
        return builtin_scan_root.resolve() == canonical
    except OSError:
        return False


def bootstrap_registry(
    *,
    root: Path | None = None,
    installed_root: Path | None = None,
) -> ConnectorRegistryReloadResponse:
    """Load connector manifests at process start (builtin + installed roots)."""

    if root is None:
        result = load_connector_modules(root=None, installed_root=installed_root)
        builtin_scan = connectors_root()
        scan_roots = [
            builtin_scan,
            installed_root if installed_root is not None else installed_plugins_root(),
        ]
        include_legacy = _should_include_legacy(root=None, builtin_scan_root=builtin_scan)
    elif installed_root is not None:
        result = load_connector_modules(
            root=root,
            installed_root=installed_root,
            include_installed=True,
        )
        scan_roots = [root, installed_root]
        include_legacy = False
    else:
        # Explicit single-root override (existing tests / tooling).
        result = load_connector_modules(root=root, include_installed=False)
        scan_roots = [root]
        include_legacy = False

    unique_roots: list[Path] = []
    seen: set[str] = set()
    for path in scan_roots:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        unique_roots.append(path)
    return _apply_load_result(
        result,
        scan_roots=unique_roots,
        include_legacy_catalog=include_legacy,
    )


def reload_registry(
    *,
    root: Path | None = None,
    installed_root: Path | None = None,
) -> ConnectorRegistryReloadResponse:
    """Admin-triggered filesystem rescan across configured registry roots."""

    return bootstrap_registry(root=root, installed_root=installed_root)


def _require_cache() -> dict[str, ConnectorModuleEntry]:
    global _registry_cache
    if _registry_cache is None:
        bootstrap_registry()
    assert _registry_cache is not None
    return _registry_cache


def _summary_for_entry(entry: ConnectorModuleEntry) -> ConnectorRegistrySummary:
    mig_issues = validate_migration_completeness(entry)
    migration_status = classify_migration_status(entry)
    return ConnectorRegistrySummary(
        id=entry.connector_id,
        status=entry.status,
        migration_status=migration_status,
        migration_label=vendor_migration_label(entry.connector_id, migration_status),
        legacy_template_id=MODULE_LEGACY_TEMPLATE.get(entry.connector_id),
        error_count=len(entry.errors),
        migration_error_count=len(mig_issues),
        resources=entry.resources.summary,
        **_entry_summary_fields(entry),
    )


def list_connector_summaries() -> list[ConnectorRegistrySummary]:
    """Return stable-sorted catalog summaries including legacy-only entries."""

    cache = _require_cache()
    rows = [_summary_for_entry(entry) for entry in sorted(cache.values(), key=lambda item: item.connector_id)]

    module_ids = set(cache.keys())
    if _include_legacy_catalog:
        for legacy in LEGACY_CATALOG_ENTRIES:
            legacy_id = legacy["id"]
            if legacy_id in module_ids:
                continue
            rows.append(
                ConnectorRegistrySummary(
                    id=legacy_id,
                    name=legacy["name"],
                    vendor=legacy["vendor"],
                    version="—",
                    source_type="HTTP_API_POLLING",
                    auth_type="—",
                    stream_count=0,
                    capabilities={},
                    status="invalid",
                    migration_status="legacy",
                    migration_label="Legacy",
                    legacy_template_id=legacy.get("legacy_template_id"),
                    error_count=0,
                    migration_error_count=0,
                    installed_from="builtin",
                )
            )

    rows.sort(key=lambda item: item.id)
    return rows


def list_migration_matrix() -> list[dict[str, str]]:
    """Return vendor migration matrix for catalog API."""

    cache = _require_cache()
    return build_migration_matrix(cache)


def get_connector_manifest(connector_id: str) -> ConnectorRegistryDetail | None:
    """Return resolved connector detail for one module."""

    cache = _require_cache()
    entry = cache.get(connector_id)
    if entry is None:
        return None
    return ConnectorRegistryDetail(
        id=entry.connector_id,
        resolved=_entry_to_resolved(entry),
    )


def get_connector_resources(connector_id: str) -> ConnectorRegistryResourcesRead | None:
    """Return resolved resource payloads for one connector module."""

    cache = _require_cache()
    entry = cache.get(connector_id)
    if entry is None:
        return None
    return ConnectorRegistryResourcesRead(
        id=entry.connector_id,
        status=entry.status,
        streams=entry.resources.streams,
        mappings=entry.resources.mappings,
        enrichments=entry.resources.enrichments,
        api_test=entry.resources.api_test,
        docs=entry.resources.docs,
        auth_schema=entry.resources.auth_schema,
        resources=entry.resources.summary,
        errors=[_issue_to_read(issue) for issue in entry.errors],
    )


def get_connector_or_raise(connector_id: str) -> ConnectorRegistryDetail:
    """Return manifest detail or raise ``RegistryError``."""

    found = get_connector_manifest(connector_id)
    if found is None:
        raise RegistryError(f"connector module not found: {connector_id}")
    return found


def get_last_load_issues() -> list[ValidationIssue]:
    """Return issues from the most recent registry scan."""

    _require_cache()
    return list(_registry_issues)


def get_registry_scan_roots() -> list[Path]:
    """Return roots used by the most recent registry scan (tests/diagnostics)."""

    _require_cache()
    return list(_registry_scan_roots)
