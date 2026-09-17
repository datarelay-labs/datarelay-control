"""Tests for M17.5.5 Vendor Preset Migration — catalog classification, legacy fallback, validation."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.connectors_registry.loader import load_connector_modules
from app.connectors_registry.migration import (
    LEGACY_TEMPLATE_MAP,
    classify_migration_status,
    resolve_legacy_template_id,
    resolve_vendor_preset,
    validate_migration_completeness,
    vendor_migration_label,
)
from app.connectors_registry.service import bootstrap_registry, clear_registry_cache, list_migration_matrix
from app.main import app


@pytest.fixture(autouse=True)
def _reset_registry() -> None:
    clear_registry_cache()
    bootstrap_registry()


def test_crowdstrike_module_based_classification() -> None:
    result = load_connector_modules()
    entry = result.modules["crowdstrike"]
    mig_issues = validate_migration_completeness(entry)
    assert not mig_issues
    assert classify_migration_status(entry) == "module_based"
    assert vendor_migration_label("crowdstrike", "module_based") == "Migrated"


def test_cybereason_migration_pending_partial() -> None:
    result = load_connector_modules()
    entry = result.modules["cybereason"]
    mig_issues = validate_migration_completeness(entry)
    assert any(issue.rule_id == "MIG-002" for issue in mig_issues)
    assert classify_migration_status(entry) == "migration_pending"
    assert vendor_migration_label("cybereason", "migration_pending") == "Partial"


def test_wiz_orca_sentinelone_pending() -> None:
    result = load_connector_modules()
    for vendor_id in ("wiz", "orca", "sentinelone"):
        entry = result.modules[vendor_id]
        assert classify_migration_status(entry) == "migration_pending"
        assert vendor_migration_label(vendor_id, "migration_pending") == "Pending"


def test_okta_and_microsoft_graph_migrated() -> None:
    result = load_connector_modules()
    for vendor_id in ("okta", "microsoft_graph"):
        entry = result.modules[vendor_id]
        assert entry.status == "valid"
        assert classify_migration_status(entry) == "module_based"


def test_mig_validation_rule_ids() -> None:
    result = load_connector_modules()
    entry = result.modules["wiz"]
    issues = validate_migration_completeness(entry)
    rule_ids = {issue.rule_id for issue in issues}
    assert "MIG-001" in rule_ids or "MIG-002" in rule_ids
    assert any(r.startswith("MIG-") for r in rule_ids)


def test_module_priority_over_legacy_template() -> None:
    resolution = resolve_legacy_template_id("crowdstrike_detections_api")
    assert resolution is not None
    assert resolution.source == "module"
    assert resolution.module_id == "crowdstrike"
    assert resolution.stream_id == "detections"
    assert resolution.mapping is not None
    assert resolution.enrichment is not None


def test_vendor_preset_does_not_silently_fallback_when_module_incomplete() -> None:
    result = load_connector_modules()
    entry = result.modules["cybereason"]
    # Module package is present but hunting stream assets are incomplete — no silent flat-template fallback.
    resolution = resolve_vendor_preset("cybereason", "hunting", entry=entry)
    assert resolution is None

    # Explicit legacy template_id reads remain a compatibility path (READ OLD).
    legacy = resolve_legacy_template_id("stellar_cyber_hunting_api")
    assert legacy is not None
    assert legacy.source == "legacy"
    assert legacy.legacy_template_id == "stellar_cyber_hunting_api"
    assert legacy.mapping is not None


def test_legacy_template_map_covers_known_templates() -> None:
    assert LEGACY_TEMPLATE_MAP["crowdstrike_detections_api"] == ("crowdstrike", "detections")
    assert LEGACY_TEMPLATE_MAP["okta_system_log"] == ("okta", "system_log")
    assert LEGACY_TEMPLATE_MAP["stellar_cyber_malop_api"] == ("cybereason", "malop")


def test_catalog_api_migration_status_and_matrix() -> None:
    client = TestClient(app)
    response = client.get("/api/v1/connectors-registry/")
    assert response.status_code == 200
    body = response.json()
    assert "migration_matrix" in body
    assert body["count"] >= 7

    by_id = {row["id"]: row for row in body["connectors"]}
    assert by_id["crowdstrike"]["migration_status"] == "module_based"
    assert by_id["crowdstrike"]["migration_label"] == "Migrated"
    assert by_id["cybereason"]["migration_status"] == "migration_pending"
    assert by_id["wiz"]["migration_status"] == "migration_pending"

    matrix = {row["vendor_id"]: row for row in body["migration_matrix"]}
    assert matrix["crowdstrike"]["label"] == "Migrated"
    assert matrix["cybereason"]["label"] == "Partial"
    assert matrix["wiz"]["label"] == "Pending"


def test_catalog_includes_legacy_only_entries() -> None:
    client = TestClient(app)
    response = client.get("/api/v1/connectors-registry/")
    body = response.json()
    by_id = {row["id"]: row for row in body["connectors"]}
    assert by_id["generic-http"]["migration_status"] == "legacy"
    assert by_id["generic-http"]["migration_label"] == "Legacy"


def test_list_migration_matrix_helper() -> None:
    matrix = list_migration_matrix()
    vendor_ids = {row["vendor_id"] for row in matrix}
    assert "crowdstrike" in vendor_ids
    assert "wiz" in vendor_ids
