"""SQLAlchemy model: DeliveryLog — structured failure and pipeline logs."""

import logging
from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text, event, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Mapped, mapped_column

from app.db.delivery_log_partitions import add_month, month_floor, partition_name
from app.database import Base, utcnow

logger = logging.getLogger(__name__)
_ENSURED_PARTITION_MONTHS: set[str] = set()


class DeliveryLog(Base):
    """Structured logs including failure details (master design §19.9)."""

    __tablename__ = "delivery_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    connector_id: Mapped[int | None] = mapped_column(ForeignKey("connectors.id"), nullable=True)
    stream_id: Mapped[int | None] = mapped_column(ForeignKey("streams.id"), nullable=True)
    route_id: Mapped[int | None] = mapped_column(ForeignKey("routes.id"), nullable=True)
    destination_id: Mapped[int | None] = mapped_column(ForeignKey("destinations.id"), nullable=True)
    stage: Mapped[str] = mapped_column(String(64), nullable=False)
    level: Mapped[str] = mapped_column(String(16), nullable=False, default="INFO")
    status: Mapped[str | None] = mapped_column(String(64), nullable=True)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    payload_sample: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    http_status: Mapped[int | None] = mapped_column(Integer, nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(128), nullable=True)
    run_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    batch_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    policy_action: Mapped[str | None] = mapped_column(String(64), nullable=True)
    decision_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    delivery_disposition: Mapped[str | None] = mapped_column(String(64), nullable=True)
    skip_reason: Mapped[str | None] = mapped_column(String(128), nullable=True)
    quarantine_event_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


@event.listens_for(DeliveryLog, "before_insert")
def _ensure_delivery_log_partition_for_insert(_mapper, connection, target: DeliveryLog) -> None:
    """Best-effort future partition creation for unusual inserted timestamps."""

    created_at = target.created_at
    if created_at is None:
        created_at = utcnow()
        target.created_at = created_at
    if not isinstance(created_at, datetime):
        return
    month_start = month_floor(created_at)
    month_key = month_start.isoformat()
    if month_key in _ENSURED_PARTITION_MONTHS:
        return
    try:
        month_end = add_month(month_start)
        name = partition_name(month_start)
        connection.execute(
            text(
                f"""
                CREATE TABLE IF NOT EXISTS {name}
                PARTITION OF delivery_logs
                FOR VALUES FROM ('{month_start.isoformat()} 00:00:00+00')
                TO ('{month_end.isoformat()} 00:00:00+00')
                """
            )
        )
        _ENSURED_PARTITION_MONTHS.add(month_key)
    except SQLAlchemyError as exc:
        logger.warning(
            "%s",
            {
                "stage": "delivery_log_partition_insert_ensure_failed",
                "partition_month": month_start.isoformat(),
                "error_type": type(exc).__name__,
                "message": str(exc)[:500],
            },
        )
