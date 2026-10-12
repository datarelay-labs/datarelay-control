#!/usr/bin/env python3
"""Read-only Control PF-12C Ed25519 offline bundle verification preflight.

This tool does not install, unpack, execute, sign, publish or rollback a
bundle. Public-key trust pin must come from outside the untrusted package.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from app.offline.signed_bundle_verifier import verify_signed_offline_bundle


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--signature", required=True, type=Path)
    parser.add_argument("--trusted-public-key", required=True, type=Path)
    parser.add_argument("--expected-public-key-sha256", required=True)
    parser.add_argument("--expected-product", required=True)
    parser.add_argument("--expected-publisher", required=True)
    args = parser.parse_args()
    try:
        receipt = verify_signed_offline_bundle(
            archive_path=args.archive,
            manifest_path=args.manifest,
            signature_path=args.signature,
            trusted_public_key_path=args.trusted_public_key,
            expected_public_key_sha256=args.expected_public_key_sha256,
            expected_product_ref=args.expected_product,
            expected_publisher_key_ref=args.expected_publisher,
        )
    except (OSError, TypeError, ValueError):
        # Path, exception and signed manifest data may contain secrets.
        print("PF12C_OFFLINE_VERIFICATION_FAILED", file=sys.stderr)
        return 2
    print(json.dumps({
        "product_ref": receipt.artifact.product_ref,
        "release_ref": receipt.artifact.release_ref,
        "version": receipt.artifact.version,
        "publisher_key_ref": receipt.artifact.publisher_key_ref,
        "manifest_sha256": receipt.artifact.manifest_sha256,
        "artifact_sha256": receipt.artifact.artifact_sha256,
        "signature_verified": receipt.proof.manifest_signature_verified,
        "artifact_integrity_verified": receipt.proof.artifact_bytes_hashed,
        "publisher_trust_pin_verified": receipt.proof.publisher_trust_verified,
        "provenance_verified": receipt.proof.provenance_verified,
        "installation_authorized": receipt.installation_authorized,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
