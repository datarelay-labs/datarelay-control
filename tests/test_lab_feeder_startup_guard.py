"""The dev feeder rejects stale API targets before starting."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / "scripts/dev-validation/start-lab-throughput-feeder.sh"


def _run_launcher(tmp_path: Path, *, curl_exit: int):
    bindir = tmp_path / "fake-bin"
    bindir.mkdir()
    capture = tmp_path / "commands.txt"
    curl = bindir / "curl"
    curl.write_text("#!/bin/sh\necho \"curl $*\" >> \"$CAPTURE\"\nexit " + str(curl_exit) + "\n")
    curl.chmod(0o700)
    python = bindir / "python3"
    python.write_text('#!/bin/sh\necho "python3 $*" >> "$CAPTURE"\n')
    python.chmod(0o700)
    env = dict(os.environ)
    env["PATH"] = str(bindir) + os.pathsep + env.get("PATH", "")
    env["CAPTURE"] = str(capture)
    env["LAB_THROUGHPUT_API_BASE_URL"] = "http://127.0.0.1:19399"
    result = subprocess.run(
        ["bash", str(LAUNCHER), "--once"], cwd=ROOT,
        env=env, capture_output=True, text=True, check=False, timeout=8,
    )
    return result, capture.read_text().splitlines()


def test_feeder_rejects_unreachable_api_without_starting(tmp_path):
    result, lines = _run_launcher(tmp_path, curl_exit=7)
    assert result.returncode == 69
    assert "LAB_THROUGHPUT_API_UNAVAILABLE" in result.stderr
    assert len(lines) == 1
    assert "http://127.0.0.1:19399/health" in lines[0]


def test_feeder_starts_only_after_api_health_success(tmp_path):
    result, lines = _run_launcher(tmp_path, curl_exit=0)
    assert result.returncode == 0
    assert len(lines) == 2
    assert "http://127.0.0.1:19399/health" in lines[0]
    assert "python3 -m app.dev_validation_lab.lab_throughput_feeder --once" in lines[1]
