"""Guardrails for required-check path-filter deadlock prevention.

Branch protection on main-v2 requires:
  pytest-full, migration-validation, test-and-build, release-gate-unit

Those jobs must be *created* on every main-v2 PR. Top-level pull_request
paths/paths-ignore filters on the producing workflows would skip the whole
workflow and leave required checks Expected forever.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
DETECT = ROOT / "scripts" / "ci" / "detect-required-check-paths.sh"

REQUIRED_WORKFLOWS = {
    "backend-tests.yml": {"pytest-full", "migration-validation"},
    "frontend-tests.yml": {"test-and-build"},
    "oss-v1-release-validation.yml": {"release-gate-unit"},
}


def _load_workflow(name: str) -> dict:
    path = ROOT / ".github" / "workflows" / name
    with path.open(encoding="utf-8") as f:
        doc = yaml.safe_load(f)
    assert isinstance(doc, dict)
    return doc


def _detect(*files: str) -> dict[str, str]:
    assert DETECT.is_file()
    proc = subprocess.run(
        [str(DETECT), "--files", *files],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    out: dict[str, str] = {}
    for line in proc.stdout.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            out[k] = v
    return out


@pytest.mark.parametrize("workflow_name, job_names", sorted(REQUIRED_WORKFLOWS.items()))
def test_required_workflows_have_no_blocking_pr_path_filters(workflow_name: str, job_names: set[str]) -> None:
    doc = _load_workflow(workflow_name)
    on = doc.get("on") or doc.get(True)  # YAML may parse 'on' as True
    assert isinstance(on, dict), f"{workflow_name}: missing on:"

    pr = on.get("pull_request")
    assert pr is not None, f"{workflow_name}: missing pull_request trigger"

    if isinstance(pr, dict):
        assert "paths" not in pr, f"{workflow_name}: pull_request.paths must not block required checks"
        assert "paths-ignore" not in pr, f"{workflow_name}: pull_request.paths-ignore must not block required checks"
        branches = pr.get("branches")
        assert branches is not None, f"{workflow_name}: pull_request.branches required"
        assert "main-v2" in branches, f"{workflow_name}: must target main-v2"

    jobs = doc.get("jobs") or {}
    for job_name in job_names:
        assert job_name in jobs, f"{workflow_name}: missing required job {job_name}"
        job = jobs[job_name]
        # Job-level if:false would yield skipped, which is unsafe for required contexts.
        assert "if" not in job, f"{workflow_name}/{job_name}: do not skip required job via if:"


def test_detect_docs_only_is_noop() -> None:
    result = _detect("README.md", "docs/architecture/overview.md")
    assert result["backend"] == "false"
    assert result["migration"] == "false"
    assert result["frontend"] == "false"
    assert result["release"] == "false"


def test_detect_backend_python_runs_backend_and_migration() -> None:
    result = _detect("app/main.py")
    assert result["backend"] == "true"
    assert result["migration"] == "true"
    assert result["frontend"] == "false"
    assert result["release"] == "false"


def test_detect_alembic_runs_migration() -> None:
    result = _detect("alembic/versions/20260808_example.py")
    assert result["backend"] == "true"  # alembic is in backend patterns
    assert result["migration"] == "true"
    assert result["frontend"] == "false"


def test_detect_frontend_only() -> None:
    result = _detect("frontend/src/App.tsx")
    assert result["backend"] == "false"
    assert result["migration"] == "false"
    assert result["frontend"] == "true"
    assert result["release"] == "false"


def test_detect_release_paths() -> None:
    result = _detect("e2e/framework/validate-oss-v1-release-gate.test.ts")
    assert result["release"] == "true"
    assert result["backend"] == "false"
    assert result["frontend"] == "false"


def test_detect_minio_fixture_dockerfile_runs_backend() -> None:
    result = _detect("docker/Dockerfile.minio-test")
    assert result["backend"] == "true"
    assert result["migration"] == "true"
    assert result["frontend"] == "false"
    assert result["release"] == "false"


def test_minio_fixture_dockerfile_is_on_fixture_e2e_path_filters() -> None:
    for name in ("source-adapter-e2e.yml", "external-runtime-e2e.yml"):
        doc = _load_workflow(name)
        on = doc.get("on") or doc.get(True)
        assert isinstance(on, dict)
        pr = on.get("pull_request")
        assert isinstance(pr, dict)
        paths = pr.get("paths") or []
        assert "docker/Dockerfile.minio-test" in paths


def test_detect_required_workflow_change_is_conservative() -> None:
    result = _detect(".github/workflows/backend-tests.yml")
    assert result["backend"] == "true"
    assert result["migration"] == "true"
    assert result["frontend"] == "true"
    assert result["release"] == "true"
    assert result["reason"] == "required_workflow_or_detector_changed"
