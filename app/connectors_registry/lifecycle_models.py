"""SQLAlchemy model: platform-owned Marketplace package install lifecycle."""

from __future__ import annotations

from sqlalchemy import DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, utcnow

LIFECYCLE_STATUS_INSTALLED = "INSTALLED"
LIFECYCLE_STATUS_FAILED = "FAILED"
LIFECYCLE_STATUS_REMOVED = "REMOVED"

LIFECYCLE_STATUSES: tuple[str, ...] = (
    LIFECYCLE_STATUS_INSTALLED,
    LIFECYCLE_STATUS_FAILED,
    LIFECYCLE_STATUS_REMOVED,
)

# Platform-derived acquisition origin for M29.3 local upload installs.
LIFECYCLE_ORIGIN_UPLOAD = "upload"

PACKAGE_FORMAT_TAR_GZ = "tar.gz"


class MarketplacePackageInstall(Base):
    """Platform-owned install record (not declared by package manifests)."""

    __tablename__ = "marketplace_package_installs"

    package_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    package_kind: Mapped[str] = mapped_column(String(64), nullable=False)
    pack_version: Mapped[str] = mapped_column(String(128), nullable=False)
    origin: Mapped[str] = mapped_column(String(64), nullable=False, default=LIFECYCLE_ORIGIN_UPLOAD)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default=LIFECYCLE_STATUS_INSTALLED)
    digest: Mapped[str] = mapped_column(String(128), nullable=False)
    installed_path: Mapped[str] = mapped_column(Text, nullable=False)
    previous_version: Mapped[str | None] = mapped_column(String(128), nullable=True)
    previous_digest: Mapped[str | None] = mapped_column(String(128), nullable=True)
    installed_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[DateTime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow
    )
