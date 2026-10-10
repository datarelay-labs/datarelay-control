"""PF-12B Control backup artifact truth, with fake pg_dump only (no database)."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import stat
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
BACKUP = ROOT / "scripts" / "ops" / "backup-postgres.sh"


def _fake_backup(tmp_path: Path, *, gzip: bool = False, fail: bool = False):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir(exist_ok=True)
    fake_date = fake_bin / "date"
    fake_date.write_text(
        "#!/usr/bin/env python3\n"
        "import sys\n"
        "print('20261010T000000Z' if 'Y%m%dT%H%M%SZ' in ' '.join(sys.argv) else '2026-10-10T00:00:00Z')\n"
    )
    fake_date.chmod(0o700)
    pg_dump = fake_bin / "pg_dump"
    pg_dump.write_text(
        "#!/usr/bin/env python3\n"
        "import os, pathlib, sys\n"
        "dest = next(a.split('=', 1)[1] for a in sys.argv if a.startswith('--file='))\n"
        "pathlib.Path(dest).write_bytes(b'FAKE_DB_DATA_ONLY')\n"
        "sys.exit(33 if os.getenv('FAKE_PG_DUMP_FAIL') else 0)\n"
    )
    pg_dump.chmod(0o700)
    backup_dir = tmp_path / "owned-backups"
    env = {
        **os.environ,
        "PATH": str(fake_bin) + os.pathsep + os.environ.get("PATH", ""),
        "DATABASE_URL": "postgresql://fakeuser:fakepassword@127.0.0.1:5432/gdc_pf12_fake",
        "BACKUP_DIR": str(backup_dir),
        "GZIP_BACKUP": "1" if gzip else "0",
        "FAKE_PG_DUMP_FAIL": "1" if fail else "",
    }
    completed = subprocess.run(
        ["bash", str(BACKUP)], env=env, capture_output=True,
        text=True, timeout=25, check=False,
    )
    return completed, backup_dir


@pytest.mark.parametrize("gzip", [False, True])
def test_success_creates_private_nonempty_archive_with_independent_digest(tmp_path, gzip):
    result, folder = _fake_backup(tmp_path, gzip=gzip)
    assert result.returncode == 0, result.stderr
    ext = "*.dump.gz" if gzip else "*.dump"
    archives = list(folder.glob(ext))
    assert len(archives) == 1
    artifact = archives[0]
    assert stat.S_IMODE(artifact.stat().st_mode) == 0o600
    assert artifact.stat().st_size > 0
    sidecar = Path(f"{artifact}.sha256")
    assert sidecar.is_file()
    assert stat.S_IMODE(sidecar.stat().st_mode) == 0o600
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    assert sidecar.read_text().strip() == f"{digest}  {artifact.name}"
    assert digest in result.stdout
    assert "fakepassword" not in result.stdout + result.stderr
    assert "encryption" not in sidecar.read_text().lower()


def test_failing_pg_dump_never_produces_a_success_receipt_and_limits_partial_permissions(tmp_path):
    result, folder = _fake_backup(tmp_path, fail=True)
    assert result.returncode != 0
    assert "RESULT: FAILURE" in result.stdout
    assert list(folder.glob("*.sha256")) == []
    for artifact in folder.glob("*.dump"):
        assert stat.S_IMODE(artifact.stat().st_mode) == 0o600
    assert "fakepassword" not in result.stdout + result.stderr


def test_second_backup_same_timestamp_refuses_to_overwrite_existing_archive(tmp_path):
    first, folder = _fake_backup(tmp_path)
    assert first.returncode == 0
    archive = next(folder.glob("*.dump"))
    original_bytes = archive.read_bytes()
    sidecar = Path(f"{archive}.sha256")
    original_digest = sidecar.read_text()

    second, _ = _fake_backup(tmp_path)
    assert second.returncode != 0
    assert "refusing overwrite" in second.stderr
    assert archive.read_bytes() == original_bytes
    assert sidecar.read_text() == original_digest


@pytest.mark.parametrize("extension", [".dump", ".dump.gz", ".dump.sha256", ".dump.gz.sha256"])
def test_backup_refuses_broken_symlink_artifact_collisions(tmp_path, extension):
    # A broken symlink is false under -e, but a pg_dump --file write would
    # otherwise follow it and create an arbitrary outside file.
    folder = tmp_path / "owned-backups"
    folder.mkdir()
    outside = tmp_path / f"unrelated-{extension.replace('.', '_')}"
    link = folder / f"gdc-postgres-20261010T000000Z{extension}"
    link.symlink_to(outside)
    result, _ = _fake_backup(tmp_path)
    assert result.returncode != 0
    assert "refusing overwrite" in result.stderr
    assert link.is_symlink()
    assert not outside.exists()


def test_export_fails_closed_without_real_postgres_binary_or_credentials(tmp_path):
    folder = tmp_path / "owned-backups"
    result = subprocess.run(
        ["bash", str(BACKUP)], env={"PATH": os.environ.get("PATH", ""), "BACKUP_DIR": str(folder)},
        capture_output=True, text=True, timeout=20, check=False,
    )
    assert result.returncode != 0
    assert not list(folder.glob("*.dump")) if folder.exists() else True
