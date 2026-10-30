"""JSON-safe value isolation for the runtime pipeline (minimize deepcopy cost)."""

from __future__ import annotations

from typing import Any

from app.checkpoints.route_delivery_state import (
    ROUTE_DELIVERY_STATE_KEY,
    strip_route_delivery_state,
    summarize_route_delivery_state,
)

_CHECKPOINT_LOG_META_KEYS = frozenset(
    {
        "last_processed_key",
        "last_processed_file",
        "last_processed_last_modified",
        "last_processed_mtime",
        "last_processed_etag",
        "last_processed_size",
        "last_processed_offset",
        "last_processed_hash",
        "last_processed_db_watermark",
        "last_processed_db_order",
        "updated_at",
        "checkpoint_type",
    }
)
_EVENT_ID_PREVIEW_KEYS = ("event_id", "id", "@timestamp", "timestamp")


def copy_json_value(value: Any) -> Any:
    """Deep-copy nested dict/list only; pass through immutable JSON scalars."""

    if isinstance(value, dict):
        return {key: copy_json_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [copy_json_value(item) for item in value]
    return value


def copy_event_dict(event: dict[str, Any]) -> dict[str, Any]:
    """Return an isolated event dict safe from downstream in-place mutation."""

    return copy_json_value(event)


def copy_events(events: list[dict[str, Any]], *, limit: int | None = None) -> list[dict[str, Any]]:
    """Copy a bounded list of event dicts for replay/checkpoint snapshots."""

    bounded = events[:limit] if limit is not None else events
    return [copy_event_dict(item) for item in bounded if isinstance(item, dict)]


def slim_checkpoint_for_log(checkpoint: dict[str, Any] | None) -> dict[str, Any] | None:
    """Persist only checkpoint metadata and event-id preview (not full last_success_event)."""

    if not isinstance(checkpoint, dict):
        return None

    out: dict[str, Any] = {}
    for key in _CHECKPOINT_LOG_META_KEYS:
        if key in checkpoint:
            out[key] = checkpoint[key]

    last_success = checkpoint.get("last_success_event")
    if isinstance(last_success, dict):
        preview = {key: last_success[key] for key in _EVENT_ID_PREVIEW_KEYS if key in last_success}
        if preview:
            out["last_success_event"] = preview

    if out:
        return out
    # Per-Route delivery fingerprints are runtime bookkeeping, never log payload; the fallback
    # copy still never carries raw delivered events (top-level or nested delivery_checkpoint).
    base = strip_route_delivery_state(checkpoint)
    return checkpoint_read_view(base) if isinstance(base, dict) else None


def _event_id_preview(event: Any) -> dict[str, Any] | None:
    if not isinstance(event, dict):
        return None
    preview = {
        key: event[key]
        for key in _EVENT_ID_PREVIEW_KEYS
        if key in event and (event[key] is None or isinstance(event[key], (str, int, float, bool)))
    }
    return preview or None


def checkpoint_read_view(checkpoint: Any) -> dict[str, Any]:
    """Return an API-safe checkpoint copy without raw delivered event payloads.

    The stored checkpoint keeps the full ``last_success_event`` for incremental fetch; read
    APIs expose only checkpoint metadata and an event-id/timestamp preview of that event.
    Per-Route delivery fingerprints are reduced to per-Route delivered-event counts.
    """

    if not isinstance(checkpoint, dict):
        return {}

    out: dict[str, Any] = {}
    for key, value in checkpoint.items():
        if key == "last_success_event":
            preview = _event_id_preview(value)
            if preview is not None:
                out[key] = preview
        elif key == "delivery_checkpoint" and isinstance(value, dict):
            out[key] = checkpoint_read_view(value)
        elif key == ROUTE_DELIVERY_STATE_KEY:
            out[key] = summarize_route_delivery_state(value)
        else:
            out[key] = copy_json_value(value)
    return out
