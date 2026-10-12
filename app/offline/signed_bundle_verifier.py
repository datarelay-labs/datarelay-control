"""PF-12C Control signed offline bundle preflight, never an installer.

Read only exact artifact bytes and detached Ed25519 manifest signature.
Trust anchor and its independent SHA256 pin must be supplied out-of-band;
neither the untrusted manifest nor its accompanying archive may appoint
a public signing key. This module installs nothing.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import hmac
import json
from pathlib import Path
import re
from typing import Iterator

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from datarelay_onprem_security import (
    ArtifactKind, ArtifactProof, OfflineArtifact, verify_stream_sha256,
)

_HEX_SHA256 = re.compile(r"[a-f0-9]{64}\Z")
_MANIFEST_FIELDS = frozenset({
    "schema_version", "product_ref", "release_ref", "version", "kind",
    "artifact_filename", "artifact_sha256", "artifact_bytes",
    "publisher_key_ref",
})
_MAX_MANIFEST = 16 * 1024
_MAX_PUBLIC_KEY = 8 * 1024


@dataclass(frozen=True)
class VerifiedSignedBundle:
    artifact: OfflineArtifact
    proof: ArtifactProof
    installation_authorized: bool = False


def _reject_symlink_path(path: Path) -> None:
    """Reject links in any path component, not just the final file name."""
    absolute = path.absolute()
    if any(component.is_symlink() for component in (absolute, *absolute.parents)):
        raise ValueError("Symlink is not a trusted offline source")


def _read_limited(path: Path, *, limit: int) -> bytes:
    _reject_symlink_path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError("Missing or untrusted offline verification file")
    with path.open("rb") as f:
        data = f.read(limit + 1)
    if not data or len(data) > limit:
        raise ValueError("Invalid verification file size")
    return data


def _no_duplicate_json_fields(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Ambiguous duplicate signed manifest field")
        result[key] = value
    return result


def _read_chunks(path: Path) -> Iterator[bytes]:
    with path.open("rb") as f:
        while chunk := f.read(1024 * 1024):
            yield chunk


def verify_signed_offline_bundle(
    *, archive_path: Path, manifest_path: Path, signature_path: Path,
    trusted_public_key_path: Path, expected_public_key_sha256: str,
    expected_product_ref: str, expected_publisher_key_ref: str,
) -> VerifiedSignedBundle:
    """Verify exact signed bytes and independent trust pin without side effects.

    Positive output is cryptographic evidence only. It never permits actual
    product deployment, migration, upgrade or rollback.
    """
    archive = Path(archive_path)
    manifest = Path(manifest_path)
    signature = Path(signature_path)
    trusted = Path(trusted_public_key_path)
    for path in (archive, manifest, signature, trusted):
        _reject_symlink_path(path)
    if not all(p.parent.resolve() == manifest.parent.resolve() for p in (archive, signature)):
        raise ValueError("Offline archive and detached manifest must share package directory")
    if trusted.resolve().is_relative_to(manifest.parent.resolve()):
        raise ValueError("Trusted publisher key must be outside the untrusted package")
    if not _HEX_SHA256.fullmatch(expected_public_key_sha256):
        raise ValueError("Missing valid out-of-band trusted public-key pin")

    key_data = _read_limited(trusted, limit=_MAX_PUBLIC_KEY)
    try:
        key = serialization.load_pem_public_key(key_data)
    except (TypeError, ValueError) as exc:
        raise ValueError("Invalid trusted publisher public key") from exc
    if not isinstance(key, Ed25519PublicKey):
        raise ValueError("Trusted publisher key must use Ed25519")
    der = key.public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    if not hmac.compare_digest(hashlib.sha256(der).hexdigest(), expected_public_key_sha256):
        raise ValueError("Publisher key does not match the out-of-band trust pin")

    signed_bytes = _read_limited(manifest, limit=_MAX_MANIFEST)
    detached_sig = _read_limited(signature, limit=64)
    if len(detached_sig) != 64:
        raise ValueError("Invalid Ed25519 signature length")
    try:
        key.verify(detached_sig, signed_bytes)
    except InvalidSignature as exc:
        raise ValueError("Signed offline manifest verification failed") from exc

    try:
        parsed = json.loads(signed_bytes, object_pairs_hook=_no_duplicate_json_fields)
    except (ValueError, UnicodeError) as exc:
        raise ValueError("Invalid signed manifest JSON") from exc
    if not isinstance(parsed, dict) or frozenset(parsed) != _MANIFEST_FIELDS:
        raise ValueError("Missing or unexpected signed manifest fields")
    if type(parsed["schema_version"]) is not int or parsed["schema_version"] != 1:
        raise ValueError("Unsupported signed manifest schema")
    if parsed["product_ref"] != expected_product_ref or parsed["publisher_key_ref"] != expected_publisher_key_ref:
        raise ValueError("Offline product or trusted publisher identity mismatch")
    if parsed["kind"] != ArtifactKind.PRODUCT_RELEASE.value:
        raise ValueError("Only Control product-release offline bundles are supported")
    if (not isinstance(parsed["artifact_filename"], str) or
            parsed["artifact_filename"] != archive.name or
            not archive.name.endswith(".tar.gz") or
            Path(parsed["artifact_filename"]).name != parsed["artifact_filename"]):
        raise ValueError("Offline archive file identity mismatch")
    if not archive.is_file() or archive.stat().st_size <= 0:
        raise ValueError("Missing offline archive")
    artifact = OfflineArtifact(
        product_ref=parsed["product_ref"],
        release_ref=parsed["release_ref"],
        version=parsed["version"],
        kind=ArtifactKind.PRODUCT_RELEASE,
        artifact_sha256=parsed["artifact_sha256"],
        manifest_sha256=hashlib.sha256(signed_bytes).hexdigest(),
        artifact_bytes=parsed["artifact_bytes"],
        publisher_key_ref=parsed["publisher_key_ref"],
    )
    if archive.stat().st_size != artifact.artifact_bytes or not verify_stream_sha256(
        _read_chunks(archive), expected_sha256=artifact.artifact_sha256,
        expected_bytes=artifact.artifact_bytes,
    ):
        raise ValueError("Offline archive bytes do not match signed manifest")
    proof = ArtifactProof(
        expected_artifact_sha256=artifact.artifact_sha256,
        expected_manifest_sha256=artifact.manifest_sha256,
        verified_publisher_key_ref=artifact.publisher_key_ref,
        artifact_bytes_hashed=True,
        manifest_bytes_hashed=True,
        manifest_signature_verified=True,
        publisher_trust_verified=True,
        # Product provenance/release-readiness also depends on SBOM,
        # compatibility, rollback and owner-signoff; not established here.
        provenance_verified=False,
    )
    return VerifiedSignedBundle(artifact=artifact, proof=proof)
