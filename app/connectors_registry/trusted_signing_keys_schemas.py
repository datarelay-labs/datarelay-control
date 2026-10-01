"""Pydantic schemas for Marketplace trusted signing key APIs."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class TrustedSigningKeyCreate(BaseModel):
    key_id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=255)
    public_key: str = Field(min_length=1)
    publisher: str | None = Field(default=None, max_length=255)
    enabled: bool = True


class TrustedSigningKeyUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    publisher: str | None = Field(default=None, max_length=255)
    enabled: bool | None = None
    # public_key rotation allowed for administrators; never accept private keys.
    public_key: str | None = Field(default=None, min_length=1)


class TrustedSigningKeyRead(BaseModel):
    key_id: str
    name: str
    public_key: str
    publisher: str | None = None
    enabled: bool
    created_at: datetime
    updated_at: datetime


class TrustedSigningKeyListResponse(BaseModel):
    keys: list[TrustedSigningKeyRead] = Field(default_factory=list)
    count: int = 0
