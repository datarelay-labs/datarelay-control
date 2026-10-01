"""Package dependency (requires) checks for Marketplace install validation."""

from __future__ import annotations

from packaging.specifiers import InvalidSpecifier, SpecifierSet
from packaging.version import InvalidVersion, Version

from app.connectors_registry.lifecycle_errors import LifecycleError
from app.connectors_registry.models import ConnectorManifest, PackageRequirement


def iter_requirements(manifest: ConnectorManifest | None) -> list[PackageRequirement]:
    if manifest is None or manifest.requires is None:
        return []
    if isinstance(manifest.requires, list):
        return list(manifest.requires)
    return [manifest.requires]


def _version_in_specifier(version: str, specifier: str) -> bool:
    try:
        parsed = Version(version)
    except InvalidVersion as exc:
        raise LifecycleError(
            f"installed dependency version is not comparable: {version!r}",
            error_code="DEPENDENCY_VERSION_INVALID",
        ) from exc
    # Charter examples use space-separated ranges ("≥1 <2"); packaging wants commas.
    normalized = ",".join(part for part in specifier.replace(",", " ").split() if part)
    try:
        spec = SpecifierSet(normalized)
    except InvalidSpecifier as exc:
        raise LifecycleError(
            f"invalid dependency version requirement: {specifier!r}",
            error_code="DEPENDENCY_SPEC_INVALID",
        ) from exc
    return parsed in spec


def validate_stream_extension_requires(
    manifest: ConnectorManifest,
    *,
    available_versions: dict[str, str],
) -> None:
    """Reject stream_extension installs with missing/mismatched requires.

    Does not auto-install dependencies.
    """

    if (manifest.package_kind or "source") != "stream_extension":
        return

    requirements = iter_requirements(manifest)
    if not requirements:
        raise LifecycleError(
            "stream_extension package must declare requires",
            error_code="DEPENDENCY_REQUIRED",
        )

    for requirement in requirements:
        required_id = requirement.package_id.strip()
        if not required_id:
            raise LifecycleError(
                "requires.package_id is required",
                error_code="DEPENDENCY_REQUIRED",
            )
        if required_id not in available_versions:
            raise LifecycleError(
                f"required package not installed: {required_id}",
                error_code="DEPENDENCY_MISSING",
                details={"package_id": required_id},
            )
        if requirement.version:
            installed_version = available_versions[required_id]
            if not _version_in_specifier(installed_version, requirement.version):
                raise LifecycleError(
                    (
                        f"required package version mismatch for {required_id}: "
                        f"installed={installed_version!r} requires={requirement.version!r}"
                    ),
                    error_code="DEPENDENCY_VERSION_MISMATCH",
                    details={
                        "package_id": required_id,
                        "installed_version": installed_version,
                        "requires": requirement.version,
                    },
                )
