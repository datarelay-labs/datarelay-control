"""M7 Identity Vault — deterministic tokenization (hash-only persistence)."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select, text, tuple_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.protection.models import IdentityVaultEntry


@dataclass
class TokenBatchStats:
    batch_items: int = 0
    cache_hits: int = 0
    created: int = 0

def _vault_hash_salt() -> bytes:
    raw = (
        str(getattr(settings, "GDC_IDENTITY_VAULT_HASH_SALT", None) or "").strip()
        or str(settings.GDC_PROTECTION_HASH_SALT or "").strip()
        or "gdc-identity-vault-default-salt"
    )
    return raw.encode("utf-8")


def hash_original_value(*, stream_id: int, field_path: str, original_value: str) -> str:
    """One-way fingerprint for vault lookup; plaintext is never persisted."""

    canonical = original_value.strip()
    payload = f"{int(stream_id)}\n{field_path.strip()}\n{canonical}".encode("utf-8")
    return hashlib.sha256(_vault_hash_salt() + payload).hexdigest()


def format_token(sequence: int) -> str:
    """Global vault token format (shared sequence across streams and paths)."""

    return f"USER_{int(sequence):06d}"


def _allocate_token_sequence(db: Session) -> str:
    seq = db.execute(text("SELECT nextval('identity_vault_token_seq')")).scalar()
    return format_token(int(seq))


def _canonical_token_key(field_path: str, original_value: str) -> tuple[str, str]:
    return field_path.strip(), original_value.strip()


def get_or_create_tokens_batch(
    db: Session,
    *,
    stream_id: int,
    items: list[dict[str, str]],
) -> tuple[dict[tuple[str, str], str], TokenBatchStats]:
    """Batch lookup/create for tokenization; preserves per-value concurrency guarantees."""

    stats = TokenBatchStats()
    token_map: dict[tuple[str, str], str] = {}
    if not items:
        return token_map, stats

    now = datetime.now(timezone.utc)
    deduped: dict[tuple[str, str], tuple[str, str]] = {}
    hash_by_key: dict[tuple[str, str], str] = {}

    for raw in items:
        path = str(raw.get("field_path") or "").strip()
        value = str(raw.get("original_value") or "").strip()
        if not path.startswith("$") or not value:
            continue
        key = _canonical_token_key(path, value)
        if key in deduped:
            continue
        deduped[key] = (path, value)
        hash_by_key[key] = hash_original_value(stream_id=stream_id, field_path=path, original_value=value)

    stats.batch_items = len(deduped)
    if not deduped:
        return token_map, stats

    lookup_keys = [(path, hash_by_key[key]) for key, (path, _value) in deduped.items()]
    existing_rows = list(
        db.execute(
            select(IdentityVaultEntry).where(
                IdentityVaultEntry.stream_id == int(stream_id),
                tuple_(IdentityVaultEntry.field_path, IdentityVaultEntry.original_value_hash).in_(
                    lookup_keys
                ),
            )
        ).scalars()
    )
    existing_by_hash: dict[tuple[str, str], IdentityVaultEntry] = {
        (str(row.field_path), str(row.original_value_hash)): row for row in existing_rows
    }

    for key, (path, value) in deduped.items():
        value_hash = hash_by_key[key]
        existing = existing_by_hash.get((path, value_hash))
        if existing is not None:
            existing.last_seen_at = now
            token_map[key] = str(existing.token_value)
            stats.cache_hits += 1
            continue
        token = get_or_create_token(
            db,
            stream_id=stream_id,
            field_path=path,
            original_value=value,
        )
        token_map[key] = token
        stats.created += 1

    if stats.cache_hits:
        db.flush()
    return token_map, stats


def get_or_create_token(
    db: Session,
    *,
    stream_id: int,
    field_path: str,
    original_value: str,
) -> str:
    """Return a stable token for the same (stream, path, value); allocate on first sight."""

    if not isinstance(original_value, str):
        raise TypeError("original_value must be str for tokenization")
    text_value = original_value.strip()
    if not text_value:
        raise ValueError("original_value must be non-empty for tokenization")

    path = field_path.strip()
    if not path.startswith("$"):
        raise ValueError("field_path must start with $")

    value_hash = hash_original_value(stream_id=stream_id, field_path=path, original_value=text_value)
    now = datetime.now(timezone.utc)

    existing = db.execute(
        select(IdentityVaultEntry).where(
            IdentityVaultEntry.stream_id == int(stream_id),
            IdentityVaultEntry.field_path == path,
            IdentityVaultEntry.original_value_hash == value_hash,
        )
    ).scalar_one_or_none()
    if existing is not None:
        existing.last_seen_at = now
        db.flush()
        return str(existing.token_value)

    for _attempt in range(3):
        token = _allocate_token_sequence(db)
        row = IdentityVaultEntry(
            stream_id=int(stream_id),
            field_path=path,
            original_value_hash=value_hash,
            token_value=token,
            created_at=now,
            last_seen_at=now,
        )
        try:
            with db.begin_nested():
                db.add(row)
                db.flush()
            return token
        except IntegrityError:
            existing = db.execute(
                select(IdentityVaultEntry).where(
                    IdentityVaultEntry.stream_id == int(stream_id),
                    IdentityVaultEntry.field_path == path,
                    IdentityVaultEntry.original_value_hash == value_hash,
                )
            ).scalar_one_or_none()
            if existing is not None:
                existing.last_seen_at = now
                db.flush()
                return str(existing.token_value)

    raise RuntimeError("failed to allocate identity vault token")


def tokenizable_text(value: Any) -> str | None:
    """Canonical text that identifies ``value`` in the identity vault.

    Strings and plain numbers (numeric ids) are tokenizable; booleans, objects and arrays are not.
    Numbers used to fall through to full-mask semantics, which delivered ``null`` (F-157).
    """

    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)):
        return str(value)
    return None


def tokenize_value(
    db: Session | None,
    *,
    stream_id: int,
    field_path: str,
    value: Any,
    token_map: dict[tuple[str, str], str] | None = None,
) -> Any:
    """Apply tokenization to a scalar value; non-strings use full-mask semantics."""

    from app.protection.modes import full_mask_value

    if value is None:
        return None
    text_value = tokenizable_text(value)
    if text_value is None or not text_value:
        return full_mask_value(value)
    if token_map is not None:
        cached = token_map.get(_canonical_token_key(field_path, text_value))
        if cached is not None:
            return cached
    if db is None:
        raise ValueError("database session required for tokenization")
    return get_or_create_token(
        db,
        stream_id=stream_id,
        field_path=field_path,
        original_value=text_value,
    )


def stream_uses_tokenization(db: Session, stream_id: int) -> bool:
    from app.protection.models import PROTECTION_MODE_TOKENIZATION, StreamProtectionRule

    count = (
        db.execute(
            select(func.count())
            .select_from(StreamProtectionRule)
            .where(
                StreamProtectionRule.stream_id == int(stream_id),
                StreamProtectionRule.enabled.is_(True),
                StreamProtectionRule.protection_mode == PROTECTION_MODE_TOKENIZATION,
            )
        ).scalar()
        or 0
    )
    return int(count) > 0


def commit_vault_writes_for_preview(db: Session | None, stream_id: int) -> None:
    """Persist vault rows created during preview / pipeline-debug (no other DB writes)."""

    if db is None:
        return
    if stream_uses_tokenization(db, stream_id):
        db.commit()


def count_vault_entries_for_stream(db: Session, stream_id: int) -> int:
    return int(
        db.execute(
            select(func.count()).select_from(IdentityVaultEntry).where(
                IdentityVaultEntry.stream_id == int(stream_id)
            )
        ).scalar()
        or 0
    )


def build_vault_summary(db: Session) -> dict[str, Any]:
    """Read-only global vault stats (no plaintext, no token listing in MVP)."""

    vault_entries = int(db.execute(select(func.count()).select_from(IdentityVaultEntry)).scalar() or 0)
    stream_count = int(
        db.execute(select(func.count(func.distinct(IdentityVaultEntry.stream_id)))).scalar() or 0
    )
    last_created_at = db.execute(select(func.max(IdentityVaultEntry.created_at))).scalar()
    return {
        "vault_entries": vault_entries,
        "stream_count": stream_count,
        "last_created_at": last_created_at,
    }
