"""Stream-scoped replay events (protected delivery payload snapshots)."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

REPLAY_STATUS_PENDING = "pending"
REPLAY_STATUS_REPLAYING = "replaying"
REPLAY_STATUS_REPLAYED = "replayed"
REPLAY_STATUS_FAILED = "failed"
REPLAY_STATUS_DISCARDED = "discarded"

REPLAY_STATUSES = frozenset(
    {
        REPLAY_STATUS_PENDING,
        REPLAY_STATUS_REPLAYING,
        REPLAY_STATUS_REPLAYED,
        REPLAY_STATUS_FAILED,
        REPLAY_STATUS_DISCARDED,
    }
)

REPLAY_TERMINAL_STATUSES = frozenset({REPLAY_STATUS_REPLAYED, REPLAY_STATUS_DISCARDED})

# Claim / attempt metadata lives in delivery_context_json["delivery_attempt"] —
# no schema migration required (status String(16) already fits "replaying").
DELIVERY_ATTEMPT_CONTEXT_KEY = "delivery_attempt"
REPLAY_DELIVERY_GUARANTEE_AT_LEAST_ONCE = "at_least_once"

# Replay provenance must be explicit. Historical "nearest earlier quarantine on the
# same stream" inference can attach an unrelated delivery failure to a violation.
REPLAY_CONTEXT_ORIGIN_KEY = "replay_origin"
REPLAY_CONTEXT_ORIGIN_DELIVERY_FAILURE = "delivery_failure"
REPLAY_CONTEXT_ORIGIN_QUARANTINE = "quarantine"
REPLAY_CONTEXT_QUARANTINE_EVENT_ID_KEY = "quarantine_event_id"


def replay_quarantine_event_id(row: "StreamReplayEvent") -> int | None:
    context = row.delivery_context_json if isinstance(row.delivery_context_json, dict) else {}
    if str(context.get(REPLAY_CONTEXT_ORIGIN_KEY) or "").strip().lower() != REPLAY_CONTEXT_ORIGIN_QUARANTINE:
        return None
    raw = context.get(REPLAY_CONTEXT_QUARANTINE_EVENT_ID_KEY)
    try:
        quarantine_id = int(raw)
    except (TypeError, ValueError):
        return None
    return quarantine_id if quarantine_id > 0 else None

DELIVERY_KIND_BASE_ROUTE = "base_route"
DELIVERY_KIND_FAILOVER_SECONDARY = "failover_secondary"
DELIVERY_KIND_DYNAMIC_ROUTE = "dynamic_route"

DELIVERY_KINDS = frozenset(
    {
        DELIVERY_KIND_BASE_ROUTE,
        DELIVERY_KIND_FAILOVER_SECONDARY,
        DELIVERY_KIND_DYNAMIC_ROUTE,
    }
)


class StreamReplayEvent(Base):
    __tablename__ = "stream_replay_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    stream_id: Mapped[int] = mapped_column(ForeignKey("streams.id", ondelete="CASCADE"), nullable=False)
    destination_id: Mapped[int] = mapped_column(ForeignKey("destinations.id", ondelete="RESTRICT"), nullable=False)
    route_id: Mapped[int | None] = mapped_column(ForeignKey("routes.id", ondelete="SET NULL"), nullable=True)
    dynamic_route_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    failover_route_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    delivery_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=REPLAY_STATUS_PENDING)
    protected_payload_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    delivery_context_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    error_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    event_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    last_replay_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
