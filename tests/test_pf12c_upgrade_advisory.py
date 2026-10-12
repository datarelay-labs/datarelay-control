"""PF-12C Product Foundation upgrade/rollback advisory on signed Control bundles.

Only ephemeral Ed25519 signing keys and fake byte payloads are used. No
production packages, trust roots, installers, host or database commands.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from app.offline.upgrade_readiness import build_control_upgrade_readiness
from tests.test_pf12c_signed_offline_bundle import _fake_signed_bundle, _verify


def _advisory(tmp_path: Path, *, operation: str = "upgrade", **overrides):
    fixture = _fake_signed_bundle(tmp_path)
    receipt = _verify(fixture)
    arguments = {
        "installed_version": "0.9.0",
        "current_revision": "current.r7",
        "schema_revision": 68,
        "expected_revision": "current.r7",
        "operation": operation,
    }
    arguments.update(overrides)
    return build_control_upgrade_readiness(receipt, **arguments)


def test_signed_upgrade_is_not_a_release_or_install_authorization(tmp_path: Path):
    result = _advisory(tmp_path)
    assert result["operation"] == "upgrade"
    assert result["source_cryptographically_verified"] is True
    assert result["installed_version"] == "0.9.0"
    assert result["target_version"] == "1.0.0"
    assert result["may_submit_to_product_authority"] is False
    assert result["product_apply_required"] is True
    assert result["installed_facts_authoritative"] is False
    assert result["installer_executed"] is False
    assert "provenance_unverified" in result["blockers"]
    assert "mfa_required" in result["blockers"]
    assert "schema_unverified" in result["blockers"]
    assert "backup_unverified" in result["blockers"]
    assert "rollback_unverified" in result["blockers"]
    assert "installer_unavailable" in result["blockers"]
    assert "offline_recovery_required" in result["blockers"]
    for word in ("trusted-public-key", "secret-key", "fake_offline_archive"):
        assert word not in repr(result).lower()


def test_revision_mismatch_and_downgrade_are_visible_but_never_eligible(tmp_path: Path):
    stale = _advisory(tmp_path, expected_revision="current.r6")
    assert "stale_installation" in stale["blockers"]
    second = tmp_path / "second"
    second.mkdir()
    older = _advisory(second, installed_version="1.1.0")
    assert "not_newer" in older["blockers"]
    assert not stale["may_submit_to_product_authority"]
    assert not older["may_submit_to_product_authority"]


def test_readonly_rollback_preview_reuses_shared_contract_and_blocks_actions(tmp_path: Path):
    result = _advisory(tmp_path, operation="rollback", installed_version="1.2.0")
    assert result["operation"] == "rollback"
    assert result["target_version"] == "1.0.0"
    assert result["may_submit_to_product_authority"] is False
    assert "rollback_unavailable" in result["blockers"]
    assert "old_artifact_unverified" in result["blockers"]
    assert "schema_rollback_unverified" in result["blockers"]
    assert "current_data_backup_missing" in result["blockers"]
    assert "offline_recovery_required" in result["blockers"]
    assert result["installer_executed"] is False


@pytest.mark.parametrize(
    "updates",
    [
        {"operation": "reinstall"},
        {"installed_version": "not-valid-semver"},
        {"schema_revision": -1},
        {"expected_revision": "str\nwith-newline"},
    ],
)
def test_malformed_operator_supplied_state_fails_closed(tmp_path: Path, updates):
    with pytest.raises(ValueError):
        _advisory(tmp_path, **updates)


def test_cli_signed_bundle_can_show_advisory_readiness_without_install(tmp_path: Path):
    archive, manifest, signature, trust, pin, _priv, _doc = _fake_signed_bundle(tmp_path)
    root = Path(__file__).resolve().parents[1]
    cli = root / "scripts/release/verify-signed-offline-bundle.py"
    env = {**os.environ, "PYTHONPATH": os.pathsep.join([
        str(root / "vendor/onprem-security/datarelay_onprem_security-0.10.0.dev0-py3-none-any.whl"),
        str(root),
    ])}
    args = [
        sys.executable, str(cli), "--archive", str(archive),
        "--manifest", str(manifest), "--signature", str(signature),
        "--trusted-public-key", str(trust),
        "--expected-public-key-sha256", pin,
        "--expected-product", "datarelay.control",
        "--expected-publisher", "datarelay.publisher1",
        "--operation", "upgrade",
        "--installed-version", "0.9.0",
        "--installed-revision", "current.r7",
        "--installed-schema-revision", "68",
        "--expected-live-revision", "current.r7",
    ]
    result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["signature_verified"] is True
    assert data["installation_authorized"] is False
    assert data["advisory"]["operation"] == "upgrade"
    assert "provenance_unverified" in data["advisory"]["blockers"]
    assert data["advisory"]["may_submit_to_product_authority"] is False


def test_cli_rejects_partial_operator_state_instead_of_claiming_readiness(tmp_path: Path):
    archive, manifest, signature, trust, pin, _priv, _doc = _fake_signed_bundle(tmp_path)
    root = Path(__file__).resolve().parents[1]
    cli = root / "scripts/release/verify-signed-offline-bundle.py"
    env = {**os.environ, "PYTHONPATH": os.pathsep.join([
        str(root / "vendor/onprem-security/datarelay_onprem_security-0.10.0.dev0-py3-none-any.whl"),
        str(root),
    ])}
    result = subprocess.run([
        sys.executable, str(cli),
        "--archive", str(archive), "--manifest", str(manifest),
        "--signature", str(signature), "--trusted-public-key", str(trust),
        "--expected-public-key-sha256", pin,
        "--expected-product", "datarelay.control",
        "--expected-publisher", "datarelay.publisher1",
        "--operation", "upgrade", "--installed-version", "0.9.0",
    ], env=env, capture_output=True, text=True, timeout=10)
    assert result.returncode != 0
    assert "PF12C" in result.stderr
    assert "trusted" not in result.stdout.lower()
