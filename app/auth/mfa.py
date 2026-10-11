"""Control-owned optional TOTP MFA lifecycle, backed by Foundation RFC6238.

Default OFF. A password-verified, limited challenge is NOT a JWT/session.
All factors, user roles and OTP replay counters are rechecked transactionally
in the product PostgreSQL DB. Dedicated key must be provisioned for MFA.
"""
from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
import hashlib
import secrets

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException, Request
from sqlalchemy.orm import Session
from datarelay_onprem_security import (
    PasswordResult, UserMfaState, new_totp_secret, provisioning_uri,
    new_recovery_codes, recovery_code_digest, verify_totp,
)

from app.config import settings
from app.platform_admin.models import PlatformMfaChallenge, PlatformUserMfa, PlatformUser
from app.platform_admin import journal
from app.auth.login_throttle import (
    check_login_allowed, record_login_failure, record_login_success,
)

MFA_CHALLENGE_SECONDS = 180
MFA_MAX_PENDING_CHALLENGES = 5
MFA_ENROLLMENT_SECONDS = 300
MFA_FACTOR_MAX_FAILURES = 8
MFA_FACTOR_WINDOW_SECONDS = 15 * 60
MFA_FACTOR_LOCK_SECONDS = 5 * 60
# Store only hashes/dedicated AES-GCM-wrapped secrets; never expose in API logs.


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _fingerprint(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _binding(request: Request) -> tuple[str, str]:
    # Direct TCP client only. Never accept an arbitrary X-Forwarded-For value.
    source = request.client.host if request.client else "unknown"
    agent = request.headers.get("user-agent") or ""
    return _fingerprint(str(source)[:128]), _fingerprint(str(agent)[:1024])


def _key() -> bytes:
    raw = str(settings.GDC_MFA_ENCRYPTION_KEY_HEX or "").strip()
    if len(raw) != 64:
        raise HTTPException(503, detail={
            "error_code": "MFA_KEY_UNAVAILABLE",
            "message": "MFA encryption key must be provisioned by an administrator.",
        })
    try:
        return bytes.fromhex(raw)
    except ValueError as exc:
        raise HTTPException(503, detail={
            "error_code": "MFA_KEY_UNAVAILABLE", "message": "MFA encryption key is invalid.",
        }) from exc


def _seal(user_id: int, secret: str) -> str:
    nonce = secrets.token_bytes(12)
    ciphertext = AESGCM(_key()).encrypt(
        nonce, secret.encode("ascii"), f"gdc-mfa:{user_id}".encode("ascii"),
    )
    return base64.urlsafe_b64encode(nonce + ciphertext).decode("ascii")


def _unseal(user_id: int, ciphertext: str) -> str:
    try:
        value = base64.urlsafe_b64decode(ciphertext.encode("ascii"))
        return AESGCM(_key()).decrypt(
            value[:12], value[12:], f"gdc-mfa:{user_id}".encode("ascii"),
        ).decode("ascii")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, detail={
            "error_code": "MFA_SECRET_UNAVAILABLE",
            "message": "MFA secret cannot be read. Recovery administrator required.",
        }) from exc


def _user_mfa(db: Session, user_id: int, *, lock: bool = False) -> PlatformUserMfa | None:
    q = db.query(PlatformUserMfa).filter(PlatformUserMfa.user_id == user_id)
    if lock:
        q = q.with_for_update()
    return q.one_or_none()


def _generic_failure() -> HTTPException:
    return HTTPException(status_code=401, detail={
        "error_code": "MFA_VERIFICATION_FAILED",
        "message": "Invalid or expired MFA challenge.",
    })


def _check_factor_window(
    db: Session, row: PlatformUserMfa, now: datetime, *, consume_challenge: bool = False,
) -> None:
    """One durable per-account factor budget for login and setup verification."""
    if row.locked_until and now < row.locked_until:
        wait = max(1, int((row.locked_until - now).total_seconds()))
        if consume_challenge:
            db.commit()
        raise HTTPException(status_code=429, detail={
            "error_code": "MFA_RATE_LIMITED",
            "message": "Too many MFA failures. Try again later.",
        }, headers={"Retry-After": str(wait)})
    if row.locked_until or (row.failure_window_started_at and
                             now - row.failure_window_started_at >= timedelta(seconds=MFA_FACTOR_WINDOW_SECONDS)):
        _clear_factor_failures(row)


def _record_factor_failure(row: PlatformUserMfa, now: datetime) -> None:
    if row.failure_window_started_at is None:
        row.failure_window_started_at = now
    row.failed_attempts = int(row.failed_attempts or 0) + 1
    if row.failed_attempts >= MFA_FACTOR_MAX_FAILURES:
        row.locked_until = now + timedelta(seconds=MFA_FACTOR_LOCK_SECONDS)


def _clear_factor_failures(row: PlatformUserMfa) -> None:
    row.failed_attempts = 0
    row.failure_window_started_at = None
    row.locked_until = None


def state_for_user(db: Session, user: PlatformUser) -> UserMfaState:
    row = _user_mfa(db, int(user.id))
    return UserMfaState(
        required=bool(row and row.required),
        enrolled=bool(row and row.secret_ciphertext),
    )


def begin_password_challenge(
    db: Session, user: PlatformUser, request: Request, *, current: datetime | None = None,
) -> dict[str, object]:
    """Create pre-auth proof only for an enrolled, required MFA account."""
    now = current or _now()
    mfa = _user_mfa(db, int(user.id), lock=True)
    state = UserMfaState(required=bool(mfa and mfa.required),
                         enrolled=bool(mfa and mfa.secret_ciphertext))
    if state.after_verified_password() is not PasswordResult.MFA_REQUIRED:
        # Inconsistent required-but-not-enrolled is a FAIL-CLOSED state.
        raise HTTPException(503, detail={"error_code": "MFA_ENROLLMENT_REQUIRED",
                                         "message": "MFA enrollment needs administrator recovery."})
    _key()
    # The MFA row is locked above: multiple workers cannot bypass this
    # per-user pending challenge cap by starting at the same instant.
    # Factor verification locks its proof before the account MFA row. If
    # pruning tried to DELETE that same proof while holding the MFA row lock,
    # the two transactions could deadlock. Skip proofs being verified; the
    # next login will prune them after their lock is released.
    expired_hashes = [
        token_hash for (token_hash,) in db.query(PlatformMfaChallenge.token_hash).filter(
            PlatformMfaChallenge.user_id == int(user.id),
            PlatformMfaChallenge.expires_at <= now,
        ).with_for_update(skip_locked=True).all()
    ]
    if expired_hashes:
        db.query(PlatformMfaChallenge).filter(
            PlatformMfaChallenge.token_hash.in_(expired_hashes),
        ).delete(synchronize_session=False)
    pending = db.query(PlatformMfaChallenge.expires_at).filter(
        PlatformMfaChallenge.user_id == int(user.id),
        PlatformMfaChallenge.expires_at > now,
    ).order_by(PlatformMfaChallenge.expires_at).all()
    if len(pending) >= MFA_MAX_PENDING_CHALLENGES:
        wait = max(1, int((pending[0][0] - now).total_seconds()))
        db.commit()  # Persist expiry cleanup before rejecting the request.
        raise HTTPException(status_code=429, detail={
            "error_code": "MFA_CHALLENGE_LIMIT",
            "message": "Too many pending MFA sign-ins. Complete an existing challenge or retry later.",
        }, headers={"Retry-After": str(wait)})
    token = secrets.token_urlsafe(32)
    src, agent = _binding(request)
    db.add(PlatformMfaChallenge(
        token_hash=_fingerprint(token), user_id=int(user.id),
        token_version=int(user.token_version or 1),
        role=str(user.role), source_hash=src, user_agent_hash=agent,
        created_at=now, expires_at=now + timedelta(seconds=MFA_CHALLENGE_SECONDS),
    ))
    journal.record_audit_event(
        db, action="USER_LOGIN_MFA_PENDING", actor_username=str(user.username),
        actor_user_id=int(user.id), entity_type="PLATFORM_USER", entity_id=int(user.id),
        details={"mfa": "pending"}, request=request,
    )
    db.commit()
    return {"mfa_required": True, "challenge_token": token,
            "expires_at": (now + timedelta(seconds=MFA_CHALLENGE_SECONDS)).isoformat()}


def verify_password_challenge(
    db: Session, token: str, code: str, recovery_code: str, request: Request,
    *, current: datetime | None = None,
) -> PlatformUser:
    """Consume pre-auth proof once; issue bearer tokens only *after* success."""
    now = current or _now()
    hashed = _fingerprint(str(token or ""))
    src, agent = _binding(request)
    challenge = db.query(PlatformMfaChallenge).filter(
        PlatformMfaChallenge.token_hash == hashed,
    ).with_for_update().one_or_none()
    if challenge is None:
        raise _generic_failure()
    user = db.query(PlatformUser).filter(
        PlatformUser.id == challenge.user_id,
    ).with_for_update().one_or_none()
    mfa = _user_mfa(db, int(challenge.user_id), lock=True)
    # Consumed whether the submitted factor is valid or invalid. No retry
    # using the same proof; DB locks prevent multi-worker replay.
    db.delete(challenge)
    valid_account = bool(
        user and user.status == "ACTIVE" and mfa and mfa.required
        and mfa.secret_ciphertext
        and int(user.token_version or 1) == challenge.token_version
        and str(user.role) == challenge.role
        and now < challenge.expires_at
        and src == challenge.source_hash and agent == challenge.user_agent_hash
    )
    if not valid_account:
        db.commit()
        raise _generic_failure()
    username = str(user.username)
    _check_factor_window(db, mfa, now, consume_challenge=True)
    # The same per-account and per-source guard remains in force across
    # repeated password-first challenges; success only clears it after MFA.
    try:
        check_login_allowed(username=username, ip=str(request.client.host if request.client else "unknown"))
    except HTTPException:
        # Consume the pending proof even when a rate-limit denies this factor.
        # Otherwise transaction rollback could resurrect a blocked challenge.
        db.commit()
        raise
    matching = None
    consumed_digest = None
    if code and not recovery_code:
        secret = _unseal(int(user.id), str(mfa.secret_ciphertext))
        matching = verify_totp(
            secret, code, now=now.timestamp(), last_counter=int(mfa.last_counter),
        )
    elif recovery_code and not code:
        try:
            target = recovery_code_digest(recovery_code, installation_key=_key())
            codes = list(mfa.recovery_hashes_json or [])
            if target in codes:
                consumed_digest = target
        except ValueError:
            pass
    if matching is None and consumed_digest is None:
        _record_factor_failure(mfa, now)
        journal.record_audit_event(
            db, action="USER_LOGIN_MFA_FAILED", actor_username=username,
            actor_user_id=int(user.id), entity_type="PLATFORM_USER", entity_id=int(user.id),
            result="failure", details={"reason": "invalid_factor"}, request=request,
        )
        db.commit()
        record_login_failure(username=username, ip=str(request.client.host if request.client else "unknown"))
        raise _generic_failure()
    _clear_factor_failures(mfa)
    if matching is not None:
        mfa.last_counter = matching
    else:
        values = list(mfa.recovery_hashes_json or [])
        values.remove(consumed_digest)
        mfa.recovery_hashes_json = values
    user.last_login_at = now
    journal.record_audit_event(
        db, action="USER_LOGIN_MFA_SUCCESS", actor_username=username,
        actor_user_id=int(user.id), entity_type="PLATFORM_USER", entity_id=int(user.id),
        details={"factor": "recovery" if consumed_digest else "totp"}, request=request,
    )
    db.commit()
    record_login_success(username=username, ip=str(request.client.host if request.client else "unknown"))
    return user


def start_enrollment(
    db: Session, user: PlatformUser, *, current: datetime | None = None,
) -> dict[str, object]:
    now = current or _now()
    _key()
    row = _user_mfa(db, int(user.id), lock=True)
    if row is None:
        row = PlatformUserMfa(user_id=int(user.id), required=False)
        db.add(row)
    if row.required or row.secret_ciphertext:
        raise HTTPException(409, detail={"error_code": "MFA_ALREADY_ENABLED",
                                         "message": "MFA is already enabled."})
    _check_factor_window(db, row, now)
    secret = new_totp_secret()
    row.pending_secret_ciphertext = _seal(int(user.id), secret)
    row.pending_expires_at = now + timedelta(seconds=MFA_ENROLLMENT_SECONDS)
    journal.record_audit_event(
        db, action="MFA_ENROLLMENT_STARTED", actor_username=str(user.username),
        actor_user_id=int(user.id), entity_type="PLATFORM_USER", entity_id=int(user.id),
        details={"state": "pending"},
    )
    db.commit()
    return {"otpauth_uri": provisioning_uri(secret, issuer="DataRelay Control",
                                           account=str(user.username)),
            "secret": secret, "expires_at": row.pending_expires_at.isoformat()}


def confirm_enrollment(
    db: Session, user: PlatformUser, code: str, *, current: datetime | None = None,
) -> tuple[str, ...]:
    now = current or _now()
    row = _user_mfa(db, int(user.id), lock=True)
    if not row or row.required or not row.pending_secret_ciphertext or not row.pending_expires_at:
        raise HTTPException(409, detail={"error_code": "MFA_SETUP_MISSING",
                                         "message": "Start MFA enrollment again."})
    _check_factor_window(db, row, now)
    if now >= row.pending_expires_at:
        row.pending_secret_ciphertext = None
        row.pending_expires_at = None
        db.commit()
        raise HTTPException(400, detail={"error_code": "MFA_SETUP_EXPIRED",
                                         "message": "MFA enrollment expired."})
    secret = _unseal(int(user.id), str(row.pending_secret_ciphertext))
    counter = verify_totp(secret, code, now=now.timestamp())
    if counter is None:
        _record_factor_failure(row, now)
        db.commit()
        raise HTTPException(400, detail={"error_code": "MFA_CODE_INVALID",
                                         "message": "Invalid authenticator code."})
    _clear_factor_failures(row)
    codes = new_recovery_codes(8)
    row.secret_ciphertext = row.pending_secret_ciphertext
    row.pending_secret_ciphertext = None
    row.pending_expires_at = None
    row.required = True
    row.last_counter = counter
    row.recovery_hashes_json = [
        recovery_code_digest(code_value, installation_key=_key()) for code_value in codes
    ]
    user.token_version = int(user.token_version or 1) + 1
    journal.record_audit_event(
        db, action="MFA_ENABLED", actor_username=str(user.username),
        actor_user_id=int(user.id), entity_type="PLATFORM_USER", entity_id=int(user.id),
        details={"token_version_bumped": True, "recovery_count": len(codes)},
    )
    db.commit()
    return codes
