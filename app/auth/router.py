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
from app.auth.mfa import (
    begin_password_challenge, confirm_enrollment, start_enrollment,
    state_for_user, verify_password_challenge,
)
from datarelay_onprem_security import PasswordResult
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
    resolve_auth_context,
)
from app.auth.token_bundle import TokenBundle, build_token_bundle
from app.auth.security import get_password_hash, verify_password
from app.config import settings
from app.database import get_db
from app.platform_admin import journal
from app.platform_admin.models import PlatformUser
from app.platform_admin.repository import get_display_settings_row, get_user_by_id, get_user_by_username

logger = logging.getLogger(__name__)

router = APIRouter()


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=256)


class MfaChallengeResponse(BaseModel):
    mfa_required: bool = True
    challenge_token: str
    expires_at: str


class MfaVerifyRequest(BaseModel):
    challenge_token: str = Field(min_length=20, max_length=128)
    totp: str = Field(default="", max_length=16)
    recovery_code: str = Field(default="", max_length=80)


class MfaEnrollStartRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)


class MfaEnrollConfirmRequest(BaseModel):
    totp: str = Field(min_length=6, max_length=6)


class MfaEnrollConfirmResponse(BaseModel):
    enabled: bool = True
    recovery_codes: list[str]


class MfaStatusResponse(BaseModel):
    enabled: bool
    enrollment_pending: bool = False


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
    """Only a persisted, currently supported role may create a session.

    Never escalate an unknown or malformed DB role to Administrator. Legacy
    implicit development identities are handled separately by role_guard.
    """
    v = (raw or "").strip().upper()
    if v not in KNOWN_ROLES:
        raise HTTPException(status_code=403, detail={
            "error_code": "AUTH_ROLE_INVALID",
            "message": "Account role is not recognized. Contact an administrator.",
        })
    return v


def _auth_error(code: str, message: str, http_status: int = status.HTTP_401_UNAUTHORIZED) -> HTTPException:
    return HTTPException(
        status_code=http_status,
        detail={"error_code": code, "message": message},
        headers={"WWW-Authenticate": "Bearer"},
    )


@router.post("/login", response_model=TokenBundle | MfaChallengeResponse)
def login(
    payload: LoginRequest, request: Request, db: Session = Depends(get_db),
) -> TokenBundle | MfaChallengeResponse:
    """Verify credentials, then require a separate proof for enrolled MFA users.

    No access/refresh JWT is created while a second factor is pending.
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
    state = state_for_user(db, user)
    if state.after_verified_password() is PasswordResult.MFA_REQUIRED:
        # Critical: do not issue any usable access/refresh JWT or clear MFA
        # brute-force counters until the separate OTP/recovery stage succeeds.
        return MfaChallengeResponse(
            **begin_password_challenge(db, user, request),
        )
    if state.after_verified_password() is PasswordResult.MFA_ENROLLMENT_REQUIRED:
        raise HTTPException(status_code=503, detail={
            "error_code": "MFA_ENROLLMENT_REQUIRED",
            "message": "MFA setup requires a recovery administrator.",
        })
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


@router.post("/mfa/verify", response_model=TokenBundle)
def verify_mfa_login(
    payload: MfaVerifyRequest, request: Request, db: Session = Depends(get_db),
) -> TokenBundle:
    """Verify the pre-auth challenge before creating either JWT type."""
    user = verify_password_challenge(
        db, payload.challenge_token, payload.totp, payload.recovery_code, request,
    )
    return build_token_bundle(
        user_id=int(user.id), username=str(user.username),
        role=_normalize_role(user.role),
        token_version=int(user.token_version or 1),
        user_status=str(user.status),
        must_change_password=bool(user.must_change_password),
        mfa_verified=True,
    )


def _current_mfa_actor(request: Request, db: Session, *, lock_user: bool = False):
    ctx = resolve_auth_context(request)
    if ctx.source != "jwt" or ctx.user_id is None:
        raise _auth_error("AUTH_REQUIRED", "Sign in to manage your MFA.")
    if lock_user:
        # Serialize enrollment epoch rotation with refresh/password updates.
        # populate_existing avoids accepting a stale identity-map user after
        # a concurrent transaction has advanced the token version.
        user = db.query(PlatformUser).filter(
            PlatformUser.id == int(ctx.user_id),
        ).with_for_update().populate_existing().one_or_none()
    else:
        user = get_user_by_id(db, int(ctx.user_id))
    if (user is None or user.status != "ACTIVE"
            or _normalize_role(user.role) != ctx.role
            or int(user.token_version or 1) != int(ctx.token_version or 0)):
        raise _auth_error("AUTH_TOKEN_REVOKED", "Sign in again.")
    if bool(user.must_change_password):
        raise _auth_error("PASSWORD_CHANGE_REQUIRED", "Change your password first.", 403)
    return user


@router.get("/mfa/status", response_model=MfaStatusResponse)
def mfa_status(request: Request, db: Session = Depends(get_db)) -> MfaStatusResponse:
    user = _current_mfa_actor(request, db)
    state = state_for_user(db, user)
    return MfaStatusResponse(enabled=state.required)


@router.post("/mfa/enroll/start")
def mfa_enroll_start(
    payload: MfaEnrollStartRequest, request: Request, db: Session = Depends(get_db),
) -> dict[str, object]:
    user = _current_mfa_actor(request, db)
    ip = client_ip_from_request(request)
    # A stolen pre-MFA bearer token must not enable unlimited password guesses
    # through the setup endpoint. Share the normal login failure budget.
    check_login_allowed(username=str(user.username), ip=ip)
    if not verify_password(payload.current_password, user.password_hash):
        record_login_failure(username=str(user.username), ip=ip)
        raise HTTPException(status_code=400, detail={
            "error_code": "MFA_SETUP_DENIED",
            "message": "Current password is incorrect.",
        })
    return start_enrollment(db, user)


@router.post("/mfa/enroll/confirm", response_model=MfaEnrollConfirmResponse)
def mfa_enroll_confirm(
    payload: MfaEnrollConfirmRequest, request: Request, db: Session = Depends(get_db),
) -> MfaEnrollConfirmResponse:
    user = _current_mfa_actor(request, db, lock_user=True)
    codes = confirm_enrollment(db, user, payload.totp)
    return MfaEnrollConfirmResponse(recovery_codes=list(codes))


@router.post("/refresh", response_model=TokenBundle)
def refresh(payload: RefreshRequest, db: Session = Depends(get_db)) -> TokenBundle:
    """Exchange a valid refresh JWT for a fresh access + refresh pair.

    Refresh tokens are single-use: a successful refresh bumps
    ``platform_users.token_version`` so the presented refresh JWT cannot be
    replayed. Protected API access also checks the current product user
    security state when authentication is required.
    """

    try:
        claims: TokenClaims = decode_token(payload.refresh_token, expected_type=TOKEN_TYPE_REFRESH)
    except AuthTokenError as exc:
        raise _auth_error(exc.code, exc.message) from exc

    # Lock the epoch row: simultaneous refreshes of one token must not both
    # pass the pre-rotation version check and mint sibling sessions.
    user = db.query(PlatformUser).filter(PlatformUser.id == claims.user_id).with_for_update().one_or_none()
    if user is None or user.status != "ACTIVE":
        raise _auth_error("AUTH_USER_INACTIVE", "Account is inactive or removed.")
    if int(getattr(user, "token_version", 1) or 1) != claims.token_version:
        raise _auth_error("AUTH_TOKEN_REVOKED", "Refresh token was already used or revoked; please sign in again.")

    if state_for_user(db, user).required and not claims.mfa_verified:
        raise _auth_error("MFA_REQUIRED", "A new MFA sign-in is required.")
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
        mfa_verified=claims.mfa_verified,
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
        query = db.query(PlatformUser).filter(PlatformUser.id == int(ctx.user_id))
        # Logout is an unguarded /auth endpoint by design. When revoke_all
        # mutates the live epoch, protect against stale-JWT replay and races
        # with concurrent refresh/password/MFA epoch rotations.
        user = (query.with_for_update() if revoke_all else query).one_or_none()
        stored_role = (user.role or "").strip().upper() if user else ""
        if (
            user is None or user.status != "ACTIVE"
            or stored_role not in KNOWN_ROLES
            or ctx.role != stored_role
            or ctx.token_version is None
            or int(user.token_version or 1) != int(ctx.token_version)
            or (state_for_user(db, user).required and not ctx.mfa_verified)
        ):
            db.rollback()
            return None  # Idempotent response; never mutate from a stale JWT.
        details = {"revoke_all": revoke_all, "role": ctx.role}
        if revoke_all:
            user.token_version = int(user.token_version or 1) + 1
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
    if "timezone" in payload.model_fields_set:
        # An explicitly supplied null clears the override; an omitted field is a no-op.
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
