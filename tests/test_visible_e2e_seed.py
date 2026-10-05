"""Safety and compose-awareness checks for visible [DEV E2E] fixture seed."""

from __future__ import annotations

import os

import pytest

from app.dev_validation_lab.visible_e2e_seed import (
    VISIBLE_E2E_WEBHOOK_RECEIVER_KEY,
    assert_safe_database_url,
    seed_visible_e2e_fixtures,
)


def test_assert_safe_database_url_allows_compose_postgres_host(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://gdc:gdc@postgres:5432/gdc")
    monkeypatch.setenv("APP_ENV", "development")
    assert_safe_database_url(local_dev_mode=False, allow_compose_catalog_host=True)


def test_assert_safe_database_url_rejects_compose_postgres_without_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://gdc:gdc@postgres:5432/gdc")
    monkeypatch.setenv("APP_ENV", "development")
    with pytest.raises(SystemExit, match="loopback"):
        assert_safe_database_url(local_dev_mode=False, allow_compose_catalog_host=False)


def test_assert_safe_database_url_allows_local_dev_catalog_with_explicit_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://gdc:gdc@127.0.0.1:55432/gdc_dev_browser")
    monkeypatch.setenv("APP_ENV", "development")
    assert_safe_database_url(local_dev_mode=True)


def test_assert_safe_database_url_rejects_local_dev_catalog_without_explicit_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://gdc:gdc@127.0.0.1:55432/gdc_dev_browser")
    monkeypatch.setenv("APP_ENV", "development")
    with pytest.raises(SystemExit, match="database must be one of"):
        assert_safe_database_url(local_dev_mode=False)


def test_seed_visible_e2e_fixtures_idempotent(db_session, monkeypatch: pytest.MonkeyPatch) -> None:
    """Uses the pytest catalog; does not touch operator platform DB."""

    monkeypatch.setenv("DATABASE_URL", os.environ["TEST_DATABASE_URL"])
    monkeypatch.setenv("WIREMOCK_BASE_URL", "http://127.0.0.1:28080")
    monkeypatch.setenv("GDC_VISIBLE_E2E_WEBHOOK_BASE_URL", "http://127.0.0.1:18091")
    monkeypatch.setenv("GDC_VISIBLE_E2E_SYSLOG_HOST", "127.0.0.1")
    monkeypatch.setenv("GDC_VISIBLE_E2E_SYSLOG_PLAIN_PORT", "15514")
    monkeypatch.setenv("GDC_VISIBLE_E2E_SYSLOG_TLS_PORT", "16514")
    monkeypatch.setenv("SOURCE_E2E_MINIO_ENDPOINT", "http://127.0.0.1:59000")
    monkeypatch.setenv("SOURCE_E2E_MINIO_BUCKET", "gdc-source-e2e")
    monkeypatch.setenv("SOURCE_E2E_PG_FIXTURE_HOST", "127.0.0.1")
    monkeypatch.setenv("SOURCE_E2E_PG_FIXTURE_PORT", "55433")
    monkeypatch.setenv("SOURCE_E2E_SFTP_HOST", "127.0.0.1")
    monkeypatch.setenv("SOURCE_E2E_SFTP_PORT", "22222")

    first = seed_visible_e2e_fixtures(db_session, local_dev_mode=False)
    second = seed_visible_e2e_fixtures(db_session, local_dev_mode=False)

    assert first["ok"] is True
    assert second["ok"] is True
    assert first["webhook_receiver_key"] == VISIBLE_E2E_WEBHOOK_RECEIVER_KEY
    assert len(first["streams"]) == len(second["streams"]) == 5
    assert len(first["connectors"]) == len(second["connectors"]) == 5
