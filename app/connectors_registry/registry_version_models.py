"""SQLAlchemy model: connector registry cache generation (M29.4)."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, CheckConstraint, DateTime, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, utcnow

REGISTRY_VERSION_SINGLETON_ID = 1


class ConnectorRegistryVersion(Base):
    """Singleton row tracking registry cache generation across processes."""

    __tablename__ = "connector_registry_version"
    __table_args__ = (
        CheckConstraint("id = 1", name="ck_connector_registry_version_singleton"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=REGISTRY_VERSION_SINGLETON_ID)
    generation: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow
    )
