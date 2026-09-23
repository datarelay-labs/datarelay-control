"""PostgreSQL partition management for delivery_logs."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)
_PARTITION_RE = re.compile(r"^delivery_logs_(\d{4})_(\d{2})$")


def month_floor(value: date | datetime) -> date:
    """Return the first day of the UTC month for a date/datetime."""

    if isinstance(value, datetime):
        if value.tzinfo is not None:
            value = value.astimezone(timezone.utc)
        value = value.date()
    return date(value.year, value.month, 1)


def add_month(value: date) -> date:
    """Return the first day of the following month."""

    if value.month == 12:
        return date(value.year + 1, 1, 1)
    return date(value.year, value.month + 1, 1)


def partition_name(month_start: date) -> str:
    """Return the canonical monthly partition name."""

    return f"delivery_logs_{month_start.year:04d}_{month_start.month:02d}"


@dataclass(frozen=True)
class DeliveryLogPartitionDropTarget:
    """A monthly delivery_logs partition that is safe to drop as a whole."""

    partition_name: str
    month_start: date
    month_end: date
    row_count: int
    cutoff_utc: datetime


def partition_month_from_name(name: str) -> date | None:
    """Parse canonical ``delivery_logs_YYYY_MM`` names; ignore default/unknown partitions."""

    match = _PARTITION_RE.match(str(name))
    if not match:
        return None
    year = int(match.group(1))
    month = int(match.group(2))
    if month < 1 or month > 12:
        return None
    return date(year, month, 1)


def protected_partition_months(reference_time: date | datetime | None = None) -> set[date]:
    """Return months that retention must never drop: current and next month."""

    current = month_floor(reference_time or datetime.now(timezone.utc))
    return {current, add_month(current)}


def quote_delivery_log_partition_ident(name: str) -> str:
    """Quote a canonical monthly partition name for safe DDL/SQL."""

    if not _PARTITION_RE.match(name):
        raise ValueError(f"unexpected delivery_logs partition name: {name}")
    return '"' + name.replace('"', '""') + '"'


def _quote_ident(name: str) -> str:
    return quote_delivery_log_partition_ident(name)


def list_delivery_log_monthly_partitions(db: Session) -> list[tuple[str, date]]:
    """List canonical monthly child partitions for ``delivery_logs``."""

    rows = db.execute(
        text(
            """
            SELECT child.relname
            FROM pg_inherits
            JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
            JOIN pg_class child ON child.oid = pg_inherits.inhrelid
            WHERE parent.relname = 'delivery_logs'
            ORDER BY child.relname
            """
        )
    ).fetchall()
    out: list[tuple[str, date]] = []
    for row in rows:
        name = str(row[0])
        month_start = partition_month_from_name(name)
        if month_start is not None:
            out.append((name, month_start))
    return out


def _partition_row_count(db: Session, name: str) -> int:
    """Exact ``COUNT(*)`` for small partitions; catalog estimate for large ones."""

    from app.retention.batch import _LARGE_DELIVERY_LOG_BYTES

    quoted = _quote_ident(name)
    try:
        size = db.execute(text(f"SELECT pg_total_relation_size('{name}'::regclass)")).scalar()
    except Exception:
        size = None
    if size is not None and int(size) >= _LARGE_DELIVERY_LOG_BYTES:
        est = db.execute(
            text("SELECT GREATEST(reltuples::bigint, 0) FROM pg_class WHERE oid = :rel::regclass"),
            {"rel": name},
        ).scalar()
        return int(est or 0)
    return int(db.execute(text(f"SELECT count(*) FROM {quoted}")).scalar() or 0)


def calculate_delivery_log_partition_drop_targets(
    db: Session,
    *,
    retention_days: int,
    now: date | datetime | None = None,
) -> list[DeliveryLogPartitionDropTarget]:
    """Return whole-month partitions older than retention and outside protected months.

    A partition is eligible only when its upper bound is at or before the first
    day of the cutoff month. This avoids dropping a month that may contain rows
    newer than the retention cutoff. Current and next month are always excluded.
    """

    ref = now or datetime.now(timezone.utc)
    if isinstance(ref, date) and not isinstance(ref, datetime):
        cutoff = datetime(ref.year, ref.month, ref.day, tzinfo=timezone.utc)
    else:
        cutoff = ref if isinstance(ref, datetime) else datetime.now(timezone.utc)
        if cutoff.tzinfo is None:
            cutoff = cutoff.replace(tzinfo=timezone.utc)
        cutoff = cutoff.astimezone(timezone.utc)
    cutoff = cutoff - timedelta(days=max(1, int(retention_days)))
    cutoff_month = month_floor(cutoff)
    protected = protected_partition_months(ref)

    targets: list[DeliveryLogPartitionDropTarget] = []
    for name, month_start in list_delivery_log_monthly_partitions(db):
        month_end = add_month(month_start)
        if month_start in protected:
            continue
        if month_end > cutoff_month:
            continue
        row_count = _partition_row_count(db, name)
        targets.append(
            DeliveryLogPartitionDropTarget(
                partition_name=name,
                month_start=month_start,
                month_end=month_end,
                row_count=row_count,
                cutoff_utc=cutoff,
            )
        )
    return targets


def drop_delivery_log_partitions(
    db: Session,
    targets: list[DeliveryLogPartitionDropTarget],
    *,
    now: date | datetime | None = None,
) -> int:
    """Drop previously calculated monthly partitions and return their row count.

    The caller is responsible for the higher-level retention execution guard.
    This function still re-checks the current/next month protection before every
    DROP TABLE statement.
    """

    protected = protected_partition_months(now)
    dropped_rows = 0
    for target in targets:
        if target.month_start in protected:
            raise ValueError(f"refusing to drop protected delivery_logs partition: {target.partition_name}")
        _quote_ident(target.partition_name)
        if partition_month_from_name(target.partition_name) != target.month_start:
            raise ValueError(f"delivery_logs partition target metadata mismatch: {target.partition_name}")
        db.execute(text(f"DROP TABLE IF EXISTS {_quote_ident(target.partition_name)}"))
        dropped_rows += int(target.row_count)
    return dropped_rows


def ensure_delivery_log_partition(db: Session, month_start: date) -> str:
    """Create one monthly partition if it is missing and return its name."""

    start = month_floor(month_start)
    end = add_month(start)
    name = partition_name(start)
    db.execute(
        text(
            f"""
            CREATE TABLE IF NOT EXISTS {name}
            PARTITION OF delivery_logs
            FOR VALUES FROM ('{start.isoformat()} 00:00:00+00')
            TO ('{end.isoformat()} 00:00:00+00')
            """
        )
    )
    return name


def ensure_delivery_log_default_partition(db: Session) -> str:
    """Create the default safety partition used when a monthly partition is missing."""

    db.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS delivery_logs_default
            PARTITION OF delivery_logs DEFAULT
            """
        )
    )
    return "delivery_logs_default"


def ensure_delivery_log_partitions(
    db: Session,
    *,
    start_month: date | datetime | None = None,
    months_ahead: int = 1,
) -> list[str]:
    """Ensure current and future monthly partitions exist.

    The function is additive only. It never detaches, truncates, or drops existing partitions.
    """

    current = month_floor(start_month or datetime.now(timezone.utc))
    count = max(0, int(months_ahead)) + 1
    out: list[str] = []
    month = current
    for _ in range(count):
        out.append(ensure_delivery_log_partition(db, month))
        month = add_month(month)
    out.append(ensure_delivery_log_default_partition(db))
    return out


def ensure_delivery_log_partitions_gracefully(months_ahead: int = 1) -> list[str]:
    """Startup-safe partition ensure using its own transaction.

    Failures are logged and swallowed so API startup is not blocked by a permissions
    or schema-readiness problem. Runtime inserts still depend on the migration-created
    partitioned table and future partition creation.
    """

    from app.database import SessionLocal

    db = SessionLocal()
    try:
        names = ensure_delivery_log_partitions(db, months_ahead=months_ahead)
        db.commit()
        logger.info("%s", {"stage": "delivery_log_partitions_ensured", "partitions": names})
        return names
    except SQLAlchemyError as exc:
        db.rollback()
        logger.warning(
            "%s",
            {
                "stage": "delivery_log_partitions_ensure_failed",
                "error_type": type(exc).__name__,
                "message": str(exc)[:500],
            },
        )
        return []
    finally:
        db.close()


__all__ = [
    "DeliveryLogPartitionDropTarget",
    "add_month",
    "calculate_delivery_log_partition_drop_targets",
    "drop_delivery_log_partitions",
    "ensure_delivery_log_default_partition",
    "ensure_delivery_log_partition",
    "ensure_delivery_log_partitions",
    "ensure_delivery_log_partitions_gracefully",
    "list_delivery_log_monthly_partitions",
    "month_floor",
    "partition_month_from_name",
    "partition_name",
    "protected_partition_months",
]
