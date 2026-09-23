"""PostgreSQL-friendly batched deletes by ``created_at`` (or similar) ordering."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session
from sqlalchemy.sql import ColumnElement

_MAX_BATCH_ITERATIONS = 200
# Above this size, delivery_logs preview/cleanup must not COUNT(*).
_LARGE_DELIVERY_LOG_BYTES = 1_073_741_824


def _is_delivery_log_model(model: type) -> bool:
    return str(getattr(model, "__tablename__", "")) == "delivery_logs"


def delivery_logs_total_bytes(db: Session) -> int | None:
    """Catalog size of ``delivery_logs`` including partitions. None when unavailable."""

    try:
        val = db.execute(text("SELECT pg_total_relation_size('delivery_logs'::regclass)")).scalar()
        return int(val) if val is not None else None
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass
        return None


def delivery_logs_requires_bounded_count(db: Session) -> bool:
    """True when a full ``delivery_logs`` count would scan a large partition tree."""

    size = delivery_logs_total_bytes(db)
    return size is not None and size >= _LARGE_DELIVERY_LOG_BYTES


def estimate_delivery_logs_eligible(
    db: Session,
    *,
    cutoff: datetime,
) -> tuple[int, datetime | None]:
    """Estimate rows older than ``cutoff`` from partition catalog stats.

    Whole months before the cutoff contribute ``pg_class.reltuples``. The month
    that contains the cutoff contributes its reltuples as an upper bound. This
    never runs ``COUNT(*)``.
    """

    from app.db.delivery_log_partitions import list_delivery_log_monthly_partitions

    if cutoff.tzinfo is None:
        cutoff = cutoff.replace(tzinfo=timezone.utc)
    else:
        cutoff = cutoff.astimezone(timezone.utc)
    cutoff_day = cutoff.date()
    total = 0
    oldest: datetime | None = None
    for name, month_start in list_delivery_log_monthly_partitions(db):
        if month_start >= cutoff_day:
            continue
        est = db.execute(
            text("SELECT GREATEST(reltuples::bigint, 0) FROM pg_class WHERE oid = :rel::regclass"),
            {"rel": name},
        ).scalar()
        total += int(est or 0)
        month_dt = datetime(month_start.year, month_start.month, month_start.day, tzinfo=timezone.utc)
        if oldest is None or month_dt < oldest:
            oldest = month_dt
    return total, oldest


def eligible_count_and_oldest(
    db: Session,
    *,
    model: type,
    time_column: Any,
    cutoff: datetime,
    extra: ColumnElement[bool] | None = None,
) -> tuple[int, datetime | None]:
    """Return ``(count, min(timestamp))`` for rows strictly older than ``cutoff``.

    Large ``delivery_logs`` trees use a partition estimate instead of ``COUNT(*)``.
    """

    if _is_delivery_log_model(model) and extra is None and delivery_logs_requires_bounded_count(db):
        return estimate_delivery_logs_eligible(db, cutoff=cutoff)

    flt = time_column < cutoff
    if extra is not None:
        flt = flt & extra
    cnt = int(db.query(model).filter(flt).count())
    if cnt == 0:
        return 0, None
    oldest = db.scalar(select(func.min(time_column)).where(flt))
    return cnt, oldest


def _delete_batches(
    db: Session,
    *,
    model: type,
    time_column: Any,
    flt: ColumnElement[bool],
    batch_size: int,
    max_deleted: int | None,
) -> tuple[int, bool]:
    """Delete up to ``max_deleted`` rows. Returns ``(deleted, more_remain)``."""

    total_deleted = 0
    iterations = 0
    pk = getattr(model, "id")
    cap = None if max_deleted is None else max(0, int(max_deleted))
    while iterations < _MAX_BATCH_ITERATIONS:
        if cap is not None and total_deleted >= cap:
            break
        iterations += 1
        room = max(1, int(batch_size))
        if cap is not None:
            room = min(room, cap - total_deleted)
            if room <= 0:
                break
        ids_subq = (
            select(pk)
            .where(flt)
            .order_by(time_column.asc(), pk.asc())
            .limit(room)
            .scalar_subquery()
        )
        deleted = db.query(model).filter(pk.in_(ids_subq)).delete(synchronize_session=False)
        if deleted is None:
            deleted = 0
        if deleted <= 0:
            return total_deleted, False
        total_deleted += int(deleted)
        db.commit()
        if int(deleted) < room:
            return total_deleted, False
    more = db.scalar(select(pk).where(flt).limit(1)) is not None
    return total_deleted, more


def batch_delete_by_time_before(
    db: Session,
    *,
    model: type,
    time_column: Any,
    cutoff: datetime,
    batch_size: int,
    dry_run: bool,
    extra: ColumnElement[bool] | None = None,
    max_deleted: int | None = None,
) -> tuple[int, int]:
    """Delete rows with ``time_column < cutoff`` in batches of at most ``batch_size``.

    Returns ``(matched_count, deleted_count)``. ``max_deleted`` caps rows removed
    in this call. Large ``delivery_logs`` relations skip the pre-delete
    ``COUNT(*)`` and report a partition estimate (dry-run) or the bounded
    deleted count plus a one-row existence probe (execute).

    Each delete batch is committed separately to avoid long table locks. On any
    exception the caller should ``rollback`` the session — this function does
    not swallow DB errors.
    """

    flt = time_column < cutoff
    if extra is not None:
        flt = flt & extra
    cap = None if max_deleted is None else max(0, int(max_deleted))
    if cap == 0:
        return 0, 0

    bounded = _is_delivery_log_model(model) and extra is None and delivery_logs_requires_bounded_count(db)
    if bounded:
        if dry_run:
            matched, _oldest = estimate_delivery_logs_eligible(db, cutoff=cutoff)
            if cap is not None:
                matched = min(matched, cap)
            return matched, 0
        deleted, more = _delete_batches(
            db,
            model=model,
            time_column=time_column,
            flt=flt,
            batch_size=batch_size,
            max_deleted=cap,
        )
        return deleted + (1 if more else 0), deleted

    matched_count = int(db.query(model).filter(flt).count())
    if dry_run or matched_count == 0:
        if cap is not None:
            matched_count = min(matched_count, cap)
        return matched_count, 0

    deleted, _more = _delete_batches(
        db,
        model=model,
        time_column=time_column,
        flt=flt,
        batch_size=batch_size,
        max_deleted=cap if cap is not None else matched_count,
    )
    return matched_count, deleted


__all__ = [
    "_LARGE_DELIVERY_LOG_BYTES",
    "_MAX_BATCH_ITERATIONS",
    "batch_delete_by_time_before",
    "delivery_logs_requires_bounded_count",
    "delivery_logs_total_bytes",
    "eligible_count_and_oldest",
    "estimate_delivery_logs_eligible",
]
