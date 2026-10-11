"""Isolated, fake-tool guards for Macro C offline install and release backup.

No real Docker daemon, PostgreSQL, restore operation or operator state is used.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
from typing import Iterator

import pytest

ROOT = Path(__file__).resolve().parents[1]
STAMP = "20261012T010000Z"


def _make_backup_lab(tmp_path: Path) -> tuple[Path, dict[str, str]]:
    lab = tmp_path / "mock-release"
    release = lab / "scripts" / "release"
    release.mkdir(parents=True)
    for name in ("backup-before-upgrade.sh", "_release_postgres_catalog.sh"):
        shutil.copy2(ROOT / "scripts" / "release" / name, release / name)
    (lab / "docker-compose.platform.yml").write_text("services:\n  postgres: {}\n")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "case \" ${*} \" in\n"
        '  *" compose version "*) exit 0;;\n'
        '  *" config "*) printf "services:\\\\n  postgres:\\\\n    environment:\\\\n      POSTGRES_DB: gdc\\\\n      POSTGRES_USER: gdc\\\\n"; exit 0;;\n'
        '  *" ps -q postgres "*) printf "mock-postgres\\\\n"; exit 0;;\n'
        '  *" exec mock-postgres psql "*) printf "1\\\\n"; exit 0;;\n'
        '  *" exec mock-postgres pg_dump "*) printf "%s" "${MOCK_DUMP_PAYLOAD:-FAKE_SQL_ONLY}"; exit 0;;\n'
        "esac\n"
        'echo "Unrecognized mock docker invocation: $*" >&2; exit 20\n'
    )
    docker.chmod(0o700)
    clock = bin_dir / "date"
    clock.write_text(
        "#!/usr/bin/env bash\n"
        f'case "$*" in *"+%Y%m%dT%H%M%SZ"*) printf "{STAMP}\\\\n";; '
        '*) printf "2026-10-12T01:00:00Z\\\\n";; esac\n'
    )
    clock.chmod(0o700)
    env = {
        **os.environ,
        "PATH": str(bin_dir) + os.pathsep + os.environ.get("PATH", ""),
        "GDC_BACKUP_DIR": str(lab / "deploy" / "backups"),
        "GDC_BACKUP_DB_NAME": "gdc",
    }
    return lab, env


@pytest.fixture
def backup_sandbox() -> Iterator[tuple[Path, dict[str, str]]]:
    # Production pre-upgrade guard rejects /tmp roots; use a disposable $HOME lab.
    with tempfile.TemporaryDirectory(prefix="drcontrol-macroc-backup-", dir=Path.home()) as root:
        yield _make_backup_lab(Path(root))


def _run_backup(lab: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    # Run the production script in a separate fake repo with an explicit 022 umask.
    return subprocess.run(
        ["bash", "-c", 'umask 022; exec bash "$1"', "mock",
         str(lab / "scripts" / "release" / "backup-before-upgrade.sh")],
        env=env, capture_output=True, text=True, timeout=15, check=False,
    )


def test_preupgrade_backup_is_private_and_has_verifiable_digest(backup_sandbox) -> None:
    lab, env = backup_sandbox
    result = _run_backup(lab, env)
    assert result.returncode == 0, result.stderr
    directory = lab / "deploy" / "backups"
    archive = directory / f"gdc_pg_{STAMP}.sql.gz"
    digest = Path(str(archive) + ".sha256")
    log = directory / f"backup_{STAMP}.log"
    for artifact in (archive, digest, log):
        assert artifact.exists(), (artifact, result.stdout, result.stderr)
        assert stat.S_IMODE(artifact.stat().st_mode) == 0o600
    assert archive.stat().st_size > 0
    assert digest.read_text().strip() == (
        f"{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}"
    )


def test_preupgrade_backup_never_overwrites_same_timestamp(backup_sandbox) -> None:
    lab, env = backup_sandbox
    first = _run_backup(lab, env)
    assert first.returncode == 0, first.stderr
    archive = lab / "deploy" / "backups" / f"gdc_pg_{STAMP}.sql.gz"
    old = archive.read_bytes()
    second = _run_backup(lab, {**env, "MOCK_DUMP_PAYLOAD": "DIFFERENT"})
    assert second.returncode != 0, second.stdout + second.stderr
    assert archive.read_bytes() == old


def test_preupgrade_backup_does_not_follow_dangling_archive_symlink(tmp_path: Path, backup_sandbox) -> None:
    lab, env = backup_sandbox
    folder = lab / "deploy" / "backups"
    folder.mkdir(parents=True)
    outside = tmp_path / "outside.sql.gz"
    (folder / f"gdc_pg_{STAMP}.sql.gz").symlink_to(outside)
    result = _run_backup(lab, env)
    assert result.returncode != 0, result.stdout + result.stderr
    assert not outside.exists()


def _make_offline_lab(tmp_path: Path) -> tuple[Path, dict[str, str]]:
    lab = tmp_path / "mock-offline"
    scripts = lab / "scripts"
    scripts.mkdir(parents=True)
    shutil.copy2(
        ROOT / "scripts" / "offline" / "templates" / "scripts" / "install-offline.sh",
        scripts / "install-offline.sh",
    )
    (scripts / "_common.sh").write_text(
        'offline_resolve_package_root() { cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd; }\n'
        'offline_compose_file() { echo "$OFFLINE_PACKAGE_ROOT/configs/docker-compose.offline.yml"; }\n'
        'offline_env_file() { echo "$OFFLINE_PACKAGE_ROOT/configs/.env"; }\n'
        'offline_env_template() { echo "$OFFLINE_PACKAGE_ROOT/configs/.env.production.template"; }\n'
        'offline_ensure_docker_engine() { :; }\n'
        'offline_ts() { echo "mock-time"; }\n'
        'offline_read_env() { echo "gdc"; }\n'
        'offline_compose() { printf "compose %s\\\\n" "$*" >> "$MOCK_ACTION_LOG"; }\n'
        'offline_print_install_summary() { echo "mock summary"; }\n'
        'offline_confirm_destructive() { echo "confirmation_requested" >> "$MOCK_ACTION_LOG"; '
        '[[ "${MOCK_CONFIRM:-}" == "YES" ]]; }\n'
    )
    cfg = lab / "configs"
    cfg.mkdir()
    (cfg / "docker-compose.offline.yml").write_text("services: {}\n")
    (cfg / ".env.production.template").write_text(
        "POSTGRES_USER=gdc\nPOSTGRES_DB=gdc\nPOSTGRES_PASSWORD=mock_secret\n"
        "DATABASE_URL=postgresql://gdc:mock_secret@127.0.0.1:55432/gdc\n"
        "SECRET_KEY=mock_key\nJWT_SECRET_KEY=mock_jwt_key\n"
        "ENCRYPTION_KEY=mock_encryption_key\nGDC_PROXY_RELOAD_TOKEN=mock_token\n"
    )
    img = lab / "images"
    img.mkdir()
    loader = img / "load-images.sh"
    loader.write_text("#!/usr/bin/env bash\nexit 0\n")
    loader.chmod(0o700)
    env = {**os.environ, "MOCK_ACTION_LOG": str(tmp_path / "offline-actions.log")}
    return lab, env


def _run_offline(lab: Path, env: dict[str, str], *flags: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(lab / "scripts" / "install-offline.sh"), *flags],
        env=env, capture_output=True, text=True, timeout=15, check=False,
    )


def _actions(env: dict[str, str]) -> str:
    path = Path(env["MOCK_ACTION_LOG"])
    return path.read_text() if path.exists() else ""


def test_offline_default_install_never_removes_existing_volumes(tmp_path: Path) -> None:
    lab, env = _make_offline_lab(tmp_path)
    result = _run_offline(lab, env)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "down -v" not in _actions(env)


def test_offline_explicit_reset_requires_yes(tmp_path: Path) -> None:
    lab, env = _make_offline_lab(tmp_path)
    result = _run_offline(lab, env, "--reset-existing-data")
    assert result.returncode != 0
    assert "confirmation_requested" in _actions(env)
    assert "down -v" not in _actions(env)


def test_offline_confirmed_reset_is_explicit_only(tmp_path: Path) -> None:
    lab, env = _make_offline_lab(tmp_path)
    result = _run_offline(lab, {**env, "MOCK_CONFIRM": "YES"}, "--reset-existing-data")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "confirmation_requested" in _actions(env)
    assert "down -v --remove-orphans" in _actions(env)


def test_preupgrade_backup_rejects_dangling_digest_symlink(
    tmp_path: Path, backup_sandbox
) -> None:
    lab, env = backup_sandbox
    directory = lab / "deploy" / "backups"
    directory.mkdir(parents=True)
    outside = tmp_path / "tampered.sha256"
    (directory / f"gdc_pg_{STAMP}.sql.gz.sha256").symlink_to(outside)
    result = _run_backup(lab, env)
    assert result.returncode != 0, result.stdout + result.stderr
    assert not outside.exists()
    assert not (directory / f"gdc_pg_{STAMP}.sql.gz").exists()


def test_offline_skip_reset_compatibility_preserves_volumes(tmp_path: Path) -> None:
    lab, env = _make_offline_lab(tmp_path)
    result = _run_offline(lab, env, "--skip-reset")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "down -v" not in _actions(env)


def _run_release_restore_preflight(
    tmp_path: Path,
    *,
    checksum: str | None,
    legacy_override: bool = False,
) -> tuple[subprocess.CompletedProcess[str], str]:
    """Only a fake docker binary exists on PATH; no actual restore can run."""
    archive = tmp_path / "mock-release.sql.gz"
    archive.write_bytes(b"NOT_A_REAL_DATABASE_DUMP")
    if checksum is not None:
        receipt = archive.with_name(archive.name + ".sha256")
        if checksum == "valid":
            receipt.write_text(
                f"{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}\n"
            )
        elif checksum == "wrong-name":
            receipt.write_text(
                f"{hashlib.sha256(archive.read_bytes()).hexdigest()}  another.sql.gz\n"
            )
        else:
            receipt.write_text(f"{'0' * 64}  {archive.name}\n")

    bin_dir = tmp_path / "fake-bin"
    bin_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text(
        "#!/usr/bin/env bash\n"
        'printf "%s\\n" "$*" >> "$MOCK_RESTORE_DOCKER_LOG"\n'
        'exit 88  # Stop before any real Compose/PostgreSQL operation.\n'
    )
    docker.chmod(0o700)
    calls = tmp_path / "restore-docker-calls.log"
    env = {
        **os.environ,
        "PATH": str(bin_dir) + os.pathsep + os.environ.get("PATH", ""),
        "RESTORE_CONFIRM": "YES_I_UNDERSTAND",
        "MOCK_RESTORE_DOCKER_LOG": str(calls),
    }
    if legacy_override:
        env["ALLOW_UNVERIFIED_LEGACY_DUMP"] = "yes"
    else:
        env.pop("ALLOW_UNVERIFIED_LEGACY_DUMP", None)
    result = subprocess.run(
        ["bash", str(ROOT / "scripts/release/restore.sh"), str(archive)],
        env=env, capture_output=True, text=True, input="", timeout=15, check=False,
    )
    return result, calls.read_text() if calls.exists() else ""


def test_release_restore_rejects_bad_digest_before_docker(tmp_path: Path) -> None:
    result, docker_calls = _run_release_restore_preflight(tmp_path, checksum="corrupt")
    assert result.returncode != 0
    assert "checksum" in (result.stdout + result.stderr).lower()
    assert docker_calls == ""


def test_release_restore_rejects_digest_for_other_archive(tmp_path: Path) -> None:
    result, docker_calls = _run_release_restore_preflight(tmp_path, checksum="wrong-name")
    assert result.returncode != 0
    assert "checksum" in (result.stdout + result.stderr).lower()
    assert docker_calls == ""


def test_release_restore_requires_explicit_legacy_waiver(tmp_path: Path) -> None:
    result, docker_calls = _run_release_restore_preflight(tmp_path, checksum=None)
    assert result.returncode != 0
    assert "ALLOW_UNVERIFIED_LEGACY_DUMP" in result.stdout + result.stderr
    assert docker_calls == ""


def test_release_restore_accepts_valid_digest_at_preflight_only(tmp_path: Path) -> None:
    result, docker_calls = _run_release_restore_preflight(tmp_path, checksum="valid")
    # The fake docker intentionally exits 88; real restore never proceeds.
    assert result.returncode != 0
    assert "compose version" in docker_calls
    assert "exec" not in docker_calls


def test_release_restore_legacy_waiver_reaches_mock_only(tmp_path: Path) -> None:
    result, docker_calls = _run_release_restore_preflight(
        tmp_path, checksum=None, legacy_override=True
    )
    assert result.returncode != 0
    assert "compose version" in docker_calls
    assert "exec" not in docker_calls
