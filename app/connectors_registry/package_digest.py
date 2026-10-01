"""Canonical Marketplace package digest (M29.5A).

Digest is computed from package *content* only:

- relative posix paths (deterministic sort)
- file bytes
- signature metadata files are excluded
- archive member timestamps / uid / gid do not affect the digest

Recompressing the same package tree MUST yield the same digest.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

SIGNATURE_METADATA_NAMES = frozenset(
    {
        "signature.json",
        "signature.yaml",
        "signature.yml",
    }
)

DIGEST_ALGORITHM = "sha256"


def is_signature_metadata_path(rel: Path | str) -> bool:
    """Return True when *rel* (package-relative) is signature metadata."""

    path = Path(rel)
    # Only top-level package-root signature metadata is excluded.
    if len(path.parts) != 1:
        return False
    return path.name.lower() in SIGNATURE_METADATA_NAMES


def iter_digest_files(package_root: Path) -> list[Path]:
    """Return regular files under package_root included in the canonical digest."""

    files: list[Path] = []
    if not package_root.is_dir():
        return files
    for path in package_root.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        try:
            rel = path.relative_to(package_root)
        except ValueError:
            continue
        if is_signature_metadata_path(rel):
            continue
        files.append(path)
    files.sort(key=lambda p: p.relative_to(package_root).as_posix())
    return files


def compute_canonical_package_digest(package_root: Path) -> str:
    """Return hex-encoded SHA-256 over sorted (path, content) pairs.

    Format per file (UTF-8 path, posix, no leading ``./``)::

        <path>\\0<content_length_decimal>\\0<content>\\0
    """

    hasher = hashlib.sha256()
    for path in iter_digest_files(package_root):
        rel = path.relative_to(package_root).as_posix()
        content = path.read_bytes()
        hasher.update(rel.encode("utf-8"))
        hasher.update(b"\0")
        hasher.update(str(len(content)).encode("ascii"))
        hasher.update(b"\0")
        hasher.update(content)
        hasher.update(b"\0")
    return hasher.hexdigest()
