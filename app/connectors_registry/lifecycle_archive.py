"""Safe local ``.tar.gz`` archive acquisition and staging for Marketplace installs."""

from __future__ import annotations

import hashlib
import os
import shutil
import stat
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from app.connectors_registry.lifecycle_errors import LifecycleError
from app.connectors_registry.models import ConnectorManifest
from app.connectors_registry.package_validator import validate_marketplace_package

_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024  # 64 MiB
_MAX_MEMBER_COUNT = 10_000
_MAX_TOTAL_UNCOMPRESSED = 256 * 1024 * 1024  # 256 MiB


@dataclass(frozen=True)
class StagedPackage:
    """Validated package extracted into a temporary staging directory."""

    staging_root: Path
    package_root: Path
    manifest_path: Path
    manifest: ConnectorManifest
    package_id: str
    package_kind: str
    pack_version: str
    digest: str


def compute_archive_digest(data: bytes) -> str:
    """Return a stable sha256 digest for an uploaded archive."""

    return hashlib.sha256(data).hexdigest()


def _is_within_directory(path: Path, directory: Path) -> bool:
    try:
        path.resolve().relative_to(directory.resolve())
        return True
    except (ValueError, OSError):
        return False


def _reject(code: str, message: str) -> None:
    raise LifecycleError(message, error_code=code)


def _validate_member_name(name: str, *, staging_root: Path) -> Path:
    if not name or name.strip() != name:
        _reject("ARCHIVE_UNSAFE_PATH", f"archive member has unsafe name: {name!r}")
    if name.startswith("/") or name.startswith("\\"):
        _reject("ARCHIVE_ABSOLUTE_PATH", f"archive member has absolute path: {name!r}")
    # Windows-style drive paths
    if len(name) >= 2 and name[1] == ":":
        _reject("ARCHIVE_ABSOLUTE_PATH", f"archive member has absolute path: {name!r}")
    normalized = Path(name)
    if ".." in normalized.parts:
        _reject("ARCHIVE_PATH_TRAVERSAL", f"archive member escapes via ..: {name!r}")
    target = (staging_root / normalized).resolve()
    if not _is_within_directory(target, staging_root) and target != staging_root.resolve():
        _reject("ARCHIVE_ROOT_ESCAPE", f"archive member escapes staging root: {name!r}")
    return staging_root / normalized


def _member_is_regular_file(member: tarfile.TarInfo) -> bool:
    return member.isreg() or member.isfile()


def _member_is_dir(member: tarfile.TarInfo) -> bool:
    return member.isdir()


def extract_tar_gz_to_staging(archive_bytes: bytes, *, staging_parent: Path | None = None) -> Path:
    """Extract a ``.tar.gz`` archive into a new staging directory with safety checks.

    Returns the staging directory path. Caller owns cleanup.
    """

    if not archive_bytes:
        _reject("ARCHIVE_EMPTY", "archive is empty")
    if len(archive_bytes) > _MAX_ARCHIVE_BYTES:
        _reject("ARCHIVE_TOO_LARGE", f"archive exceeds {_MAX_ARCHIVE_BYTES} bytes")

    staging_parent = staging_parent or Path(tempfile.gettempdir())
    staging_parent.mkdir(parents=True, exist_ok=True)
    staging_root = Path(tempfile.mkdtemp(prefix="m29_stage_", dir=str(staging_parent)))

    try:
        import io

        with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as tar:
            members = tar.getmembers()
            if len(members) > _MAX_MEMBER_COUNT:
                _reject("ARCHIVE_TOO_MANY_FILES", f"archive exceeds {_MAX_MEMBER_COUNT} members")

            seen_targets: set[str] = set()
            total_size = 0
            for member in members:
                name = member.name
                target = _validate_member_name(name, staging_root=staging_root)
                target_key = str(target.resolve()) if target.exists() else str(target)
                # Normalize key relative to staging for duplicate detection
                rel_key = str(Path(name).as_posix()).rstrip("/")
                if rel_key in seen_targets:
                    _reject("ARCHIVE_DUPLICATE_TARGET", f"duplicate archive target: {name!r}")
                seen_targets.add(rel_key)

                if member.issym() or member.islnk():
                    _reject(
                        "ARCHIVE_LINK_ESCAPE",
                        f"symlink/hardlink members are not allowed: {name!r}",
                    )
                if member.isdev() or member.isfifo() or member.ischr() or member.isblk():
                    _reject(
                        "ARCHIVE_SPECIAL_FILE",
                        f"device/special files are not allowed: {name!r}",
                    )
                if not (_member_is_regular_file(member) or _member_is_dir(member)):
                    _reject(
                        "ARCHIVE_SPECIAL_FILE",
                        f"unsupported archive member type: {name!r}",
                    )

                if _member_is_regular_file(member):
                    size = int(member.size or 0)
                    if size < 0:
                        _reject("ARCHIVE_INVALID", f"negative size for member: {name!r}")
                    total_size += size
                    if total_size > _MAX_TOTAL_UNCOMPRESSED:
                        _reject(
                            "ARCHIVE_TOO_LARGE",
                            f"uncompressed size exceeds {_MAX_TOTAL_UNCOMPRESSED} bytes",
                        )

                # Extract one member at a time with destination bound checks.
                try:
                    tar.extract(member, path=staging_root, set_attrs=False, filter="data")
                except TypeError:
                    # Older tarfile without filter= support.
                    tar.extract(member, path=staging_root, set_attrs=False)

                # Post-extract: refuse if anything landed outside staging (symlink race etc.)
                if target.exists() or target.is_symlink():
                    if target.is_symlink():
                        _reject("ARCHIVE_LINK_ESCAPE", f"extracted symlink not allowed: {name!r}")
                    if not _is_within_directory(target, staging_root) and target.resolve() != staging_root.resolve():
                        _reject("ARCHIVE_ROOT_ESCAPE", f"extracted path escapes staging: {name!r}")
                    # Hardlink / unexpected mode checks
                    mode = target.lstat().st_mode
                    if stat.S_ISLNK(mode):
                        _reject("ARCHIVE_LINK_ESCAPE", f"extracted symlink not allowed: {name!r}")
                    if stat.S_ISCHR(mode) or stat.S_ISBLK(mode) or stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode):
                        _reject("ARCHIVE_SPECIAL_FILE", f"extracted special file not allowed: {name!r}")

        return staging_root
    except LifecycleError:
        shutil.rmtree(staging_root, ignore_errors=True)
        raise
    except tarfile.TarError as exc:
        shutil.rmtree(staging_root, ignore_errors=True)
        _reject("ARCHIVE_MALFORMED", f"malformed tar.gz archive: {exc}")
    except OSError as exc:
        shutil.rmtree(staging_root, ignore_errors=True)
        _reject("ARCHIVE_EXTRACT_FAILED", f"archive extraction failed: {exc}")
    return staging_root  # pragma: no cover


def resolve_and_validate_staged_package(staging_root: Path, *, digest: str) -> StagedPackage:
    """Resolve a unique package root under staging via Marketplace package validator."""

    validated = validate_marketplace_package(staging_root, digest=digest)
    return StagedPackage(
        staging_root=staging_root,
        package_root=validated.package_root,
        manifest_path=validated.manifest_path,
        manifest=validated.manifest,
        package_id=validated.package_id,
        package_kind=validated.package_kind,
        pack_version=validated.pack_version,
        digest=validated.digest,
    )


def stage_archive_bytes(archive_bytes: bytes, *, staging_parent: Path | None = None) -> StagedPackage:
    """Acquire → extract → validate a local ``.tar.gz`` package archive."""

    digest = compute_archive_digest(archive_bytes)
    staging_root = extract_tar_gz_to_staging(archive_bytes, staging_parent=staging_parent)
    try:
        return resolve_and_validate_staged_package(staging_root, digest=digest)
    except Exception:
        shutil.rmtree(staging_root, ignore_errors=True)
        raise


def read_upload_bytes(upload: BinaryIO, *, max_bytes: int = _MAX_ARCHIVE_BYTES) -> bytes:
    """Read an upload stream with a hard size limit."""

    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = upload.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            _reject("ARCHIVE_TOO_LARGE", f"archive exceeds {max_bytes} bytes")
        chunks.append(chunk)
    return b"".join(chunks)


def cleanup_staging(staged: StagedPackage | Path) -> None:
    """Remove a staging directory tree."""

    root = staged.staging_root if isinstance(staged, StagedPackage) else staged
    shutil.rmtree(root, ignore_errors=True)
