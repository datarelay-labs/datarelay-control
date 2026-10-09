"""Shared platform JWT session bundle builder (local login)."""

from __future__ import annotations

from datetime import datetime, timezone

from pydantic import BaseModel, Field

from app.auth.jwt_service import issue_access_token, issue_refresh_token
from app.auth.route_access import build_capabilities


class SessionUser(BaseModel):
    username: str
    role: str
    status: str
    must_change_password: bool = False
    capabilities: dict[str, bool] = Field(default_factory=dict)


class TokenBundle(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int
    expires_at: str
    user: SessionUser


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def build_token_bundle(
    *,
    user_id: int,
    username: str,
    role: str,
    token_version: int,
    user_status: str,
    must_change_password: bool = False,
    mfa_verified: bool = False,
) -> TokenBundle:
    access, access_exp = issue_access_token(
        username=username,
        user_id=user_id,
        role=role,
        token_version=token_version,
        must_change_password=must_change_password,
        mfa_verified=mfa_verified,
    )
    refresh, _refresh_exp = issue_refresh_token(
        username=username,
        user_id=user_id,
        role=role,
        token_version=token_version,
        must_change_password=must_change_password,
        mfa_verified=mfa_verified,
    )
    expires_in = max(1, int((access_exp - _utcnow()).total_seconds()))
    return TokenBundle(
        access_token=access,
        refresh_token=refresh,
        token_type="bearer",
        expires_in=expires_in,
        expires_at=access_exp.isoformat(),
        user=SessionUser(
            username=username,
            role=role,
            status=user_status,
            must_change_password=must_change_password,
            capabilities=build_capabilities(role),
        ),
    )
