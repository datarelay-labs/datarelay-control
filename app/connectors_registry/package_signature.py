"""Marketplace package Ed25519 signature verification (M29.5A).

Private keys are never accepted or stored by the platform. Only public keys in
``marketplace_trusted_signing_keys`` are used for verification.

Signature metadata lives at the package root (``signature.json`` / ``.yaml``)
and is excluded from the canonical digest.
"""

from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from sqlalchemy.orm import Session

from app.connectors_registry.lifecycle_errors import LifecycleError
from app.connectors_registry.package_digest import SIGNATURE_METADATA_NAMES, is_signature_metadata_path
from app.connectors_registry.trusted_signing_keys_models import MarketplaceTrustedSigningKey

SIGNATURE_ALGORITHM_ED25519 = "ed25519"

SIGNATURE_STATUS_VALID = "VALID"
SIGNATURE_STATUS_UNSIGNED = "UNSIGNED"
SIGNATURE_STATUS_UNKNOWN_KEY = "UNKNOWN_KEY"
SIGNATURE_STATUS_INVALID_SIGNATURE = "INVALID_SIGNATURE"
SIGNATURE_STATUS_DISABLED_KEY = "DISABLED_KEY"
SIGNATURE_STATUS_DIGEST_MISMATCH = "INVALID_SIGNATURE"

SIGNATURE_STATUSES: tuple[str, ...] = (
    SIGNATURE_STATUS_VALID,
    SIGNATURE_STATUS_UNSIGNED,
    SIGNATURE_STATUS_UNKNOWN_KEY,
    SIGNATURE_STATUS_INVALID_SIGNATURE,
    SIGNATURE_STATUS_DISABLED_KEY,
)


@dataclass(frozen=True)
class PackageSignatureMetadata:
    """Parsed package-root signature metadata (untrusted until verified)."""

    algorithm: str
    key_id: str
    digest: str
    signature: str
    source_file: str


@dataclass(frozen=True)
class PackageSignatureResult:
    """Platform-derived signature verification outcome."""

    status: str
    digest: str
    signing_key_id: str | None = None
    algorithm: str | None = None


def _reject(code: str, message: str, **details: object) -> None:
    raise LifecycleError(message, error_code=code, details=dict(details) if details else None)


def find_signature_metadata_path(package_root: Path) -> Path | None:
    matches = [
        package_root / name
        for name in sorted(SIGNATURE_METADATA_NAMES)
        if (package_root / name).is_file()
    ]
    if len(matches) > 1:
        _reject(
            "SIGNATURE_INVALID",
            "package contains multiple signature metadata files",
            files=[path.name for path in matches],
        )
    return matches[0] if matches else None


def _load_signature_dict(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    suffix = path.suffix.lower()
    if suffix == ".json":
        raw = json.loads(text)
    else:
        import yaml

        raw = yaml.safe_load(text)
    if not isinstance(raw, dict):
        _reject("SIGNATURE_INVALID", "signature metadata must be an object", file=path.name)
    return raw


def parse_signature_metadata(package_root: Path) -> PackageSignatureMetadata | None:
    """Parse package-root signature metadata, or ``None`` when unsigned."""

    path = find_signature_metadata_path(package_root)
    if path is None:
        return None
    try:
        raw = _load_signature_dict(path)
    except LifecycleError:
        raise
    except Exception as exc:
        _reject("SIGNATURE_INVALID", f"signature metadata parse failed: {exc}", file=path.name)

    algorithm = str(raw.get("algorithm") or "").strip().lower()
    key_id = str(raw.get("key_id") or "").strip()
    digest = str(raw.get("digest") or "").strip().lower()
    signature = str(raw.get("signature") or "").strip()
    if not algorithm or not key_id or not digest or not signature:
        _reject(
            "SIGNATURE_INVALID",
            "signature metadata requires algorithm, key_id, digest, signature",
            file=path.name,
        )
    if algorithm != SIGNATURE_ALGORITHM_ED25519:
        _reject(
            "SIGNATURE_UNSUPPORTED_ALGORITHM",
            f"unsupported signature algorithm: {algorithm!r}",
            file=path.name,
        )
    # Strip optional sha256: prefix for comparison convenience.
    if digest.startswith("sha256:"):
        digest = digest.split(":", 1)[1].strip()
    return PackageSignatureMetadata(
        algorithm=algorithm,
        key_id=key_id,
        digest=digest,
        signature=signature,
        source_file=path.name,
    )


def _strict_base64_decode(text: str, *, label: str) -> bytes:
    padded = text + "=" * (-len(text) % 4)
    for altchars in (None, b"-_"):
        try:
            return base64.b64decode(padded, altchars=altchars, validate=True)
        except (binascii.Error, ValueError):
            continue
    raise ValueError(f"{label} must be valid base64")


def decode_ed25519_public_key(public_key: str) -> bytes:
    """Decode a trusted public key from base64 or hex into 32 raw bytes."""

    text = (public_key or "").strip()
    if not text:
        raise ValueError("public_key is empty")
    if text.startswith("-----BEGIN"):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

        loaded = serialization.load_pem_public_key(text.encode("utf-8"))
        if not isinstance(loaded, Ed25519PublicKey):
            raise ValueError("PEM public key is not Ed25519")
        return loaded.public_bytes(Encoding.Raw, PublicFormat.Raw)

    raw: bytes | None = None
    # Prefer hex when clearly hex-shaped.
    if re_fullmatch_hex(text) and len(text) == 64:
        raw = bytes.fromhex(text)
    else:
        try:
            raw = _strict_base64_decode(text, label="public_key")
        except ValueError as exc:
            raise ValueError("public_key must be base64 or hex Ed25519 key") from exc
    if len(raw) != 32:
        raise ValueError("Ed25519 public key must be 32 bytes")
    # Validate by constructing the key object.
    Ed25519PublicKey.from_public_bytes(raw)
    return raw


def re_fullmatch_hex(text: str) -> bool:
    import re

    return bool(re.fullmatch(r"[0-9a-fA-F]+", text))


def encode_ed25519_public_key(raw: bytes) -> str:
    if len(raw) != 32:
        raise ValueError("Ed25519 public key must be 32 bytes")
    return base64.b64encode(raw).decode("ascii")


def _decode_signature_bytes(signature: str) -> bytes:
    text = signature.strip()
    raw = _strict_base64_decode(text, label="signature")
    if len(raw) != 64:
        raise ValueError("Ed25519 signature must be 64 bytes")
    return raw


def verify_package_signature(
    db: Session,
    *,
    canonical_digest: str,
    metadata: PackageSignatureMetadata | None,
) -> PackageSignatureResult:
    """Verify package signature against platform-owned trusted public keys."""

    digest = canonical_digest.strip().lower()
    if digest.startswith("sha256:"):
        digest = digest.split(":", 1)[1].strip()

    if metadata is None:
        return PackageSignatureResult(status=SIGNATURE_STATUS_UNSIGNED, digest=digest)

    if metadata.digest != digest:
        return PackageSignatureResult(
            status=SIGNATURE_STATUS_INVALID_SIGNATURE,
            digest=digest,
            signing_key_id=metadata.key_id,
            algorithm=metadata.algorithm,
        )

    row = (
        db.query(MarketplaceTrustedSigningKey)
        .filter(MarketplaceTrustedSigningKey.key_id == metadata.key_id)
        .first()
    )
    if row is None:
        return PackageSignatureResult(
            status=SIGNATURE_STATUS_UNKNOWN_KEY,
            digest=digest,
            signing_key_id=metadata.key_id,
            algorithm=metadata.algorithm,
        )
    if not row.enabled:
        return PackageSignatureResult(
            status=SIGNATURE_STATUS_DISABLED_KEY,
            digest=digest,
            signing_key_id=row.key_id,
            algorithm=metadata.algorithm,
        )

    try:
        pub_raw = decode_ed25519_public_key(row.public_key)
        sig_raw = _decode_signature_bytes(metadata.signature)
        Ed25519PublicKey.from_public_bytes(pub_raw).verify(
            sig_raw,
            digest.encode("ascii"),
        )
    except Exception:
        return PackageSignatureResult(
            status=SIGNATURE_STATUS_INVALID_SIGNATURE,
            digest=digest,
            signing_key_id=row.key_id,
            algorithm=metadata.algorithm,
        )

    return PackageSignatureResult(
        status=SIGNATURE_STATUS_VALID,
        digest=digest,
        signing_key_id=row.key_id,
        algorithm=metadata.algorithm,
    )


def assert_signature_install_allowed(
    result: PackageSignatureResult,
    *,
    actor_role: str,
) -> None:
    """Enforce local-upload signature policy for install/upgrade."""

    from app.auth.governance_rbac import is_administrator

    status = result.status
    if status == SIGNATURE_STATUS_VALID:
        return
    if status == SIGNATURE_STATUS_UNSIGNED:
        if is_administrator(actor_role):
            return
        raise LifecycleError(
            "unsigned package install requires Administrator role",
            error_code="UNSIGNED_PACKAGE_FORBIDDEN",
            details={
                "signature_status": status,
                "digest": result.digest,
            },
        )

    error_by_status = {
        SIGNATURE_STATUS_UNKNOWN_KEY: (
            "PACKAGE_SIGNATURE_UNKNOWN_KEY",
            "package signature references an unknown trusted signing key",
        ),
        SIGNATURE_STATUS_DISABLED_KEY: (
            "PACKAGE_SIGNATURE_DISABLED_KEY",
            "package signature references a disabled trusted signing key",
        ),
        SIGNATURE_STATUS_INVALID_SIGNATURE: (
            "PACKAGE_SIGNATURE_INVALID",
            "package signature verification failed",
        ),
    }
    code, message = error_by_status.get(
        status,
        ("PACKAGE_SIGNATURE_INVALID", "package signature verification failed"),
    )
    raise LifecycleError(
        message,
        error_code=code,
        details={
            "signature_status": status,
            "signing_key_id": result.signing_key_id,
            "digest": result.digest,
        },
    )


def build_signature_metadata_dict(
    *,
    key_id: str,
    digest: str,
    signature_b64: str,
    algorithm: str = SIGNATURE_ALGORITHM_ED25519,
) -> dict[str, str]:
    """Helper for tests / tooling — not used by the server to sign packages."""

    return {
        "algorithm": algorithm,
        "key_id": key_id,
        "digest": digest,
        "signature": signature_b64,
    }


# Re-export for callers that need path helpers alongside signature APIs.
__all__ = [
    "SIGNATURE_ALGORITHM_ED25519",
    "SIGNATURE_STATUS_VALID",
    "SIGNATURE_STATUS_UNSIGNED",
    "SIGNATURE_STATUS_UNKNOWN_KEY",
    "SIGNATURE_STATUS_INVALID_SIGNATURE",
    "SIGNATURE_STATUS_DISABLED_KEY",
    "PackageSignatureMetadata",
    "PackageSignatureResult",
    "assert_signature_install_allowed",
    "build_signature_metadata_dict",
    "decode_ed25519_public_key",
    "encode_ed25519_public_key",
    "find_signature_metadata_path",
    "is_signature_metadata_path",
    "parse_signature_metadata",
    "verify_package_signature",
]
