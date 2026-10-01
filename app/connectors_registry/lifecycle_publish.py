"""Atomic filesystem publish helpers for Marketplace package lifecycle."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from app.connectors_registry.lifecycle_errors import LifecycleError
from app.connectors_registry.roots import installed_plugins_root, is_path_within_root


def lifecycle_state_root(*, installed_root: Path | None = None) -> Path:
    """Return the hidden lifecycle state directory under the installed plugins root."""

    root = installed_root if installed_root is not None else installed_plugins_root()
    return root / ".lifecycle"


def generations_root(*, installed_root: Path | None = None) -> Path:
    return lifecycle_state_root(installed_root=installed_root) / "generations"


def staging_area(*, installed_root: Path | None = None) -> Path:
    path = lifecycle_state_root(installed_root=installed_root) / "staging"
    path.mkdir(parents=True, exist_ok=True)
    return path


def active_package_path(package_id: str, *, installed_root: Path | None = None) -> Path:
    root = installed_root if installed_root is not None else installed_plugins_root()
    safe_id = package_id.strip()
    if not safe_id or "/" in safe_id or "\\" in safe_id or safe_id in {".", ".."}:
        raise LifecycleError(
            f"invalid package_id for filesystem path: {package_id!r}",
            error_code="INVALID_PACKAGE_ID",
        )
    path = root / safe_id
    if not is_path_within_root(path, root):
        raise LifecycleError(
            f"package path escapes installed root: {package_id!r}",
            error_code="INVALID_PACKAGE_ID",
        )
    return path


def generation_path(
    package_id: str,
    pack_version: str,
    *,
    installed_root: Path | None = None,
) -> Path:
    base = generations_root(installed_root=installed_root) / package_id.strip()
    safe_version = pack_version.strip().replace("/", "_").replace("\\", "_")
    if not safe_version or safe_version in {".", ".."}:
        raise LifecycleError(
            f"invalid pack_version for generation path: {pack_version!r}",
            error_code="INVALID_PACK_VERSION",
        )
    return base / safe_version


def _replace_tree(src: Path, dest: Path) -> None:
    """Atomically replace ``dest`` with contents of ``src`` via temp + rename."""

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp_dest = dest.parent / f".publish_tmp_{dest.name}_{os.getpid()}"
    if tmp_dest.exists():
        shutil.rmtree(tmp_dest)
    shutil.copytree(src, tmp_dest, symlinks=False, ignore_dangling_symlinks=True)

    backup: Path | None = None
    if dest.exists():
        backup = dest.parent / f".publish_bak_{dest.name}_{os.getpid()}"
        if backup.exists():
            shutil.rmtree(backup)
        os.rename(dest, backup)

    try:
        os.rename(tmp_dest, dest)
    except OSError:
        if backup is not None and backup.exists() and not dest.exists():
            os.rename(backup, dest)
        if tmp_dest.exists():
            shutil.rmtree(tmp_dest, ignore_errors=True)
        raise

    if backup is not None and backup.exists():
        shutil.rmtree(backup, ignore_errors=True)


def atomic_publish_package(
    package_root: Path,
    *,
    package_id: str,
    installed_root: Path | None = None,
) -> Path:
    """Publish a validated package root into the installed plugins directory."""

    dest = active_package_path(package_id, installed_root=installed_root)
    try:
        _replace_tree(package_root, dest)
    except OSError as exc:
        raise LifecycleError(
            f"atomic publish failed: {exc}",
            error_code="PUBLISH_FAILED",
        ) from exc
    return dest


def preserve_generation(
    *,
    package_id: str,
    pack_version: str,
    source_path: Path,
    installed_root: Path | None = None,
) -> Path:
    """Copy the current active package into the rollback generations store."""

    dest = generation_path(package_id, pack_version, installed_root=installed_root)
    if dest.exists():
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        shutil.copytree(source_path, dest, symlinks=False)
    except OSError as exc:
        raise LifecycleError(
            f"failed to preserve previous generation: {exc}",
            error_code="GENERATION_PRESERVE_FAILED",
        ) from exc
    return dest


def restore_generation(
    *,
    package_id: str,
    pack_version: str,
    installed_root: Path | None = None,
) -> Path:
    """Restore a preserved generation back to the active installed path."""

    source = generation_path(package_id, pack_version, installed_root=installed_root)
    if not source.is_dir():
        raise LifecycleError(
            f"no rollback generation for {package_id!r} version {pack_version!r}",
            error_code="ROLLBACK_UNAVAILABLE",
        )
    return atomic_publish_package(
        source,
        package_id=package_id,
        installed_root=installed_root,
    )


def remove_active_package(package_id: str, *, installed_root: Path | None = None) -> None:
    """Remove the active installed package directory if present."""

    path = active_package_path(package_id, installed_root=installed_root)
    if path.exists():
        shutil.rmtree(path)


def remove_generations(package_id: str, *, installed_root: Path | None = None) -> None:
    """Remove all preserved generations for a package."""

    base = generations_root(installed_root=installed_root) / package_id.strip()
    if base.exists():
        shutil.rmtree(base)
