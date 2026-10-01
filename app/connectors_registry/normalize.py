"""In-memory Manifest v2 normalization (does not rewrite files)."""

from __future__ import annotations

from copy import deepcopy
from typing import Any


SUPPORTED_PACKAGE_KINDS = frozenset({"source", "stream_extension"})
DEFAULT_PACKAGE_KIND = "source"


def _nonblank_str(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def _missing_or_blank(data: dict[str, Any], key: str) -> bool:
    if key not in data or data[key] is None:
        return True
    return isinstance(data[key], str) and not data[key].strip()


def normalize_manifest_dict(raw: dict[str, Any]) -> dict[str, Any]:
    """Return a canonical in-memory manifest dict.

    Rules (M29.1):
    - ``version`` only → ``pack_version = version``
    - ``pack_version`` only → ``version = pack_version`` (API contract)
    - both present and equal → keep both
    - missing ``package_id`` → ``package_id = id``
    - missing ``package_kind`` → ``package_kind = source``

    Does not fabricate ``api_version``, ``source_evidence``, ``license``,
    ``requires``, ``upstream_provenance``, or ``schema_version``.
    """

    data = deepcopy(raw)

    version = _nonblank_str(data.get("version"))
    pack_version = _nonblank_str(data.get("pack_version"))
    version_missing = _missing_or_blank(data, "version")
    pack_version_missing = _missing_or_blank(data, "pack_version")

    if version is not None and pack_version_missing:
        data["version"] = version
        data["pack_version"] = version
    elif pack_version is not None and version_missing:
        data["pack_version"] = pack_version
        data["version"] = pack_version
    elif version is not None and pack_version is not None:
        data["version"] = version
        data["pack_version"] = pack_version

    connector_id = _nonblank_str(data.get("id"))
    package_id = _nonblank_str(data.get("package_id"))
    if _missing_or_blank(data, "package_id") and connector_id is not None:
        data["package_id"] = connector_id
    elif package_id is not None:
        data["package_id"] = package_id

    package_kind = _nonblank_str(data.get("package_kind"))
    if _missing_or_blank(data, "package_kind"):
        data["package_kind"] = DEFAULT_PACKAGE_KIND
    elif package_kind is not None:
        data["package_kind"] = package_kind

    return data
