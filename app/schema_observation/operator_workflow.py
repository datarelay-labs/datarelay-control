"""Schema drift M4 — operator acknowledge, baseline reset, and summary (no detection changes)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.schema_observation.drift_detection import (
    _baseline_paths_from_row,
    _serialize_baseline,
    build_field_drifts_read_model,
    schema_drift_detection_enabled,
)
from app.schema_observation.models import (
    DRIFT_CATEGORY_FIELD_ADDED,
    DRIFT_CATEGORY_FIELD_REMOVED,
    DRIFT_CATEGORY_FIELD_TYPE_CHANGED,
    DRIFT_RESOLUTION_BASELINE_RESET,
    DRIFT_STATUS_ACKNOWLEDGED,
    DRIFT_STATUS_OPEN,
    DRIFT_STATUS_RESOLVED,
    StreamObservedSchema,
    StreamSchemaFieldDrift,
)
from app.schema_observation.service import _paths_from_row, _serialize_paths, get_observed_schema_row

DriftStatusFilter = Literal["open", "acknowledged", "all"]

_DRIFT_CATEGORIES = (
    DRIFT_CATEGORY_FIELD_ADDED,
    DRIFT_CATEGORY_FIELD_REMOVED,
    DRIFT_CATEGORY_FIELD_TYPE_CHANGED,
)


class DriftFindingNotFoundError(Exception):
    def __init__(self, finding_id: int) -> None:
        self.finding_id = finding_id
        super().__init__(f"drift finding not found: {finding_id}")


class DriftFindingStateError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)


class ObservedSchemaNotFoundError(Exception):
    pass


def normalize_status_filter(raw: str | None) -> DriftStatusFilter:
    if raw is None or raw.strip() == "":
        return "open"
    value = raw.strip().lower()
    if value in ("open", "acknowledged", "all"):
        return value  # type: ignore[return-value]
    raise ValueError(f"invalid status filter: {raw!r}; expected open, acknowledged, or all")


def list_field_drifts(
    db: Session,
    stream_id: int,
    *,
    status_filter: DriftStatusFilter = "open",
) -> list[StreamSchemaFieldDrift]:
    stmt = select(StreamSchemaFieldDrift).where(StreamSchemaFieldDrift.stream_id == stream_id)
    if status_filter == "open":
        stmt = stmt.where(StreamSchemaFieldDrift.status == DRIFT_STATUS_OPEN)
    elif status_filter == "acknowledged":
        stmt = stmt.where(StreamSchemaFieldDrift.status == DRIFT_STATUS_ACKNOWLEDGED)
    stmt = stmt.order_by(StreamSchemaFieldDrift.category, StreamSchemaFieldDrift.field_path)
    return list(db.execute(stmt).scalars())


def get_field_drifts_read_payload(
    db: Session,
    stream_id: int,
    *,
    status_filter: DriftStatusFilter = "open",
) -> dict[str, Any]:
    row = get_observed_schema_row(db, stream_id)
    findings = list_field_drifts(db, stream_id, status_filter=status_filter)
    payload = build_field_drifts_read_model(stream_id=stream_id, row=row, findings=findings)
    payload["status_filter"] = status_filter
    if row is not None:
        payload["baseline_version"] = int(row.baseline_version or 1)
        payload["baseline_reset_at"] = row.baseline_reset_at
    else:
        payload["baseline_version"] = 1
        payload["baseline_reset_at"] = None
    return payload


def count_open_schema_field_drifts(db: Session) -> int:
    """Global OPEN ``StreamSchemaFieldDrift`` finding count (cross-stream aggregate)."""

    raw = db.execute(
        select(func.count()).where(StreamSchemaFieldDrift.status == DRIFT_STATUS_OPEN)
    ).scalar_one()
    return int(raw or 0)


def build_drift_summary(db: Session, stream_id: int) -> dict[str, Any]:
    row = get_observed_schema_row(db, stream_id)
    counts = dict(
        db.execute(
            select(StreamSchemaFieldDrift.status, func.count())
            .where(StreamSchemaFieldDrift.stream_id == stream_id)
            .group_by(StreamSchemaFieldDrift.status)
        ).all()
    )
    open_count = int(counts.get(DRIFT_STATUS_OPEN, 0))
    acknowledged_count = int(counts.get(DRIFT_STATUS_ACKNOWLEDGED, 0))
    resolved_count = int(counts.get(DRIFT_STATUS_RESOLVED, 0))

    by_category: dict[str, int] = {cat: 0 for cat in _DRIFT_CATEGORIES}
    category_rows = db.execute(
        select(StreamSchemaFieldDrift.category, func.count())
        .where(
            StreamSchemaFieldDrift.stream_id == stream_id,
            StreamSchemaFieldDrift.status == DRIFT_STATUS_OPEN,
        )
        .group_by(StreamSchemaFieldDrift.category)
    ).all()
    for category, count in category_rows:
        if category in by_category:
            by_category[category] = int(count)

    return {
        "stream_id": stream_id,
        "open_count": open_count,
        "acknowledged_count": acknowledged_count,
        "resolved_count": resolved_count,
        "by_category": by_category,
        "baseline_version": int(row.baseline_version or 1) if row is not None else 1,
        "baseline_established_at": row.baseline_established_at if row is not None else None,
        "baseline_reset_at": row.baseline_reset_at if row is not None else None,
        "drift_detection_enabled": schema_drift_detection_enabled(),
    }


def acknowledge_field_drift(
    db: Session,
    *,
    stream_id: int,
    finding_id: int,
    actor_username: str,
    note: str | None = None,
) -> StreamSchemaFieldDrift:
    finding = db.execute(
        select(StreamSchemaFieldDrift).where(
            StreamSchemaFieldDrift.id == finding_id,
            StreamSchemaFieldDrift.stream_id == stream_id,
        )
    ).scalar_one_or_none()
    if finding is None:
        raise DriftFindingNotFoundError(finding_id)
    if finding.status != DRIFT_STATUS_OPEN:
        raise DriftFindingStateError(
            f"finding {finding_id} cannot be acknowledged from status {finding.status!r}"
        )
    now = datetime.now(timezone.utc)
    finding.status = DRIFT_STATUS_ACKNOWLEDGED
    finding.acknowledged_at = now
    finding.acknowledged_by = actor_username
    if note is not None and note.strip():
        finding.operator_note = note.strip()
    return finding


def reset_schema_baseline(
    db: Session,
    *,
    stream_id: int,
    actor_username: str,
    reason: str,
) -> StreamObservedSchema:
    row = get_observed_schema_row(db, stream_id)
    if row is None:
        raise ObservedSchemaNotFoundError()

    observed_paths = _paths_from_row(row.paths_json)
    if not observed_paths:
        raise DriftFindingStateError("cannot reset baseline without observed paths")

    snapshot = {
        path: {"type": meta["type"]}
        for path, meta in observed_paths.items()
        if isinstance(meta.get("type"), str)
    }
    now = datetime.now(timezone.utc)
    row.baseline_paths_json = _serialize_baseline(snapshot)
    row.baseline_established_at = now
    row.baseline_version = int(row.baseline_version or 1) + 1
    row.baseline_reset_at = now
    row.baseline_reset_by = actor_username
    row.baseline_reset_reason = reason.strip() if reason.strip() else None

    for meta in observed_paths.values():
        meta["runs_since_seen"] = 0
        meta["add_confirm_runs"] = 0
        meta["type_change_confirm_runs"] = 0
        meta.pop("type_change_last_batch_type", None)
    row.paths_json = _serialize_paths(observed_paths)
    row.updated_at = now

    open_findings = list_field_drifts(db, stream_id, status_filter="open")
    resolved_open_count = len(open_findings)
    for finding in open_findings:
        finding.status = DRIFT_STATUS_RESOLVED
        finding.resolved_at = now
        finding.resolved_by = actor_username
        finding.resolution = DRIFT_RESOLUTION_BASELINE_RESET

    return row, resolved_open_count


def build_baseline_reset_response(
    stream_id: int,
    row: StreamObservedSchema,
    *,
    resolved_open_finding_count: int,
) -> dict[str, Any]:
    baseline_paths = _baseline_paths_from_row(row.baseline_paths_json)
    return {
        "stream_id": stream_id,
        "baseline_version": int(row.baseline_version or 1),
        "baseline_path_count": len(baseline_paths),
        "baseline_established_at": row.baseline_established_at,
        "baseline_reset_at": row.baseline_reset_at,
        "baseline_reset_by": row.baseline_reset_by,
        "baseline_reset_reason": row.baseline_reset_reason,
        "resolved_open_finding_count": resolved_open_finding_count,
    }
