"""Filesystem discovery and parsing for connector manifests and module resources."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import yaml

from app.connectors_registry.errors import ValidationIssue
from app.connectors_registry.models import (
    ConnectorModuleEntry,
    ConnectorModuleResources,
    ConnectorManifest,
    PackageRequirement,
    RegistryLoadResult,
    RegistryOrigin,
)
from app.connectors_registry.roots import (
    RegistryRoot,
    builtin_connectors_root,
    default_registry_roots,
    is_path_within_root,
)
from app.connectors_registry.validator import (
    build_resources_summary,
    detect_duplicate_ids,
    extract_docs_metadata,
    validate_api_test_yaml,
    validate_enrichment_json,
    validate_manifest_dict,
    validate_mapping_json,
    validate_stream_template,
)

logger = logging.getLogger(__name__)

_MANIFEST_FILENAMES = ("manifest.yaml", "manifest.yml", "manifest.json")


def connectors_root() -> Path:
    """Return absolute path to ``connectors/`` at repository root."""

    return builtin_connectors_root()


def _read_yaml_or_json(path: Path) -> Any:
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        return json.loads(text)
    return yaml.safe_load(text)


def _read_manifest_file(path: Path) -> dict[str, Any]:
    data = _read_yaml_or_json(path)
    if not isinstance(data, dict):
        raise ValueError(f"manifest root must be an object: {path}")
    return data


def _discover_manifest_paths(root: Path) -> list[tuple[Path, Path]]:
    """Discover ``(module_dir, manifest_path)`` pairs constrained to ``root``."""

    if not root.is_dir():
        return []

    found: list[tuple[Path, Path]] = []
    try:
        children = sorted(root.iterdir())
    except OSError as exc:
        logger.error(
            "%s",
            {
                "stage": "connector_registry_root_unreadable",
                "path": str(root),
                "error": str(exc),
            },
        )
        return []

    for child in children:
        if not child.is_dir():
            continue
        if not is_path_within_root(child, root):
            logger.error(
                "%s",
                {
                    "stage": "connector_registry_path_escape",
                    "path": str(child),
                    "root": str(root),
                },
            )
            continue
        for name in _MANIFEST_FILENAMES:
            candidate = child / name
            if not candidate.is_file():
                continue
            if not is_path_within_root(candidate, root):
                logger.error(
                    "%s",
                    {
                        "stage": "connector_registry_path_escape",
                        "path": str(candidate),
                        "root": str(root),
                    },
                )
                break
            found.append((child, candidate))
            break
    return found


def _relative_module_path(module_dir: Path, path: Path) -> str:
    try:
        return str(path.relative_to(module_dir))
    except ValueError:
        return str(path)


def _load_stream_templates(
    module_dir: Path,
    *,
    connector_id: str,
    manifest: ConnectorManifest | None,
) -> tuple[dict[str, dict[str, Any]], list[ValidationIssue]]:
    streams: dict[str, dict[str, Any]] = {}
    issues: list[ValidationIssue] = []

    streams_dir = module_dir / "streams"
    if streams_dir.is_dir():
        for path in sorted(streams_dir.glob("*.yaml")) + sorted(streams_dir.glob("*.yml")):
            stream_id = path.stem
            try:
                data = _read_yaml_or_json(path)
            except (OSError, json.JSONDecodeError, yaml.YAMLError, ValueError) as exc:
                issues.append(
                    ValidationIssue(
                        rule_id="STR-001",
                        message=f"stream parse failed: {exc}",
                        connector_id=connector_id,
                        path=str(path),
                    )
                )
                continue
            if not isinstance(data, dict):
                issues.append(
                    ValidationIssue(
                        rule_id="STR-001",
                        message="stream template root must be an object",
                        connector_id=connector_id,
                        path=str(path),
                    )
                )
                continue
            streams[stream_id] = data
            issues.extend(
                validate_stream_template(
                    stream_id,
                    data,
                    connector_id=connector_id,
                    path=str(path),
                )
            )

    if manifest is not None:
        for stream_ref in manifest.streams:
            if stream_ref.template:
                template_path = module_dir / stream_ref.template
                if not template_path.is_file():
                    issues.append(
                        ValidationIssue(
                            rule_id="STR-003",
                            message=f"stream template not found: {stream_ref.template}",
                            connector_id=connector_id,
                            path=str(template_path),
                        )
                    )
                    continue
                stream_id = stream_ref.id
                if stream_id not in streams:
                    try:
                        data = _read_yaml_or_json(template_path)
                    except (OSError, json.JSONDecodeError, yaml.YAMLError, ValueError) as exc:
                        issues.append(
                            ValidationIssue(
                                rule_id="STR-001",
                                message=f"stream parse failed: {exc}",
                                connector_id=connector_id,
                                path=str(template_path),
                            )
                        )
                        continue
                    if isinstance(data, dict):
                        streams[stream_id] = data
                        issues.extend(
                            validate_stream_template(
                                stream_id,
                                data,
                                connector_id=connector_id,
                                path=str(template_path),
                            )
                        )

    return streams, issues


def _load_json_directory(
    module_dir: Path,
    subdir: str,
    *,
    connector_id: str,
    rule_id: str,
    validator,
) -> tuple[dict[str, dict[str, Any]], list[ValidationIssue]]:
    loaded: dict[str, dict[str, Any]] = {}
    issues: list[ValidationIssue] = []
    target = module_dir / subdir
    if not target.is_dir():
        return loaded, issues

    for path in sorted(target.glob("*.json")):
        resource_id = path.stem
        try:
            data = _read_yaml_or_json(path)
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            issues.append(
                ValidationIssue(
                    rule_id=rule_id,
                    message=f"{subdir} parse failed: {exc}",
                    connector_id=connector_id,
                    path=str(path),
                )
            )
            continue
        loaded[resource_id] = data if isinstance(data, dict) else data  # type: ignore[assignment]
        issues.extend(
            validator(
                resource_id,
                data,
                connector_id=connector_id,
                path=str(path),
            )
        )
    return loaded, issues


def _load_manifest_referenced_json(
    module_dir: Path,
    manifest: ConnectorManifest | None,
    *,
    connector_id: str,
    attr: str,
    rule_id: str,
    validator,
    bucket: dict[str, dict[str, Any]],
) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    if manifest is None:
        return issues

    for stream_ref in manifest.streams:
        rel_path = getattr(stream_ref, attr, None)
        if not rel_path:
            continue
        file_path = module_dir / rel_path
        if not file_path.is_file():
            issues.append(
                ValidationIssue(
                    rule_id=rule_id,
                    message=f"referenced file not found: {rel_path}",
                    connector_id=connector_id,
                    path=str(file_path),
                )
            )
            continue
        resource_id = file_path.stem
        if resource_id in bucket:
            continue
        try:
            data = _read_yaml_or_json(file_path)
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            issues.append(
                ValidationIssue(
                    rule_id=rule_id,
                    message=f"parse failed: {exc}",
                    connector_id=connector_id,
                    path=str(file_path),
                )
            )
            continue
        bucket[resource_id] = data if isinstance(data, dict) else data  # type: ignore[assignment]
        issues.extend(
            validator(
                resource_id,
                data,
                connector_id=connector_id,
                path=str(file_path),
            )
        )
    return issues


def _load_api_test(module_dir: Path, *, connector_id: str) -> tuple[dict[str, Any] | None, list[ValidationIssue]]:
    issues: list[ValidationIssue] = []
    for name in ("api_test.yaml", "api_test.yml"):
        path = module_dir / name
        if not path.is_file():
            continue
        try:
            data = _read_yaml_or_json(path)
        except (OSError, json.JSONDecodeError, yaml.YAMLError, ValueError) as exc:
            issues.append(
                ValidationIssue(
                    rule_id="API-001",
                    message=f"api_test parse failed: {exc}",
                    connector_id=connector_id,
                    path=str(path),
                )
            )
            return None, issues
        issues.extend(validate_api_test_yaml(data, connector_id=connector_id, path=str(path)))
        if isinstance(data, dict):
            return data, issues
        return None, issues
    return None, issues


def _load_docs_metadata(module_dir: Path) -> Any:
    docs_path = module_dir / "docs.md"
    if not docs_path.is_file():
        return None
    return extract_docs_metadata(docs_path, relative_path="docs.md")


def _load_auth_schema(
    module_dir: Path,
    *,
    connector_id: str,
    manifest: ConnectorManifest | None,
) -> tuple[dict[str, Any] | None, list[ValidationIssue]]:
    issues: list[ValidationIssue] = []
    if manifest is None:
        return None, issues

    schema_ref = manifest.auth.schema_ref
    if not schema_ref:
        return None, issues

    schema_path = module_dir / schema_ref
    if not schema_path.is_file():
        issues.append(
            ValidationIssue(
                rule_id="AUT-001",
                message=f"auth schema not found: {schema_ref}",
                connector_id=connector_id,
                path=str(schema_path),
            )
        )
        return None, issues

    try:
        data = _read_yaml_or_json(schema_path)
    except (OSError, json.JSONDecodeError, yaml.YAMLError, ValueError) as exc:
        issues.append(
            ValidationIssue(
                rule_id="AUT-001",
                message=f"auth schema parse failed: {exc}",
                connector_id=connector_id,
                path=str(schema_path),
            )
        )
        return None, issues

    if not isinstance(data, dict):
        issues.append(
            ValidationIssue(
                rule_id="AUT-001",
                message="auth schema root must be an object",
                connector_id=connector_id,
                path=str(schema_path),
            )
        )
        return None, issues

    return data, issues


def _load_module_resources(
    module_dir: Path,
    *,
    connector_id: str,
    manifest: ConnectorManifest | None,
) -> tuple[ConnectorModuleResources, list[ValidationIssue]]:
    issues: list[ValidationIssue] = []
    resources = ConnectorModuleResources()

    streams, stream_issues = _load_stream_templates(
        module_dir,
        connector_id=connector_id,
        manifest=manifest,
    )
    resources.streams = streams
    issues.extend(stream_issues)

    mappings, mapping_issues = _load_json_directory(
        module_dir,
        "mappings",
        connector_id=connector_id,
        rule_id="MAP-001",
        validator=validate_mapping_json,
    )
    resources.mappings = mappings
    issues.extend(mapping_issues)
    issues.extend(
        _load_manifest_referenced_json(
            module_dir,
            manifest,
            connector_id=connector_id,
            attr="default_mapping",
            rule_id="MAP-001",
            validator=validate_mapping_json,
            bucket=resources.mappings,
        )
    )

    enrichments, enrichment_issues = _load_json_directory(
        module_dir,
        "enrichments",
        connector_id=connector_id,
        rule_id="ENR-001",
        validator=validate_enrichment_json,
    )
    resources.enrichments = enrichments
    issues.extend(enrichment_issues)
    issues.extend(
        _load_manifest_referenced_json(
            module_dir,
            manifest,
            connector_id=connector_id,
            attr="default_enrichment",
            rule_id="ENR-001",
            validator=validate_enrichment_json,
            bucket=resources.enrichments,
        )
    )

    api_test, api_issues = _load_api_test(module_dir, connector_id=connector_id)
    resources.api_test = api_test
    issues.extend(api_issues)

    resources.docs = _load_docs_metadata(module_dir)

    auth_schema, auth_schema_issues = _load_auth_schema(
        module_dir,
        connector_id=connector_id,
        manifest=manifest,
    )
    resources.auth_schema = auth_schema
    issues.extend(auth_schema_issues)

    build_resources_summary(resources)
    return resources, issues


def _package_identity(manifest: ConnectorManifest | None, connector_id: str) -> tuple[str, str | None]:
    """Return ``(package_id, pack_version)`` for collision checks."""

    if manifest is None:
        return connector_id, None
    package_id = (manifest.package_id or manifest.id or connector_id).strip() or connector_id
    pack_version = manifest.pack_version or manifest.version
    return package_id, pack_version


def _iter_requires(manifest: ConnectorManifest | None) -> list[PackageRequirement]:
    if manifest is None or manifest.requires is None:
        return []
    if isinstance(manifest.requires, list):
        return list(manifest.requires)
    return [manifest.requires]


def _scan_single_root(
    registry_root: RegistryRoot,
    *,
    result: RegistryLoadResult,
) -> list[tuple[str, ConnectorManifest | None, Path, Path, list[ValidationIssue], RegistryOrigin]]:
    """Parse manifests under one root. Does not yet apply cross-root merges."""

    parsed: list[tuple[str, ConnectorManifest | None, Path, Path, list[ValidationIssue], RegistryOrigin]] = []
    id_paths: list[tuple[str, str]] = []
    escape_issues: list[ValidationIssue] = []

    root = registry_root.path
    if not root.exists():
        return parsed
    if not root.is_dir():
        result.issues.append(
            ValidationIssue(
                rule_id="REG-003",
                message=f"registry root is not a directory: {root}",
                path=str(root),
            )
        )
        return parsed

    discovered = _discover_manifest_paths(root)
    # Surface escape attempts that were skipped during discovery when a symlink
    # child exists but was rejected by the boundary check.
    try:
        for child in sorted(root.iterdir()):
            if child.is_symlink() or child.is_dir():
                if not is_path_within_root(child, root):
                    escape_issues.append(
                        ValidationIssue(
                            rule_id="REG-004",
                            message=(
                                f"package path escapes configured {registry_root.origin} "
                                f"root: {child}"
                            ),
                            path=str(child),
                        )
                    )
    except OSError:
        pass
    if escape_issues:
        result.issues.extend(escape_issues)

    for module_dir, manifest_path in discovered:
        connector_id: str | None = None
        manifest: ConnectorManifest | None = None
        manifest_issues: list[ValidationIssue] = []

        try:
            raw = _read_manifest_file(manifest_path)
        except (OSError, json.JSONDecodeError, yaml.YAMLError, ValueError) as exc:
            issue = ValidationIssue(
                rule_id="MAN-002",
                message=f"manifest parse failed: {exc}",
                connector_id=None,
                path=str(manifest_path),
            )
            result.issues.append(issue)
            logger.error(
                "%s",
                {
                    "stage": "connector_manifest_parse_failed",
                    "path": str(manifest_path),
                    "error": str(exc),
                },
            )
            continue

        # Manifest-declared installed_from is never registry authority.
        connector_id = str(raw.get("id") or "").strip() or None
        manifest, manifest_issues = validate_manifest_dict(raw, manifest_path=str(manifest_path))

        if connector_id is None:
            result.issues.extend(manifest_issues)
            for issue in manifest_issues:
                logger.error(
                    "%s",
                    {
                        "stage": "connector_manifest_invalid",
                        "rule_id": issue.rule_id,
                        "connector_id": issue.connector_id,
                        "path": issue.path,
                        "message": issue.message,
                    },
                )
            continue

        parsed.append(
            (
                connector_id,
                manifest,
                module_dir,
                manifest_path,
                manifest_issues,
                registry_root.origin,
            )
        )
        id_paths.append((connector_id, str(manifest_path)))

    reject_paths, duplicate_issues = detect_duplicate_ids(id_paths)
    if duplicate_issues:
        result.issues.extend(duplicate_issues)
        for issue in duplicate_issues:
            logger.error(
                "%s",
                {
                    "stage": "connector_manifest_duplicate",
                    "rule_id": issue.rule_id,
                    "connector_id": issue.connector_id,
                    "path": issue.path,
                    "message": issue.message,
                },
            )

    return [item for item in parsed if str(item[3]) not in reject_paths]


def _collision_message(
    *,
    package_id: str,
    existing: ConnectorModuleEntry,
    challenger_origin: RegistryOrigin,
    challenger_version: str | None,
) -> str:
    existing_version = None
    if existing.manifest is not None:
        existing_version = existing.manifest.pack_version or existing.manifest.version
    if existing_version == challenger_version and existing_version is not None:
        kind = "duplicate"
    else:
        kind = "ambiguous"
    return (
        f"{kind} package_id={package_id!r} across registry roots: "
        f"existing_origin={existing.installed_from} existing_version={existing_version!r} "
        f"challenger_origin={challenger_origin} challenger_version={challenger_version!r}; "
        "automatic override is forbidden until package lifecycle (M29.3)"
    )


def _apply_dependency_issues(result: RegistryLoadResult) -> None:
    """Flag missing ``requires`` targets in the unified catalog (no install)."""

    known_package_ids: set[str] = set()
    for entry in result.modules.values():
        package_id, _ = _package_identity(entry.manifest, entry.connector_id)
        known_package_ids.add(package_id)
        known_package_ids.add(entry.connector_id)

    for entry in result.modules.values():
        for requirement in _iter_requires(entry.manifest):
            required_id = requirement.package_id.strip()
            if required_id in known_package_ids:
                continue
            issue = ValidationIssue(
                rule_id="DEP-001",
                message=f"missing required package: {required_id}",
                connector_id=entry.connector_id,
                path=str(entry.manifest_path),
            )
            entry.errors.append(issue)
            entry.status = "invalid"
            result.issues.append(issue)


def _finalize_parsed_modules(
    parsed: list[tuple[str, ConnectorManifest | None, Path, Path, list[ValidationIssue], RegistryOrigin]],
    result: RegistryLoadResult,
) -> None:
    """Merge parsed modules with deterministic multi-root collision policy."""

    # Index by connector_id for catalog; also track package_id owners.
    package_owners: dict[str, ConnectorModuleEntry] = {}

    for connector_id, manifest, module_dir, manifest_path, manifest_issues, origin in parsed:
        resources, resource_issues = _load_module_resources(
            module_dir,
            connector_id=connector_id,
            manifest=manifest,
        )
        all_issues = list(manifest_issues) + resource_issues
        status = "valid" if not all_issues else "invalid"

        entry = ConnectorModuleEntry(
            connector_id=connector_id,
            manifest=manifest,
            module_dir=module_dir,
            manifest_path=manifest_path,
            status=status,
            errors=all_issues,
            resources=resources,
            installed_from=origin,
        )
        package_id, pack_version = _package_identity(manifest, connector_id)

        existing_by_id = result.modules.get(connector_id)
        existing_by_package = package_owners.get(package_id)

        conflict_with: ConnectorModuleEntry | None = None
        if existing_by_id is not None:
            conflict_with = existing_by_id
        elif existing_by_package is not None and existing_by_package.connector_id != connector_id:
            conflict_with = existing_by_package

        if conflict_with is not None:
            # Never silent-overwrite. Prefer keeping the first (builtin-first scan order).
            issue = ValidationIssue(
                rule_id="REG-001",
                message=_collision_message(
                    package_id=package_id,
                    existing=conflict_with,
                    challenger_origin=origin,
                    challenger_version=pack_version,
                ),
                connector_id=connector_id,
                path=str(manifest_path),
            )
            result.issues.append(issue)
            logger.error(
                "%s",
                {
                    "stage": "connector_registry_collision",
                    "rule_id": issue.rule_id,
                    "connector_id": connector_id,
                    "package_id": package_id,
                    "path": issue.path,
                    "message": issue.message,
                },
            )
            # Challenger is rejected from catalog (no shadowing).
            continue

        if all_issues:
            result.issues.extend(all_issues)
            for issue in all_issues:
                logger.error(
                    "%s",
                    {
                        "stage": "connector_module_invalid",
                        "rule_id": issue.rule_id,
                        "connector_id": issue.connector_id,
                        "path": issue.path,
                        "message": issue.message,
                    },
                )

        result.modules[connector_id] = entry
        package_owners[package_id] = entry

    _apply_dependency_issues(result)


def load_connector_modules(
    *,
    root: Path | None = None,
    installed_root: Path | None = None,
    include_installed: bool | None = None,
) -> RegistryLoadResult:
    """Scan configured registry roots and build a unified in-memory catalog.

    Compatibility:
    - ``root=None`` (default): scan builtin ``connectors/`` plus installed plugins root.
    - ``root=<path>``: single-root scan (tests / overrides). Installed root is included
      only when ``include_installed=True`` or an explicit ``installed_root`` is passed.
    - Missing or empty installed root is valid and yields no packages from that origin.
    """

    result = RegistryLoadResult()

    if root is None and include_installed is False:
        roots = [RegistryRoot(origin="builtin", path=connectors_root())]
    elif root is not None and include_installed is not True and installed_root is None:
        roots = [RegistryRoot(origin="builtin", path=root)]
    elif root is not None:
        roots = [
            RegistryRoot(origin="builtin", path=root),
            RegistryRoot(
                origin="installed",
                path=installed_root if installed_root is not None else default_registry_roots()[1].path,
            ),
        ]
    else:
        # Use connectors_root() so tests can monkeypatch the builtin root.
        roots = default_registry_roots(
            builtin_root=connectors_root(),
            installed_root=installed_root,
        )

    parsed: list[tuple[str, ConnectorManifest | None, Path, Path, list[ValidationIssue], RegistryOrigin]] = []
    for registry_root in roots:
        parsed.extend(_scan_single_root(registry_root, result=result))

    _finalize_parsed_modules(parsed, result)
    return result
