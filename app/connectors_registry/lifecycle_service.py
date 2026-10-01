"""Marketplace package lifecycle: install / upgrade / rollback / uninstall."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import BinaryIO

from sqlalchemy.orm import Session

from app.connectors_registry.lifecycle_archive import (
    StagedPackage,
    cleanup_staging,
    read_upload_bytes,
    stage_archive_bytes,
)
from app.connectors_registry.lifecycle_dependencies import validate_stream_extension_requires
from app.connectors_registry.lifecycle_errors import LifecycleError
from app.connectors_registry.lifecycle_models import (
    LIFECYCLE_ORIGIN_UPLOAD,
    LIFECYCLE_STATUS_INSTALLED,
    LIFECYCLE_STATUS_REMOVED,
    MarketplacePackageInstall,
)
from app.connectors_registry.lifecycle_provenance import streams_depending_on_package
from app.connectors_registry.lifecycle_publish import (
    active_package_path,
    atomic_publish_package,
    preserve_generation,
    remove_active_package,
    remove_generations,
    restore_generation,
    staging_area,
)
from app.connectors_registry.lifecycle_schemas import (
    MarketplacePackageInstallRead,
    MarketplacePackageListResponse,
)
from app.connectors_registry.roots import builtin_connectors_root, installed_plugins_root
from app.connectors_registry.service import list_connector_summaries, reload_registry
from app.database import utcnow

logger = logging.getLogger(__name__)


def _row_to_read(row: MarketplacePackageInstall) -> MarketplacePackageInstallRead:
    return MarketplacePackageInstallRead(
        package_id=row.package_id,
        package_kind=row.package_kind,
        pack_version=row.pack_version,
        origin=row.origin,
        status=row.status,
        digest=row.digest,
        installed_path=row.installed_path,
        previous_version=row.previous_version,
        previous_digest=row.previous_digest,
        installed_at=row.installed_at,
        updated_at=row.updated_at,
    )


def list_installed_packages(db: Session) -> MarketplacePackageListResponse:
    rows = (
        db.query(MarketplacePackageInstall)
        .filter(MarketplacePackageInstall.status == LIFECYCLE_STATUS_INSTALLED)
        .order_by(MarketplacePackageInstall.package_id.asc())
        .all()
    )
    packages = [_row_to_read(row) for row in rows]
    return MarketplacePackageListResponse(packages=packages, count=len(packages))


def _get_row(db: Session, package_id: str) -> MarketplacePackageInstall | None:
    return (
        db.query(MarketplacePackageInstall)
        .filter(MarketplacePackageInstall.package_id == package_id)
        .first()
    )


def _builtin_package_ids(*, builtin_root: Path | None = None) -> set[str]:
    root = builtin_root if builtin_root is not None else builtin_connectors_root()
    ids: set[str] = set()
    if not root.is_dir():
        return ids
    for child in root.iterdir():
        if child.is_dir() and not child.name.startswith("."):
            ids.add(child.name)
    return ids


def _available_package_versions(
    db: Session,
    *,
    builtin_root: Path | None = None,
    installed_root: Path | None = None,
) -> dict[str, str]:
    """Map package_id → pack_version for currently available packages."""

    versions: dict[str, str] = {}

    # Builtin packages: directory name == package_id (normalized).
    root = builtin_root if builtin_root is not None else builtin_connectors_root()
    if root.is_dir():
        from app.connectors_registry.loader import _MANIFEST_FILENAMES, _read_manifest_file
        from app.connectors_registry.normalize import normalize_manifest_dict

        for child in root.iterdir():
            if not child.is_dir() or child.name.startswith("."):
                continue
            for name in _MANIFEST_FILENAMES:
                path = child / name
                if not path.is_file():
                    continue
                try:
                    raw = normalize_manifest_dict(_read_manifest_file(path))
                except (OSError, ValueError):
                    break
                package_id = str(raw.get("package_id") or child.name).strip()
                pack_version = str(raw.get("pack_version") or raw.get("version") or "").strip()
                if package_id and pack_version:
                    versions[package_id] = pack_version
                    versions[child.name] = pack_version
                break

    # Installed lifecycle rows override / extend.
    rows = (
        db.query(MarketplacePackageInstall)
        .filter(MarketplacePackageInstall.status == LIFECYCLE_STATUS_INSTALLED)
        .all()
    )
    for row in rows:
        versions[row.package_id] = row.pack_version

    # Also consult in-memory registry when available (covers installed without reload lag).
    try:
        for summary in list_connector_summaries():
            package_id = (summary.package_id or summary.id or "").strip()
            pack_version = (summary.pack_version or summary.version or "").strip()
            if package_id and pack_version and package_id not in versions:
                versions[package_id] = pack_version
            if summary.id and pack_version and summary.id not in versions:
                versions[summary.id] = pack_version
    except Exception:
        pass

    return versions


def _assert_no_install_collision(
    db: Session,
    package_id: str,
    *,
    builtin_root: Path | None = None,
    installed_root: Path | None = None,
) -> None:
    if package_id in _builtin_package_ids(builtin_root=builtin_root):
        raise LifecycleError(
            f"cannot install package that shadows builtin package_id={package_id!r}",
            error_code="BUILTIN_SHADOW_FORBIDDEN",
            details={"package_id": package_id},
        )

    existing = _get_row(db, package_id)
    if existing is not None and existing.status == LIFECYCLE_STATUS_INSTALLED:
        raise LifecycleError(
            f"package already installed: {package_id}",
            error_code="PACKAGE_ALREADY_INSTALLED",
            details={"package_id": package_id, "pack_version": existing.pack_version},
        )

    active = active_package_path(package_id, installed_root=installed_root)
    if active.is_dir():
        raise LifecycleError(
            f"package already present on filesystem: {package_id}",
            error_code="PACKAGE_ALREADY_INSTALLED",
            details={"package_id": package_id, "path": str(active)},
        )


def _stage_from_upload(
    archive: bytes | BinaryIO,
    *,
    installed_root: Path | None = None,
) -> StagedPackage:
    if isinstance(archive, (bytes, bytearray)):
        data = bytes(archive)
    else:
        data = read_upload_bytes(archive)
    parent = staging_area(installed_root=installed_root)
    return stage_archive_bytes(data, staging_parent=parent)


def _reload(*, builtin_root: Path | None, installed_root: Path | None) -> None:
    reload_registry(root=builtin_root, installed_root=installed_root)


def install_package(
    db: Session,
    archive: bytes | BinaryIO,
    *,
    builtin_root: Path | None = None,
    installed_root: Path | None = None,
) -> MarketplacePackageInstallRead:
    """Upload/acquire → validate → install a local ``.tar.gz`` package."""

    installed_root = installed_root if installed_root is not None else installed_plugins_root()
    staged: StagedPackage | None = None
    try:
        staged = _stage_from_upload(archive, installed_root=installed_root)
        _assert_no_install_collision(
            db,
            staged.package_id,
            builtin_root=builtin_root,
            installed_root=installed_root,
        )

        available = _available_package_versions(
            db,
            builtin_root=builtin_root,
            installed_root=installed_root,
        )
        validate_stream_extension_requires(staged.manifest, available_versions=available)

        # Filesystem publish first (no long-held DB transaction around I/O).
        published = atomic_publish_package(
            staged.package_root,
            package_id=staged.package_id,
            installed_root=installed_root,
        )

        try:
            now = utcnow()
            row = _get_row(db, staged.package_id)
            if row is None:
                row = MarketplacePackageInstall(
                    package_id=staged.package_id,
                    package_kind=staged.package_kind,
                    pack_version=staged.pack_version,
                    origin=LIFECYCLE_ORIGIN_UPLOAD,
                    status=LIFECYCLE_STATUS_INSTALLED,
                    digest=staged.digest,
                    installed_path=str(published),
                    previous_version=None,
                    previous_digest=None,
                    installed_at=now,
                    updated_at=now,
                )
                db.add(row)
            else:
                row.package_kind = staged.package_kind
                row.pack_version = staged.pack_version
                row.origin = LIFECYCLE_ORIGIN_UPLOAD
                row.status = LIFECYCLE_STATUS_INSTALLED
                row.digest = staged.digest
                row.installed_path = str(published)
                row.previous_version = None
                row.previous_digest = None
                row.installed_at = now
                row.updated_at = now
            db.commit()
            db.refresh(row)
        except Exception:
            remove_active_package(staged.package_id, installed_root=installed_root)
            db.rollback()
            raise

        _reload(builtin_root=builtin_root, installed_root=installed_root)

        logger.info(
            "%s",
            {
                "stage": "marketplace_package_installed",
                "package_id": row.package_id,
                "pack_version": row.pack_version,
                "origin": row.origin,
                "digest": row.digest,
            },
        )
        return _row_to_read(row)
    except LifecycleError:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise LifecycleError(
            f"install failed: {exc}",
            error_code="INSTALL_FAILED",
        ) from exc
    finally:
        if staged is not None:
            cleanup_staging(staged)


def upgrade_package(
    db: Session,
    package_id: str,
    archive: bytes | BinaryIO,
    *,
    builtin_root: Path | None = None,
    installed_root: Path | None = None,
) -> MarketplacePackageInstallRead:
    """Upgrade an installed package to a different pack_version (catalog only)."""

    installed_root = installed_root if installed_root is not None else installed_plugins_root()
    package_id = package_id.strip()
    staged: StagedPackage | None = None
    preserved = False
    previous_active: Path | None = None

    try:
        row = _get_row(db, package_id)
        if row is None or row.status != LIFECYCLE_STATUS_INSTALLED:
            raise LifecycleError(
                f"package not installed: {package_id}",
                error_code="PACKAGE_NOT_INSTALLED",
            )

        staged = _stage_from_upload(archive, installed_root=installed_root)
        if staged.package_id != package_id:
            raise LifecycleError(
                (
                    f"upgrade package_id mismatch: expected {package_id!r}, "
                    f"archive has {staged.package_id!r}"
                ),
                error_code="PACKAGE_ID_MISMATCH",
            )
        if staged.pack_version == row.pack_version:
            raise LifecycleError(
                f"upgrade requires a different pack_version (current={row.pack_version!r})",
                error_code="SAME_VERSION",
            )

        available = _available_package_versions(
            db,
            builtin_root=builtin_root,
            installed_root=installed_root,
        )
        # During upgrade, treat current package as still available at its current version
        # for other extensions; the package being upgraded uses the new manifest requires.
        validate_stream_extension_requires(staged.manifest, available_versions=available)

        previous_active = active_package_path(package_id, installed_root=installed_root)
        if not previous_active.is_dir():
            raise LifecycleError(
                f"installed package files missing: {package_id}",
                error_code="PACKAGE_FILES_MISSING",
            )

        previous_version = row.pack_version
        previous_digest = row.digest
        preserve_generation(
            package_id=package_id,
            pack_version=previous_version,
            source_path=previous_active,
            installed_root=installed_root,
        )
        preserved = True

        try:
            published = atomic_publish_package(
                staged.package_root,
                package_id=package_id,
                installed_root=installed_root,
            )
        except Exception:
            # Restore previous active from generation if publish failed mid-way.
            if preserved:
                restore_generation(
                    package_id=package_id,
                    pack_version=previous_version,
                    installed_root=installed_root,
                )
            raise

        row.package_kind = staged.package_kind
        row.pack_version = staged.pack_version
        row.origin = LIFECYCLE_ORIGIN_UPLOAD
        row.status = LIFECYCLE_STATUS_INSTALLED
        row.digest = staged.digest
        row.installed_path = str(published)
        row.previous_version = previous_version
        row.previous_digest = previous_digest
        row.updated_at = utcnow()
        db.commit()
        db.refresh(row)

        _reload(builtin_root=builtin_root, installed_root=installed_root)
        return _row_to_read(row)
    except LifecycleError:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise LifecycleError(
            f"upgrade failed: {exc}",
            error_code="UPGRADE_FAILED",
        ) from exc
    finally:
        if staged is not None:
            cleanup_staging(staged)


def rollback_package(
    db: Session,
    package_id: str,
    *,
    builtin_root: Path | None = None,
    installed_root: Path | None = None,
) -> MarketplacePackageInstallRead:
    """Restore the previous successfully installed package generation."""

    installed_root = installed_root if installed_root is not None else installed_plugins_root()
    package_id = package_id.strip()

    try:
        row = _get_row(db, package_id)
        if row is None or row.status != LIFECYCLE_STATUS_INSTALLED:
            raise LifecycleError(
                f"package not installed: {package_id}",
                error_code="PACKAGE_NOT_INSTALLED",
            )
        if not row.previous_version or not row.previous_digest:
            raise LifecycleError(
                f"no previous generation available for rollback: {package_id}",
                error_code="ROLLBACK_UNAVAILABLE",
            )

        previous_version = row.previous_version
        previous_digest = row.previous_digest
        current_version = row.pack_version

        published = restore_generation(
            package_id=package_id,
            pack_version=previous_version,
            installed_root=installed_root,
        )

        row.pack_version = previous_version
        row.digest = previous_digest
        row.installed_path = str(published)
        row.previous_version = None
        row.previous_digest = None
        row.updated_at = utcnow()
        db.commit()
        db.refresh(row)

        # Drop the rolled-away current generation copy if present.
        from app.connectors_registry.lifecycle_publish import generation_path

        abandoned = generation_path(
            package_id,
            current_version,
            installed_root=installed_root,
        )
        if abandoned.exists():
            import shutil

            shutil.rmtree(abandoned, ignore_errors=True)

        _reload(builtin_root=builtin_root, installed_root=installed_root)
        return _row_to_read(row)
    except LifecycleError:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise LifecycleError(
            f"rollback failed: {exc}",
            error_code="ROLLBACK_FAILED",
        ) from exc


def uninstall_package(
    db: Session,
    package_id: str,
    *,
    builtin_root: Path | None = None,
    installed_root: Path | None = None,
) -> MarketplacePackageInstallRead:
    """Uninstall an installed (non-builtin) package when no proven dependencies remain."""

    installed_root = installed_root if installed_root is not None else installed_plugins_root()
    package_id = package_id.strip()

    try:
        if package_id in _builtin_package_ids(builtin_root=builtin_root):
            raise LifecycleError(
                f"builtin package cannot be uninstalled: {package_id}",
                error_code="BUILTIN_UNINSTALL_FORBIDDEN",
            )

        row = _get_row(db, package_id)
        if row is None or row.status != LIFECYCLE_STATUS_INSTALLED:
            raise LifecycleError(
                f"package not installed: {package_id}",
                error_code="PACKAGE_NOT_INSTALLED",
            )

        dependents = streams_depending_on_package(db, package_id)
        if dependents:
            raise LifecycleError(
                (
                    f"uninstall blocked: {len(dependents)} stream(s) materialized "
                    f"from package_id={package_id!r}"
                ),
                error_code="DEPENDENCY_PROTECTED",
                details={
                    "package_id": package_id,
                    "stream_ids": [int(s.id) for s in dependents],
                },
            )

        # Also block when another installed package requires this one.
        other_rows = (
            db.query(MarketplacePackageInstall)
            .filter(
                MarketplacePackageInstall.status == LIFECYCLE_STATUS_INSTALLED,
                MarketplacePackageInstall.package_id != package_id,
            )
            .all()
        )
        if other_rows:
            from app.connectors_registry.loader import load_connector_modules
            from app.connectors_registry.lifecycle_dependencies import iter_requirements

            result = load_connector_modules(
                root=builtin_root,
                installed_root=installed_root,
                include_installed=True,
            )
            for entry in result.modules.values():
                if entry.connector_id == package_id:
                    continue
                for requirement in iter_requirements(entry.manifest):
                    if requirement.package_id.strip() == package_id:
                        raise LifecycleError(
                            (
                                f"uninstall blocked: package {entry.connector_id!r} "
                                f"requires {package_id!r}"
                            ),
                            error_code="DEPENDENCY_PROTECTED",
                            details={
                                "package_id": package_id,
                                "dependent_package_id": entry.connector_id,
                            },
                        )

        remove_active_package(package_id, installed_root=installed_root)
        remove_generations(package_id, installed_root=installed_root)

        row.status = LIFECYCLE_STATUS_REMOVED
        row.installed_path = ""
        row.previous_version = None
        row.previous_digest = None
        row.updated_at = utcnow()
        db.commit()
        db.refresh(row)

        _reload(builtin_root=builtin_root, installed_root=installed_root)
        return _row_to_read(row)
    except LifecycleError:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise LifecycleError(
            f"uninstall failed: {exc}",
            error_code="UNINSTALL_FAILED",
        ) from exc
