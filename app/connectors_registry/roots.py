"""Unified Connector Registry root resolution (builtin + installed)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from app.config import settings

RegistryOrigin = Literal["builtin", "installed"]


@dataclass(frozen=True)
class RegistryRoot:
    """One configured filesystem package root."""

    origin: RegistryOrigin
    path: Path


def repo_root() -> Path:
    """Absolute path to the repository root."""

    return Path(__file__).resolve().parent.parent.parent


def builtin_connectors_root() -> Path:
    """Product-owned built-in package root (``connectors/``)."""

    return repo_root() / "connectors"


def resolve_configured_path(raw: str) -> Path:
    """Resolve a configured path; relative values are anchored at the repo root."""

    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        candidate = repo_root() / candidate
    return candidate


def installed_plugins_root(*, configured: str | None = None) -> Path:
    """Marketplace-managed installed package root (``GDC_PLUGINS_DIR``)."""

    raw = configured if configured is not None else settings.GDC_PLUGINS_DIR
    return resolve_configured_path(raw)


def default_registry_roots(
    *,
    builtin_root: Path | None = None,
    installed_root: Path | None = None,
) -> list[RegistryRoot]:
    """Return the canonical multi-root scan order: builtin then installed."""

    return [
        RegistryRoot(origin="builtin", path=(builtin_root or builtin_connectors_root())),
        RegistryRoot(origin="installed", path=(installed_root or installed_plugins_root())),
    ]


def is_path_within_root(path: Path, root: Path) -> bool:
    """Return True when ``path`` resolves inside ``root`` (blocks symlink escape)."""

    try:
        resolved_path = path.resolve()
        resolved_root = root.resolve()
    except OSError:
        return False
    if resolved_path == resolved_root:
        return True
    try:
        resolved_path.relative_to(resolved_root)
        return True
    except ValueError:
        return False
