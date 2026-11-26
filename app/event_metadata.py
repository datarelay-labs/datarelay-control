"""Root-level bookkeeping fields shared by runtime observation and delivery."""

from __future__ import annotations

from typing import Any

_INTERNAL_FIELDS = frozenset({"gdc_db_watermark", "gdc_db_order_value"})


def is_runtime_metadata_key(key: Any) -> bool:
    return isinstance(key, str) and (key.startswith("__gdc_") or key in _INTERNAL_FIELDS)


def without_runtime_metadata(event: dict[str, Any]) -> dict[str, Any]:
    """Return a shallow projection; never mutate runtime bookkeeping or nested vendor fields."""
    return {key: value for key, value in event.items() if not is_runtime_metadata_key(key)}


def is_runtime_metadata_path(path: str) -> bool:
    """Recognize reserved root paths in legacy observed inventories."""
    if path.startswith(("$.__gdc_", "$['__gdc_")):
        return True
    return any(
        path == root or path.startswith((root + ".", root + "["))
        for key in _INTERNAL_FIELDS
        for root in (f"$.{key}", f"$['{key}']")
    )
