"""M17.5.5 vendor preset migration — classification, validation, and legacy fallback."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from app.connectors_registry.errors import ValidationIssue
from app.connectors_registry.models import ConnectorModuleEntry

logger = logging.getLogger(__name__)

MigrationStatus = Literal["module_based", "legacy", "migration_pending"]

# Legacy flat template_id → (module_id, stream_id | None)
LEGACY_TEMPLATE_MAP: dict[str, tuple[str, str | None]] = {
    "crowdstrike_detections_api": ("crowdstrike", "detections"),
    "okta_system_log": ("okta", "system_log"),
    "stellar_cyber_malop_api": ("cybereason", "malop"),
    "stellar_cyber_hunting_api": ("cybereason", "hunting"),
}

# module_id → legacy template_id (first match wins for module-level fallback)
MODULE_LEGACY_TEMPLATE: dict[str, str] = {}
for _template_id, (_module_id, _stream_id) in LEGACY_TEMPLATE_MAP.items():
    MODULE_LEGACY_TEMPLATE.setdefault(_module_id, _template_id)

# Vendors tracked for migration reporting (module_id slug)
MIGRATION_VENDOR_IDS: tuple[str, ...] = (
    "crowdstrike",
    "okta",
    "microsoft_graph",
    "cybereason",
    "sentinelone",
    "wiz",
    "orca",
)

# Legacy-only catalog entries (no connectors/{id}/ directory)
LEGACY_CATALOG_ENTRIES: tuple[dict[str, str], ...] = (
    {
        "id": "generic-http",
        "name": "Generic REST Polling",
        "vendor": "Generic",
        "legacy_template_id": "generic_rest_polling",
    },
    {
        "id": "stellar-cyber",
        "name": "Stellar Cyber (legacy templates)",
        "vendor": "StellarCyber",
        "legacy_template_id": "stellar_cyber_malop_api",
    },
)


def _mapping_stem(path: str | None) -> str | None:
    if not path:
        return None
    return Path(path).stem


def _stream_has_mapping(entry: ConnectorModuleEntry, stream_id: str, stream_ref) -> bool:
    stem = _mapping_stem(stream_ref.default_mapping)
    if stem and stem in entry.resources.mappings:
        return True
    return stream_id in entry.resources.mappings or f"{stream_id}.default" in entry.resources.mappings


def _stream_has_enrichment(entry: ConnectorModuleEntry, stream_id: str, stream_ref) -> bool:
    stem = _mapping_stem(stream_ref.default_enrichment)
    if stem and stem in entry.resources.enrichments:
        return True
    return stream_id in entry.resources.enrichments or f"{stream_id}.default" in entry.resources.enrichments


def validate_migration_completeness(
    entry: ConnectorModuleEntry,
) -> list[ValidationIssue]:
    """Apply MIG-001..MIG-004 migration completeness rules."""

    issues: list[ValidationIssue] = []
    connector_id = entry.connector_id
    manifest = entry.manifest
    resources = entry.resources

    # MIG-001 — module completeness (manifest, auth schema, docs)
    if manifest is None:
        issues.append(
            ValidationIssue(
                rule_id="MIG-001",
                message="module manifest is required for migration completeness",
                connector_id=connector_id,
                path=str(entry.manifest_path),
            )
        )
    else:
        if manifest.auth.schema_ref and resources.auth_schema is None:
            issues.append(
                ValidationIssue(
                    rule_id="MIG-001",
                    message=f"auth schema not loaded: {manifest.auth.schema_ref}",
                    connector_id=connector_id,
                    path=str(entry.module_dir / (manifest.auth.schema_ref or "")),
                )
            )
        if resources.docs is None:
            issues.append(
                ValidationIssue(
                    rule_id="MIG-001",
                    message="docs.md is required for migrated modules",
                    connector_id=connector_id,
                    path=str(entry.module_dir / "docs.md"),
                )
            )

    if manifest is None:
        return issues

    for stream_ref in manifest.streams:
        stream_id = stream_ref.id
        rel_template = stream_ref.template or f"streams/{stream_id}.yaml"
        template_path = str(entry.module_dir / rel_template)

        # MIG-002 — stream template completeness
        if stream_id not in resources.streams:
            issues.append(
                ValidationIssue(
                    rule_id="MIG-002",
                    message=f"stream template not loaded: {stream_id}",
                    connector_id=connector_id,
                    path=template_path,
                )
            )

        # MIG-003 — mapping availability
        if not _stream_has_mapping(entry, stream_id, stream_ref):
            issues.append(
                ValidationIssue(
                    rule_id="MIG-003",
                    message=f"mapping preset not available for stream: {stream_id}",
                    connector_id=connector_id,
                    path=str(entry.module_dir / (stream_ref.default_mapping or f"mappings/{stream_id}.json")),
                )
            )

        # MIG-004 — enrichment availability
        if not _stream_has_enrichment(entry, stream_id, stream_ref):
            issues.append(
                ValidationIssue(
                    rule_id="MIG-004",
                    message=f"enrichment preset not available for stream: {stream_id}",
                    connector_id=connector_id,
                    path=str(entry.module_dir / (stream_ref.default_enrichment or f"enrichments/{stream_id}.json")),
                )
            )

    return issues


def classify_migration_status(
    entry: ConnectorModuleEntry | None,
    *,
    legacy_template_id: str | None = None,
) -> MigrationStatus:
    """Classify a vendor/module for Connector Catalog display."""

    if entry is None:
        return "legacy"

    mig_issues = validate_migration_completeness(entry)
    has_mig_issues = len(mig_issues) > 0
    is_valid = entry.status == "valid" and not has_mig_issues

    if is_valid:
        return "module_based"
    if entry.manifest is not None or entry.module_dir.is_dir():
        return "migration_pending"
    if legacy_template_id:
        return "legacy"
    return "migration_pending"


def vendor_migration_label(module_id: str, status: MigrationStatus) -> str:
    """Human-readable migration matrix label."""

    if status == "module_based":
        return "Migrated"
    if status == "migration_pending":
        return "Partial" if module_id in ("cybereason",) else "Pending"
    return "Legacy"


@dataclass
class PresetResolution:
    """Outcome of module-first preset resolution."""

    source: Literal["module", "legacy"]
    module_id: str | None
    stream_id: str | None
    legacy_template_id: str | None
    mapping: dict[str, Any] | None = None
    enrichment: dict[str, Any] | None = None
    stream_template: dict[str, Any] | None = None


def _load_legacy_template(template_id: str) -> dict[str, Any] | None:
    try:
        from app.templates.registry import get_template

        found = get_template(template_id)
        if found is None:
            return None
        return found.model_dump()
    except Exception:
        return None


def _module_stream_preset(
    entry: ConnectorModuleEntry,
    stream_id: str,
) -> PresetResolution | None:
    manifest = entry.manifest
    if manifest is None:
        return None

    stream_ref = next((s for s in manifest.streams if s.id == stream_id), None)
    if stream_ref is None:
        return None

    stream_template = entry.resources.streams.get(stream_id)
    if stream_template is None:
        return None

    mapping_key = _mapping_stem(stream_ref.default_mapping) or stream_id
    enrichment_key = _mapping_stem(stream_ref.default_enrichment) or stream_id
    mapping = entry.resources.mappings.get(mapping_key)
    if mapping is None:
        mapping = entry.resources.mappings.get(f"{stream_id}.default")
    enrichment = entry.resources.enrichments.get(enrichment_key)
    if enrichment is None:
        enrichment = entry.resources.enrichments.get(f"{stream_id}.default")

    mig_issues = validate_migration_completeness(entry)
    if mig_issues or entry.status != "valid":
        return None

    return PresetResolution(
        source="module",
        module_id=entry.connector_id,
        stream_id=stream_id,
        legacy_template_id=MODULE_LEGACY_TEMPLATE.get(entry.connector_id),
        mapping=mapping,
        enrichment=enrichment,
        stream_template=stream_template,
    )


def resolve_vendor_preset(
    module_id: str,
    stream_id: str,
    *,
    entry: ConnectorModuleEntry | None = None,
) -> PresetResolution | None:
    """Resolve mapping/enrichment/stream preset from the connector module only.

    Compatibility reader for obsolete flat templates is ``resolve_legacy_template_id``
    (explicit legacy template_id reads). Product operation must not silently fall
    back from a present module package to flat templates.
    """

    if entry is not None:
        return _module_stream_preset(entry, stream_id)

    try:
        from app.connectors_registry.service import _require_cache

        cache = _require_cache()
        module_entry = cache.get(module_id)
    except Exception:
        module_entry = None

    if module_entry is not None:
        return _module_stream_preset(module_entry, stream_id)

    # No module package loaded — do not invent legacy fallback here.
    logger.info(
        "%s",
        {
            "stage": "vendor_preset_module_miss",
            "module_id": module_id,
            "stream_id": stream_id,
            "message": "No module preset; use resolve_legacy_template_id for explicit legacy template reads only",
        },
    )
    return None


def resolve_legacy_template_id(template_id: str) -> PresetResolution | None:
    """Compatibility reader for persisted/explicit legacy flat template_id values.

    Prefer module presets when the vendor package exists. Do not use for new writes —
    new connector configuration must use ``connectors/{vendor}/`` modules.
    """

    mapped = LEGACY_TEMPLATE_MAP.get(template_id)
    if mapped is None:
        return None

    module_id, stream_id = mapped
    if stream_id is None:
        return None

    try:
        from app.connectors_registry.service import _require_cache

        cache = _require_cache()
        entry = cache.get(module_id)
    except Exception:
        entry = None

    if entry is not None:
        module_preset = _module_stream_preset(entry, stream_id)
        if module_preset is not None:
            logger.info(
                "%s",
                {
                    "stage": "legacy_template_module_priority",
                    "legacy_template_id": template_id,
                    "module_id": module_id,
                    "stream_id": stream_id,
                    "message": "Module preset preferred over legacy flat template",
                },
            )
            return module_preset

    logger.warning(
        "%s",
        {
            "stage": "legacy_template_compat_read",
            "legacy_template_id": template_id,
            "module_id": module_id,
            "stream_id": stream_id,
            "message": "Compatibility read of legacy flat template; complete connectors/{vendor}/ migration",
        },
    )

    legacy = _load_legacy_template(template_id)
    if legacy is None:
        return None

    return PresetResolution(
        source="legacy",
        module_id=module_id,
        stream_id=stream_id,
        legacy_template_id=template_id,
        mapping=dict(legacy.get("mapping_defaults") or {}),
        enrichment=dict(legacy.get("enrichment_defaults") or {}),
        stream_template=dict(legacy.get("stream_defaults") or {}),
    )


def build_migration_matrix(
    modules: dict[str, ConnectorModuleEntry],
) -> list[dict[str, str]]:
    """Vendor migration matrix for reporting and catalog enrichment."""

    rows: list[dict[str, str]] = []
    for vendor_id in MIGRATION_VENDOR_IDS:
        entry = modules.get(vendor_id)
        status = classify_migration_status(entry)
        label = vendor_migration_label(vendor_id, status)
        legacy_template = MODULE_LEGACY_TEMPLATE.get(vendor_id)
        rows.append(
            {
                "vendor_id": vendor_id,
                "migration_status": status,
                "label": label,
                "legacy_template_id": legacy_template or "",
                "module_status": entry.status if entry else "none",
            }
        )
    return rows
