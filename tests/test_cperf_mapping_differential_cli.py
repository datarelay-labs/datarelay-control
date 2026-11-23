"""Exercise deterministic C-PERF source-matched Mapping differential CLI.

The test uses synthetic JSON only; no database, network or shared state.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "perf" / "cperf_mapping_differential.py"


def _invoke(path: Path, *, seed: int = 123, empty: bool = False, baseline: Path | None = None) -> subprocess.CompletedProcess[str]:
    command = [
        sys.executable, str(SCRIPT), "--out", str(path), "--cases", "40",
        "--seed", str(seed),
    ]
    if empty:
        command.append("--allow-empty")
    if baseline:
        command.extend(("--compare-to", str(baseline)))
    # A child started from scripts/perf does not implicitly inherit pytest's
    # project-root sys.path. Set the root explicitly for both local and CI.
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join(filter(None, (str(ROOT), env.get("PYTHONPATH", ""))))
    return subprocess.run(
        command, cwd=ROOT, env=env, capture_output=True, text=True,
        check=False, timeout=30,
    )


def test_mapping_differential_cli_reproducible_and_detects_mismatch(tmp_path: Path) -> None:
    baseline = tmp_path / "baseline.jsonl"
    candidate = tmp_path / "candidate.jsonl"
    first = _invoke(baseline, empty=True)
    assert first.returncode == 0, first.stderr
    second = _invoke(candidate, empty=True, baseline=baseline)
    assert second.returncode == 0, second.stderr
    assert json.loads(second.stdout)["baseline_equal"] is True
    assert json.loads(second.stdout)["errors"] == 0
    assert len(candidate.read_text().splitlines()) == 40
    assert candidate.read_bytes() == baseline.read_bytes()

    mismatch = _invoke(candidate, seed=124, empty=True, baseline=baseline)
    assert mismatch.returncode != 0
    assert "source-matched output mismatch" in mismatch.stderr
