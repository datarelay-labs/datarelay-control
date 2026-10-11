"""Migration integrity diagnostics (read-only Alembic graph checks)."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from app.db.migration_integrity import (
    KNOWN_ORPHAN_REVISIONS,
    audit_database_url,
    evaluate_migration_integrity,
    load_script_directory,
    project_root,
)


def test_known_orphan_revision_list_includes_reported_drift() -> None:
    assert "20260513_0021_dl_parts" in KNOWN_ORPHAN_REVISIONS


def test_load_script_directory_heads_match_repo() -> None:
    heads = load_script_directory(project_root()).get_heads()
    assert heads == ["20261009_0067_mfa_lockout"]


def test_legacy_dev_schema_revision_remains_on_active_chain() -> None:
    scripts = load_script_directory(project_root())
    legacy = scripts.get_revision("20260826_0070_registries")
    assert legacy is not None
    assert legacy.down_revision == "20261001_0064"
    bridge = scripts.get_revision("20261006_0065_legacy_bridge")
    assert bridge is not None
    assert bridge.down_revision == "20260826_0070_registries"
    enrollment = scripts.get_revision("20261009_0066_platform_mfa")
    assert enrollment is not None
    assert enrollment.down_revision == bridge.revision
    lockout = scripts.get_revision("20261009_0067_mfa_lockout")
    assert lockout is not None
    assert lockout.down_revision == enrollment.revision


def test_audit_database_url_platform_compose_mismatch() -> None:
    warnings = audit_database_url(
        "postgresql://gdc:gdc@127.0.0.1:55432/otherdb",
        compose_file="docker-compose.platform.yml",
    )
    assert any("gdc" in w for w in warnings)


def test_audit_database_url_rejects_non_postgres_scheme() -> None:
    warnings = audit_database_url("sqlite:///tmp/x.db")
    assert any("PostgreSQL" in w for w in warnings)


def _stamp_alembic_head(test_db_url: str, project_root: Path) -> None:
    """Per-test truncate clears alembic_version; restamp to match existing DDL."""

    from alembic import command
    from alembic.config import Config

    cfg = Config(str(project_root / "alembic.ini"))
    cfg.set_main_option("script_location", str(project_root / "alembic"))
    cfg.set_main_option("sqlalchemy.url", test_db_url)
    command.stamp(cfg, "head")


def test_evaluate_migration_integrity_ok_on_migrated_db(
    reset_db: None,
    db_engine,
    test_db_url: str,
    project_root: Path,
) -> None:
    from app.config import settings

    _stamp_alembic_head(test_db_url, project_root)
    report = evaluate_migration_integrity(
        db_engine,
        database_url=settings.DATABASE_URL,
    )
    assert report.status in ("ok", "warn")
    assert report.ok is True
    assert report.db_revision_is_head is True
    assert report.repo_heads == ("20261009_0067_mfa_lockout",)


def test_evaluate_migration_integrity_orphan_revision_errors(db_engine) -> None:
    from app.config import settings

    with patch(
        "app.db.migration_integrity.read_db_revision",
        return_value="20260513_0021_dl_parts",
    ):
        report = evaluate_migration_integrity(
            db_engine,
            database_url=settings.DATABASE_URL,
        )
    assert report.ok is False
    assert report.status == "error"
    assert report.db_revision_is_known_orphan is True
    assert any("20260513_0021_dl_parts" in e for e in report.errors)


def test_evaluate_migration_integrity_pre_upgrade_fresh_db_ok(db_engine) -> None:
    from app.config import settings

    with (
        patch("app.db.migration_integrity.alembic_version_table_exists", return_value=False),
        patch("app.db.migration_integrity.public_schema_table_names", return_value=frozenset()),
        patch("app.db.migration_integrity.read_db_revision", return_value=None),
    ):
        report = evaluate_migration_integrity(
            db_engine,
            database_url=settings.DATABASE_URL,
            pre_upgrade=True,
        )
    assert report.status == "ok"
    assert report.ok is True
    assert any("Fresh database detected" in i for i in report.infos)
    from app.db.validate_migrations import EXIT_FRESH_BOOTSTRAP, resolve_exit_code

    assert resolve_exit_code(report, strict=False) == EXIT_FRESH_BOOTSTRAP


def test_evaluate_migration_integrity_behind_head_warns_pre_upgrade(db_engine) -> None:
    from app.config import settings

    with patch(
        "app.db.migration_integrity.read_db_revision",
        return_value="20260512_0018_op_ret_meta",
    ):
        report = evaluate_migration_integrity(
            db_engine,
            database_url=settings.DATABASE_URL,
            pre_upgrade=True,
        )
    assert report.status == "warn"
    assert report.ok is True
    assert any("behind" in w.lower() for w in report.warnings)


def test_embedded_password_hint_is_warning_in_non_dev(
    reset_db: None,
    db_engine,
    test_db_url: str,
    project_root: Path,
) -> None:
    from app.config import settings

    _stamp_alembic_head(test_db_url, project_root)
    pwd_url = "postgresql://embed_user:embed_pw@127.0.0.1:55432/gdc_pytest"
    with patch.object(settings, "APP_ENV", "production"):
        report = evaluate_migration_integrity(
            db_engine,
            database_url=pwd_url,
            env_database_url=None,
            compose_file="",
        )
    assert report.status == "warn"
    assert any("embeds a password" in w for w in report.warnings)
    assert report.infos == ()


def test_embedded_password_hint_is_low_severity_info_in_development(
    reset_db: None,
    db_engine,
    test_db_url: str,
    project_root: Path,
) -> None:
    from app.config import settings

    _stamp_alembic_head(test_db_url, project_root)
    pwd_url = "postgresql://embed_user:embed_pw@127.0.0.1:55432/gdc_pytest"
    with patch.object(settings, "APP_ENV", "development"):
        report = evaluate_migration_integrity(
            db_engine,
            database_url=pwd_url,
            env_database_url=None,
            compose_file="",
        )
    assert report.status == "ok"
    assert any("embeds a password" in i for i in report.infos)
    assert not any("embeds a password" in w for w in report.warnings)


def test_startup_snapshot_includes_migration_integrity(
    reset_db: None,
    test_db_url: str,
    project_root: Path,
) -> None:
    from app.startup_readiness import evaluate_startup_readiness

    _stamp_alembic_head(test_db_url, project_root)
    snap = evaluate_startup_readiness()
    assert snap.migration_integrity is not None
    pub = snap.as_public_dict()
    assert "migration_integrity" in pub
    assert pub["migration_integrity"]["status"] in ("ok", "warn")
    assert pub["migration_integrity"]["ok"] is True
    assert "infos" in pub["migration_integrity"]
