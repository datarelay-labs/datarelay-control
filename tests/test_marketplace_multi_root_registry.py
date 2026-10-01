"""Tests for M29.2 unified multi-root Connector Registry."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.connectors_registry.loader import load_connector_modules
from app.connectors_registry.service import (
    bootstrap_registry,
    clear_registry_cache,
    get_connector_manifest,
    get_last_load_issues,
    list_connector_summaries,
    reload_registry,
)
from app.database import get_db
from app.main import app

BUILTIN_CONNECTOR_IDS = {
    "crowdstrike",
    "cybereason",
    "microsoft_graph",
    "okta",
    "orca",
    "sentinelone",
    "wiz",
}


def _base_source(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": "acme",
        "name": "Acme API",
        "vendor": "Acme",
        "version": "1.0.0",
        "source_type": "HTTP_API_POLLING",
        "auth": {"type": "bearer"},
        "streams": [{"id": "events", "name": "Events"}],
    }
    payload.update(overrides)
    return payload


def _write_manifest(module_dir: Path, payload: dict[str, Any]) -> Path:
    module_dir.mkdir(parents=True, exist_ok=True)
    path = module_dir / "manifest.yaml"
    path.write_text(yaml.safe_dump(payload, sort_keys=False), encoding="utf-8")
    return path


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    clear_registry_cache()
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)
        clear_registry_cache()


@pytest.fixture
def builtin_root(tmp_path: Path) -> Path:
    return tmp_path / "connectors"


@pytest.fixture
def installed_root(tmp_path: Path) -> Path:
    return tmp_path / "plugins"


def test_builtin_only_registry_compat(builtin_root: Path) -> None:
    _write_manifest(builtin_root / "acme", _base_source())
    result = load_connector_modules(root=builtin_root, include_installed=False)
    assert set(result.modules) == {"acme"}
    assert result.modules["acme"].installed_from == "builtin"
    assert result.modules["acme"].status == "valid"


def test_missing_installed_root_pass(builtin_root: Path, tmp_path: Path) -> None:
    _write_manifest(builtin_root / "acme", _base_source())
    missing = tmp_path / "does-not-exist"
    assert not missing.exists()
    result = load_connector_modules(
        root=builtin_root,
        installed_root=missing,
        include_installed=True,
    )
    assert set(result.modules) == {"acme"}
    assert not any(issue.rule_id.startswith("REG-") for issue in result.issues)


def test_empty_installed_root_pass(builtin_root: Path, installed_root: Path) -> None:
    _write_manifest(builtin_root / "acme", _base_source())
    installed_root.mkdir(parents=True, exist_ok=True)
    result = load_connector_modules(
        root=builtin_root,
        installed_root=installed_root,
        include_installed=True,
    )
    assert set(result.modules) == {"acme"}
    assert result.modules["acme"].installed_from == "builtin"


def test_valid_installed_source_pack_discovered(builtin_root: Path, installed_root: Path) -> None:
    builtin_root.mkdir(parents=True, exist_ok=True)
    _write_manifest(
        installed_root / "partner",
        _base_source(
            id="partner",
            name="Partner Pack",
            pack_version="1.0.0",
            package_id="partner",
            package_kind="source",
        ),
    )
    result = load_connector_modules(
        root=builtin_root,
        installed_root=installed_root,
        include_installed=True,
    )
    assert "partner" in result.modules
    entry = result.modules["partner"]
    assert entry.installed_from == "installed"
    assert entry.manifest is not None
    assert entry.manifest.package_id == "partner"
    assert entry.manifest.pack_version == "1.0.0"
    assert entry.manifest.package_kind == "source"


def test_builtin_and_installed_unified_catalog(builtin_root: Path, installed_root: Path) -> None:
    _write_manifest(builtin_root / "acme", _base_source(id="acme"))
    _write_manifest(installed_root / "partner", _base_source(id="partner", name="Partner"))
    result = load_connector_modules(
        root=builtin_root,
        installed_root=installed_root,
        include_installed=True,
    )
    assert set(result.modules) == {"acme", "partner"}
    assert result.modules["acme"].installed_from == "builtin"
    assert result.modules["partner"].installed_from == "installed"


def test_installed_manifest_v2_normalization(builtin_root: Path, installed_root: Path) -> None:
    builtin_root.mkdir(parents=True, exist_ok=True)
    raw = _base_source(id="partner")
    del raw["version"]
    raw["pack_version"] = "3.2.1"
    _write_manifest(installed_root / "partner", raw)
    result = load_connector_modules(
        root=builtin_root,
        installed_root=installed_root,
        include_installed=True,
    )
    manifest = result.modules["partner"].manifest
    assert manifest is not None
    assert manifest.version == "3.2.1"
    assert manifest.pack_version == "3.2.1"
    assert manifest.package_id == "partner"
    assert manifest.package_kind == "source"


def test_legacy_builtin_normalization_preserved() -> None:
    result = load_connector_modules(include_installed=False)
    for connector_id in sorted(BUILTIN_CONNECTOR_IDS):
        entry = result.modules[connector_id]
        assert entry.manifest is not None
        assert entry.manifest.pack_version == entry.manifest.version
        assert entry.manifest.package_id == connector_id
        assert entry.manifest.package_kind == "source"
        assert entry.installed_from == "builtin"


def test_platform_derived_origin_not_from_manifest(builtin_root: Path, installed_root: Path) -> None:
    _write_manifest(
        builtin_root / "acme",
        _base_source(id="acme", installed_from="upload"),
    )
    _write_manifest(
        installed_root / "partner",
        _base_source(id="partner", installed_from="git"),
    )
    result = load_connector_modules(
        root=builtin_root,
        installed_root=installed_root,
        include_installed=True,
    )
    assert result.modules["acme"].installed_from == "builtin"
    assert result.modules["partner"].installed_from == "installed"
    # Spoofed values may remain as opaque extra on the pydantic model, but
    # registry authority is entry.installed_from only.
    detail = None
    clear_registry_cache()
    bootstrap_registry(root=builtin_root, installed_root=installed_root)
    detail = get_connector_manifest("partner")
    assert detail is not None
    assert detail.resolved.installed_from == "installed"


def test_manifest_installed_from_spoof_not_authority(builtin_root: Path, installed_root: Path) -> None:
    builtin_root.mkdir(parents=True, exist_ok=True)
    _write_manifest(
        installed_root / "spoof",
        _base_source(id="spoof", installed_from="builtin"),
    )
    result = load_connector_modules(
        root=builtin_root,
        installed_root=installed_root,
        include_installed=True,
    )
    assert result.modules["spoof"].installed_from == "installed"


def test_duplicate_package_id_same_version_collision(builtin_root: Path, installed_root: Path) -> None:
    _write_manifest(builtin_root / "acme", _base_source(id="acme", version="1.0.0", package_id="acme"))
    _write_manifest(
        installed_root / "acme-installed",
        _base_source(id="acme", version="1.0.0", package_id="acme", name="Shadow"),
    )
    result = load_connector_modules(
        root=builtin_root,
        installed_root=installed_root,
        include_installed=True,
    )
    assert set(result.modules) == {"acme"}
    assert result.modules["acme"].manifest is not None
    assert result.modules["acme"].manifest.name == "Acme API"
    assert result.modules["acme"].installed_from == "builtin"
    assert any(issue.rule_id == "REG-001" for issue in result.issues)


def test_builtin_shadowing_blocked_different_version(builtin_root: Path, installed_root: Path) -> None:
    _write_manifest(builtin_root / "acme", _base_source(id="acme", version="1.0.0"))
    _write_manifest(
        installed_root / "acme",
        _base_source(id="acme", version="2.0.0", name="Installed Acme"),
    )
    result = load_connector_modules(
        root=builtin_root,
        installed_root=installed_root,
        include_installed=True,
    )
    assert result.modules["acme"].manifest is not None
    assert result.modules["acme"].manifest.version == "1.0.0"
    assert result.modules["acme"].installed_from == "builtin"
    assert any(issue.rule_id == "REG-001" for issue in result.issues)
    assert "Installed Acme" not in {
        (entry.manifest.name if entry.manifest else "") for entry in result.modules.values()
    }


def test_stream_extension_discovery_and_requires(builtin_root: Path, installed_root: Path) -> None:
    _write_manifest(builtin_root / "cybereason", _base_source(id="cybereason", name="Cybereason"))
    _write_manifest(
        installed_root / "cybereason_hunting",
        _base_source(
            id="cybereason_hunting",
            name="Cybereason Hunting",
            package_kind="stream_extension",
            package_id="cybereason_hunting",
            pack_version="1.0.0",
            requires={"package_id": "cybereason", "version": ">=1.0.0 <2.0.0"},
        ),
    )
    result = load_connector_modules(
        root=builtin_root,
        installed_root=installed_root,
        include_installed=True,
    )
    ext = result.modules["cybereason_hunting"]
    assert ext.installed_from == "installed"
    assert ext.manifest is not None
    assert ext.manifest.package_kind == "stream_extension"
    assert ext.manifest.requires is not None
    assert not isinstance(ext.manifest.requires, list)
    assert ext.manifest.requires.package_id == "cybereason"
    assert ext.manifest.requires.version == ">=1.0.0 <2.0.0"
    assert ext.status == "valid"


def test_missing_dependency_flagged(builtin_root: Path, installed_root: Path) -> None:
    builtin_root.mkdir(parents=True, exist_ok=True)
    _write_manifest(
        installed_root / "ext",
        _base_source(
            id="ext",
            package_kind="stream_extension",
            requires={"package_id": "missing_base"},
        ),
    )
    result = load_connector_modules(
        root=builtin_root,
        installed_root=installed_root,
        include_installed=True,
    )
    entry = result.modules["ext"]
    assert entry.status == "invalid"
    assert any(issue.rule_id == "DEP-001" for issue in entry.errors)
    assert any(issue.rule_id == "DEP-001" for issue in result.issues)


def test_reload_picks_up_installed_package(
    builtin_root: Path,
    installed_root: Path,
) -> None:
    _write_manifest(builtin_root / "acme", _base_source(id="acme"))
    installed_root.mkdir(parents=True, exist_ok=True)
    clear_registry_cache()
    first = bootstrap_registry(root=builtin_root, installed_root=installed_root)
    assert set(first.connector_ids) == {"acme"}

    _write_manifest(installed_root / "partner", _base_source(id="partner", name="Partner"))
    second = reload_registry(root=builtin_root, installed_root=installed_root)
    assert set(second.connector_ids) == {"acme", "partner"}
    rows = list_connector_summaries()
    by_id = {row.id: row for row in rows}
    assert by_id["partner"].installed_from == "installed"


def test_path_escape_symlink_blocked(builtin_root: Path, installed_root: Path, tmp_path: Path) -> None:
    builtin_root.mkdir(parents=True, exist_ok=True)
    installed_root.mkdir(parents=True, exist_ok=True)
    outside = tmp_path / "outside_pack"
    _write_manifest(outside, _base_source(id="escaped", name="Escaped"))
    link = installed_root / "escaped"
    link.symlink_to(outside, target_is_directory=True)

    result = load_connector_modules(
        root=builtin_root,
        installed_root=installed_root,
        include_installed=True,
    )
    assert "escaped" not in result.modules
    assert any(issue.rule_id == "REG-004" for issue in result.issues)


def test_existing_seven_builtin_connectors_load() -> None:
    result = load_connector_modules()
    assert BUILTIN_CONNECTOR_IDS.issubset(set(result.modules.keys()))
    for connector_id in sorted(BUILTIN_CONNECTOR_IDS):
        assert result.modules[connector_id].installed_from == "builtin"


def test_registry_list_detail_api_regression(
    client: TestClient,
    builtin_root: Path,
    installed_root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.connectors_registry.service.connectors_root", lambda: builtin_root)
    monkeypatch.setattr("app.connectors_registry.loader.connectors_root", lambda: builtin_root)
    monkeypatch.setattr(
        "app.connectors_registry.service.installed_plugins_root",
        lambda: installed_root,
    )
    monkeypatch.setattr(
        "app.connectors_registry.roots.installed_plugins_root",
        lambda: installed_root,
    )

    _write_manifest(builtin_root / "acme", _base_source(id="acme", pack_version="1.0.0"))
    _write_manifest(installed_root / "partner", _base_source(id="partner", name="Partner"))
    clear_registry_cache()
    bootstrap_registry(root=builtin_root, installed_root=installed_root)

    listed = client.get("/api/v1/connectors-registry/")
    assert listed.status_code == 200
    body = listed.json()
    by_id = {row["id"]: row for row in body["connectors"]}
    assert by_id["acme"]["installed_from"] == "builtin"
    assert by_id["acme"]["pack_version"] == "1.0.0"
    assert by_id["partner"]["installed_from"] == "installed"

    detail = client.get("/api/v1/connectors-registry/partner")
    assert detail.status_code == 200
    resolved = detail.json()["resolved"]
    assert resolved["installed_from"] == "installed"
    assert resolved["requires"] is None

    reloaded = client.post("/api/v1/connectors-registry/reload")
    assert reloaded.status_code == 200
    assert set(reloaded.json()["connector_ids"]) == {"acme", "partner"}


def test_catalog_exposes_requires_metadata(builtin_root: Path, installed_root: Path) -> None:
    _write_manifest(builtin_root / "base", _base_source(id="base"))
    _write_manifest(
        installed_root / "ext",
        _base_source(
            id="ext",
            package_kind="stream_extension",
            requires={"package_id": "base", "version": "1.0.0"},
        ),
    )
    clear_registry_cache()
    bootstrap_registry(root=builtin_root, installed_root=installed_root)
    rows = {row.id: row for row in list_connector_summaries()}
    assert rows["ext"].requires == {"package_id": "base", "version": "1.0.0"}
    detail = get_connector_manifest("ext")
    assert detail is not None
    assert detail.resolved.requires == {"package_id": "base", "version": "1.0.0"}


def test_default_multi_root_missing_plugins_dir_ok() -> None:
    """Production default: missing GDC_PLUGINS_DIR path must not break builtin catalog."""

    clear_registry_cache()
    bootstrap_registry()
    issues = get_last_load_issues()
    assert not any(issue.rule_id == "REG-003" for issue in issues)
    rows = list_connector_summaries()
    module_ids = {row.id for row in rows if row.migration_status != "legacy"}
    assert BUILTIN_CONNECTOR_IDS.issubset(module_ids)
