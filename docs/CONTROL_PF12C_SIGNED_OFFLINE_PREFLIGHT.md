# Control PF-12C — Signed Offline Bundle Verification Preflight

**Status:** source-only verification, not an installer or release authorization.
The existing product offline builder still emits unsigned SHA256 integrity
receipts; a checksum alone never authenticates a publisher. This new optional
read-only tool does **not** convert those legacy bundles into trusted releases.

## Product/Shared boundary

- Product Foundation's pinned `datarelay-onprem-security==0.10.0.dev0`
  supplies `OfflineArtifact`, `ArtifactProof` and the memory-bounded
  `verify_stream_sha256` for exact-size actual artifact bytes.
- Control owns the actual on-disk offline artifact, an **externally trusted**
  Ed25519 public key, the independent pinned SHA256 of its DER SPKI bytes,
  product and publisher identifiers, and the detached manifest signature.
- `app/offline/signed_bundle_verifier.py` validates those facts using
  `cryptography`'s Ed25519 public verification only. No private key, signing
  facility, host/network operation, tar extraction or package install exists.
- `scripts/release/verify-signed-offline-bundle.py` reports verified
  cryptographic facts as JSON. `installation_authorized=false` and
  `provenance_verified=false` are always reported. These facts do not grant
  product installer, release or rollback authority.

## Test-only signed-manifest contract

The exact bytes of a UTF-8 JSON manifest are covered by the detached
64-byte Ed25519 signature. A v1 manifest contains exactly:

```json
{
  "schema_version": 1,
  "product_ref": "datarelay.control",
  "release_ref": "control.release1",
  "version": "1.0.0",
  "kind": "product_release",
  "artifact_filename": "offline-release-1.0.0.tar.gz",
  "artifact_sha256": "<64 lowercase hex characters>",
  "artifact_bytes": 123,
  "publisher_key_ref": "datarelay.publisher1"
}
```

The digest and byte count in this illustrative template are placeholders,
not real release evidence. Unknown fields, duplicate JSON fields, malformed
values, wrong product/publisher, symlinks and archive filename substitutions
fail closed. The manifest, signature and archive must be co-located; the
public trust key MUST come from a separate operator-controlled location
outside the untrusted archive directory. An independent trusted key fingerprint
argument is mandatory and cannot be sourced from the package itself.

### Read-only invocation pattern

```bash
PYTHONPATH=vendor/onprem-security/datarelay_onprem_security-0.10.0.dev0-py3-none-any.whl:. \
python3 scripts/release/verify-signed-offline-bundle.py \
  --archive /path/to/untrusted/offline-release-1.0.0.tar.gz \
  --manifest /path/to/untrusted/signed-manifest.json \
  --signature /path/to/untrusted/signed-manifest.sig \
  --trusted-public-key /separately-approved/trust/publisher.pem \
  --expected-public-key-sha256 '<owner-pinned SHA256 of DER SPKI public key>' \
  --expected-product datarelay.control \
  --expected-publisher datarelay.publisher1
```

This pattern is documentation, **not** a command executed against an
operational package in this work. Neither caller-provided key nor manifest
metadata constitutes a new root of trust without independently approved
key custody/provenance.

## PF-12C shared upgrade / rollback advisory (source only)

The native `app/offline/upgrade_readiness.py` adapter now consumes the result
of **actual detached signature + byte integrity verification** and invokes
Product Foundation's `InstalledProduct`, `UpgradeEvidence`,
`preview_offline_upgrade`, `UpgradeRollbackEvidence` and
`preview_offline_rollback` contracts. The existing verification CLI accepts
an optional, *complete* set of unverified operator hints:

```text
--operation upgrade|rollback
--installed-version 0.9.0
--installed-revision current.r7
--installed-schema-revision 68
--expected-live-revision current.r7
```

These options are illustrative; no real device or product state was inspected
for this source change. All five must be provided together or omitted.
`advisory.blockers` reports version order, stale revision, unverified schema,
MFA, backup, installer, audit and recovery prerequisites. The input version
and schema are only **caller assertions**, never a trusted live product read.
The product-owned adapter supplies no positive runtime/permission/backup
evidence and returns `may_submit_to_product_authority=false` under
all inputs. Actual installation and rollback remain unavailable. A signature
validates exact signed bytes, not installed state, approved release provenance,
schema migration qualification or operator identity.

Native tests exercise both directions, stale/invalid product state, CLI
partial-state rejection and the previous signature-tamper tests using only
ephemeral signing fixtures. No host upgrade, package publication or key
provisioning is performed.

## Verification and release gates

Native `tests/test_pf12c_signed_offline_bundle.py` uses an ephemeral
in-memory test signing key, fake tiny archive and separate temporary trust
directory. It covers successful detached signature and full byte hash,
tampered archive/manifest/signature, wrong trust fingerprint, mismatched
product/publisher/filename, duplicated JSON, invalid metadata, trust-key
placement/symlink and CLI output without leaking payload bytes. The tests
do not install Docker, execute an installer, access a real release,
write an operator trust store or touch a production DB.

**Still not implemented/approved:** real owner-pinned publisher trust
distribution, authorized signing process and signed production packages,
SBOM/provenance, immutable release manifest lifecycle, installer fail-closed
signature gate, **verified live** schema/upgrade compatibility and real
installer/rollback authority, backup restore/recovery drill,
operational apply/rollback, Browser BFS, two genuine-user Full User E2E,
candidate freeze and release authorization.
