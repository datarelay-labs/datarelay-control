"""Tests for M29.4 Marketplace package validator + registry generation invalidation."""

from __future__ import annotations

import io
import tarfile
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
import yaml
from alembic import command
from alembic.config import Config
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.connectors_registry.lifecycle_errors import LifecycleError
from app.connectors_registry.loader import load_connector_modules as real_load_connector_modules
from app.connectors_registry.lifecycle_service import (
    install_package,
    rollback_package,
    uninstall_package,
    upgrade_package,
)
from app.connectors_registry.package_validator import (
    validate_marketplace_package,
    validate_platform_compatibility_metadata,
)
from app.connectors_registry.registry_generation import (
    bump_registry_generation,
    ensure_registry_version_row,
    fetch_registry_generation,
    read_registry_generation,
)
from app.connectors_registry.registry_version_models import ConnectorRegistryVersion
from app.connectors_registry.service import (
    RegistryService,
    clear_registry_cache,
    get_default_registry_service,
    list_connector_summaries,
    reload_registry,
)


def _base_source(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": "acme",
        "name": "Acme API",
        "vendor": "Acme",
        "version": "1.0.0",
        "source_type": "HTTP_API_POLLING",
        "auth": {"type": "bearer"},
        "streams": [{"id": "events", "name": "Events"}],
        "package_id": "acme",
        "package_kind": "source",
        "pack_version": "1.0.0",
    }
    payload.update(overrides)
    return payload


def _make_tar_gz(files: dict[str, str | bytes]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, content in files.items():
            data = content.encode("utf-8") if isinstance(content, str) else content
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def _package_archive(manifest: dict[str, Any], *, root_dir: str = "acme") -> bytes:
    body = yaml.safe_dump(manifest, sort_keys=False)
    return _make_tar_gz({f"{root_dir}/manifest.yaml": body})


@pytest.fixture
def builtin_root(tmp_path: Path) -> Path:
    root = tmp_path / "connectors"
    root.mkdir(parents=True, exist_ok=True)
    return root


@pytest.fixture
def installed_root(tmp_path: Path) -> Path:
    root = tmp_path / "plugins"
    root.mkdir(parents=True, exist_ok=True)
    return root


@pytest.fixture
def session_factory(db_engine: Engine):
    factory = sessionmaker(bind=db_engine, autocommit=False, autoflush=False, expire_on_commit=False)

    def _factory() -> Session:
        return factory()

    return _factory


def test_generation_row_bootstrap(db_session: Session) -> None:
    assert db_session.query(ConnectorRegistryVersion).count() == 0
    row = ensure_registry_version_row(db_session)
    db_session.commit()
    assert row.id == 1
    assert row.generation == 0
    assert read_registry_generation(db_session) == 0


def test_existing_registry_cache_regression(
    db_session: Session, builtin_root: Path, installed_root: Path, session_factory
) -> None:
    clear_registry_cache()
    svc = RegistryService(session_factory=session_factory, generation_check_interval_sec=0.0)
    svc.bootstrap(root=builtin_root, installed_root=installed_root)
    first = svc.reload_count
    ids = {row.id for row in svc.list_connector_summaries()}
    assert "acme" not in ids
    # Unchanged generation must not force another filesystem reload.
    svc.list_connector_summaries()
    assert svc.reload_count == first


def test_bootstrap_retries_when_generation_changes_during_scan(
    builtin_root: Path, installed_root: Path, session_factory
) -> None:
    svc = RegistryService(session_factory=session_factory, generation_check_interval_sec=0.0)
    with (
        patch(
            "app.connectors_registry.service.fetch_registry_generation",
            side_effect=[7, 8, 8],
        ) as generation_read,
        patch(
            "app.connectors_registry.service.load_connector_modules",
            wraps=real_load_connector_modules,
        ) as filesystem_scan,
    ):
        svc.bootstrap(root=builtin_root, installed_root=installed_root)

    assert generation_read.call_count == 3
    assert filesystem_scan.call_count == 2
    assert svc.local_generation == 8
    assert svc.reload_count == 1


def test_bootstrap_does_not_label_scan_when_post_scan_generation_read_fails(
    builtin_root: Path, installed_root: Path, session_factory
) -> None:
    svc = RegistryService(session_factory=session_factory, generation_check_interval_sec=0.0)
    with patch(
        "app.connectors_registry.service.fetch_registry_generation",
        side_effect=[3, RuntimeError("db read failed")],
    ):
        svc.bootstrap(root=builtin_root, installed_root=installed_root)
    assert svc.local_generation is None
    assert svc._last_generation_check_monotonic == 0.0


def test_generation_increment_on_install(
    db_session: Session, builtin_root: Path, installed_root: Path, session_factory
) -> None:
    ensure_registry_version_row(db_session)
    db_session.commit()
    before = read_registry_generation(db_session)
    install_package(
        db_session,
        _package_archive(_base_source()),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    assert read_registry_generation(db_session) == before + 1


def test_generation_increment_on_upgrade(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    install_package(
        db_session,
        _package_archive(_base_source()),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    before = read_registry_generation(db_session)
    upgrade_package(
        db_session,
        "acme",
        _package_archive(_base_source(version="1.1.0", pack_version="1.1.0")),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    assert read_registry_generation(db_session) == before + 1


def test_generation_increment_on_rollback(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    install_package(
        db_session,
        _package_archive(_base_source()),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    upgrade_package(
        db_session,
        "acme",
        _package_archive(_base_source(version="1.1.0", pack_version="1.1.0")),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    before = read_registry_generation(db_session)
    rollback_package(
        db_session,
        "acme",
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    assert read_registry_generation(db_session) == before + 1


def test_generation_increment_on_uninstall(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    install_package(
        db_session,
        _package_archive(_base_source()),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    before = read_registry_generation(db_session)
    uninstall_package(
        db_session,
        "acme",
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    assert read_registry_generation(db_session) == before + 1


def test_failed_install_no_increment(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    ensure_registry_version_row(db_session)
    db_session.commit()
    before = read_registry_generation(db_session)
    with pytest.raises(LifecycleError):
        install_package(
            db_session,
            b"not-a-tar-gz",
            builtin_root=builtin_root,
            installed_root=installed_root,
        )
    assert read_registry_generation(db_session) == before


def test_failed_upgrade_no_increment(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    install_package(
        db_session,
        _package_archive(_base_source()),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    before = read_registry_generation(db_session)
    with pytest.raises(LifecycleError):
        upgrade_package(
            db_session,
            "acme",
            _package_archive(_base_source()),  # same version
            builtin_root=builtin_root,
            installed_root=installed_root,
        )
    assert read_registry_generation(db_session) == before


def test_second_registry_instance_detects_change(
    db_session: Session, builtin_root: Path, installed_root: Path, session_factory
) -> None:
    svc_b = RegistryService(session_factory=session_factory, generation_check_interval_sec=0.0)
    svc_b.bootstrap(root=builtin_root, installed_root=installed_root)
    assert "acme" not in {row.id for row in svc_b.list_connector_summaries()}
    stale_gen = svc_b.local_generation
    stale_reloads = svc_b.reload_count

    install_package(
        db_session,
        _package_archive(_base_source()),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )

    # Simulate a process that still holds a stale generation memory.
    svc_b._local_generation = stale_gen
    svc_b._last_generation_check_monotonic = 0.0
    ids = {row.id for row in svc_b.list_connector_summaries()}
    assert "acme" in ids
    assert svc_b.reload_count > stale_reloads
    assert svc_b.local_generation == read_registry_generation(db_session)


def test_stale_cache_auto_reload(
    db_session: Session, builtin_root: Path, installed_root: Path, session_factory
) -> None:
    svc = RegistryService(session_factory=session_factory, generation_check_interval_sec=0.0)
    svc.bootstrap(root=builtin_root, installed_root=installed_root)
    install_package(
        db_session,
        _package_archive(_base_source()),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    # Force stale local view after another "process" mutated generation.
    svc._local_generation = 0
    svc._last_generation_check_monotonic = 0.0
    detail_ids = {row.id for row in svc.list_connector_summaries()}
    assert "acme" in detail_ids


def test_unchanged_generation_no_reload(
    db_session: Session, builtin_root: Path, installed_root: Path, session_factory
) -> None:
    ensure_registry_version_row(db_session)
    db_session.commit()
    svc = RegistryService(session_factory=session_factory, generation_check_interval_sec=0.0)
    svc.bootstrap(root=builtin_root, installed_root=installed_root)
    before = svc.reload_count
    svc._last_generation_check_monotonic = 0.0
    svc.list_connector_summaries()
    svc._last_generation_check_monotonic = 0.0
    svc.list_connector_summaries()
    assert svc.reload_count == before


def test_db_check_throttle(
    db_session: Session, builtin_root: Path, installed_root: Path, session_factory
) -> None:
    ensure_registry_version_row(db_session)
    db_session.commit()
    svc = RegistryService(session_factory=session_factory, generation_check_interval_sec=2.0)
    svc.bootstrap(root=builtin_root, installed_root=installed_root)
    before = svc.reload_count

    bump_registry_generation(db_session)
    db_session.commit()

    # Within throttle window: no DB-driven reload yet.
    svc.list_connector_summaries()
    assert svc.reload_count == before
    assert "acme" not in {row.id for row in svc.list_connector_summaries()}

    # Expire throttle and observe auto-reload (filesystem still empty here).
    svc._last_generation_check_monotonic = 0.0
    svc.list_connector_summaries()
    assert svc.reload_count > before
    assert svc.local_generation == read_registry_generation(db_session)


def test_explicit_current_process_reload(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    clear_registry_cache()
    reload_registry(root=builtin_root, installed_root=installed_root)
    default = get_default_registry_service()
    before = default.reload_count
    install_package(
        db_session,
        _package_archive(_base_source()),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    # Lifecycle success path must immediately reload the current process.
    assert default.reload_count > before
    assert any(row.id == "acme" for row in list_connector_summaries())


def test_db_failure_with_existing_cache_fallback(
    db_session: Session, builtin_root: Path, installed_root: Path, session_factory
) -> None:
    svc = RegistryService(session_factory=session_factory, generation_check_interval_sec=0.0)
    svc.bootstrap(root=builtin_root, installed_root=installed_root)
    before = svc.reload_count
    with patch(
        "app.connectors_registry.service.fetch_registry_generation",
        side_effect=RuntimeError("db unavailable"),
    ):
        rows = svc.list_connector_summaries()
    assert isinstance(rows, list)
    assert svc.reload_count == before


def test_package_validator_entrypoint(tmp_path: Path) -> None:
    from app.connectors_registry.lifecycle_archive import stage_archive_bytes

    staged = stage_archive_bytes(
        _package_archive(_base_source()),
        staging_parent=tmp_path,
    )
    validated = validate_marketplace_package(staged.staging_root, digest=staged.digest)
    assert validated.package_id == "acme"
    assert validated.pack_version == "1.0.0"
    assert validated.package_kind == "source"


def test_platform_compatibility_metadata_shape() -> None:
    assert validate_platform_compatibility_metadata(
        {"platform_compatibility": "nope"},
        connector_id="acme",
        manifest_path="manifest.yaml",
    )
    assert not validate_platform_compatibility_metadata(
        {"platform_compatibility": {"min_platform_version": "1.0"}},
        connector_id="acme",
        manifest_path="manifest.yaml",
    )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("min_platform_version", []),
        ("min_platform_version", ""),
        ("max_platform_version", {"version": "2.0"}),
        ("max_platform_version", "   "),
    ],
)
def test_top_level_platform_compatibility_fields_validate_shape(
    field: str, value: Any
) -> None:
    issues = validate_platform_compatibility_metadata(
        {field: value},
        connector_id="acme",
        manifest_path="manifest.yaml",
    )
    assert any(field in issue for issue in issues)


def test_top_level_platform_compatibility_fields_accept_nonblank_strings() -> None:
    assert not validate_platform_compatibility_metadata(
        {"min_platform_version": "1.0", "max_platform_version": "2.0"},
        connector_id="acme",
        manifest_path="manifest.yaml",
    )


def test_migration_upgrade_downgrade_registry_gen(
    reset_db_schema: None, test_db_url: str, db_engine: Engine
) -> None:
    root = Path(__file__).resolve().parents[1]
    cfg = Config(str(root / "alembic.ini"))
    cfg.set_main_option("script_location", str(root / "alembic"))
    cfg.set_main_option("sqlalchemy.url", test_db_url)

    command.upgrade(cfg, "head")
    inspector = inspect(db_engine)
    tables = set(inspector.get_table_names())
    assert "connector_registry_version" in tables
    assert "marketplace_trusted_signing_keys" in tables
    with db_engine.connect() as conn:
        gen = conn.execute(text("SELECT generation FROM connector_registry_version WHERE id = 1")).scalar_one()
        rev = conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
    assert gen == 0
    assert rev == "20261001_0066"

    command.downgrade(cfg, "20261001_0065")
    inspector = inspect(db_engine)
    tables = set(inspector.get_table_names())
    assert "connector_registry_version" in tables
    assert "marketplace_trusted_signing_keys" not in tables
    assert "marketplace_package_installs" in tables

    command.upgrade(cfg, "head")
    with db_engine.connect() as conn:
        gen = conn.execute(text("SELECT generation FROM connector_registry_version WHERE id = 1")).scalar_one()
        rev = conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
    assert gen == 0
    assert rev == "20261001_0066"


def test_fetch_registry_generation_uses_session_factory(session_factory, db_session: Session) -> None:
    ensure_registry_version_row(db_session)
    db_session.commit()
    assert fetch_registry_generation(session_factory=session_factory) == 0
    bump_registry_generation(db_session)
    db_session.commit()
    assert fetch_registry_generation(session_factory=session_factory) == 1
