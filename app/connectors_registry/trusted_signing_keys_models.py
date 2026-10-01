"""SQLAlchemy model: platform-owned Marketplace trusted signing public keys."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, utcnow


class MarketplaceTrustedSigningKey(Base):
    """Trusted Ed25519 public key used to verify Marketplace package signatures.

    Private keys MUST NEVER be stored here or elsewhere in Data Relay package
    / server persistence for Marketplace signing.
    """

    __tablename__ = "marketplace_trusted_signing_keys"

    key_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    public_key: Mapped[str] = mapped_column(Text, nullable=False)
    publisher: Mapped[str | None] = mapped_column(String(255), nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow
    )
