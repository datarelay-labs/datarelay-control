"""In-memory Manifest v2 normalization (does not rewrite files)."""

from __future__ import annotations

from copy import deepcopy
from typing import Any


SUPPORTED_PACKAGE_KINDS = frozenset({"source", "stream_extension"})
DEFAULT_PACKAGE_KIND = "source"


def _nonblank_str(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    text = str(value).strip()
    return text or None


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

    if version is not None and pack_version is None:
        data["version"] = version
        data["pack_version"] = version
    elif pack_version is not None and version is None:
        data["pack_version"] = pack_version
        data["version"] = pack_version
    elif version is not None and pack_version is not None:
        data["version"] = version
        data["pack_version"] = pack_version

    connector_id = _nonblank_str(data.get("id"))
    package_id = _nonblank_str(data.get("package_id"))
    if package_id is None and connector_id is not None:
        data["package_id"] = connector_id
    elif package_id is not None:
        data["package_id"] = package_id

    package_kind = _nonblank_str(data.get("package_kind"))
    if package_kind is None:
        data["package_kind"] = DEFAULT_PACKAGE_KIND
    else:
        data["package_kind"] = package_kind

    return data
