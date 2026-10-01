"""Tests for M29.1 Marketplace Manifest v2 compatibility (registry parse/validate/normalize)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.connectors_registry.loader import load_connector_modules
from app.connectors_registry.models import ConnectorManifest, PackageRequirement, SourceEvidenceItem
from app.connectors_registry.normalize import normalize_manifest_dict
from app.connectors_registry.service import bootstrap_registry, clear_registry_cache, list_connector_summaries
from app.connectors_registry.validator import validate_manifest_dict
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


def _base_legacy(**overrides: Any) -> dict[str, Any]:
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
def registry_root(tmp_path: Path) -> Path:
    return tmp_path / "connectors"


def test_legacy_version_only_pass() -> None:
    manifest, issues = validate_manifest_dict(_base_legacy(), manifest_path="/tmp/m.yaml")
    assert issues == []
    assert manifest is not None
    assert manifest.version == "1.0.0"
    assert manifest.pack_version == "1.0.0"


def test_pack_version_only_pass() -> None:
    raw = _base_legacy()
    del raw["version"]
    raw["pack_version"] = "2.1.0"
    manifest, issues = validate_manifest_dict(raw, manifest_path="/tmp/m.yaml")
    assert issues == []
    assert manifest is not None
    assert manifest.pack_version == "2.1.0"
    assert manifest.version == "2.1.0"


def test_version_equals_pack_version_pass() -> None:
    raw = _base_legacy(version="1.2.3", pack_version="1.2.3")
    manifest, issues = validate_manifest_dict(raw, manifest_path="/tmp/m.yaml")
    assert issues == []
    assert manifest is not None
    assert manifest.version == "1.2.3"
    assert manifest.pack_version == "1.2.3"


def test_version_pack_version_conflict_fail() -> None:
    raw = _base_legacy(version="1.0.0", pack_version="2.0.0")
    manifest, issues = validate_manifest_dict(raw, manifest_path="/tmp/m.yaml")
    assert manifest is None
    assert any(i.rule_id == "MAN-007" for i in issues)


def test_legacy_id_package_id_normalization() -> None:
    raw = _base_legacy(id="crowdstrike")
    assert "package_id" not in raw
    manifest, issues = validate_manifest_dict(raw, manifest_path="/tmp/m.yaml")
    assert issues == []
    assert manifest is not None
    assert manifest.id == "crowdstrike"
    assert manifest.package_id == "crowdstrike"


def test_legacy_manifest_package_kind_defaults_to_source() -> None:
    raw = _base_legacy()
    assert "package_kind" not in raw
    manifest, issues = validate_manifest_dict(raw, manifest_path="/tmp/m.yaml")
    assert issues == []
    assert manifest is not None
    assert manifest.package_kind == "source"


def test_package_kind_source_pass() -> None:
    raw = _base_legacy(package_kind="source")
    manifest, issues = validate_manifest_dict(raw, manifest_path="/tmp/m.yaml")
    assert issues == []
    assert manifest is not None
    assert manifest.package_kind == "source"


def test_package_kind_stream_extension_pass() -> None:
    raw = _base_legacy(
        package_kind="stream_extension",
        requires={"package_id": "cybereason", "version": ">=1.0.0 <2.0.0"},
    )
    manifest, issues = validate_manifest_dict(raw, manifest_path="/tmp/m.yaml")
    assert issues == []
    assert manifest is not None
    assert manifest.package_kind == "stream_extension"
    assert isinstance(manifest.requires, PackageRequirement)
    assert manifest.requires.package_id == "cybereason"


def test_invalid_package_kind_fail() -> None:
    raw = _base_legacy(package_kind="destination")
    manifest, issues = validate_manifest_dict(raw, manifest_path="/tmp/m.yaml")
    assert manifest is None
    assert any(i.rule_id == "MAN-008" for i in issues)


def test_api_version_optional_parse() -> None:
    raw = _base_legacy(api_version="v1.2")
    manifest, issues = validate_manifest_dict(raw, manifest_path="/tmp/m.yaml")
    assert issues == []
    assert manifest is not None
    assert manifest.api_version == "v1.2"

    legacy, legacy_issues = validate_manifest_dict(_base_legacy(), manifest_path="/tmp/m.yaml")
    assert legacy_issues == []
    assert legacy is not None
    assert legacy.api_version is None


def test_source_evidence_valid_parse() -> None:
    raw = _base_legacy(
        source_evidence=[
            {
                "type": "vendor_doc",
                "ref": "https://example.com/docs",
                "captured_at": "2026-05-22T12:00:00Z",
                "notes": "official",
            }
        ]
    )
    manifest, issues = validate_manifest_dict(raw, manifest_path="/tmp/m.yaml")
    assert issues == []
    assert manifest is not None
    assert manifest.source_evidence is not None
    assert len(manifest.source_evidence) == 1
    assert isinstance(manifest.source_evidence[0], SourceEvidenceItem)
    assert manifest.source_evidence[0].type == "vendor_doc"
    assert manifest.source_evidence[0].ref == "https://example.com/docs"


def test_malformed_source_evidence_reject() -> None:
    raw = _base_legacy(source_evidence={"type": "api_test"})
    manifest, issues = validate_manifest_dict(raw, manifest_path="/tmp/m.yaml")
    assert manifest is None
    assert any(i.rule_id == "MAN-009" for i in issues)

    raw2 = _base_legacy(source_evidence=[{"type": "api_test"}])
    manifest2, issues2 = validate_manifest_dict(raw2, manifest_path="/tmp/m.yaml")
    assert manifest2 is None
    assert any(i.rule_id == "MAN-009" for i in issues2)


def test_requires_valid_parse() -> None:
    raw = _base_legacy(
        package_kind="stream_extension",
        requires=[
            {"package_id": "cybereason", "version": ">=1.0.0"},
            {"package_id": "okta"},
        ],
    )
    manifest, issues = validate_manifest_dict(raw, manifest_path="/tmp/m.yaml")
    assert issues == []
    assert manifest is not None
    assert isinstance(manifest.requires, list)
    assert len(manifest.requires) == 2
    assert manifest.requires[0].package_id == "cybereason"
    assert manifest.requires[1].package_id == "okta"


def test_license_and_provenance_parse() -> None:
    raw = _base_legacy(
        license="Apache-2.0",
        upstream_provenance={
            "upstream_project": "example-connector",
            "upstream_url": "https://example.com/repo",
            "upstream_commit_or_version": "abc123",
            "license_spdx_or_detected_license": "Apache-2.0",
            "import_method": "manual_port",
        },
    )
    manifest, issues = validate_manifest_dict(raw, manifest_path="/tmp/m.yaml")
    assert issues == []
    assert manifest is not None
    assert manifest.license == "Apache-2.0"
    assert manifest.upstream_provenance is not None
    assert manifest.upstream_provenance.upstream_project == "example-connector"

    structured = _base_legacy(
        license={"spdx": "MIT", "source": "LICENSE", "notice_required": False},
    )
    manifest2, issues2 = validate_manifest_dict(structured, manifest_path="/tmp/m.yaml")
    assert issues2 == []
    assert manifest2 is not None
    assert not isinstance(manifest2.license, str)
    assert manifest2.license is not None
    assert manifest2.license.spdx == "MIT"


def test_unknown_optional_metadata_forward_compatibility() -> None:
    raw = _base_legacy(
        schema_version="2",
        future_marketplace_flag=True,
        experimental_tags=["alpha"],
    )
    manifest, issues = validate_manifest_dict(raw, manifest_path="/tmp/m.yaml")
    assert issues == []
    assert manifest is not None
    assert manifest.schema_version == "2"
    dumped = manifest.model_dump()
    assert dumped.get("future_marketplace_flag") is True
    assert dumped.get("experimental_tags") == ["alpha"]


def test_existing_seven_connector_manifests_load() -> None:
    result = load_connector_modules()
    assert BUILTIN_CONNECTOR_IDS.issubset(set(result.modules.keys()))
    for connector_id in sorted(BUILTIN_CONNECTOR_IDS):
        entry = result.modules[connector_id]
        assert entry.manifest is not None
        assert entry.manifest.id == connector_id
        assert entry.manifest.package_id == connector_id
        assert entry.manifest.package_kind == "source"
        assert entry.manifest.pack_version == entry.manifest.version
        assert entry.manifest.version
        # Files on disk are not rewritten; normalization is in-memory only.
        assert entry.manifest.api_version is None
        assert entry.manifest.source_evidence is None
        assert entry.manifest.license is None


def test_registry_list_detail_api_regression(
    client: TestClient,
    registry_root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.connectors_registry.service.connectors_root", lambda: registry_root)
    monkeypatch.setattr("app.connectors_registry.loader.connectors_root", lambda: registry_root)

    _write_manifest(registry_root / "acme", _base_legacy(id="acme", pack_version="1.0.0"))
    clear_registry_cache()
    bootstrap_registry(root=registry_root)

    listed = client.get("/api/v1/connectors-registry/")
    assert listed.status_code == 200
    body = listed.json()
    assert body["count"] == 1
    row = body["connectors"][0]
    assert row["id"] == "acme"
    assert row["version"] == "1.0.0"
    assert row["pack_version"] == "1.0.0"
    assert row["package_id"] == "acme"
    assert row["package_kind"] == "source"

    detail = client.get("/api/v1/connectors-registry/acme")
    assert detail.status_code == 200
    resolved = detail.json()["resolved"]
    assert resolved["version"] == "1.0.0"
    assert resolved["pack_version"] == "1.0.0"
    assert resolved["package_id"] == "acme"
    assert resolved["package_kind"] == "source"
    assert resolved["manifest"]["id"] == "acme"
    assert resolved["manifest"]["pack_version"] == "1.0.0"


def test_connector_catalog_regression() -> None:
    clear_registry_cache()
    bootstrap_registry()
    rows = list_connector_summaries()
    module_ids = {row.id for row in rows if row.migration_status != "legacy"}
    assert BUILTIN_CONNECTOR_IDS.issubset(module_ids)
    for row in rows:
        if row.id in BUILTIN_CONNECTOR_IDS:
            assert row.version not in {"", "—"}
            assert row.pack_version == row.version
            assert row.package_id == row.id
            assert row.package_kind == "source"

    client = TestClient(app)
    response = client.get("/api/v1/connectors-registry/")
    assert response.status_code == 200
    payload = response.json()
    assert payload["count"] >= len(BUILTIN_CONNECTOR_IDS)
    by_id = {c["id"]: c for c in payload["connectors"]}
    for connector_id in BUILTIN_CONNECTOR_IDS:
        assert connector_id in by_id
        assert by_id[connector_id]["version"]
        assert by_id[connector_id]["pack_version"] == by_id[connector_id]["version"]


def test_normalize_does_not_fabricate_optional_metadata() -> None:
    normalized = normalize_manifest_dict(_base_legacy())
    assert "api_version" not in normalized or normalized.get("api_version") is None
    assert "source_evidence" not in normalized
    assert "license" not in normalized
    assert "requires" not in normalized
    assert "upstream_provenance" not in normalized
    assert "schema_version" not in normalized
    assert normalized["pack_version"] == "1.0.0"
    assert normalized["package_id"] == "acme"
    assert normalized["package_kind"] == "source"


def test_builtin_manifest_files_unchanged_on_disk() -> None:
    """Guard: loaders must not rewrite connector YAML during validation."""

    root = Path(__file__).resolve().parents[1] / "connectors"
    before: dict[str, str] = {}
    for connector_id in sorted(BUILTIN_CONNECTOR_IDS):
        path = root / connector_id / "manifest.yaml"
        before[connector_id] = path.read_text(encoding="utf-8")

    result = load_connector_modules()
    assert BUILTIN_CONNECTOR_IDS.issubset(set(result.modules.keys()))

    for connector_id, original in before.items():
        path = root / connector_id / "manifest.yaml"
        assert path.read_text(encoding="utf-8") == original
        assert "pack_version:" not in original
        assert "package_kind:" not in original
        assert "package_id:" not in original


def test_model_roundtrip_preserves_legacy_and_v2_fields() -> None:
    raw = _base_legacy(
        pack_version="1.0.0",
        package_id="acme-pack",
        package_kind="source",
        api_version="2024-01",
    )
    manifest = ConnectorManifest.model_validate(normalize_manifest_dict(raw))
    assert manifest.id == "acme"
    assert manifest.package_id == "acme-pack"
    assert manifest.version == "1.0.0"
    assert manifest.pack_version == "1.0.0"
    assert manifest.api_version == "2024-01"
