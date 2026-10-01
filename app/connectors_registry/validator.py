"""Manifest and resource validation rules for Connector Registry."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic import ValidationError

from app.connectors_registry.errors import ValidationIssue
from app.connectors_registry.models import ConnectorManifest, ConnectorModuleResources, DocsMetadata
from app.connectors_registry.normalize import SUPPORTED_PACKAGE_KINDS, normalize_manifest_dict


def _is_blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _nonblank_str(value: Any) -> str | None:
    if _is_blank(value):
        return None
    return str(value).strip()


def _stream_id_from_dict(data: dict[str, Any]) -> str | None:
    for key in ("id", "stream_id"):
        value = data.get(key)
        if not _is_blank(value):
            return str(value).strip()
    return None


def _stream_name_from_dict(data: dict[str, Any]) -> str | None:
    value = data.get("name")
    if not _is_blank(value):
        return str(value).strip()
    return None


def _stream_has_endpoint(data: dict[str, Any]) -> bool:
    if not _is_blank(data.get("source_path")):
        return True
    if not _is_blank(data.get("endpoint")):
        return True
    config_json = data.get("config_json")
    if isinstance(config_json, dict) and not _is_blank(config_json.get("endpoint")):
        return True
    return False


def _validate_source_evidence(
    raw_evidence: Any,
    *,
    connector_id: str | None,
    manifest_path: str,
) -> list[ValidationIssue]:
    """Validate optional source_evidence list shape (specs/049 + Charter)."""

    issues: list[ValidationIssue] = []
    if raw_evidence is None:
        return issues

    if not isinstance(raw_evidence, list):
        issues.append(
            ValidationIssue(
                rule_id="MAN-009",
                message="source_evidence must be a list of evidence objects",
                connector_id=connector_id,
                path=manifest_path,
            )
        )
        return issues

    for index, item in enumerate(raw_evidence):
        if not isinstance(item, dict):
            issues.append(
                ValidationIssue(
                    rule_id="MAN-009",
                    message=f"source_evidence[{index}] must be an object",
                    connector_id=connector_id,
                    path=manifest_path,
                )
            )
            continue
        if _is_blank(item.get("type")):
            issues.append(
                ValidationIssue(
                    rule_id="MAN-009",
                    message=f"source_evidence[{index}].type is required",
                    connector_id=connector_id,
                    path=manifest_path,
                )
            )
        if _is_blank(item.get("ref")):
            issues.append(
                ValidationIssue(
                    rule_id="MAN-009",
                    message=f"source_evidence[{index}].ref is required",
                    connector_id=connector_id,
                    path=manifest_path,
                )
            )
    return issues


def _validate_requires(
    raw_requires: Any,
    *,
    connector_id: str | None,
    manifest_path: str,
) -> list[ValidationIssue]:
    """Validate optional requires dependency declaration shape (parse only)."""

    issues: list[ValidationIssue] = []
    if raw_requires is None:
        return issues

    entries: list[Any]
    if isinstance(raw_requires, dict):
        entries = [raw_requires]
    elif isinstance(raw_requires, list):
        entries = raw_requires
    else:
        issues.append(
            ValidationIssue(
                rule_id="MAN-010",
                message="requires must be an object or list of objects",
                connector_id=connector_id,
                path=manifest_path,
            )
        )
        return issues

    for index, item in enumerate(entries):
        if not isinstance(item, dict):
            issues.append(
                ValidationIssue(
                    rule_id="MAN-010",
                    message=f"requires[{index}] must be an object",
                    connector_id=connector_id,
                    path=manifest_path,
                )
            )
            continue
        if _is_blank(item.get("package_id")):
            issues.append(
                ValidationIssue(
                    rule_id="MAN-010",
                    message=f"requires[{index}].package_id is required",
                    connector_id=connector_id,
                    path=manifest_path,
                )
            )
    return issues


def _validate_license_and_provenance(
    raw: dict[str, Any],
    *,
    connector_id: str | None,
    manifest_path: str,
) -> list[ValidationIssue]:
    """Validate optional license / upstream_provenance shapes (metadata only)."""

    issues: list[ValidationIssue] = []
    license_value = raw.get("license")
    if license_value is not None and not isinstance(license_value, (str, dict)):
        issues.append(
            ValidationIssue(
                rule_id="MAN-011",
                message="license must be a string or object",
                connector_id=connector_id,
                path=manifest_path,
            )
        )
    elif isinstance(license_value, str) and not license_value.strip():
        issues.append(
            ValidationIssue(
                rule_id="MAN-011",
                message="license string must not be blank",
                connector_id=connector_id,
                path=manifest_path,
            )
        )

    provenance = raw.get("upstream_provenance")
    if provenance is not None and not isinstance(provenance, dict):
        issues.append(
            ValidationIssue(
                rule_id="MAN-012",
                message="upstream_provenance must be an object",
                connector_id=connector_id,
                path=manifest_path,
            )
        )
    return issues


def validate_manifest_dict(
    raw: dict[str, Any],
    *,
    manifest_path: str,
) -> tuple[ConnectorManifest | None, list[ValidationIssue]]:
    """Apply MAN-001..MAN-012 then normalize into a canonical ConnectorManifest."""

    issues: list[ValidationIssue] = []
    connector_id = _nonblank_str(raw.get("id"))

    if _is_blank(raw.get("id")):
        issues.append(
            ValidationIssue(
                rule_id="MAN-001",
                message="manifest id is required",
                connector_id=connector_id,
                path=manifest_path,
            )
        )

    if _is_blank(raw.get("vendor")):
        issues.append(
            ValidationIssue(
                rule_id="MAN-002",
                message="manifest vendor is required",
                connector_id=connector_id,
                path=manifest_path,
            )
        )

    streams = raw.get("streams")
    if not isinstance(streams, list) or len(streams) < 1:
        issues.append(
            ValidationIssue(
                rule_id="MAN-003",
                message="manifest must define at least one stream",
                connector_id=connector_id,
                path=manifest_path,
            )
        )

    auth = raw.get("auth")
    if not isinstance(auth, dict) or _is_blank(auth.get("type")):
        issues.append(
            ValidationIssue(
                rule_id="MAN-004",
                message="manifest auth definition with type is required",
                connector_id=connector_id,
                path=manifest_path,
            )
        )

    version = _nonblank_str(raw.get("version"))
    pack_version = _nonblank_str(raw.get("pack_version"))
    if version is None and pack_version is None:
        issues.append(
            ValidationIssue(
                rule_id="MAN-006",
                message="manifest version or pack_version is required",
                connector_id=connector_id,
                path=manifest_path,
            )
        )
    elif version is not None and pack_version is not None and version != pack_version:
        issues.append(
            ValidationIssue(
                rule_id="MAN-007",
                message=(
                    "manifest version and pack_version conflict: "
                    f"version={version!r} pack_version={pack_version!r}"
                ),
                connector_id=connector_id,
                path=manifest_path,
            )
        )

    package_kind = raw.get("package_kind")
    if package_kind is not None and not _is_blank(package_kind):
        kind_text = str(package_kind).strip()
        if kind_text not in SUPPORTED_PACKAGE_KINDS:
            issues.append(
                ValidationIssue(
                    rule_id="MAN-008",
                    message=(
                        f"unsupported package_kind: {kind_text!r} "
                        f"(supported: {', '.join(sorted(SUPPORTED_PACKAGE_KINDS))})"
                    ),
                    connector_id=connector_id,
                    path=manifest_path,
                )
            )

    issues.extend(
        _validate_source_evidence(
            raw.get("source_evidence"),
            connector_id=connector_id,
            manifest_path=manifest_path,
        )
    )
    issues.extend(
        _validate_requires(
            raw.get("requires"),
            connector_id=connector_id,
            manifest_path=manifest_path,
        )
    )
    issues.extend(
        _validate_license_and_provenance(
            raw,
            connector_id=connector_id,
            manifest_path=manifest_path,
        )
    )

    # Do not normalize/parse when revision fields conflict, are missing, or v2
    # metadata shape is invalid. Legacy MAN-001..004 still attempt pydantic parse
    # when an id + revision is present (same as M17.5 behavior).
    hard_block_ids = {"MAN-006", "MAN-007", "MAN-008", "MAN-009", "MAN-010", "MAN-011", "MAN-012"}
    hard_blocked = any(issue.rule_id in hard_block_ids for issue in issues)

    manifest: ConnectorManifest | None = None
    if connector_id is not None and not hard_blocked and (version is not None or pack_version is not None):
        try:
            normalized = normalize_manifest_dict(raw)
            manifest = ConnectorManifest.model_validate(normalized)
        except ValidationError as exc:
            for err in exc.errors():
                issues.append(
                    ValidationIssue(
                        rule_id="MAN-002",
                        message=err.get("msg", "manifest validation failed"),
                        connector_id=connector_id,
                        path=manifest_path,
                    )
                )

    return manifest, issues


def detect_duplicate_ids(
    candidates: list[tuple[str, str]],
) -> tuple[set[str], list[ValidationIssue]]:
    """Apply MAN-005 across all candidate manifests (first path wins)."""

    seen: dict[str, str] = {}
    reject_paths: set[str] = set()
    issues: list[ValidationIssue] = []
    for connector_id, manifest_path in candidates:
        if connector_id in seen:
            reject_paths.add(manifest_path)
            issues.append(
                ValidationIssue(
                    rule_id="MAN-005",
                    message=f"duplicate connector id: {connector_id}",
                    connector_id=connector_id,
                    path=manifest_path,
                )
            )
            continue
        seen[connector_id] = manifest_path
    return reject_paths, issues


def validate_stream_template(
    stream_id: str,
    data: dict[str, Any],
    *,
    connector_id: str,
    path: str,
) -> list[ValidationIssue]:
    """Apply STR-001..STR-003 to a loaded stream template."""

    issues: list[ValidationIssue] = []

    resolved_id = _stream_id_from_dict(data)
    if resolved_id is None:
        issues.append(
            ValidationIssue(
                rule_id="STR-001",
                message="stream id is required",
                connector_id=connector_id,
                path=path,
            )
        )
    elif resolved_id != stream_id:
        issues.append(
            ValidationIssue(
                rule_id="STR-001",
                message=f"stream id mismatch: expected {stream_id}, got {resolved_id}",
                connector_id=connector_id,
                path=path,
            )
        )

    if _stream_name_from_dict(data) is None:
        issues.append(
            ValidationIssue(
                rule_id="STR-002",
                message="stream name is required",
                connector_id=connector_id,
                path=path,
            )
        )

    if not _stream_has_endpoint(data):
        issues.append(
            ValidationIssue(
                rule_id="STR-003",
                message="stream source_path or endpoint definition is required",
                connector_id=connector_id,
                path=path,
            )
        )

    return issues


def validate_mapping_json(
    mapping_id: str,
    data: Any,
    *,
    connector_id: str,
    path: str,
) -> list[ValidationIssue]:
    """Apply MAP-001 to a loaded mapping preset."""

    if not isinstance(data, dict):
        return [
            ValidationIssue(
                rule_id="MAP-001",
                message=f"mapping must be a JSON object: {mapping_id}",
                connector_id=connector_id,
                path=path,
            )
        ]
    return []


def validate_enrichment_json(
    enrichment_id: str,
    data: Any,
    *,
    connector_id: str,
    path: str,
) -> list[ValidationIssue]:
    """Apply ENR-001 to a loaded enrichment preset."""

    if not isinstance(data, dict):
        return [
            ValidationIssue(
                rule_id="ENR-001",
                message=f"enrichment must be a JSON object: {enrichment_id}",
                connector_id=connector_id,
                path=path,
            )
        ]
    return []


def validate_api_test_yaml(
    data: Any,
    *,
    connector_id: str,
    path: str,
) -> list[ValidationIssue]:
    """Apply API-001 to a loaded api_test.yaml document."""

    if not isinstance(data, dict):
        return [
            ValidationIssue(
                rule_id="API-001",
                message="api_test.yaml root must be an object",
                connector_id=connector_id,
                path=path,
            )
        ]
    return []


def extract_docs_metadata(docs_path: Path, *, relative_path: str) -> DocsMetadata:
    """Build docs metadata without returning full raw markdown."""

    text = docs_path.read_text(encoding="utf-8")
    lines = text.splitlines()
    title: str | None = None
    summary: str | None = None

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            title = stripped.lstrip("#").strip()
            break

    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        summary = stripped[:200]
        break

    return DocsMetadata(
        path=relative_path,
        title=title,
        summary=summary,
        line_count=len(lines),
    )


def build_resources_summary(resources: ConnectorModuleResources) -> ConnectorModuleResources:
    """Recompute summary counts from loaded resource payloads."""

    resources.summary = resources.summary.model_copy(
        update={
            "streams_count": len(resources.streams),
            "mappings_count": len(resources.mappings),
            "enrichments_count": len(resources.enrichments),
            "has_api_test": resources.api_test is not None,
            "has_docs": resources.docs is not None,
        }
    )
    return resources
