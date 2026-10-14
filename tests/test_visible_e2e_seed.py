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


def test_preview_catalog_requires_explicit_exact_name_opt_in(monkeypatch: pytest.MonkeyPatch) -> None:
    name = 'datarelay_rue2e_preview_bdd69c53'
    monkeypatch.setenv('DATABASE_URL', f'postgresql://gdc:gdc@127.0.0.1:55441/{name}')
    monkeypatch.setenv('APP_ENV', 'development')
    with pytest.raises(SystemExit):
        assert_safe_database_url(local_dev_mode=True)
    assert_safe_database_url(local_dev_mode=True, preview_database=name)


@pytest.mark.parametrize('url,env,name,local', [
    ('postgresql://gdc:gdc@127.0.0.1:55441/datarelay_rue2e_preview_bdd69c53', 'production', 'datarelay_rue2e_preview_bdd69c53', True),
    ('postgresql://gdc:gdc@127.0.0.1:55441/datarelay_rue2e_preview_bdd69c53', 'development', 'datarelay_rue2e_preview_bdd69c53', False),
    ('postgresql://gdc:gdc@127.0.0.1:55432/datarelay_rue2e_preview_bdd69c53', 'development', 'datarelay_rue2e_preview_bdd69c53', True),
    ('postgresql://gdc:gdc@127.0.0.1:55441/gdc', 'development', 'gdc', True),
    ('postgresql://gdc:gdc@127.0.0.1:55441/datarelay_rue2e_preview_bdd69c53', 'development', 'datarelay_rue2e_preview_00000000', True),
    ('postgresql://gdc:gdc@10.10.10.50:55441/datarelay_rue2e_preview_bdd69c53', 'development', 'datarelay_rue2e_preview_bdd69c53', True),
    ('postgresql://other:gdc@127.0.0.1:55441/datarelay_rue2e_preview_bdd69c53', 'development', 'datarelay_rue2e_preview_bdd69c53', True),
    ('postgresql://gdc:gdc@127.0.0.1:55441/datarelay_rue2e_preview_bdd69c53', '', 'datarelay_rue2e_preview_bdd69c53', True),
])
def test_preview_catalog_opt_in_never_expands_to_other_targets(monkeypatch, url, env, name, local):
    monkeypatch.setenv('DATABASE_URL', url)
    monkeypatch.setenv('APP_ENV', env)
    with pytest.raises(SystemExit):
        assert_safe_database_url(local_dev_mode=local, preview_database=name)


@pytest.mark.parametrize("suffix", ["/other", "?host=remote.example", "?port=5432", "#other"])
def test_preview_catalog_rejects_uri_target_overrides(monkeypatch, suffix):
    name = "datarelay_rue2e_preview_bdd69c53"
    monkeypatch.setenv("DATABASE_URL", f"postgresql://gdc:gdc@127.0.0.1:55441/{name}{suffix}")
    monkeypatch.setenv("APP_ENV", "development")
    with pytest.raises(SystemExit):
        assert_safe_database_url(local_dev_mode=True, preview_database=name)


@pytest.mark.parametrize("name", ["", "gdc", "datarelay_rue2e_preview_", "datarelay_rue2e_preview_nothex00"])
def test_preview_catalog_rejects_non_isolated_names(monkeypatch, name):
    monkeypatch.setenv("DATABASE_URL", f"postgresql://gdc:gdc@127.0.0.1:55441/{name}")
    monkeypatch.setenv("APP_ENV", "development")
    with pytest.raises(SystemExit):
        assert_safe_database_url(local_dev_mode=True, preview_database=name)


def test_preview_catalog_rejects_compose_alias_even_when_legacy_flag_enabled(monkeypatch):
    name = "datarelay_rue2e_preview_bdd69c53"
    monkeypatch.setenv("DATABASE_URL", f"postgresql://gdc:gdc@postgres:55441/{name}")
    monkeypatch.setenv("APP_ENV", "development")
    with pytest.raises(SystemExit):
        assert_safe_database_url(local_dev_mode=True, allow_compose_catalog_host=True, preview_database=name)
