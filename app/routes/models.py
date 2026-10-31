"""SQLAlchemy model: Route."""

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, utcnow


class Route(Base):
    """Connects stream to destination with route-level policy (master design §19.7)."""

    __tablename__ = "routes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    stream_id: Mapped[int] = mapped_column(ForeignKey("streams.id"), nullable=False)
    destination_id: Mapped[int] = mapped_column(ForeignKey("destinations.id"), nullable=False)
    # Optional operator label. NULL keeps the "Route #<id>" identity used everywhere else.
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    description: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    failure_policy: Mapped[str] = mapped_column(String(64), nullable=False, default="LOG_AND_CONTINUE")
    formatter_config_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    rate_limit_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    status: Mapped[str] = mapped_column(String(64), nullable=False, default="ENABLED")
    disable_reason: Mapped[str | None] = mapped_column(String(512), nullable=True)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[DateTime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow
    )

    stream = relationship("Stream", back_populates="routes")
    destination = relationship("Destination", back_populates="routes")
    route_mapping = relationship("RouteMapping", back_populates="route", uselist=False)
    route_enrichment = relationship("RouteEnrichment", back_populates="route", uselist=False)


# Register route-scoped transform models so SQLAlchemy resolves string relationships.
import app.route_transform.models  # noqa: F401, E402
