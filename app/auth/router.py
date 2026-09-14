"""Auth HTTP routes — local platform_users login + JWT session (spec 020).

Replaces the spec 019 ``X-GDC-Role`` header trust with a real JWT login.
Tokens are signed HS256 with ``settings.JWT_SECRET_KEY``.  Access tokens are
short-lived; refresh tokens last longer (24 h by default).  Invalidation is
achieved by bumping ``platform_users.token_version`` (no DB revocation list).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field, ValidationInfo, field_validator
from sqlalchemy.orm import Session

from app.auth.password_policy import validate_new_platform_password
from app.auth.jwt_service import (
    AuthTokenError,
    TOKEN_TYPE_REFRESH,
    TokenClaims,
    decode_token,
)
from app.auth.login_throttle import (
    check_login_allowed,
    client_ip_from_request,
    record_login_failure,
    record_login_success,
)
from app.auth.route_access import build_capabilities
from app.auth.role_guard import (
    KNOWN_ROLES,
    ROLE_ADMINISTRATOR,
    resolve_auth_context,
)
from app.auth.token_bundle import TokenBundle, build_token_bundle
from app.auth.security import get_password_hash, verify_password
from app.config import settings
from app.database import get_db
from app.platform_admin import journal
from app.platform_admin.repository import get_display_settings_row, get_user_by_id, get_user_by_username

logger = logging.getLogger(__name__)

router = APIRouter()


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=256)


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=10)


class LogoutRequest(BaseModel):
    revoke_all: bool = False


class WhoAmIResponse(BaseModel):
    username: str
    role: str
    authenticated: bool
    must_change_password: bool = False
    token_expires_at: str | None = None
    capabilities: dict[str, bool] = Field(default_factory=dict)
    timezone: str | None = None
    platform_default_timezone: str = "UTC"


class SelfProfileUpdate(BaseModel):
    timezone: str | None = Field(default=None, max_length=64)

    @field_validator("timezone")
    @classmethod
    def _tz_ok(cls, v: str | None) -> str | None:
        if v is None or not str(v).strip():
            return None
        from app.platform_admin.timezone_util import validate_iana_timezone

        return validate_iana_timezone(v)


class SelfPasswordChangeRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=1, max_length=256)
    confirm_new_password: str = Field(min_length=1, max_length=256)

    @field_validator("confirm_new_password")
    @classmethod
    def _new_passwords_match(cls, v: str, info: ValidationInfo) -> str:
        if info.data.get("new_password") != v:
            raise ValueError("new_password and confirm_new_password do not match")
        return v


class SelfPasswordChangeResponse(BaseModel):
    ok: bool = True
    message: str = "Password updated. Please sign in again."


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _normalize_role(raw: str | None) -> str:
    v = (raw or "").strip().upper()
    return v if v in KNOWN_ROLES else ROLE_ADMINISTRATOR


def _auth_error(code: str, message: str, http_status: int = status.HTTP_401_UNAUTHORIZED) -> HTTPException:
    return HTTPException(
        status_code=http_status,
        detail={"error_code": code, "message": message},
        headers={"WWW-Authenticate": "Bearer"},
    )


@router.post("/login", response_model=TokenBundle)
def login(payload: LoginRequest, request: Request, db: Session = Depends(get_db)) -> TokenBundle:
    """Verify credentials and return an access + refresh JWT pair.

    On failure we always return ``USER_AUTH_FAILED`` with HTTP 400 so the
    client cannot tell whether the username exists.  Successful logins record
    a ``USER_LOGIN`` audit event and update ``last_login_at``.
    """

    username = (payload.username or "").strip()
    ip = client_ip_from_request(request)
    check_login_allowed(username=username, ip=ip)
    user = get_user_by_username(db, username)
    if user is None or user.status != "ACTIVE" or not verify_password(payload.password, user.password_hash):
        record_login_failure(username=username, ip=ip)
        journal.record_audit_event(
            db,
            action="USER_LOGIN_FAILED",
            actor_username=username or None,
            entity_type="PLATFORM_USER",
            entity_id=int(user.id) if user is not None else None,
            result="failure",
            details={"reason": "invalid_credentials"},
            request=request,
        )
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error_code": "USER_AUTH_FAILED", "message": "Invalid username or password."},
        )

    role = _normalize_role(user.role)
    user.last_login_at = _utcnow()
    token_version = int(getattr(user, "token_version", 1) or 1)
    must_change = bool(getattr(user, "must_change_password", False))
    journal.record_audit_event(
        db,
        action="USER_LOGIN",
        actor_username=username,
        actor_user_id=int(user.id),
        entity_type="PLATFORM_USER",
        entity_id=int(user.id),
        entity_name=username,
        details={"role": role, "session": "jwt"},
        request=request,
    )
    db.commit()
    record_login_success(username=username, ip=ip)
    return build_token_bundle(
        user_id=int(user.id),
        username=username,
        role=role,
        token_version=token_version,
        user_status=str(user.status),
        must_change_password=must_change,
    )


@router.post("/refresh", response_model=TokenBundle)
def refresh(payload: RefreshRequest, db: Session = Depends(get_db)) -> TokenBundle:
    """Exchange a valid refresh JWT for a fresh access + refresh pair.

    Refresh tokens are single-use: a successful refresh bumps
    ``platform_users.token_version`` so the presented refresh JWT cannot be
    replayed. Access-token middleware still honors access TTL without a live
    ``token_version`` check (existing product contract).
    """

    try:
        claims: TokenClaims = decode_token(payload.refresh_token, expected_type=TOKEN_TYPE_REFRESH)
    except AuthTokenError as exc:
        raise _auth_error(exc.code, exc.message) from exc

    user = get_user_by_id(db, claims.user_id)
    if user is None or user.status != "ACTIVE":
        raise _auth_error("AUTH_USER_INACTIVE", "Account is inactive or removed.")
    if int(getattr(user, "token_version", 1) or 1) != claims.token_version:
        raise _auth_error("AUTH_TOKEN_REVOKED", "Refresh token was already used or revoked; please sign in again.")

    role = _normalize_role(user.role)
    must_change = bool(getattr(user, "must_change_password", False))
    # Consume this refresh token (and any sibling refresh JWTs at the same tv).
    user.token_version = int(getattr(user, "token_version", 1) or 1) + 1
    new_tv = int(user.token_version)
    journal.record_audit_event(
        db,
        action="USER_TOKEN_REFRESHED",
        actor_username=str(user.username),
        entity_type="PLATFORM_USER",
        entity_id=int(user.id),
        entity_name=str(user.username),
        details={"role": role, "refresh_rotated": True},
    )
    db.commit()
    return build_token_bundle(
        user_id=int(user.id),
        username=str(user.username),
        role=role,
        token_version=new_tv,
        user_status=str(user.status),
        must_change_password=must_change,
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    request: Request,
    payload: LogoutRequest | None = Body(default=None),
    db: Session = Depends(get_db),
) -> None:
    """Best-effort logout.

    The client always discards its tokens after calling this endpoint.  When
    ``revoke_all`` is true, we additionally bump ``platform_users.token_version``
    so previously issued refresh tokens (and any other concurrent sessions) are
    rejected on their next use.  Logout is idempotent — calling it without a
    valid bearer token still returns 204.
    """

    ctx = resolve_auth_context(request)
    revoke_all = bool(payload.revoke_all) if payload else False
    if ctx.source == "jwt" and ctx.user_id is not None:
        user = get_user_by_id(db, ctx.user_id)
        if user is not None:
            details = {"revoke_all": revoke_all, "role": ctx.role}
            if revoke_all:
                user.token_version = int(getattr(user, "token_version", 1) or 1) + 1
            journal.record_audit_event(
                db,
                action="USER_LOGOUT",
                actor_username=str(user.username),
                entity_type="PLATFORM_USER",
                entity_id=int(user.id),
                entity_name=str(user.username),
                details=details,
            )
            db.commit()
    return None


@router.post("/change-password", response_model=SelfPasswordChangeResponse)
def change_own_password(
    request: Request,
    payload: SelfPasswordChangeRequest,
    db: Session = Depends(get_db),
) -> SelfPasswordChangeResponse:
    """Rotate password for the authenticated principal (spec 039).

    Requires the current password, rejects the weak default ``admin`` as a new
    password, clears ``must_change_password``, bumps ``token_version`` (JWTs
    must be re-issued via a fresh login).
    """

    ctx = resolve_auth_context(request)
    if ctx.source != "jwt" or ctx.user_id is None:
        raise _auth_error("AUTH_REQUIRED", "Authentication is required for this endpoint.")
    user = get_user_by_id(db, int(ctx.user_id))
    if user is None or user.status != "ACTIVE":
        raise _auth_error("AUTH_USER_INACTIVE", "Account is inactive or removed.")
    if int(getattr(user, "token_version", 1) or 1) != (ctx.token_version or 0):
        raise _auth_error("AUTH_TOKEN_REVOKED", "Session was invalidated; please sign in again.")

    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error_code": "USER_AUTH_FAILED", "message": "Current password is incorrect."},
        )

    try:
        validate_new_platform_password(payload.new_password)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error_code": "PASSWORD_POLICY_REJECTED", "message": str(exc)},
        ) from exc

    user.password_hash = get_password_hash(payload.new_password)
    user.must_change_password = False
    user.token_version = int(getattr(user, "token_version", 1) or 1) + 1
    journal.record_audit_event(
        db,
        action="PASSWORD_CHANGED",
        actor_username=str(user.username),
        entity_type="PLATFORM_USER",
        entity_id=int(user.id),
        entity_name=str(user.username),
        details={"self_service": True, "token_version_bumped": True},
    )
    db.commit()
    return SelfPasswordChangeResponse()


def _whoami_from_context(ctx, db: Session) -> WhoAmIResponse:
    display = get_display_settings_row(db)
    platform_tz = str(getattr(display, "default_timezone", None) or "UTC")
    if ctx.source == "jwt":
        user = get_user_by_id(db, int(ctx.user_id or 0))
        if user is None or user.status != "ACTIVE":
            raise _auth_error("AUTH_USER_INACTIVE", "Account is inactive or removed.")
        if int(getattr(user, "token_version", 1) or 1) != (ctx.token_version or 0):
            raise _auth_error("AUTH_TOKEN_REVOKED", "Session was invalidated; please sign in again.")
        expires_at = ctx.claims.expires_at.isoformat() if ctx.claims else None
        return WhoAmIResponse(
            username=ctx.username,
            role=ctx.role,
            authenticated=True,
            must_change_password=bool(getattr(user, "must_change_password", False)),
            token_expires_at=expires_at,
            capabilities=build_capabilities(ctx.role),
            timezone=getattr(user, "timezone", None),
            platform_default_timezone=platform_tz,
        )
    if ctx.source == "invalid_token":
        raise _auth_error("AUTH_TOKEN_INVALID", "Invalid authentication token.")
    if settings.REQUIRE_AUTH:
        raise _auth_error("AUTH_REQUIRED", "Authentication is required for this endpoint.")
    return WhoAmIResponse(
        username=ctx.username,
        role=ctx.role,
        authenticated=False,
        must_change_password=False,
        capabilities=build_capabilities(ctx.role),
        platform_default_timezone=platform_tz,
    )


@router.get("/whoami", response_model=WhoAmIResponse)
def whoami(request: Request, db: Session = Depends(get_db)) -> WhoAmIResponse:
    """Return the verified identity for the current request.

    Validates the bearer token (including ``token_version`` against the live
    row).  When no token is present and the deployment does not require auth,
    we echo the implicit anonymous-administrator fallback so existing tooling
    keeps working.
    """

    ctx = resolve_auth_context(request)
    return _whoami_from_context(ctx, db)


@router.patch("/profile", response_model=WhoAmIResponse)
def update_profile(
    request: Request,
    payload: SelfProfileUpdate,
    db: Session = Depends(get_db),
) -> WhoAmIResponse:
    """Update the signed-in user's display preferences (timezone)."""

    ctx = resolve_auth_context(request)
    if ctx.source != "jwt":
        raise _auth_error("AUTH_REQUIRED", "Authentication is required for this endpoint.")
    user = get_user_by_id(db, int(ctx.user_id or 0))
    if user is None or user.status != "ACTIVE":
        raise _auth_error("AUTH_USER_INACTIVE", "Account is inactive or removed.")
    if payload.timezone is not None:
        user.timezone = payload.timezone
        journal.record_audit_event(
            db,
            action="USER_PROFILE_UPDATED",
            actor_username=user.username,
            entity_type="PLATFORM_USER",
            entity_id=int(user.id),
            entity_name=user.username,
            details={"timezone": user.timezone},
        )
        db.commit()
        db.refresh(user)
    return _whoami_from_context(ctx, db)
