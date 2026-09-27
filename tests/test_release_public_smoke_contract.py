from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_public_smoke_rebuilds_candidate_images_on_explicit_local_stack() -> None:
    release = _read(".engineering/release.yaml")
    assert (
        "public_smoke_command: GDC_RELEASE_COMPOSE_FILE=docker-compose.platform.yml "
        "bash scripts/release/install.sh --build"
    ) in release


def test_install_build_path_prepares_exact_source_identity() -> None:
    install = _read("scripts/release/install.sh")
    assert "prepare_build_identity()" in install
    assert 'git_sha="$(git -C "$ROOT" rev-parse HEAD' in install
    assert 'export GDC_BUILD_GIT_SHA="$git_sha"' in install
    assert "compute_build_source_digest" in install
    assert 'export GDC_BUILD_GIT_DIRTY=true' in install
    assert 'export GDC_BUILD_GIT_DIRTY=false' in install

    build_block = install.split('if [[ "$DO_BUILD" -eq 1 ]]; then', 1)[1]
    assert build_block.index("prepare_build_identity") < build_block.index(
        'docker compose -f "$COMPOSE_REL" build api'
    )


def test_platform_and_production_security_profiles_stay_separate() -> None:
    platform = _read("docker-compose.platform.yml")
    production = _read("deploy/docker-compose.https.yml")

    assert platform.count("APP_ENV: development") >= 2
    assert platform.count('REQUIRE_AUTH: "false"') >= 2
    assert "APP_ENV: production" in production
    assert 'REQUIRE_AUTH: "true"' in production
    assert "/var/run/docker.sock" not in production


def test_installer_is_compose_aware_for_production_entry_ports() -> None:
    install = _read("scripts/release/install.sh")
    assert "using_https_compose()" in install
    assert 'raw="$(env_value GDC_ENTRY_HTTP_PORT)"' in install
    assert 'raw="$(env_value GDC_ENTRY_HTTPS_PORT)"' in install
    assert 'GDC_PLATFORM_POSTGRES_HOST_PORT_RESOLVED=""' in install
    assert 'INSTALL_REQUIRED_PORTS+=("$GDC_PLATFORM_POSTGRES_HOST_PORT_RESOLVED")' in install
    assert 'port="$(resolve_entry_http_port)"' in install
    assert '_https_port="$(resolve_entry_https_port)"' in install
    assert 'export COMPOSE_ENV_FILES="$ENV_FILE"' in install
