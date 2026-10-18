"""PF-12 restore preflight guards, using fake pg_dump and no database."""

from __future__ import annotations

import hashlib
from pathlib import Path

from tests.test_pf12_backup_artifact_hygiene import _restore_preflight


def test_legacy_override_does_not_trust_symlink_archive(tmp_path: Path) -> None:
    actual = tmp_path / "actual.dump"
    actual.write_bytes(b"FAKE_ONLY_LEGACY")
    linked = tmp_path / "legacy-link.dump"
    linked.symlink_to(actual)
    result = _restore_preflight(tmp_path, linked, allow_legacy=True)
    assert result.returncode != 0
    assert "symlink" in (result.stdout + result.stderr).lower()
    assert "SAFE_FAKE_PG_DUMP_REJECTED" not in result.stdout + result.stderr
    assert "UNEXPECTED_RESTORE" not in result.stdout + result.stderr


def test_legacy_override_does_not_ignore_broken_sidecar_symlink(tmp_path: Path) -> None:
    archive = tmp_path / "owned.dump"
    archive.write_bytes(b"FAKE_ONLY_LEGACY")
    Path(f"{archive}.sha256").symlink_to(tmp_path / "missing-digest")
    result = _restore_preflight(tmp_path, archive, allow_legacy=True)
    assert result.returncode != 0
    assert "symlink" in (result.stdout + result.stderr).lower()
    assert "SAFE_FAKE_PG_DUMP_REJECTED" not in result.stdout + result.stderr
    assert "UNEXPECTED_RESTORE" not in result.stdout + result.stderr


def test_invalid_gzip_with_matching_checksum_fails_before_prebackup(tmp_path: Path) -> None:
    archive = tmp_path / "tampered.dump.gz"
    archive.write_bytes(b"THIS_IS_NOT_GZIP_ONLY_A_FAKE_FIXTURE")
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    Path(f"{archive}.sha256").write_text(f"{digest}  {archive.name}\n")
    result = _restore_preflight(tmp_path, archive)
    assert result.returncode != 0
    assert "gzip" in (result.stdout + result.stderr).lower()
    assert "SAFE_FAKE_PG_DUMP_REJECTED" not in result.stdout + result.stderr
    assert "UNEXPECTED_RESTORE" not in result.stdout + result.stderr
