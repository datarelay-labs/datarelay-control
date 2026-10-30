"""Per-Route delivery state kept inside the stream checkpoint value.

The stream checkpoint advances only when every required Route delivered (or absorbed the
failure per its failure policy). While it is held, each poll re-fetches the same window.
To avoid re-sending already delivered events to healthy Routes (and to resume a failing
Route from its first undelivered event), the runner records, per Route, stable
fingerprints of the source events already delivered within the current unadvanced
checkpoint window.

Stored shape under ``checkpoint_value[ROUTE_DELIVERY_STATE_KEY]``::

    {"version": 1, "anchor": "<hash of the checkpoint value without this key>",
     "routes": {"<route_id>": ["<fingerprint>", ...]}}

- Fingerprints only (truncated SHA-256 of canonical JSON); raw events are never stored.
- ``anchor`` binds the state to the exact checkpoint window it was recorded in. Any other
  writer that changes the checkpoint (advance, manual edit, reset, restore) invalidates it.
- A checkpoint advance writes a fresh value without this key, which clears the state.
- Per-Route lists are bounded; dropping old fingerprints can only cause a re-send
  (at-least-once), never a lost event.

This module must stay free of app imports (used by copy_utils and the checkpoint service).
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

ROUTE_DELIVERY_STATE_KEY = "route_delivery_state"
ROUTE_DELIVERY_STATE_VERSION = 1
MAX_FINGERPRINTS_PER_ROUTE = 5000

_FINGERPRINT_HEX_LEN = 32
# Runtime-injected metadata (e.g. stream dedup queue ids) differs between runs.
_INTERNAL_META_PREFIX = "__gdc_"


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def _sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def split_route_delivery_state(checkpoint: Any) -> tuple[Any, Any]:
    """Return ``(base_checkpoint, raw_state)`` with the route delivery key removed.

    Callers see exactly what they saw before this key existed: ``{}`` stays ``{}``, and a
    row that was created only to hold route delivery state (``cursor_absent``) reads as
    ``None`` (no checkpoint).
    """

    if not isinstance(checkpoint, dict) or ROUTE_DELIVERY_STATE_KEY not in checkpoint:
        return checkpoint, None
    raw_state = checkpoint.get(ROUTE_DELIVERY_STATE_KEY)
    base: Any = {key: value for key, value in checkpoint.items() if key != ROUTE_DELIVERY_STATE_KEY}
    if not base and isinstance(raw_state, dict) and raw_state.get("cursor_absent") is True:
        base = None
    return base, raw_state


def strip_route_delivery_state(checkpoint: Any) -> Any:
    """Return the checkpoint as seen by readers that predate the route delivery key."""

    return split_route_delivery_state(checkpoint)[0]


def checkpoint_anchor(base_checkpoint: Any) -> str:
    """Stable identity of the checkpoint window (value without the route delivery key).

    No checkpoint and an empty checkpoint are the same (initial) window.
    """

    return _sha256_hex(_canonical_json(base_checkpoint or None))[:_FINGERPRINT_HEX_LEN]


def event_fingerprints(events: list[Any]) -> list[str]:
    """Stable, occurrence-aware fingerprints for source events in batch order.

    Identical events in one batch get distinct fingerprints (``<hash>``, ``<hash>#1``, ...)
    so a partially delivered batch with duplicates can never skip an undelivered copy.
    """

    seen: dict[str, int] = {}
    out: list[str] = []
    for event in events:
        if isinstance(event, dict):
            payload: Any = {
                key: value
                for key, value in event.items()
                if not (isinstance(key, str) and key.startswith(_INTERNAL_META_PREFIX))
            }
        else:
            payload = event
        digest = _sha256_hex(_canonical_json(payload))[:_FINGERPRINT_HEX_LEN]
        occurrence = seen.get(digest, 0)
        seen[digest] = occurrence + 1
        out.append(digest if occurrence == 0 else f"{digest}#{occurrence}")
    return out


def load_route_fingerprints(raw_state: Any, anchor: str) -> dict[str, list[str]]:
    """Return per-Route delivered fingerprints when the state belongs to ``anchor``."""

    if not isinstance(raw_state, dict):
        return {}
    if raw_state.get("version") != ROUTE_DELIVERY_STATE_VERSION or raw_state.get("anchor") != anchor:
        return {}
    routes = raw_state.get("routes")
    if not isinstance(routes, dict):
        return {}
    out: dict[str, list[str]] = {}
    for route_id, fingerprints in routes.items():
        if not isinstance(fingerprints, list):
            continue
        cleaned = [fp for fp in fingerprints if isinstance(fp, str) and fp]
        if cleaned:
            out[str(route_id)] = cleaned[-MAX_FINGERPRINTS_PER_ROUTE:]
    return out


def merge_fingerprints(existing: list[str], new: list[str]) -> list[str]:
    """Append unseen fingerprints, keeping order and the per-Route bound (newest kept)."""

    known = set(existing)
    merged = list(existing)
    for fp in new:
        if fp not in known:
            known.add(fp)
            merged.append(fp)
    return merged[-MAX_FINGERPRINTS_PER_ROUTE:]


def build_route_delivery_state(
    anchor: str,
    routes: dict[str, list[str]],
    *,
    keep_route_ids: set[str] | None = None,
    cursor_absent: bool = False,
) -> dict[str, Any] | None:
    """Serialize per-Route fingerprints (``None`` when nothing is recorded).

    ``cursor_absent`` records that the run started with no checkpoint at all, so a row
    created only for this state still reads as "no checkpoint".
    """

    kept: dict[str, list[str]] = {}
    for route_id, fingerprints in routes.items():
        if keep_route_ids is not None and str(route_id) not in keep_route_ids:
            continue
        if fingerprints:
            kept[str(route_id)] = list(fingerprints[-MAX_FINGERPRINTS_PER_ROUTE:])
    if not kept:
        return None
    state: dict[str, Any] = {"version": ROUTE_DELIVERY_STATE_VERSION, "anchor": anchor, "routes": kept}
    if cursor_absent:
        state["cursor_absent"] = True
    return state


def summarize_route_delivery_state(raw_state: Any) -> dict[str, Any]:
    """API-safe summary: per-Route count of events already delivered in the held window."""

    routes = raw_state.get("routes") if isinstance(raw_state, dict) else None
    counts: dict[str, int] = {}
    if isinstance(routes, dict):
        for route_id, fingerprints in routes.items():
            if isinstance(fingerprints, list):
                counts[str(route_id)] = len(fingerprints)
    return {"route_delivered_event_counts": counts}


def reduce_route_delivery_state(checkpoint: Any) -> Any:
    """Copy of the checkpoint with fingerprints replaced by the API-safe summary."""

    if not isinstance(checkpoint, dict) or ROUTE_DELIVERY_STATE_KEY not in checkpoint:
        return checkpoint
    out = {key: value for key, value in checkpoint.items() if key != ROUTE_DELIVERY_STATE_KEY}
    out[ROUTE_DELIVERY_STATE_KEY] = summarize_route_delivery_state(checkpoint.get(ROUTE_DELIVERY_STATE_KEY))
    return out
