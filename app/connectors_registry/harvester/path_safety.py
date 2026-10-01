"""Filesystem path safety helpers for untrusted Harvester inputs/outputs."""

from __future__ import annotations

from pathlib import Path


def first_symlink_component(path: Path) -> Path | None:
    """Return the first existing lexical path component that is a symlink."""

    absolute = path.absolute()
    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current = current / part
        if current.is_symlink():
            return current
        if not current.exists():
            break
    return None


def assert_no_symlink_components(path: Path, *, label: str) -> None:
    found = first_symlink_component(path)
    if found is not None:
        raise ValueError(f"{label} must not traverse a symlink: {found}")
