"""Build / source identity for API ↔ Scheduler parity checks.

Compatibility note: values may be ``unknown`` when running from a source tree
without a baked image identity. New container builds always write identity.

Identity fields:
- ``git_sha``: commit SHA at build time (not sufficient alone on dirty trees)
- ``git_dirty``: whether the worktree had uncommitted changes at build time
- ``source_digest``: deterministic digest of backend build inputs
- ``built_at`` / ``worktree``: diagnostics
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

_APP_ROOT = Path(__file__).resolve().parent
_REPO_ROOT = _APP_ROOT.parent
_IDENTITY_FILE = _APP_ROOT / "BUILD_IDENTITY.json"

# Paths relative to repository root that participate in SOURCE_DIGEST.
# Keep aligned with docker/Dockerfile.api copy set + build-relevant config.
_BUILD_DIGEST_PATHS: tuple[str, ...] = (
    "app",
    "alembic",
    "alembic.ini",
    "requirements.txt",
    "docker/Dockerfile.api",
)

_SKIP_DIR_NAMES = {
    "__pycache__",
    ".git",
    "node_modules",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "htmlcov",
    "cache",
    "logs",
}


def _env(name: str, default: str = "unknown") -> str:
    value = (os.environ.get(name) or "").strip()
    return value or default


def _collect_digest_files(repo_root: Path) -> list[Path]:
    files: list[Path] = []
    for rel in _BUILD_DIGEST_PATHS:
        target = (repo_root / rel).resolve()
        if target.is_file():
            files.append(target)
            continue
        if not target.is_dir():
            continue
        for path in sorted(target.rglob("*")):
            if not path.is_file():
                continue
            try:
                parts = path.relative_to(repo_root).parts
            except ValueError:
                continue
            if any(part in _SKIP_DIR_NAMES for part in parts):
                continue
            if path.name == "BUILD_IDENTITY.json" or path.suffix == ".pyc":
                continue
            files.append(path)
    return sorted({p.resolve() for p in files})


def compute_build_source_digest(repo_root: Path | None = None) -> str:
    """Deterministic SHA-256 over canonical backend Docker build inputs."""

    root = (repo_root or _REPO_ROOT).resolve()
    hasher = hashlib.sha256()
    for path in _collect_digest_files(root):
        rel = path.relative_to(root).as_posix()
        hasher.update(rel.encode("utf-8"))
        hasher.update(b"\0")
        hasher.update(path.read_bytes())
        hasher.update(b"\0")
    return hasher.hexdigest()


def compute_app_source_digest(app_root: Path | None = None) -> str:
    """Compat helper: digest ``app/`` package, or full build digest for a repo root."""

    root = (app_root or _APP_ROOT).resolve()
    if root.name == "app" and (root / "__init__.py").is_file():
        # Package-only digest used by older callers/tests.
        hasher = hashlib.sha256()
        paths = sorted(
            p
            for p in root.rglob("*")
            if p.is_file()
            and p.name != "BUILD_IDENTITY.json"
            and "__pycache__" not in p.parts
            and p.suffix != ".pyc"
        )
        for path in paths:
            rel = path.relative_to(root).as_posix()
            hasher.update(rel.encode("utf-8"))
            hasher.update(b"\0")
            hasher.update(path.read_bytes())
            hasher.update(b"\0")
        return hasher.hexdigest()
    return compute_build_source_digest(root)


def load_build_identity() -> dict[str, Any]:
    """Return baked identity, falling back to live source digest + env overrides."""

    baked: dict[str, Any] = {}
    if _IDENTITY_FILE.is_file():
        try:
            raw = json.loads(_IDENTITY_FILE.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                baked = raw
        except (OSError, json.JSONDecodeError):
            baked = {}

    live_digest = compute_build_source_digest()
    git_dirty_raw = _env(
        "GDC_BUILD_GIT_DIRTY",
        str(baked.get("git_dirty") if baked.get("git_dirty") is not None else "unknown"),
    )
    if isinstance(baked.get("git_dirty"), bool) and git_dirty_raw in {
        "True",
        "False",
        str(baked.get("git_dirty")),
    }:
        # Prefer env override when explicitly set; otherwise keep baked bool.
        if "GDC_BUILD_GIT_DIRTY" in os.environ and (os.environ.get("GDC_BUILD_GIT_DIRTY") or "").strip():
            lowered = git_dirty_raw.lower()
            if lowered in {"true", "1", "yes", "on"}:
                git_dirty: bool | str = True
            elif lowered in {"false", "0", "no", "off"}:
                git_dirty = False
            else:
                git_dirty = git_dirty_raw
        else:
            git_dirty = bool(baked.get("git_dirty"))
    else:
        lowered = str(git_dirty_raw).lower()
        if lowered in {"true", "1", "yes", "on"}:
            git_dirty = True
        elif lowered in {"false", "0", "no", "off"}:
            git_dirty = False
        else:
            git_dirty = git_dirty_raw

    return {
        "git_sha": _env("GDC_BUILD_GIT_SHA", str(baked.get("git_sha") or "unknown")),
        "git_dirty": git_dirty,
        "source_digest": _env(
            "GDC_BUILD_SOURCE_DIGEST",
            str(baked.get("source_digest") or live_digest),
        ),
        "worktree": _env("GDC_BUILD_WORKTREE", str(baked.get("worktree") or "unknown")),
        "built_at": _env("GDC_BUILD_TIME", str(baked.get("built_at") or "unknown")),
        "live_source_digest": live_digest,
        "route_processing_canonical": True,
        "identity_file_present": _IDENTITY_FILE.is_file(),
    }


def write_build_identity(
    *,
    git_sha: str,
    source_digest: str,
    worktree: str,
    built_at: str,
    git_dirty: bool | str = "unknown",
    destination: Path | None = None,
) -> Path:
    """Write identity JSON (used by image build)."""

    path = destination or _IDENTITY_FILE
    if isinstance(git_dirty, str):
        lowered = git_dirty.strip().lower()
        if lowered in {"true", "1", "yes", "on"}:
            dirty_value: bool | str = True
        elif lowered in {"false", "0", "no", "off"}:
            dirty_value = False
        else:
            dirty_value = git_dirty
    else:
        dirty_value = bool(git_dirty)

    payload = {
        "git_sha": git_sha,
        "git_dirty": dirty_value,
        "source_digest": source_digest,
        "worktree": worktree,
        "built_at": built_at,
        "route_processing_canonical": True,
    }
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path
