"""Backend role enforcement — JWT-driven (spec 020).

The effective role for each request is derived from a verified
``Authorization: Bearer <jwt>`` header.  The role is **not** taken from any
client-controlled header.  The legacy ``X-GDC-Role`` / ``X-GDC-Username``
headers are only honored when ``settings.AUTH_DEV_HEADER_TRUST`` is true
(off in production); they exist exclusively to keep older automation /
CI fixtures working through the deprecation period.

Coarse HTTP access (method + path + role) is evaluated in
``app.auth.route_access.evaluate_http_access`` so rules stay centralized.
Per-route ``Depends(require_roles(...))`` remains for narrow exceptions.

When ``settings.REQUIRE_AUTH`` is true (production), any non-bypass
request without a valid bearer token returns ``401 AUTH_REQUIRED``, except
``OPTIONS`` (CORS preflight), which is passed through so ``CORSMiddleware`` can
respond — the HTTP role guard runs before CORS in the ASGI stack.  When
``REQUIRE_AUTH`` is false (dev / tests) requests without a token fall
back to ``ADMINISTRATOR`` so existing test fixtures continue to work.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from fastapi import HTTPException, Request, status
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse

from app.auth.jwt_service import (
    AuthTokenError,
    TOKEN_TYPE_ACCESS,
    TokenClaims,
    decode_token,
)
from app.auth.route_access import evaluate_http_access
from app.config import settings

logger = logging.getLogger(__name__)

ROLE_HEADER = "X-GDC-Role"
USERNAME_HEADER = "X-GDC-Username"
BEARER_PREFIX = "bearer "

ROLE_ADMINISTRATOR = "ADMINISTRATOR"
ROLE_OPERATOR = "OPERATOR"
ROLE_CONNECTOR_OPERATOR = "CONNECTOR_OPERATOR"
ROLE_GOVERNANCE_OPERATOR = "GOVERNANCE_OPERATOR"
ROLE_GOVERNANCE_REVIEWER = "GOVERNANCE_REVIEWER"
ROLE_GOVERNANCE_APPROVER = "GOVERNANCE_APPROVER"
ROLE_GOVERNANCE_AUDITOR = "GOVERNANCE_AUDITOR"
ROLE_VIEWER = "VIEWER"
KNOWN_ROLES = frozenset(
    {
        ROLE_ADMINISTRATOR,
        ROLE_OPERATOR,
        ROLE_CONNECTOR_OPERATOR,
        ROLE_GOVERNANCE_OPERATOR,
        ROLE_GOVERNANCE_REVIEWER,
        ROLE_GOVERNANCE_APPROVER,
        ROLE_GOVERNANCE_AUDITOR,
        ROLE_VIEWER,
    }
)

_API = settings.API_PREFIX.rstrip("/")

# Bypass = no role enforcement at all.  Authentication endpoints, OpenAPI/docs,
# and health checks always pass through.
_BYPASS_PREFIXES: tuple[str, ...] = (
    f"{_API}/auth/login",
    f"{_API}/auth/mfa/verify",
    f"{_API}/auth/refresh",
    f"{_API}/auth/logout",
    f"{_API}/ingest/webhook",
    f"{_API}/ingest/ai",
    "/health",
    "/api/openapi.json",
    "/docs",
    "/redoc",
    "/openapi.json",
)


@dataclass(frozen=True)
class AuthContext:
    """Authenticated principal attached to the request via ``request.state.auth``."""

    username: str
    role: str
    source: str  # "jwt" | "dev_header" | "anonymous_admin"
    user_id: int | None = None
    token_version: int | None = None
    claims: TokenClaims | None = None
    must_change_password: bool = False
    mfa_verified: bool = False


def _normalize_role(raw: str | None) -> str:
    if not raw:
        return ROLE_ADMINISTRATOR
    v = raw.strip().upper()
    if v not in KNOWN_ROLES:
        return ROLE_VIEWER  # unknown role => safest interpretation
    return v


def _is_bypass(path: str) -> bool:
    return any(path == p or path.startswith(p) for p in _BYPASS_PREFIXES)


def _must_change_password_bypass(path: str) -> bool:
    """Paths allowed while JWT ``mcp`` (must change password) is set."""

    base = _API
    prefixes = (
        f"{base}/auth/refresh",
        f"{base}/auth/logout",
        f"{base}/auth/whoami",
        f"{base}/auth/change-password",
    )
    return any(path == p or path.startswith(p) for p in prefixes)


def _extract_bearer(request: Request) -> str | None:
    raw = request.headers.get("Authorization") or request.headers.get("authorization") or ""
    if not raw:
        return None
    if raw.lower().startswith(BEARER_PREFIX):
        return raw[len(BEARER_PREFIX) :].strip() or None
    return None


def resolve_auth_context(request: Request) -> AuthContext:
    """Resolve the effective principal for a request.

    The result is also cached on ``request.state.auth`` so route handlers can
    read it without re-decoding the JWT.  This function validates signature,
    issuer, expiry, and token type only. The authenticated middleware separately
    confirms current DB token epoch, role, account status and MFA factor for
    guarded product access. A cached context is never itself a DB check.
    """

    cached = getattr(request.state, "auth", None)
    if isinstance(cached, AuthContext):
        return cached

    token = _extract_bearer(request)
    if token:
        try:
            claims = decode_token(token, expected_type=TOKEN_TYPE_ACCESS)
        except AuthTokenError as exc:
            ctx = AuthContext(
                username="anonymous",
                role=ROLE_VIEWER,
                source="invalid_token",
                claims=None,
            )
            request.state.auth = ctx
            request.state.auth_error = exc
            return ctx
        role = _normalize_role(claims.role)
        ctx = AuthContext(
            username=claims.subject or "anonymous",
            role=role,
            source="jwt",
            user_id=claims.user_id,
            token_version=claims.token_version,
            claims=claims,
            must_change_password=bool(getattr(claims, "must_change_password", False)),
            mfa_verified=bool(getattr(claims, "mfa_verified", False)),
        )
        request.state.auth = ctx
        return ctx

    if settings.AUTH_DEV_HEADER_TRUST:
        raw_role = request.headers.get(ROLE_HEADER)
        raw_user = (request.headers.get(USERNAME_HEADER) or "").strip()
        if raw_role or raw_user:
            ctx = AuthContext(
                username=raw_user or "anonymous",
                role=_normalize_role(raw_role),
                source="dev_header",
            )
            request.state.auth = ctx
            return ctx

    ctx = AuthContext(
        username="anonymous",
        role=ROLE_ADMINISTRATOR,
        source="anonymous_admin",
    )
    request.state.auth = ctx
    return ctx


def resolve_request_role(request: Request) -> str:
    return resolve_auth_context(request).role


def resolve_request_username(request: Request) -> str:
    return resolve_auth_context(request).username


def _verify_live_jwt_authority(ctx: AuthContext) -> bool:
    """Current product DB epoch, role and MFA factor must match signed JWT.

    Run off the event loop. A DB error fails CLOSED instead of trusting a
    once-valid token after an admin enables MFA or changes a user's role.
    """
    from app.database import SessionLocal
    from app.platform_admin.models import PlatformUser, PlatformUserMfa

    if ctx.user_id is None or ctx.token_version is None:
        return False
    try:
        with SessionLocal() as db:
            user = db.query(PlatformUser).filter(
                PlatformUser.id == int(ctx.user_id),
            ).one_or_none()
            if (user is None or user.status != "ACTIVE"
                    or int(user.token_version or 1) != ctx.token_version
                    or _normalize_role(user.role) != ctx.role):
                return False
            row = db.query(PlatformUserMfa).filter(
                PlatformUserMfa.user_id == int(ctx.user_id),
            ).one_or_none()
            return not (row and row.required and not ctx.mfa_verified)
    except Exception:
        logger.warning("JWT current security state unavailable; refusing request")
        return False


async def role_guard_middleware(request: Request, call_next):
    """ASGI middleware enforcing JWT-derived role rules."""

    method = request.method.upper()
    path = request.url.path

    # CORS preflight must not be rejected here: ``@app.middleware("http")`` runs
    # before ``CORSMiddleware``, so a 401 short-circuit would skip CORS handling.
    if method == "OPTIONS":
        return await call_next(request)

    if _is_bypass(path):
        return await call_next(request)

    ctx = resolve_auth_context(request)

    # Token was provided but failed verification -> 401 with stable error code.
    auth_error = getattr(request.state, "auth_error", None)
    if isinstance(auth_error, AuthTokenError):
        return JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content={
                "detail": {
                    "error_code": auth_error.code,
                    "message": auth_error.message,
                }
            },
            headers={"WWW-Authenticate": 'Bearer error="invalid_token"'},
        )

    # No credentials at all in REQUIRE_AUTH mode -> 401.
    if (
        ctx.source == "anonymous_admin"
        and settings.REQUIRE_AUTH
        and not _is_bypass(path)
    ):
        return JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content={
                "detail": {
                    "error_code": "AUTH_REQUIRED",
                    "message": "Authentication is required for this endpoint.",
                }
            },
            headers={"WWW-Authenticate": "Bearer"},
        )

    if ctx.source == "jwt" and (
        settings.REQUIRE_AUTH or bool(settings.GDC_MFA_ENCRYPTION_KEY_HEX)
    ):
        if not await run_in_threadpool(_verify_live_jwt_authority, ctx):
            return JSONResponse(
                status_code=status.HTTP_401_UNAUTHORIZED,
                content={"detail": {
                    "error_code": "AUTH_TOKEN_REVOKED",
                    "message": "Reauthenticate before accessing this resource.",
                }},
            )

    if ctx.source == "jwt" and ctx.must_change_password and not _must_change_password_bypass(path):
        return JSONResponse(
            status_code=status.HTTP_403_FORBIDDEN,
            content={
                "detail": {
                    "error_code": "PASSWORD_CHANGE_REQUIRED",
                    "message": "You must change your password before using this resource.",
                    "role": ctx.role,
                    "method": method,
                    "path": path,
                }
            },
        )

    denied = evaluate_http_access(role=ctx.role, method=method, path=path)
    if denied is not None:
        return JSONResponse(
            status_code=status.HTTP_403_FORBIDDEN,
            content={
                "detail": {
                    "error_code": denied.error_code,
                    "message": denied.message,
                    "role": ctx.role,
                    "method": method,
                    "path": path,
                }
            },
        )

    return await call_next(request)


def require_roles(*allowed: str):
    """Per-route dependency: rejects requests whose role is not in ``allowed``."""

    allowed_set = frozenset(_normalize_role(r) for r in allowed)

    def _dep(request: Request) -> str:
        ctx = resolve_auth_context(request)
        if ctx.role not in allowed_set:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "error_code": "ROLE_FORBIDDEN",
                    "message": f"Role {ctx.role} cannot access this endpoint.",
                    "role": ctx.role,
                    "allowed": sorted(allowed_set),
                },
            )
        return ctx.role

    return _dep


__all__ = [
    "AuthContext",
    "BEARER_PREFIX",
    "KNOWN_ROLES",
    "ROLE_ADMINISTRATOR",
    "ROLE_CONNECTOR_OPERATOR",
    "ROLE_GOVERNANCE_APPROVER",
    "ROLE_GOVERNANCE_AUDITOR",
    "ROLE_GOVERNANCE_OPERATOR",
    "ROLE_GOVERNANCE_REVIEWER",
    "ROLE_HEADER",
    "ROLE_OPERATOR",
    "ROLE_VIEWER",
    "USERNAME_HEADER",
    "require_roles",
    "resolve_auth_context",
    "resolve_request_role",
    "resolve_request_username",
    "role_guard_middleware",
]
