"""Apply stored configuration snapshots with operational guards (no checkpoint/runtime semantics changes)."""

from __future__ import annotations

from typing import Any, Literal

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.destinations.models import Destination
from app.platform_admin import journal
from app.platform_admin.config_entity_snapshots import (
    ENTITY_DESTINATION,
    ENTITY_MAPPING,
    ENTITY_ROUTE,
    ENTITY_STREAM,
    apply_snapshot_for_entity,
    serialize_destination_config,
    serialize_mapping_for_stream,
    serialize_route_config,
    serialize_stream_config,
)
from app.platform_admin.models import PlatformConfigVersion
from app.routes.models import Route
from app.streams.models import Stream


class ConfigSnapshotApplyError(Exception):
    def __init__(
        self,
        *,
        error_code: str,
        message: str,
        http_status: int,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.http_status = http_status
        self.details = details or {}


def _stream_running(db: Session, stream_id: int) -> bool:
    s = db.query(Stream).filter(Stream.id == int(stream_id)).first()
    return bool(s and str(s.status or "") == "RUNNING")


def _assert_stream_not_running(db: Session, stream_id: int) -> None:
    if _stream_running(db, stream_id):
        raise ConfigSnapshotApplyError(
            error_code="CONFIG_APPLY_BLOCKED_STREAM_RUNNING",
            message="Stop the stream before applying this configuration snapshot.",
            http_status=409,
        )


def _assert_destination_streams_stopped(db: Session, destination_id: int) -> None:
    rows = db.query(Route.stream_id).filter(Route.destination_id == int(destination_id)).distinct().all()
    for (sid,) in rows:
        _assert_stream_not_running(db, int(sid))


def _guard_apply(db: Session, entity_type: str, snapshot: dict[str, Any]) -> None:
    if entity_type == ENTITY_STREAM:
        _assert_stream_not_running(db, int(snapshot["stream_id"]))
    elif entity_type == ENTITY_MAPPING:
        _assert_stream_not_running(db, int(snapshot["stream_id"]))
    elif entity_type == ENTITY_ROUTE:
        _assert_stream_not_running(db, int(snapshot["stream_id"]))
    elif entity_type == ENTITY_DESTINATION:
        _assert_destination_streams_stopped(db, int(snapshot["destination_id"]))


def _capture_live(db: Session, entity_type: str, entity_id: int) -> dict[str, Any]:
    if entity_type == ENTITY_STREAM:
        s = db.query(Stream).filter(Stream.id == int(entity_id)).first()
        if s is None:
            raise ConfigSnapshotApplyError(
                error_code="STREAM_NOT_FOUND",
                message=f"stream not found: {entity_id}",
                http_status=404,
            )
        return serialize_stream_config(s)
    if entity_type == ENTITY_MAPPING:
        return serialize_mapping_for_stream(db, int(entity_id))
    if entity_type == ENTITY_ROUTE:
        r = db.query(Route).filter(Route.id == int(entity_id)).first()
        if r is None:
            raise ConfigSnapshotApplyError(
                error_code="ROUTE_NOT_FOUND",
                message=f"route not found: {entity_id}",
                http_status=404,
            )
        return serialize_route_config(r)
    if entity_type == ENTITY_DESTINATION:
        d = db.query(Destination).filter(Destination.id == int(entity_id)).first()
        if d is None:
            raise ConfigSnapshotApplyError(
                error_code="DESTINATION_NOT_FOUND",
                message=f"destination not found: {entity_id}",
                http_status=404,
            )
        return serialize_destination_config(d)
    raise ConfigSnapshotApplyError(
        error_code="ENTITY_NOT_ROLLBACK_SUPPORTED",
        message=f"entity_type not supported for apply: {entity_type}",
        http_status=400,
    )


def current_entity_config_version(db: Session, *, entity_type: str, entity_id: int) -> int | None:
    """Authoritative tip for the live target: max monotonic version for this entity."""
    tip = (
        db.query(func.max(PlatformConfigVersion.version))
        .filter(
            PlatformConfigVersion.entity_type == entity_type,
            PlatformConfigVersion.entity_id == int(entity_id),
        )
        .scalar()
    )
    return int(tip) if tip is not None else None


def _assert_expected_target_version(
    db: Session,
    *,
    entity_type: str,
    entity_id: int,
    expected_version: int,
) -> None:
    current = current_entity_config_version(db, entity_type=entity_type, entity_id=entity_id)
    if current is None or int(current) != int(expected_version):
        raise ConfigSnapshotApplyError(
            error_code="CONFIG_APPLY_STALE_VERSION",
            message=(
                "Target configuration changed since expected_version; refresh the current "
                "version and retry the restore."
            ),
            http_status=409,
            details={
                "expected_version": int(expected_version),
                "current_version": current,
            },
        )


def apply_versioned_snapshot(
    db: Session,
    *,
    version_row: PlatformConfigVersion,
    target: Literal["before", "after"],
    expected_version: int,
    actor_username: str = "system",
) -> tuple[int, dict[str, Any]]:
    """Apply ``target`` side of ``version_row`` to the database; returns (new_version_int, applied_snapshot)."""

    entity_type = str(version_row.entity_type)
    entity_id = int(version_row.entity_id)
    snap = version_row.snapshot_before_json if target == "before" else version_row.snapshot_after_json
    if snap is None:
        raise ConfigSnapshotApplyError(
            error_code="CONFIG_SNAPSHOT_UNAVAILABLE",
            message="This configuration version has no stored JSON snapshot for the requested side.",
            http_status=422,
        )

    snap = dict(snap)
    # Optimistic concurrency against the live TARGET tip (not the historical snapshot row).
    _assert_expected_target_version(
        db,
        entity_type=entity_type,
        entity_id=entity_id,
        expected_version=expected_version,
    )
    _guard_apply(db, entity_type, snap)

    live_before = _capture_live(db, entity_type, entity_id)
    apply_snapshot_for_entity(db, entity_type, snap)
    db.flush()
    live_after = _capture_live(db, entity_type, entity_id)

    journal.record_audit_event(
        db,
        action="CONFIG_SNAPSHOT_APPLIED",
        actor_username=actor_username,
        entity_type=entity_type,
        entity_id=entity_id,
        entity_name=version_row.entity_name,
        details={
            "source_version_row_id": int(version_row.id),
            "source_monotonic_version": int(version_row.version),
            "expected_version": int(expected_version),
            "target": target,
        },
    )
    summary = f"Snapshot applied ({target}) from config version v{version_row.version}"
    new_v = journal.record_config_version(
        db,
        entity_type=entity_type,
        entity_id=entity_id,
        entity_name=version_row.entity_name,
        changed_by=actor_username,
        summary=summary,
        snapshot_before=live_before,
        snapshot_after=live_after,
    )
    db.commit()
    return new_v, snap
