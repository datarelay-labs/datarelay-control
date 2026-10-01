"""CRUD for platform-owned Marketplace trusted signing public keys."""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.connectors_registry.lifecycle_errors import LifecycleError
from app.connectors_registry.package_signature import (
    decode_ed25519_public_key,
    encode_ed25519_public_key,
)
from app.connectors_registry.trusted_signing_keys_models import MarketplaceTrustedSigningKey
from app.connectors_registry.trusted_signing_keys_schemas import (
    TrustedSigningKeyCreate,
    TrustedSigningKeyListResponse,
    TrustedSigningKeyRead,
    TrustedSigningKeyUpdate,
)
from app.database import utcnow


def _row_to_read(row: MarketplaceTrustedSigningKey) -> TrustedSigningKeyRead:
    return TrustedSigningKeyRead(
        key_id=row.key_id,
        name=row.name,
        public_key=row.public_key,
        publisher=row.publisher,
        enabled=bool(row.enabled),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _normalize_public_key(public_key: str) -> str:
    try:
        raw = decode_ed25519_public_key(public_key)
    except ValueError as exc:
        raise LifecycleError(
            f"invalid Ed25519 public key: {exc}",
            error_code="TRUSTED_KEY_INVALID",
        ) from exc
    return encode_ed25519_public_key(raw)


def _reject_private_key_material(text: str) -> None:
    lowered = (text or "").lower()
    if "begin" in lowered and "private key" in lowered:
        raise LifecycleError(
            "private keys must not be submitted to the trusted signing key API",
            error_code="TRUSTED_KEY_PRIVATE_FORBIDDEN",
        )


def list_trusted_signing_keys(db: Session) -> TrustedSigningKeyListResponse:
    rows = (
        db.query(MarketplaceTrustedSigningKey)
        .order_by(MarketplaceTrustedSigningKey.key_id.asc())
        .all()
    )
    keys = [_row_to_read(row) for row in rows]
    return TrustedSigningKeyListResponse(keys=keys, count=len(keys))


def get_trusted_signing_key(db: Session, key_id: str) -> TrustedSigningKeyRead:
    row = (
        db.query(MarketplaceTrustedSigningKey)
        .filter(MarketplaceTrustedSigningKey.key_id == key_id.strip())
        .first()
    )
    if row is None:
        raise LifecycleError(
            f"trusted signing key not found: {key_id}",
            error_code="TRUSTED_KEY_NOT_FOUND",
        )
    return _row_to_read(row)


def create_trusted_signing_key(db: Session, payload: TrustedSigningKeyCreate) -> TrustedSigningKeyRead:
    key_id = payload.key_id.strip()
    if not key_id:
        raise LifecycleError("key_id is required", error_code="TRUSTED_KEY_INVALID")
    _reject_private_key_material(payload.public_key)
    existing = (
        db.query(MarketplaceTrustedSigningKey)
        .filter(MarketplaceTrustedSigningKey.key_id == key_id)
        .first()
    )
    if existing is not None:
        raise LifecycleError(
            f"trusted signing key already exists: {key_id}",
            error_code="TRUSTED_KEY_EXISTS",
        )

    now = utcnow()
    row = MarketplaceTrustedSigningKey(
        key_id=key_id,
        name=payload.name.strip(),
        public_key=_normalize_public_key(payload.public_key),
        publisher=(payload.publisher.strip() if payload.publisher else None),
        enabled=bool(payload.enabled),
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _row_to_read(row)


def update_trusted_signing_key(
    db: Session,
    key_id: str,
    payload: TrustedSigningKeyUpdate,
) -> TrustedSigningKeyRead:
    row = (
        db.query(MarketplaceTrustedSigningKey)
        .filter(MarketplaceTrustedSigningKey.key_id == key_id.strip())
        .first()
    )
    if row is None:
        raise LifecycleError(
            f"trusted signing key not found: {key_id}",
            error_code="TRUSTED_KEY_NOT_FOUND",
        )
    if payload.name is not None:
        row.name = payload.name.strip()
    if payload.publisher is not None:
        row.publisher = payload.publisher.strip() or None
    if payload.enabled is not None:
        row.enabled = bool(payload.enabled)
    if payload.public_key is not None:
        _reject_private_key_material(payload.public_key)
        row.public_key = _normalize_public_key(payload.public_key)
    row.updated_at = utcnow()
    db.commit()
    db.refresh(row)
    return _row_to_read(row)


def delete_trusted_signing_key(db: Session, key_id: str) -> TrustedSigningKeyRead:
    row = (
        db.query(MarketplaceTrustedSigningKey)
        .filter(MarketplaceTrustedSigningKey.key_id == key_id.strip())
        .first()
    )
    if row is None:
        raise LifecycleError(
            f"trusted signing key not found: {key_id}",
            error_code="TRUSTED_KEY_NOT_FOUND",
        )
    read = _row_to_read(row)
    db.delete(row)
    db.commit()
    return read
