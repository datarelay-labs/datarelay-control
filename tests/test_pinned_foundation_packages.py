"""Regression checks for Control's immutable PF-5B package consumption.

The lock SHA256 is the Foundation stage-release file-tree digest, NOT the
SHA256 of the npm tarball. npm's sha512 integrity is the tarball digest.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERIFY = ROOT / "scripts/testing/verify_pinned_foundation_packages.py"


def _run(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(VERIFY), "--root", str(root)],
        text=True,
        capture_output=True,
        check=False,
    )


def _isolated_packages(tmp_path: Path) -> Path:
    target = tmp_path / "frontend"
    (target / ".foundation").mkdir(parents=True)
    shutil.copytree(ROOT / "frontend/.foundation/packs", target / ".foundation/packs")
    for name in ("foundation.lock.json", "package-lock.json", "package.json"):
        shutil.copy2(ROOT / "frontend" / name, target / name)
    return tmp_path


def test_all_ten_pinned_foundation_packages_are_integrity_checked() -> None:
    result = _run(ROOT)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "CONTROL_FOUNDATION_PACKAGES=PASS 10/10" in result.stdout


def test_mutated_archive_fails_closed_without_touching_repository(tmp_path: Path) -> None:
    root = _isolated_packages(tmp_path)
    archive = next((root / "frontend/.foundation/packs").glob("*tokens-*.tgz"))
    archive.write_bytes(archive.read_bytes() + b"tampered")
    result = _run(root)
    assert result.returncode != 0
    assert "sha512" in result.stderr.lower()


def test_staged_tree_digest_mismatch_fails_closed(tmp_path: Path) -> None:
    root = _isolated_packages(tmp_path)
    path = root / "frontend/foundation.lock.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["packages"][0]["sha256"] = "0" * 64
    path.write_text(json.dumps(data), encoding="utf-8")
    result = _run(root)
    assert result.returncode != 0
    assert "tree-sha256" in result.stderr.lower()
