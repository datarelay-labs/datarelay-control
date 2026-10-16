"""Control-owned PF-12C read-only signed upgrade/rollback readiness.

This consumes a signature-and-bytes-verified candidate, then runs the pinned
shared Product Foundation policy with *negative* product-native evidence.
Unverified caller-provided installed version/revision is never treated as
authenticated product state. No installer, DB, host or network side effects.
"""

from __future__ import annotations

from typing import Literal

from datarelay_onprem_security import (
    InstalledProduct,
    UpgradeEvidence,
    UpgradeRollbackEvidence,
    preview_offline_upgrade,
    preview_offline_rollback,
)

from app.offline.signed_bundle_verifier import VerifiedSignedBundle

_PRODUCT = "datarelay.control"


def build_control_upgrade_readiness(
    receipt: VerifiedSignedBundle, *,
    operation: Literal["upgrade", "rollback"],
    installed_version: str,
    current_revision: str,
    schema_revision: int,
    expected_revision: str,
) -> dict[str, object]:
    """Read-only *advisory*, not permission to install or restore.

    Caller version/revision/schema are unverified hints, not live facts.
    Owner approval, current product version, schema compatibility and signed
    provenance must be revalidated by a future trusted installer.
    """
    if type(receipt) is not VerifiedSignedBundle or receipt.installation_authorized is not False:
        raise ValueError("A signed read-only bundle receipt is required")
    proof = receipt.proof
    artifact = receipt.artifact
    if (
        not proof.manifest_signature_verified
        or not proof.publisher_trust_verified
        or not proof.manifest_bytes_hashed
        or not proof.artifact_bytes_hashed
        or proof.verified_publisher_key_ref != artifact.publisher_key_ref
        or proof.expected_artifact_sha256 != artifact.artifact_sha256
        or proof.expected_manifest_sha256 != artifact.manifest_sha256
    ):
        raise ValueError("Source signature, trust and byte-integrity must all be proven")
    if artifact.product_ref != _PRODUCT:
        raise ValueError("Control requires a matching signed product artifact")
    if operation not in ("upgrade", "rollback"):
        raise ValueError("Invalid offline operation")
    installed = InstalledProduct(
        product_ref=_PRODUCT,
        installed_version=installed_version,
        current_revision=current_revision,
        schema_revision=schema_revision,
    )
    if operation == "upgrade":
        result = preview_offline_upgrade(
            installed, artifact, proof,
            UpgradeEvidence(expected_live_revision=expected_revision),
        )
        return {
            "operation": "upgrade",
            "product_ref": result.product_ref,
            "installed_version": result.installed_version,
            "target_version": result.target_version,
            "release_ref": result.release_ref,
            "blockers": [blocker.value for blocker in result.blockers],
            "may_submit_to_product_authority": False,
            "product_apply_required": result.product_apply_required,
            "source_cryptographically_verified": True,
            "installed_facts_authoritative": False,
            "installer_executed": False,
        }
    result = preview_offline_rollback(
        installed, artifact,
        UpgradeRollbackEvidence(expected_live_revision=expected_revision),
    )
    return {
        "operation": "rollback",
        "product_ref": result.product_ref,
        "installed_version": result.installed_version,
        "target_version": result.target_version,
        "release_ref": artifact.release_ref,
        "blockers": [blocker.value for blocker in result.blockers],
        "may_submit_to_product_authority": False,
        "product_apply_required": result.product_apply_required,
        "source_cryptographically_verified": True,
        "installed_facts_authoritative": False,
        "installer_executed": False,
    }
