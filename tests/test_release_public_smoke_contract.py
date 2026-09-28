from __future__ import annotations

import shlex
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_public_smoke_is_candidate_bound_and_disposable() -> None:
    release = _read(".engineering/release.yaml")
    smoke = _read("scripts/release/public-smoke.sh")
    platform = _read("docker-compose.platform.yml")
    install = _read("scripts/release/install.sh")

    assert "public_smoke_command: bash scripts/release/public-smoke.sh" in release
    assert "bash scripts/release/install.sh --build" in smoke
    assert 'git -C "$ROOT" status --porcelain=v1' in smoke
    assert "ensure_platform_external_network()" in install
    assert 'docker network create "$network_name"' in install
    assert 'docker compose -p "$project" -f "$COMPOSE" down -v --remove-orphans' in smoke
    assert 'GDC_PLATFORM_CONTAINER_PREFIX="$prefix"' in smoke
    assert 'GDC_PLATFORM_DEFAULT_NETWORK_NAME="$default_network"' in smoke
    assert 'GDC_DEV_VALIDATION_NETWORK_NAME="$dev_network"' in smoke
    assert 'GDC_RELEASE_ENV_FILE="$env_file"' in smoke
    assert 'GDC_RUNTIME_IMAGE_TAG="$runtime_tag"' in smoke
    assert "public-smoke build identity mismatch" in smoke
    assert "PUBLIC_SMOKE=PASS" in smoke

    assert '${GDC_PLATFORM_CONTAINER_PREFIX:-gdc-platform}-api' in platform
    assert '${GDC_PLATFORM_DEFAULT_NETWORK_NAME:-gdc-platform_default}' in platform
    assert '${GDC_DEV_VALIDATION_NETWORK_NAME:-gdc-dev-validation}' in platform
    assert 'ENV_FILE="${GDC_RELEASE_ENV_FILE:-$ROOT/.env}"' in install


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


def _run_install_functions(body: str) -> subprocess.CompletedProcess[str]:
    install = ROOT / "scripts" / "release" / "install.sh"
    return subprocess.run(
        ["bash", "-c", f"source {shlex.quote(str(install))}\n{body}"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def test_fresh_https_env_aligns_public_redirect_port(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("GDC_PUBLIC_HTTPS_PORT=18443\n", encoding="utf-8")
    result = _run_install_functions(
        f"""
ENV_FILE={shlex.quote(str(env_file))}
COMPOSE_REL=deploy/docker-compose.https.yml
INSTALL_ENV_CREATED=1
export GDC_ENTRY_HTTPS_PORT=19443
synchronize_new_https_public_port
"""
    )
    assert result.returncode == 0, result.stderr
    assert "GDC_PUBLIC_HTTPS_PORT=19443" in env_file.read_text(encoding="utf-8")


def test_https_redirect_health_and_login_retry_direct_https() -> None:
    result = _run_install_functions(
        r"""
COMPOSE_REL=deploy/docker-compose.https.yml
export GDC_ENTRY_HTTP_PORT=19080
export GDC_ENTRY_HTTPS_PORT=19443
export GDC_SEED_ADMIN_PASSWORD=unit-test-password
curl() {
  case "$*" in
    *"http://127.0.0.1:19080/health"*) printf '301' ;;
    *"https://127.0.0.1:19443/health"*) printf '200' ;;
    *"http://127.0.0.1:19080/api/v1/auth/login"*) printf '301' ;;
    *"https://127.0.0.1:19443/api/v1/auth/login"*) printf '200' ;;
    *) printf '000' ;;
  esac
}
verify_reverse_proxy_health
verify_login_endpoint
echo PASS
"""
    )
    assert result.returncode == 0, result.stderr
    assert "PASS" in result.stdout


def test_https_banner_does_not_claim_tls_is_enabled_before_admin_activation() -> None:
    install = _read("scripts/release/install.sh")
    assert "Production HTTPS compose is active" not in install
    assert "after Admin TLS enablement" in install


def test_existing_https_env_preserves_operator_public_redirect_port(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("GDC_PUBLIC_HTTPS_PORT=24443\n", encoding="utf-8")
    result = _run_install_functions(
        f"""
ENV_FILE={shlex.quote(str(env_file))}
COMPOSE_REL=deploy/docker-compose.https.yml
INSTALL_ENV_CREATED=0
export GDC_ENTRY_HTTPS_PORT=19443
synchronize_new_https_public_port
"""
    )
    assert result.returncode == 0, result.stderr
    assert "GDC_PUBLIC_HTTPS_PORT=24443" in env_file.read_text(encoding="utf-8")
