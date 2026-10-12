"""PF-12B native backup byte-integrity and advisory recovery assessment."""

from __future__ import annotations

from hashlib import sha256
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from app.backup.recovery_evidence import inspect_backup_archive


def _fixture(tmp_path: Path, *, name: str = "gdc-postgres-20261012T120000Z.dump.gz") -> Path:
    archive = tmp_path / name
    archive.write_bytes(b"FAKE_CONTROL_ARCHIVE_NOT_REAL_DB_AND_NO_SECRETS")
    sidecar = Path(str(archive) + ".sha256")
    sidecar.write_text(f"{sha256(archive.read_bytes()).hexdigest()}  {archive.name}\n")
    archive.chmod(0o600)
    sidecar.chmod(0o600)
    os.utime(archive, (1_760_000_000, 1_760_000_000))
    return archive


def test_exact_byte_digest_is_verified_but_never_claims_encryption_or_restore(tmp_path):
    archive = _fixture(tmp_path)
    result = inspect_backup_archive(archive, now=1_760_000_100)
    assert result["byte_integrity_verified"] is True
    assert result["configuration_export"] is False
    assert result["encrypted_at_rest"] is False
    assert result["restore_drill_verified"] is False
    assert result["backup_healthy"] is False
    assert "not_complete" in result["backup_problems"]
    assert "unencrypted" in result["backup_problems"]
    assert "restore_not_verified" in result["backup_problems"]
    assert "unencrypted_backup" in result["restore_blockers"]
    assert "restore_drill_missing" in result["restore_blockers"]
    assert result["may_submit_to_restore_authority"] is False
    assert result["actual_restore_performed"] is False
    assert result["schema_compatibility_verified"] is False
    assert result["artifact_bytes"] == len(archive.read_bytes())
    assert result["backup_ref"].startswith("backup.")
    assert result["archive_sha256"] == sha256(archive.read_bytes()).hexdigest()
    content = json.dumps(result)
    assert "FAKE_CONTROL_ARCHIVE" not in content
    assert "gdc-postgres" not in content
    assert str(tmp_path) not in content


@pytest.mark.parametrize("variant", [
    "mutated_bytes", "missing_sidecar", "wrong_digest", "wrong_name",
    "sidecar_symlink", "archive_symlink", "empty_file", "extra_digest_line",
    "oversized_sidecar", "unsupported_name",
    "world_readable_archive", "world_readable_sidecar",
])
def test_untrusted_or_corrupted_backup_cannot_produce_verified_receipt(tmp_path, variant):
    archive = _fixture(tmp_path)
    sidecar = Path(str(archive) + ".sha256")
    if variant == "mutated_bytes":
        archive.write_bytes(b"TAMPERED")
    elif variant == "missing_sidecar":
        sidecar.unlink()
    elif variant == "wrong_digest":
        sidecar.write_text(f"{'0'*64}  {archive.name}\n")
    elif variant == "wrong_name":
        sidecar.write_text(f"{sha256(archive.read_bytes()).hexdigest()}  other.dump\n")
    elif variant == "sidecar_symlink":
        sidecar.unlink()
        sidecar.symlink_to(tmp_path / "none")
    elif variant == "archive_symlink":
        link = tmp_path / "alias.dump.gz"
        link.symlink_to(archive)
        archive = link
        Path(str(link)+".sha256").write_text(f"{sha256(archive.read_bytes()).hexdigest()}  {link.name}\n")
    elif variant == "empty_file":
        archive.write_bytes(b"")
        sidecar.write_text(f"{sha256(b'').hexdigest()}  {archive.name}\n")
    elif variant == "extra_digest_line":
        sidecar.write_text(sidecar.read_text() + "malicious extra line\n")
    elif variant == "oversized_sidecar":
        sidecar.write_bytes(b"0" * 600)
    elif variant == "world_readable_archive":
        archive.chmod(0o644)
    elif variant == "world_readable_sidecar":
        sidecar.chmod(0o644)
    elif variant == "unsupported_name":
        wrong = tmp_path / "backup.json"
        wrong.write_bytes(archive.read_bytes())
        Path(str(wrong)+".sha256").write_text(f"{sha256(wrong.read_bytes()).hexdigest()}  {wrong.name}\n")
        archive = wrong
    with pytest.raises(ValueError):
        inspect_backup_archive(archive, now=1_760_000_100)


def test_old_or_future_timestamps_are_marked_not_healthy(tmp_path):
    archive = _fixture(tmp_path)
    old = inspect_backup_archive(archive, now=1_760_000_000 + 4 * 86_400)
    assert "overdue" in old["backup_problems"]
    future = inspect_backup_archive(archive, now=1_760_000_000 - 40)
    assert "future_evidence" in future["backup_problems"]
    assert not old["backup_healthy"] and not future["backup_healthy"]


def test_read_only_cli_never_prints_sensitive_filename_or_certifies_restore(tmp_path):
    archive = _fixture(tmp_path)
    root = Path(__file__).resolve().parents[1]
    env = {**os.environ, "PYTHONPATH": str(root / "vendor/onprem-security/datarelay_onprem_security-0.10.0.dev0-py3-none-any.whl") + os.pathsep + str(root)}
    cli = root / "scripts/ops/inspect-backup-evidence.py"
    result = subprocess.run(
        [sys.executable, str(cli), "--archive", str(archive), "--now", "1760000100"],
        capture_output=True, text=True, timeout=8, env=env, check=False,
    )
    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["byte_integrity_verified"] is True
    assert report["actual_restore_performed"] is False
    assert report["may_submit_to_restore_authority"] is False
    assert str(archive) not in result.stdout
    assert "FAKE_CONTROL_ARCHIVE" not in result.stdout
