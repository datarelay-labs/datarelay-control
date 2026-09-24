"""Contract tests for backend full-test compose isolation."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_run_backend_full_uses_compose_project_and_reuses_healthy_wiremock() -> None:
    text = (ROOT / "scripts/test/run-backend-full.sh").read_text(encoding="utf-8")
    assert 'source "$ROOT/scripts/testing/_env.sh"' in text
    assert "COMPOSE_PROJECT_NAME" in text
    assert "GDC_TEST_CONTAINER_PREFIX" in text
    assert "wiremock_already_healthy" in text
    assert "not recreating container" in text
    assert "docker rm -f" not in text
    assert 'docker compose -p "$COMPOSE_PROJECT_NAME"' in text


def test_testing_env_defaults_isolate_container_prefix() -> None:
    text = (ROOT / "scripts/testing/_env.sh").read_text(encoding="utf-8")
    assert 'GDC_TEST_CONTAINER_PREFIX="${GDC_TEST_CONTAINER_PREFIX:-gdc-smoke}"' in text
    assert "GDC_TEST_COMPOSE_PROJECT" in text
    assert "GDC_TEST_WIREMOCK_HOST_PORT" in text
    assert "SOURCE_E2E_SFTP_CONTAINER" in text
    assert "${GDC_TEST_CONTAINER_PREFIX}-sftp-test" in text


def test_source_e2e_seed_uses_prefixed_sftp_container() -> None:
    text = (ROOT / "scripts/testing/source-e2e/seed-fixtures.sh").read_text(encoding="utf-8")
    assert "SOURCE_E2E_SFTP_CONTAINER" in text
    assert "SFTP_CONTAINER" in text
    assert "gdc-sftp-test:/home/gdc/upload" not in text


def test_compose_wiremock_host_port_is_configurable() -> None:
    text = (ROOT / "docker-compose.test.yml").read_text(encoding="utf-8")
    assert "GDC_TEST_WIREMOCK_HOST_PORT" in text
    assert "gdc}-wiremock-test" in text


def test_source_adapter_e2e_workflow_uses_shared_test_runner() -> None:
    """Compose postgres-test publishes 55441; GHA services.postgres uses 55432."""

    text = (ROOT / ".github/workflows/source-adapter-e2e.yml").read_text(encoding="utf-8")
    assert "run-source-e2e-tests.sh" in text
    assert "127.0.0.1:55432" not in text
    runner = (ROOT / "scripts/test/run-source-e2e-tests.sh").read_text(encoding="utf-8")
    assert 'source "$ROOT/scripts/testing/_env.sh"' in runner
    assert "GDC_TEST_POSTGRES_HOST_PORT" in runner


def test_external_runtime_e2e_workflow_uses_shared_test_runner() -> None:
    """Env must stay in one process so gdc-smoke-sftp-test matches pytest helpers."""

    text = (ROOT / ".github/workflows/external-runtime-e2e.yml").read_text(encoding="utf-8")
    assert "run-external-runtime-e2e-tests.sh" in text
    assert "127.0.0.1:55432" not in text
    runner = (ROOT / "scripts/test/run-external-runtime-e2e-tests.sh").read_text(encoding="utf-8")
    assert 'source "$ROOT/scripts/testing/_env.sh"' in runner
    assert "SOURCE_E2E_SFTP_CONTAINER" in (ROOT / "scripts/testing/_env.sh").read_text(encoding="utf-8")


def test_minio_fixture_uses_pinned_upstream_source() -> None:
    text = (ROOT / "docker-compose.test.yml").read_text(encoding="utf-8")
    assert "quay.io/minio/minio" not in text
    assert "minio/minio:latest" not in text
    assert "dockerfile: Dockerfile.minio-test" in text
    dockerfile = (ROOT / "docker/Dockerfile.minio-test").read_text(encoding="utf-8")
    assert "9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a" in dockerfile
    assert "45521908307306e925c98d629e1c17d78c8b72b6ee242b1bfb1409f7d8ee5841" in dockerfile


def test_sqlalchemy_keeps_psycopg2_postgresql_url_contract() -> None:
    text = (ROOT / "requirements.txt").read_text(encoding="utf-8")
    assert "sqlalchemy>=2.0.41,<2.1" in text
    assert "psycopg2-binary" in text


def test_compose_postgres_test_default_host_port_is_not_gha_services_port() -> None:
    text = (ROOT / "docker-compose.test.yml").read_text(encoding="utf-8")
    assert "GDC_TEST_POSTGRES_HOST_PORT:-55441" in text
    env = (ROOT / "scripts/testing/_env.sh").read_text(encoding="utf-8")
    assert 'GDC_TEST_POSTGRES_HOST_PORT="${GDC_TEST_POSTGRES_HOST_PORT:-55441}"' in env


def test_pytest_sessionlocal_targets_allowed_pytest_catalog() -> None:
    """Legacy protection OFF-path loads rules via SessionLocal; must match fixtures."""

    from app.database import DATABASE_URL
    from tests.db_test_policy import ALLOWED_PYTEST_DATABASE_CATALOGS, catalog_name_from_database_url

    catalog = catalog_name_from_database_url(DATABASE_URL)
    assert catalog in ALLOWED_PYTEST_DATABASE_CATALOGS
    assert catalog != "gdc"
