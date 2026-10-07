"""Read-only queries for delivery_logs (no writes)."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from app.logs.models import DeliveryLog


def _apply_partial_success_filter(q, partial_success: bool):
    """Restrict to run_complete rows with payload_sample.partial_success (PostgreSQL JSON text extract)."""

    q = q.filter(DeliveryLog.stage == "run_complete")
    txt = DeliveryLog.payload_sample["partial_success"].astext
    if partial_success:
        return q.filter(txt == "true")
    return q.filter(or_(txt == "false", txt.is_(None)))


def list_checkpoint_update_logs_for_stream(
    db: Session,
    stream_id: int,
    *,
    limit: int = 50,
) -> list[DeliveryLog]:
    """Recent checkpoint_update rows for checkpoint history API (read-only)."""

    lim = max(1, min(int(limit), 500))
    return (
        db.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == stream_id, DeliveryLog.stage == "checkpoint_update")
        .order_by(DeliveryLog.created_at.desc(), DeliveryLog.id.desc())
        .limit(lim)
        .all()
    )


def list_delivery_logs_by_run_id(
    db: Session,
    run_id: str,
    *,
    stream_id: int | None = None,
) -> list[DeliveryLog]:
    """All delivery_logs for a stream execution run, chronological order."""

    q = db.query(DeliveryLog).filter(DeliveryLog.run_id == run_id)
    if stream_id is not None:
        q = q.filter(DeliveryLog.stream_id == stream_id)
    return q.order_by(DeliveryLog.created_at.asc(), DeliveryLog.id.asc()).all()


_FAILURE_TREND_STAGES = (
    "route_send_failed",
    "route_retry_failed",
    "route_unknown_failure_policy",
    "source_rate_limited",
    "destination_rate_limited",
)


def list_delivery_logs_for_stream_between(
    db: Session,
    stream_id: int,
    *,
    start_at: datetime,
    end_at: datetime,
) -> list[DeliveryLog]:
    """All delivery_logs for stream_id with created_at in [start_at, end_at), ascending."""

    return (
        db.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.created_at >= start_at,
            DeliveryLog.created_at < end_at,
        )
        .order_by(DeliveryLog.created_at.asc(), DeliveryLog.id.asc())
        .all()
    )


def list_recent_delivery_logs_for_stream(db: Session, stream_id: int, *, limit: int) -> list[DeliveryLog]:
    """Return up to `limit` rows for stream_id ordered by created_at descending."""

    return (
        db.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == stream_id)
        .order_by(DeliveryLog.created_at.desc())
        .limit(limit)
        .all()
    )


def list_recent_delivery_logs_global(db: Session, *, limit: int) -> list[DeliveryLog]:
    """Return up to `limit` rows across all streams ordered by created_at descending."""

    return db.query(DeliveryLog).order_by(DeliveryLog.created_at.desc()).limit(limit).all()


def list_recent_delivery_logs_global_since(
    db: Session,
    *,
    since: datetime,
    limit: int,
) -> list[DeliveryLog]:
    """Recent rows with created_at >= since (descending, capped)."""

    lim = max(1, min(int(limit), 10_000))
    return (
        db.query(DeliveryLog)
        .filter(DeliveryLog.created_at >= since)
        .order_by(DeliveryLog.created_at.desc())
        .limit(lim)
        .all()
    )


def search_delivery_logs(
    db: Session,
    *,
    stream_id: int | None = None,
    route_id: int | None = None,
    destination_id: int | None = None,
    run_id: str | None = None,
    stage: str | None = None,
    level: str | None = None,
    status: str | None = None,
    error_code: str | None = None,
    partial_success: bool | None = None,
    created_at_since: datetime | None = None,
    limit: int = 100,
) -> list[DeliveryLog]:
    """Filter delivery_logs; order by created_at DESC, id DESC; read-only."""

    q = db.query(DeliveryLog)
    if created_at_since is not None:
        q = q.filter(DeliveryLog.created_at >= created_at_since)
    if run_id is not None:
        q = q.filter(DeliveryLog.run_id == run_id)
    if stream_id is not None:
        q = q.filter(DeliveryLog.stream_id == stream_id)
    if route_id is not None:
        q = q.filter(DeliveryLog.route_id == route_id)
    if destination_id is not None:
        q = q.filter(DeliveryLog.destination_id == destination_id)
    if stage is not None:
        q = q.filter(DeliveryLog.stage == stage)
    if level is not None:
        q = q.filter(DeliveryLog.level == level)
    if status is not None:
        q = q.filter(DeliveryLog.status == status)
    if error_code is not None:
        q = q.filter(DeliveryLog.error_code == error_code)
    if partial_success is not None:
        q = _apply_partial_success_filter(q, partial_success)

    return (
        q.order_by(DeliveryLog.created_at.desc(), DeliveryLog.id.desc()).limit(limit).all()
    )


def page_delivery_logs(
    db: Session,
    *,
    limit: int,
    stream_id: int | None = None,
    route_id: int | None = None,
    destination_id: int | None = None,
    run_id: str | None = None,
    stage: str | None = None,
    level: str | None = None,
    status: str | None = None,
    error_code: str | None = None,
    partial_success: bool | None = None,
    created_at_since: datetime | None = None,
    cursor_created_at: datetime | None = None,
    cursor_id: int | None = None,
) -> list[DeliveryLog]:
    """Cursor page: created_at DESC, id DESC; fetch up to limit+1 rows (read-only).

    Caller must pass cursor_created_at and cursor_id together or omit both.
    """

    q = db.query(DeliveryLog)
    if created_at_since is not None:
        q = q.filter(DeliveryLog.created_at >= created_at_since)
    if run_id is not None:
        q = q.filter(DeliveryLog.run_id == run_id)
    if stream_id is not None:
        q = q.filter(DeliveryLog.stream_id == stream_id)
    if route_id is not None:
        q = q.filter(DeliveryLog.route_id == route_id)
    if destination_id is not None:
        q = q.filter(DeliveryLog.destination_id == destination_id)
    if stage is not None:
        q = q.filter(DeliveryLog.stage == stage)
    if level is not None:
        q = q.filter(DeliveryLog.level == level)
    if status is not None:
        q = q.filter(DeliveryLog.status == status)
    if error_code is not None:
        q = q.filter(DeliveryLog.error_code == error_code)
    if partial_success is not None:
        q = _apply_partial_success_filter(q, partial_success)

    if cursor_created_at is not None and cursor_id is not None:
        q = q.filter(
            or_(
                DeliveryLog.created_at < cursor_created_at,
                and_(DeliveryLog.created_at == cursor_created_at, DeliveryLog.id < cursor_id),
            )
        )

    return (
        q.order_by(DeliveryLog.created_at.desc(), DeliveryLog.id.desc()).limit(limit + 1).all()
    )


def list_timeline_delivery_logs_for_stream(
    db: Session,
    stream_id: int,
    *,
    limit: int,
    stage: str | None = None,
    level: str | None = None,
    status: str | None = None,
    route_id: int | None = None,
    destination_id: int | None = None,
) -> list[DeliveryLog]:
    """Filter delivery_logs for one stream; order by created_at ASC, id ASC (read-only)."""

    q = db.query(DeliveryLog).filter(DeliveryLog.stream_id == stream_id)
    if route_id is not None:
        q = q.filter(DeliveryLog.route_id == route_id)
    if destination_id is not None:
        q = q.filter(DeliveryLog.destination_id == destination_id)
    if stage is not None:
        q = q.filter(DeliveryLog.stage == stage)
    if level is not None:
        q = q.filter(DeliveryLog.level == level)
    if status is not None:
        q = q.filter(DeliveryLog.status == status)

    # Select the newest bounded window first, then preserve the timeline API's
    # chronological (oldest-to-newest) response contract inside that window.
    rows = q.order_by(DeliveryLog.created_at.desc(), DeliveryLog.id.desc()).limit(limit).all()
    return list(reversed(rows))


def aggregate_failure_trend_buckets(
    db: Session,
    *,
    limit: int,
    stream_id: int | None = None,
    route_id: int | None = None,
    destination_id: int | None = None,
    created_at_since: datetime | None = None,
) -> list:
    """Group failure / rate-limit stages; order by latest_created_at DESC, count DESC (read-only)."""

    row_count = func.count(DeliveryLog.id).label("row_count")
    latest_created_at = func.max(DeliveryLog.created_at).label("latest_created_at")

    q = (
        db.query(
            DeliveryLog.stage,
            DeliveryLog.stream_id,
            DeliveryLog.route_id,
            DeliveryLog.destination_id,
            DeliveryLog.error_code,
            row_count,
            latest_created_at,
        )
        .filter(DeliveryLog.stage.in_(_FAILURE_TREND_STAGES))
    )
    if created_at_since is not None:
        q = q.filter(DeliveryLog.created_at >= created_at_since)
    if stream_id is not None:
        q = q.filter(DeliveryLog.stream_id == stream_id)
    if route_id is not None:
        q = q.filter(DeliveryLog.route_id == route_id)
    if destination_id is not None:
        q = q.filter(DeliveryLog.destination_id == destination_id)

    return (
        q.group_by(
            DeliveryLog.stage,
            DeliveryLog.stream_id,
            DeliveryLog.route_id,
            DeliveryLog.destination_id,
            DeliveryLog.error_code,
        )
        .order_by(latest_created_at.desc(), row_count.desc())
        .limit(limit)
        .all()
    )
