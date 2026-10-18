"""Fake-Docker, isolated Macro C offline package contract qualification.

No Docker daemon, database, real installer, reset or network call.
"""
from __future__ import annotations

import os
from pathlib import Path
import re
import shutil
import stat
import subprocess

ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "scripts/build-offline-package.sh"


def test_offline_stage_copies_only_existing_template_sources() -> None:
    script = BUILDER.read_text(encoding="utf-8")
    cp_sources = re.findall(
        r'(?m)^\s*cp "\$ROOT/([^"]+)" "\$INSTALL_DIR/[^"]+"', script
    )
    assert len(cp_sources) >= 8
    missing = [relative for relative in cp_sources if not (ROOT / relative).is_file()]
    assert missing == [], f"Nonexistent offline package template: {missing}"
    env_source = re.search(
        r'(?m)^\s*cp "\$ROOT/([^"]+)" "\$INSTALL_DIR/\.env"$', script
    )
    assert env_source is not None
    assert env_source.group(1) == "scripts/offline/templates/.env.production.template"


def test_fake_docker_offline_package_stages_and_preflights(tmp_path: Path) -> None:
    lab = tmp_path / "repo"
    scripts = lab / "scripts"
    templates = scripts / "offline" / "templates"
    scripts.mkdir(parents=True)
    templates.mkdir(parents=True)
    shutil.copy2(BUILDER, scripts / "build-offline-package.sh")
    shutil.copytree(
        ROOT / "scripts/offline/templates/offline_install",
        templates / "offline_install",
    )
    shutil.copy2(
        ROOT / "scripts/offline/templates/.env.production.template",
        templates / ".env.production.template",
    )
    collector = scripts / "offline" / "collect-docker-debs.sh"
    collector.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$1"
for pkg in containerd.io docker-ce docker-ce-cli docker-buildx-plugin docker-compose-plugin; do
  printf 'TEST_ONLY' > "$1/"$pkg"_mock.deb"
done
printf 'mock fixture\n' > "$(dirname "$1")/DEBS.manifest"
""",
        encoding="utf-8",
    )
    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir()
    docker = fake_bin / "docker"
    docker.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  image) [[ "$2" == inspect ]] && exit 0;;
  info) exit 0;;
  compose)
    [[ "$2" == version ]] && exit 0
    for arg in "$@"; do
      if [[ "$arg" == config ]]; then
        [[ "$*" == *" -q" ]] && exit 0
        printf 'services:\n  reverse-proxy:\n    ports:\n      - mode: ingress\n        published: "18080"\n        target: 80\n        protocol: tcp\n'
        exit 0
      fi
    done
    ;;
  save)
    [[ "$2" == -o ]] || exit 90
    printf 'FAKE_IMAGE_ARCHIVE_ONLY' > "$3"
    exit 0
    ;;
esac
echo "Unexpected mock docker command: $*" >&2
exit 91
""",
        encoding="utf-8",
    )
    docker.chmod(0o700)
    env = {
        **os.environ,
        "PATH": str(fake_bin) + os.pathsep + os.environ.get("PATH", ""),
        "GDC_OFFLINE_SKIP_BUILD": "1",
        "GDC_OFFLINE_OUTPUT_DIR": str(lab / "offline-release"),
    }
    run = subprocess.run(
        ["bash", str(scripts / "build-offline-package.sh")],
        env=env, cwd=lab, capture_output=True, text=True,
        timeout=30, check=False,
    )
    assert run.returncode == 0, run.stdout + run.stderr
    bundle = lab / "offline-release" / "offline_install"
    assert stat.S_IMODE((bundle / ".env").stat().st_mode) == 0o600
    assert (bundle / ".env").read_bytes() == (
        templates / ".env.production.template"
    ).read_bytes()
    assert (bundle / ".env.production.template").read_bytes() == (
        templates / ".env.production.template"
    ).read_bytes()
    manifest = (bundle / "checksums" / "SHA256SUMS").read_text()
    manifest_paths = [line.split("  ", 1)[-1] for line in manifest.splitlines()]
    assert "./.env" not in manifest_paths
    assert "./.env.production.template" in manifest_paths
    for name in ("SHA256SUMS", "DEBS.manifest", "IMAGES.manifest"):
        assert (bundle / "checksums" / name).is_file(), name
    check = subprocess.run(
        ["sha256sum", "-c", "checksums/SHA256SUMS"],
        cwd=bundle, capture_output=True, text=True, check=False,
    )
    assert check.returncode == 0, check.stdout + check.stderr
    archive = next(lab.glob("offline-release-*.tar.gz"))
    check_outer = subprocess.run(
        ["sha256sum", "-c", str(archive) + ".sha256"],
        cwd=lab, capture_output=True, text=True, check=False,
    )
    assert check_outer.returncode == 0, check_outer.stdout + check_outer.stderr
    dry = subprocess.run(
        ["bash", str(bundle / "install.sh"), "--dry-run"],
        env=env, cwd=lab, capture_output=True, text=True,
        timeout=15, check=False,
    )
    assert dry.returncode == 0, dry.stdout + dry.stderr
    assert "Dry-run validation PASS" in dry.stdout

    # .env holds operator-owned secrets. An operator must be able to change
    # those bytes without invalidating the immutable package file manifest.
    config = bundle / ".env"
    config.write_text(
        config.read_text(encoding="utf-8") + "\n# SANITIZED_TEST_ONLY_OPERATOR_EDIT\n",
        encoding="utf-8",
    )
    operator_dry = subprocess.run(
        ["bash", str(bundle / "install.sh"), "--dry-run"],
        env=env, cwd=lab, capture_output=True, text=True,
        timeout=15, check=False,
    )
    assert operator_dry.returncode == 0, operator_dry.stdout + operator_dry.stderr

    # Mutable secrets are excluded, but immutable bundled content must still
    # be tamper-detected before any image loading or installation.
    readme = bundle / "README.md"
    readme.write_bytes(readme.read_bytes() + b"\n# TAMPER_TEST_ONLY\n")
    tampered_dry = subprocess.run(
        ["bash", str(bundle / "install.sh"), "--dry-run"],
        env=env, cwd=lab, capture_output=True, text=True,
        timeout=15, check=False,
    )
    assert tampered_dry.returncode != 0, tampered_dry.stdout
    assert "SHA256SUMS verification failed" in (
        tampered_dry.stdout + tampered_dry.stderr
    )

    # The reset entry must reject an explicit refusal, without invoking
    # Docker down/volume deletion even when the package itself is present.
    refused_reset = subprocess.run(
        ["bash", str(bundle / "reset.sh")],
        cwd=lab, env=env, input="NO\n",
        capture_output=True, text=True, timeout=10, check=False,
    )
    assert refused_reset.returncode != 0
    assert "Aborted" in (refused_reset.stdout + refused_reset.stderr)
