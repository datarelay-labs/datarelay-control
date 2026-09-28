"""Static checks for dev-validation fixture bootstrap scripts and container endpoint policy."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.dev_validation_lab import templates as T
from app.dev_validation_lab.env_defaults import _fixture_endpoint_defaults
from app.runtime.health_scoring_policy import stream_config_excluded_from_health_scoring

ROOT = Path(__file__).resolve().parents[1]


def _read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_seed_database_uses_docker_compose_exec_not_host_mysql() -> None:
    seed = _read("scripts/testing/source-expansion/seed-database-fixtures.sh")
    db_exec = _read("scripts/dev-validation/lib/db-exec.sh")
    assert "db-exec.sh" in seed
    assert "_fixture_compose exec" in db_exec
    assert "mysql-query-test" in seed
    assert "mariadb-query-test" in seed
    assert "127.0.0.1 -P3306 --protocol=TCP" in db_exec
    assert "DATABASE_QUERY_PG_URL" not in seed
    assert "psql \"$PG_URL\"" not in seed


def test_bootstrap_waits_mysql_mariadb_with_select_1() -> None:
    text = _read("scripts/dev-validation/bootstrap-platform-dev-validation.sh")
    assert "_wait_sql_tcp mysql-query-test" in text
    assert "_wait_sql_tcp mariadb-query-test" in text
    assert "smoke-fixture-bootstrap.sh" in text


def test_bootstrap_does_not_invoke_host_mysql_client() -> None:
    text = _read("scripts/dev-validation/bootstrap-platform-dev-validation.sh")
    assert "mysql " not in text.replace("mysql-query-test", "")
    assert "mariadb " not in text.replace("mariadb-query-test", "")


def test_minio_seed_uses_docker_network_not_host_only() -> None:
    text = _read("scripts/dev-validation/seed-minio-fixtures.sh")
    assert "gdc-minio-test:9000" in text
    assert "docker run" in text
    assert "DEV_VALIDATION_DOCKER_NETWORK" in text


def test_platform_dev_validation_overlay_container_urls() -> None:
    text = _read("docker-compose.platform.dev-validation.yml")
    assert "http://gdc-wiremock-test:8080" in text
    assert "http://gdc-webhook-receiver-test:8080" in text
    assert "http://gdc-minio-test:9000" in text
    assert "127.0.0.1" not in text
    assert "28080" not in text
    assert "18091" not in text


def test_platform_compose_core_lab_bootstrap_is_self_contained() -> None:
    text = _read("docker-compose.platform.yml")
    assert text.count("APP_ENV: development") >= 2
    assert "APP_ENV: ${APP_ENV:-development}" not in text
    assert "ENABLE_DEV_VALIDATION_LAB: ${ENABLE_DEV_VALIDATION_LAB:-true}" in text
    assert "DEV_VALIDATION_AUTO_START: ${DEV_VALIDATION_AUTO_START:-true}" in text
    assert "GDC_SEED_ADMIN_PASSWORD: ${GDC_SEED_ADMIN_PASSWORD:-}" in text
    assert "http://gdc-platform-wiremock-test:8080" in text
    assert "http://gdc-webhook-receiver-test:8080" in text
    assert "gdc-syslog-test" in text
    assert (
        "alembic upgrade head && python -m app.db.seed --platform-admin-only && uvicorn app.main:app"
        in text
    )
    assert "gdc-wiremock-test:" in text
    assert "gdc-webhook-receiver-test:" in text
    assert "gdc-syslog-test:" in text


def test_platform_compose_enables_source_expansion_lab_contract() -> None:
    text = _read("docker-compose.platform.yml")
    for flag in (
        "ENABLE_DEV_VALIDATION_S3",
        "ENABLE_DEV_VALIDATION_DATABASE_QUERY",
        "ENABLE_DEV_VALIDATION_REMOTE_FILE",
    ):
        assert f"{flag}: ${{{flag}:-true}}" in text
    assert "MINIO_ACCESS_KEY: ${MINIO_ACCESS_KEY:-gdcminioaccess}" in text
    assert "DEV_VALIDATION_SFTP_PASSWORD: ${DEV_VALIDATION_SFTP_PASSWORD:-devlab123}" in text
    assert "ENABLE_DEV_VALIDATION_PERFORMANCE: ${ENABLE_DEV_VALIDATION_PERFORMANCE:-false}" in text


def test_docker_env_defaults_use_fixture_service_names(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.dev_validation_lab.env_defaults.Path.exists", lambda self: self.as_posix() == "/.dockerenv")
    eps = _fixture_endpoint_defaults()
    assert "gdc-platform-wiremock-test" in eps["DEV_VALIDATION_WIREMOCK_BASE_URL"]
    assert "gdc-webhook-receiver-test" in eps["DEV_VALIDATION_WEBHOOK_BASE_URL"]
    assert "gdc-minio-test" in eps["MINIO_ENDPOINT"]
    for key, val in eps.items():
        if isinstance(val, str):
            assert "127.0.0.1" not in val
            assert "localhost" not in val


def test_lab_templates_do_not_embed_host_mapped_ports() -> None:
    text = _read("app/dev_validation_lab/templates.py")
    assert "28080" not in text
    assert "18091" not in text
    assert "59000" not in text
    assert "127.0.0.1" not in text


def test_health_scoring_exclusion_flags_remain() -> None:
    assert stream_config_excluded_from_health_scoring({"exclude_from_health_scoring": True}) is True
    assert stream_config_excluded_from_health_scoring(
        {"exclude_from_health_scoring": True, "validation_expected_failure": True}
    ) is True
    assert T.TK_OAUTH_TOKEN_EXCHANGE_FAIL in T.HEALTH_SCORING_EXCLUDED_TEMPLATE_KEYS
    assert "Stream empty-response" in T.LAB_NEGATIVE_PATH_STREAM_TITLES
