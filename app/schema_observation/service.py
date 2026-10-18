"""Record and read per-Stream observed schema from extracted events."""

from __future__ import annotations

import logging
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import settings
from app.schema_observation.drift_detection import (
    detect_field_changes,
    ensure_pending_add_tracking,
    maybe_establish_baseline,
    schema_drift_detection_enabled,
    update_path_presence_streaks,
    update_type_change_streaks,
)
from app.schema_observation.models import StreamObservedSchema
from app.schema_observation.occurrence_tracking import collect_occurrence_batch
from app.schema_observation.path_walker import collect_paths_from_events, merge_inferred_types

logger = logging.getLogger(__name__)


def schema_observation_enabled() -> bool:
    return bool(settings.GDC_SCHEMA_OBSERVATION_ENABLED)


def _paths_from_row(paths_json: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    raw = paths_json if isinstance(paths_json, dict) else {}
    paths = raw.get("paths")
    if not isinstance(paths, dict):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for path, meta in paths.items():
        if not isinstance(path, str) or not isinstance(meta, dict):
            continue
        typ = meta.get("type")
        if isinstance(typ, str):
            out[path] = {
                "type": typ,
                "observation_count": int(meta.get("observation_count") or 0),
                "runs_since_seen": int(meta.get("runs_since_seen") or 0),
                "add_confirm_runs": int(meta.get("add_confirm_runs") or 0),
                "type_change_confirm_runs": int(meta.get("type_change_confirm_runs") or 0),
            }
            # Missing means legacy history is unscorable; do not backfill it
            # from the historically inflated observation_count field.
            if "occurrence_count" in meta:
                out[path]["occurrence_count"] = int(meta["occurrence_count"])
    return out


def _serialize_paths(
    paths: dict[str, dict[str, Any]],
    *,
    source: dict[str, Any] | None = None,
    counting: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Preserve additive metadata across runtime and explicit baseline resets."""
    raw = source if isinstance(source, dict) else {}
    out = {key: deepcopy(value) for key, value in raw.items() if key != "paths"}
    out["paths"] = deepcopy(paths)
    if counting is not None:
        out["counting_v1"] = deepcopy(counting)
    return out


def _next_counting_epoch(
    previous: dict[str, Any] | None,
    *,
    old_total_events: int,
    sample_events: int,
    batch_complete: bool,
    batch_warnings: tuple[str, ...],
) -> dict[str, Any]:
    """Start a verifiable count epoch without rewriting untrusted legacy counts."""
    old = (previous or {}).get("counting_v1")
    if isinstance(old, dict) and old.get("version") == 1:
        epoch = deepcopy(old)
    else:
        epoch = {
            "version": 1,
            "sampled_events": 0,
            "historical_events_excluded": old_total_events,
            "complete": True,
            "warnings": [],
        }
    epoch["sampled_events"] = int(epoch["sampled_events"]) + sample_events
    epoch["complete"] = bool(epoch["complete"]) and batch_complete
    epoch["warnings"] = sorted(set(epoch.get("warnings") or []).union(batch_warnings))
    return epoch


def merge_path_inventories(
    existing: dict[str, dict[str, Any]],
    batch_paths: dict[str, str],
    *,
    events_in_batch: int,
    batch_occurrence_counts: dict[str, int] | None = None,
) -> dict[str, dict[str, Any]]:
    merged = deepcopy(existing)
    if batch_occurrence_counts is not None:
        for entry in merged.values():
            # Absent in historical data: count starts in the new tracking epoch.
            entry.setdefault("occurrence_count", 0)
    for path, typ in batch_paths.items():
        entry = merged.get(path)
        exact = int((batch_occurrence_counts or {}).get(path, 0))
        if batch_occurrence_counts is not None and not 0 <= exact <= events_in_batch:
            raise ValueError("Field occurrence count must be a per-event presence count")
        if entry is None:
            merged[path] = {
                "type": typ,
                # Retain the historical field for current API/backward compatibility.
                "observation_count": events_in_batch,
                "runs_since_seen": 0,
                "add_confirm_runs": 0,
                "type_change_confirm_runs": 0,
            }
            if batch_occurrence_counts is not None:
                merged[path]["occurrence_count"] = exact
        else:
            entry["type"] = merge_inferred_types(str(entry.get("type")), typ)
            entry["observation_count"] = int(entry.get("observation_count") or 0) + events_in_batch
            if batch_occurrence_counts is not None:
                entry["occurrence_count"] = int(entry.get("occurrence_count") or 0) + exact
    return merged


def observe_extracted_events(
    db: Session,
    stream_id: int,
    events: list[Any],
) -> None:
    """Merge schema paths from extracted events into the Stream observed schema store.

    Non-blocking: callers should catch exceptions. No-op when disabled or events empty.
    """

    if not schema_observation_enabled() or not events:
        return

    max_events = max(1, int(settings.GDC_SCHEMA_OBSERVATION_MAX_EVENTS_PER_RUN))
    max_paths = max(100, int(settings.GDC_SCHEMA_OBSERVATION_MAX_PATHS))
    max_depth = max(4, int(settings.GDC_SCHEMA_OBSERVATION_MAX_DEPTH))

    valid = [ev for ev in events if isinstance(ev, dict)]
    sample = valid[:max_events]
    if not sample:
        return

    batch_paths = collect_paths_from_events(
        sample,
        max_depth=max_depth,
        max_paths=max_paths,
        max_events=max_events,
    )
    evidence = collect_occurrence_batch(
        sample,
        batch_paths=batch_paths,
        max_depth=max_depth,
        max_paths=max_paths,
        event_sample_truncated=len(valid) > len(sample),
        invalid_event_objects=len(valid) != len(events),
    )

    now = datetime.now(timezone.utc)
    # Canonical per-Stream lock order: parent Stream BEFORE observed schema.
    # The parent always exists for valid observations, even when the observed
    # schema row has not been created. This serializes first inserts and
    # existing-row updates without an absent-row SELECT race.
    owner = db.execute(
        text("SELECT id FROM streams WHERE id = :stream_id FOR UPDATE"),
        {"stream_id": stream_id},
    ).scalar_one_or_none()
    if owner is None:
        raise ValueError("Observed-schema Stream owner does not exist")
    # Force a DB refresh even if the Session previously loaded a stale row.
    row = db.get(
        StreamObservedSchema, stream_id, with_for_update=True,
        populate_existing=True,
    )
    previous_payload = row.paths_json if row is not None else None
    epoch = _next_counting_epoch(
        previous_payload,
        old_total_events=int(row.total_events_observed or 0) if row is not None else 0,
        sample_events=evidence.sampled_events,
        batch_complete=evidence.complete,
        batch_warnings=evidence.warnings,
    )
    if row is None:
        initial_paths = merge_path_inventories(
            {},
            batch_paths,
            events_in_batch=len(sample),
            batch_occurrence_counts=evidence.present_by_path,
        )
        for meta in initial_paths.values():
            meta["add_confirm_runs"] = 1
        row = StreamObservedSchema(
            stream_id=stream_id,
            paths_json=_serialize_paths(initial_paths, counting=epoch),
            total_events_observed=len(sample),
            observation_run_count=1,
            last_observation_at=now,
        )
        db.add(row)
        _finalize_observation_row(db, stream_id=stream_id, row=row, merged_paths=initial_paths, batch_paths=batch_paths)
        return

    existing_paths = _paths_from_row(row.paths_json)
    merged_paths = merge_path_inventories(
        existing_paths,
        batch_paths,
        events_in_batch=len(sample),
        batch_occurrence_counts=evidence.present_by_path,
    )
    row.paths_json = _serialize_paths(merged_paths, source=previous_payload, counting=epoch)
    row.total_events_observed = int(row.total_events_observed or 0) + len(sample)
    row.observation_run_count = int(row.observation_run_count or 0) + 1
    row.last_observation_at = now
    row.updated_at = now
    _finalize_observation_row(db, stream_id=stream_id, row=row, merged_paths=merged_paths, batch_paths=batch_paths)


def _finalize_observation_row(
    db: Session,
    *,
    stream_id: int,
    row: StreamObservedSchema,
    merged_paths: dict[str, dict[str, Any]],
    batch_paths: dict[str, str],
) -> None:
    if not schema_drift_detection_enabled():
        return

    update_path_presence_streaks(merged_paths, batch_paths)
    maybe_establish_baseline(row, merged_paths)
    baseline_raw = row.baseline_paths_json if isinstance(row.baseline_paths_json, dict) else {}
    baseline_paths = baseline_raw.get("paths") if isinstance(baseline_raw.get("paths"), dict) else {}
    ensure_pending_add_tracking(merged_paths, baseline_paths, batch_paths)
    update_type_change_streaks(merged_paths, baseline_paths, batch_paths)
    row.paths_json = _serialize_paths(merged_paths, source=row.paths_json)
    try:
        detect_field_changes(
            db,
            stream_id=stream_id,
            row=row,
            observed_paths=merged_paths,
            batch_paths=batch_paths,
        )
    except Exception:
        logger.exception("schema_drift_detection_failed stream_id=%s", stream_id)


def get_observed_schema_row(db: Session, stream_id: int) -> StreamObservedSchema | None:
    return db.get(StreamObservedSchema, stream_id)


def get_field_drifts_for_stream(
    db: Session,
    stream_id: int,
    *,
    status_filter: str | None = None,
) -> dict[str, Any]:
    from app.schema_observation.operator_workflow import (
        get_field_drifts_read_payload,
        normalize_status_filter,
    )

    return get_field_drifts_read_payload(
        db,
        stream_id,
        status_filter=normalize_status_filter(status_filter),
    )


def build_observed_schema_read_model(
    *,
    stream_id: int,
    row: StreamObservedSchema | None,
) -> dict[str, Any]:
    paths_map = _paths_from_row(row.paths_json if row is not None else None)
    entries = [
        {
            "path": path,
            "type": meta["type"],
            "observation_count": meta.get("observation_count", 0),
            "occurrence_count": meta.get("occurrence_count"),
        }
        for path, meta in sorted(paths_map.items(), key=lambda item: item[0])
    ]
    raw_counting = ((row.paths_json or {}).get("counting_v1") if row is not None else None)
    counting = raw_counting if isinstance(raw_counting, dict) and raw_counting.get("version") == 1 else None
    return {
        "stream_id": stream_id,
        "observation_enabled": schema_observation_enabled(),
        "paths": entries,
        "path_count": len(entries),
        "occurrence_sampled_events": int(counting["sampled_events"]) if counting else None,
        "occurrence_complete": bool(counting["complete"]) if counting else None,
        "occurrence_warnings": list(counting.get("warnings") or []) if counting else [],
        "historical_events_excluded": int(counting["historical_events_excluded"]) if counting else None,
        "total_events_observed": int(row.total_events_observed) if row is not None else 0,
        "observation_run_count": int(row.observation_run_count) if row is not None else 0,
        "last_observation_at": row.last_observation_at if row is not None else None,
        "updated_at": row.updated_at if row is not None else None,
    }
