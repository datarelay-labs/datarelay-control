"""PF-12C detached Ed25519 offline package preflight (no installer/network)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app.offline.signed_bundle_verifier import verify_signed_offline_bundle


def _fake_signed_bundle(tmp_path: Path):
    # These ephemeral keys are test fixtures, not customer/publisher keys.
    package = tmp_path / "untrusted-package"
    trust = tmp_path / "operator-trust"
    package.mkdir()
    trust.mkdir()
    archive = package / "offline-release-1.0.0.tar.gz"
    archive.write_bytes(b"FAKE_OFFLINE_ARCHIVE_ONLY_NO_CONTAINER_OR_DB")
    priv = Ed25519PrivateKey.generate()
    pub = priv.public_key()
    pem = pub.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    der = pub.public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    key = trust / "publisher.pem"
    key.write_bytes(pem)
    pin = hashlib.sha256(der).hexdigest()
    doc = {
        "schema_version": 1,
        "product_ref": "datarelay.control",
        "release_ref": "control.release1",
        "version": "1.0.0",
        "kind": "product_release",
        "artifact_filename": archive.name,
        "artifact_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        "artifact_bytes": archive.stat().st_size,
        "publisher_key_ref": "datarelay.publisher1",
    }
    manifest = package / "signed-manifest.json"
    manifest.write_bytes(
        json.dumps(doc, sort_keys=True, separators=(",", ":")).encode("utf-8")
    )
    sig = package / "signed-manifest.sig"
    sig.write_bytes(priv.sign(manifest.read_bytes()))
    return archive, manifest, sig, key, pin, priv, doc


def _verify(artifacts, **changes):
    archive, manifest, sig, key, pin, _private, _doc = artifacts
    params = {
        "archive_path": archive,
        "manifest_path": manifest,
        "signature_path": sig,
        "trusted_public_key_path": key,
        "expected_public_key_sha256": pin,
        "expected_product_ref": "datarelay.control",
        "expected_publisher_key_ref": "datarelay.publisher1",
    }
    params.update(changes)
    return verify_signed_offline_bundle(**params)


def test_valid_signed_bundle_returns_verified_source_facts_but_never_authorizes_install(tmp_path):
    artifacts = _fake_signed_bundle(tmp_path)
    receipt = _verify(artifacts)
    assert receipt.artifact.product_ref == "datarelay.control"
    assert receipt.proof.manifest_signature_verified is True
    assert receipt.proof.publisher_trust_verified is True
    assert receipt.proof.artifact_bytes_hashed is True
    assert receipt.proof.manifest_bytes_hashed is True
    assert receipt.installation_authorized is False


@pytest.mark.parametrize(
    "change",
    [
        "artifact", "manifest", "signature", "wrong_pin",
        "wrong_product", "wrong_publisher", "wrong_filename",
        "nested_trust_key", "symlink_archive", "symlink_trust_key",
        "duplicate_manifest_field",
    ],
)
def test_signed_bundle_mismatch_or_untrusted_source_fails_closed(tmp_path, change):
    fixture = _fake_signed_bundle(tmp_path)
    archive, manifest, sig, key, pin, priv, doc = fixture
    kwargs = {}
    if change == "artifact":
        archive.write_bytes(b"TAMPERED_AFTER_SIGNING")
    elif change == "manifest":
        doc["version"] = "1.0.1"
        manifest.write_bytes(json.dumps(doc, sort_keys=True).encode())
    elif change == "signature":
        sig.write_bytes(b"0" * 64)
    elif change == "wrong_pin":
        kwargs["expected_public_key_sha256"] = "0" * 64
    elif change == "wrong_product":
        kwargs["expected_product_ref"] = "another.product"
    elif change == "wrong_publisher":
        kwargs["expected_publisher_key_ref"] = "other.publisher"
    elif change == "wrong_filename":
        doc["artifact_filename"] = "other.tar.gz"
        manifest.write_bytes(json.dumps(doc, sort_keys=True).encode())
        sig.write_bytes(priv.sign(manifest.read_bytes()))
    elif change == "nested_trust_key":
        counterfeit = manifest.parent / "publisher.pem"
        counterfeit.write_bytes(key.read_bytes())
        kwargs["trusted_public_key_path"] = counterfeit
    elif change == "symlink_archive":
        alias = archive.with_name("alias.tar.gz")
        alias.symlink_to(archive)
        kwargs["archive_path"] = alias
    elif change == "symlink_trust_key":
        alias = key.with_name("trust-link.pem")
        alias.symlink_to(key)
        kwargs["trusted_public_key_path"] = alias
    elif change == "duplicate_manifest_field":
        manifest.write_bytes(
            b'{"schema_version":1,"schema_version":1}'
        )
        sig.write_bytes(priv.sign(manifest.read_bytes()))
    with pytest.raises(ValueError):
        _verify(fixture, **kwargs)


def test_missing_trusted_signature_or_unsafe_metadata_fails_closed(tmp_path):
    fixture = _fake_signed_bundle(tmp_path)
    archive, manifest, sig, _key, _pin, priv, doc = fixture
    sig.unlink()
    with pytest.raises(ValueError):
        _verify(fixture)
    for name, value in (
        ("kind", "platform_os_upgrade"),
        ("artifact_bytes", 0),
        ("publisher_key_ref", "unknown.publisher"),
    ):
        altered = dict(doc)
        altered[name] = value
        manifest.write_bytes(json.dumps(altered, sort_keys=True).encode())
        sig.write_bytes(priv.sign(manifest.read_bytes()))
        with pytest.raises(ValueError):
            _verify(fixture)


def test_verifier_cli_prints_only_readiness_without_install(tmp_path):
    artifacts = _fake_signed_bundle(tmp_path)
    archive, manifest, signature, trust, pin, *_ = artifacts
    root = Path(__file__).resolve().parents[1]
    script = root / "scripts" / "release" / "verify-signed-offline-bundle.py"
    import os
    env = {
        **os.environ,
        "PYTHONPATH": (
            str(root / "vendor/onprem-security/datarelay_onprem_security-0.10.0.dev0-py3-none-any.whl")
            + os.pathsep + str(root)
        ),
    }
    completed = subprocess.run(
        [
            sys.executable, str(script),
            "--archive", str(archive),
            "--manifest", str(manifest),
            "--signature", str(signature),
            "--trusted-public-key", str(trust),
            "--expected-public-key-sha256", pin,
            "--expected-product", "datarelay.control",
            "--expected-publisher", "datarelay.publisher1",
        ],
        capture_output=True, text=True, timeout=10, env=env, check=False,
    )
    assert completed.returncode == 0, completed.stderr
    response = json.loads(completed.stdout)
    assert response["signature_verified"] is True
    assert response["artifact_integrity_verified"] is True
    assert response["installation_authorized"] is False
    assert "FAKE_OFFLINE_ARCHIVE" not in completed.stdout


@pytest.mark.parametrize("directory", ["package", "trust"])
def test_verifier_rejects_symlinked_parent_directory_even_with_valid_signature(tmp_path, directory):
    """An alias directory must not bypass the documented no-symlink boundary."""
    fixture = _fake_signed_bundle(tmp_path)
    archive, manifest, sig, trusted_key, pin, *_ = fixture
    if directory == "package":
        alias = tmp_path / "untrusted-package-alias"
        alias.symlink_to(archive.parent, target_is_directory=True)
        changes = {
            "archive_path": alias / archive.name,
            "manifest_path": alias / manifest.name,
            "signature_path": alias / sig.name,
        }
    else:
        alias = tmp_path / "operator-trust-alias"
        alias.symlink_to(trusted_key.parent, target_is_directory=True)
        changes = {"trusted_public_key_path": alias / trusted_key.name}
    with pytest.raises(ValueError, match="Symlink"):
        _verify(fixture, **changes)
