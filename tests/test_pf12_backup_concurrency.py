"""Concurrent PF-12 backup collision test with fake pg_dump and no database."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
BACKUP = ROOT / "scripts/ops/backup-postgres.sh"
STAMP = "20261012T000000Z"


def test_two_concurrent_backups_same_second_never_share_archive(tmp_path: Path) -> None:
    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir()
    fixed_date = fake_bin / "date"
    fixed_date.write_text(
        "#!/usr/bin/env python3\n"
        "import sys\n"
        f"print('{STAMP}' if 'Y%m%dT%H%M%SZ' in ' '.join(sys.argv) else '2026-10-12T00:00:00Z')\n"
    )
    fixed_date.chmod(0o700)
    fake_dump = fake_bin / "pg_dump"
    fake_dump.write_text(
        "#!/usr/bin/env python3\n"
        "import os, pathlib, sys, time\n"
        "target = next(a.split('=', 1)[1] for a in sys.argv if a.startswith('--file='))\n"
        "marker = pathlib.Path(os.environ['FAKE_BACKUP_STARTED'])\n"
        "with marker.open('a') as out: out.write('started\\n')\n"
        "gate = pathlib.Path(os.environ['FAKE_BACKUP_RELEASE'])\n"
        "for _ in range(1000):\n"
        "    if gate.exists(): break\n"
        "    time.sleep(0.01)\n"
        "else: sys.exit(88)\n"
        "pathlib.Path(target).write_bytes(b'FAKE_NONDB_PG_DUMP')\n"
    )
    fake_dump.chmod(0o700)
    folder = tmp_path / "backups"
    marker = tmp_path / "started-count"
    release = tmp_path / "release-first-backup"
    env = {
        **os.environ,
        "PATH": str(fake_bin) + os.pathsep + os.environ.get("PATH", ""),
        "DATABASE_URL": "postgresql://fakeuser:fakepass@127.0.0.1:5432/test_only",
        "BACKUP_DIR": str(folder),
        "FAKE_BACKUP_STARTED": str(marker),
        "FAKE_BACKUP_RELEASE": str(release),
    }
    first = subprocess.Popen(
        ["bash", str(BACKUP)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    second = None
    try:
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            if marker.exists() and marker.read_text().count("started") >= 1:
                break
            if first.poll() is not None:
                break
            time.sleep(0.02)
        assert marker.exists() and marker.read_text().count("started") == 1, "First fake backup did not start"
        assert first.poll() is None

        # Launch before the first pg_dump has created any archive. Existing
        # sequential file-exists preflights are insufficient at this boundary.
        second = subprocess.Popen(
            ["bash", str(BACKUP)], env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline and second.poll() is None:
            if marker.read_text().count("started") >= 2:
                break
            time.sleep(0.02)
        release.touch()
        stdout1, stderr1 = first.communicate(timeout=12)
        stdout2, stderr2 = second.communicate(timeout=12)
        assert first.returncode == 0, (stdout1, stderr1)
        assert second.returncode != 0, (stdout2, stderr2)
        assert marker.read_text().count("started") == 1, "Two pg_dump writers entered same archive"
        assert "refusing" in stderr2.lower() or "locked" in stderr2.lower()
        archive = folder / f"gdc-postgres-{STAMP}.dump"
        assert archive.read_bytes() == b"FAKE_NONDB_PG_DUMP"
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        assert (folder / f"{archive.name}.sha256").read_text().strip() == f"{digest}  {archive.name}"
    finally:
        release.touch(exist_ok=True)
        for proc in (first, second):
            if proc is not None and proc.poll() is None:
                proc.terminate()
                proc.communicate(timeout=5)
