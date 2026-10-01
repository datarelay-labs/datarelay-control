"""Pydantic schemas for Marketplace package lifecycle APIs."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class MarketplacePackageInstallRead(BaseModel):
    """Platform-owned install lifecycle record."""

    package_id: str
    package_kind: str
    pack_version: str
    origin: str
    status: str
    digest: str
    installed_path: str
    previous_version: str | None = None
    previous_digest: str | None = None
    installed_at: datetime
    updated_at: datetime


class MarketplacePackageListResponse(BaseModel):
    """Installed packages listing envelope."""

    packages: list[MarketplacePackageInstallRead] = Field(default_factory=list)
    count: int = 0
