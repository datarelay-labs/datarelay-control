"""JWT issuance and verification for the local platform session (spec 020).

Lightweight: HS256 access + refresh tokens, signed with ``settings.JWT_SECRET_KEY``
(falling back to ``settings.SECRET_KEY``).  No refresh-token revocation table —
invalidation is via ``platform_users.token_version`` bumps.

Only stdlib + ``python-jose`` (already in ``requirements.txt``).  No DB writes
happen here; live ``token_version`` is enforced in ``/auth/refresh``,
``/auth/whoami``, and ``/auth/change-password`` (not in the global HTTP middleware).
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from jose import JWTError, jwt

from app.config import settings

logger = logging.getLogger(__name__)

TOKEN_TYPE_ACCESS = "access"
TOKEN_TYPE_REFRESH = "refresh"

# `jose.jwt.decode` raises specific subclasses of JWTError; we surface a single
# `AuthTokenError` to callers with a stable `code` attribute so the HTTP layer
# can map cleanly to error_code without leaking jose internals.


class AuthTokenError(Exception):
    """Raised when a JWT cannot be validated."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class TokenClaims:
    """Validated JWT claims used downstream by the role guard."""

    subject: str
    user_id: int
    role: str
    token_version: int
    token_type: str
    jti: str
    issued_at: datetime
    expires_at: datetime
    raw: dict[str, Any]
    must_change_password: bool = False


def _signing_key() -> str:
    key = (settings.JWT_SECRET_KEY or "").strip() or (settings.SECRET_KEY or "").strip()
    if not key or key == "change-me-in-production":
        # Development / tests may keep the placeholder; production startup fail-closes
        # via ``app.production_security`` before serving traffic.
        _warn_default_secret()
        return key or "insecure-dev-secret"
    return key


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


_DEFAULT_SECRET_WARNED = False


def _warn_default_secret() -> None:
    global _DEFAULT_SECRET_WARNED
    if _DEFAULT_SECRET_WARNED:
        return
    _DEFAULT_SECRET_WARNED = True
    logger.warning(
        "%s",
        {
            "stage": "jwt_secret_default",
            "message": "JWT_SECRET_KEY / SECRET_KEY is unset or default. "
            "Set JWT_SECRET_KEY to a strong value before serving production traffic.",
        },
    )


def _expire_minutes(token_type: str) -> int:
    if token_type == TOKEN_TYPE_REFRESH:
        m = int(getattr(settings, "REFRESH_TOKEN_EXPIRE_MINUTES", 60 * 24))
    else:
        m = int(getattr(settings, "ACCESS_TOKEN_EXPIRE_MINUTES", 60))
    return max(1, m)


def _build_payload(
    *,
    username: str,
    user_id: int,
    role: str,
    token_version: int,
    token_type: str,
    must_change_password: bool = False,
) -> dict[str, Any]:
    now = _utcnow()
    exp = now + timedelta(minutes=_expire_minutes(token_type))
    out: dict[str, Any] = {
        "sub": username,
        "uid": int(user_id),
        "role": role,
        "tv": int(token_version),
        "typ": token_type,
        "iss": settings.JWT_ISSUER,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
        "jti": uuid.uuid4().hex,
    }
    if must_change_password:
        out["mcp"] = 1
    return out


def issue_access_token(
    *,
    username: str,
    user_id: int,
    role: str,
    token_version: int,
    must_change_password: bool = False,
) -> tuple[str, datetime]:
    """Return ``(jwt_string, expires_at_utc)`` for an access token."""

    payload = _build_payload(
        username=username,
        user_id=user_id,
        role=role,
        token_version=token_version,
        token_type=TOKEN_TYPE_ACCESS,
        must_change_password=must_change_password,
    )
    token = jwt.encode(payload, _signing_key(), algorithm=settings.JWT_ALGORITHM)
    return token, datetime.fromtimestamp(payload["exp"], tz=timezone.utc)


def issue_refresh_token(
    *,
    username: str,
    user_id: int,
    role: str,
    token_version: int,
    must_change_password: bool = False,
) -> tuple[str, datetime]:
    payload = _build_payload(
        username=username,
        user_id=user_id,
        role=role,
        token_version=token_version,
        token_type=TOKEN_TYPE_REFRESH,
        must_change_password=must_change_password,
    )
    token = jwt.encode(payload, _signing_key(), algorithm=settings.JWT_ALGORITHM)
    return token, datetime.fromtimestamp(payload["exp"], tz=timezone.utc)


def decode_token(token: str, *, expected_type: str | None = None) -> TokenClaims:
    """Decode and validate a JWT.

    Raises ``AuthTokenError`` with a stable ``code`` when the token is missing,
    malformed, expired, or carries an unexpected ``typ`` claim.
    """

    if not token:
        raise AuthTokenError("AUTH_TOKEN_MISSING", "Missing authentication token.")
    try:
        payload = jwt.decode(
            token,
            _signing_key(),
            algorithms=[settings.JWT_ALGORITHM],
            options={"require": ["exp", "sub", "uid", "role", "tv", "typ"]},
            issuer=settings.JWT_ISSUER,
        )
    except JWTError as exc:
        msg = str(exc) or "Invalid token."
        if "expired" in msg.lower() or "signature has expired" in msg.lower():
            raise AuthTokenError("AUTH_TOKEN_EXPIRED", "Authentication token expired.") from exc
        raise AuthTokenError("AUTH_TOKEN_INVALID", f"Invalid token: {msg}") from exc

    token_type = str(payload.get("typ") or "")
    if expected_type and token_type != expected_type:
        raise AuthTokenError(
            "AUTH_TOKEN_INVALID",
            f"Expected {expected_type} token but received {token_type or 'unknown'}.",
        )
    try:
        mcp_raw = payload.get("mcp")
        must_change = bool(mcp_raw) if mcp_raw is not None else False
        return TokenClaims(
            subject=str(payload["sub"]),
            user_id=int(payload["uid"]),
            role=str(payload["role"]).strip().upper(),
            token_version=int(payload["tv"]),
            token_type=token_type,
            jti=str(payload.get("jti") or ""),
            issued_at=datetime.fromtimestamp(int(payload["iat"]), tz=timezone.utc),
            expires_at=datetime.fromtimestamp(int(payload["exp"]), tz=timezone.utc),
            raw=dict(payload),
            must_change_password=must_change,
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise AuthTokenError("AUTH_TOKEN_INVALID", f"Malformed token claims: {exc}") from exc


__all__ = [
    "AuthTokenError",
    "TOKEN_TYPE_ACCESS",
    "TOKEN_TYPE_REFRESH",
    "TokenClaims",
    "decode_token",
    "issue_access_token",
    "issue_refresh_token",
]
