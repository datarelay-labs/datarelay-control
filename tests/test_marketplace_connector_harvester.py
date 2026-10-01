"""Tests for M29.6 Connector Harvester / External Import Pipeline."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from app.connectors_registry.harvester import (
    INDEPENDENT_NETWORK_POLICY_ADDED,
    REMOTE_ACQUISITION_IMPLEMENTED,
    SHARED_ACQUISITION_POLICY_REUSED,
    HarvestInputMode,
    HarvestRequest,
    HarvesterService,
    MappingStatus,
    TrustCandidate,
    UnknownHarvesterAdapterError,
    build_default_harvester_registry,
    harvest_and_import,
)
from app.connectors_registry.harvester.normalizer import normalize_harvested_dict
from app.connectors_registry.license_policy import (
    LICENSE_DECISION_ALLOW,
    LICENSE_DECISION_DENY,
    LICENSE_DECISION_REFERENCE_ONLY,
    LICENSE_DECISION_REVIEW,
)
from app.connectors_registry.package_secret_scan import scan_package_secrets

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "harvester"


# ---------------------------------------------------------------------------
# Harvester core
# ---------------------------------------------------------------------------


def test_adapter_registry_lists_expected_ecosystems() -> None:
    registry = build_default_harvester_registry()
    ecosystems = registry.known_ecosystems()
    assert "singer" in ecosystems
    assert "meltano" in ecosystems
    assert "otel" in ecosystems
    assert "fluent_bit" in ecosystems
    assert "telegraf" in ecosystems


def test_unknown_adapter_rejected() -> None:
    service = HarvesterService()
    result = service.harvest_and_import(
        HarvestRequest(
            ecosystem="does_not_exist",
            input_mode=HarvestInputMode.STRUCTURED_METADATA_FIXTURE,
            path=FIXTURES / "singer" / "allow_http_polling.yaml",
        )
    )
    assert result.package_generated is False
    assert result.validation_status == "BLOCKED"
    assert any(i.code == "UNKNOWN_ADAPTER" for i in result.issues)
    with pytest.raises(UnknownHarvesterAdapterError):
        build_default_harvester_registry().get("nope")


def test_deterministic_normalization() -> None:
    raw = {
        "ecosystem": "singer",
        "identity": {
            "integration_name": "tap-x",
            "vendor": "Acme",
            "upstream_path": "taps/tap-x",
            "upstream_version": "1.0.0",
        },
        "license": {"identifier": "MIT"},
        "proposed_source_type": "HTTP_API_POLLING",
        "streams": [
            {"name": "a", "http_method": "GET", "path": "/a"},
        ],
    }
    a = normalize_harvested_dict(raw, default_ecosystem="singer")
    b = normalize_harvested_dict(raw, default_ecosystem="singer")
    assert a.provenance.integration_name == b.provenance.integration_name == "tap-x"
    assert a.mapping_status == MappingStatus.MAPPED
    assert a.proposed_source_type == "HTTP_API_POLLING"
    assert a.streams[0].path == "/a"


def test_unsupported_source_mapping_skips_package(tmp_path: Path) -> None:
    result = harvest_and_import(
        HarvestRequest(
            ecosystem="singer",
            input_mode=HarvestInputMode.STRUCTURED_METADATA_FIXTURE,
            path=FIXTURES / "singer" / "unsupported_mapping.yaml",
            output_dir=tmp_path,
        )
    )
    assert result.license_decision == LICENSE_DECISION_ALLOW
    assert result.mapping_status == MappingStatus.UNSUPPORTED
    assert result.package_generated is False
    assert result.validation_status == "SKIPPED"
    assert any(i.code == "UNSUPPORTED_MAPPING" for i in result.issues)


def test_v1_capability_flags() -> None:
    assert REMOTE_ACQUISITION_IMPLEMENTED is False
    assert SHARED_ACQUISITION_POLICY_REUSED is True
    assert INDEPENDENT_NETWORK_POLICY_ADDED is False


# ---------------------------------------------------------------------------
# License gates
# ---------------------------------------------------------------------------


def test_allow_generates_candidate_package(tmp_path: Path) -> None:
    result = harvest_and_import(
        HarvestRequest(
            ecosystem="singer",
            input_mode=HarvestInputMode.STRUCTURED_METADATA_FIXTURE,
            path=FIXTURES / "singer" / "allow_http_polling.yaml",
            output_dir=tmp_path,
            trust_candidate=TrustCandidate.IMPORTED,
        )
    )
    assert result.license_decision == LICENSE_DECISION_ALLOW
    assert result.package_generated is True
    assert result.validation_status == "PASS"
    assert result.package_path is not None
    assert (result.package_path / "manifest.yaml").is_file()
    assert (result.package_path / "streams" / "events.yaml").is_file()
    assert (result.package_path / "README.md").is_file()
    assert (result.package_path / "harvester_evidence.yaml").is_file()
    assert result.trust_candidate == TrustCandidate.IMPORTED


def test_symlink_fixture_input_rejected(tmp_path: Path) -> None:
    link = tmp_path / "fixture.yaml"
    link.symlink_to(FIXTURES / "singer" / "allow_http_polling.yaml")
    result = harvest_and_import(
        HarvestRequest(
            ecosystem="singer",
            input_mode=HarvestInputMode.STRUCTURED_METADATA_FIXTURE,
            path=link,
            output_dir=tmp_path / "out",
        )
    )
    assert result.package_generated is False
    assert result.validation_status == "BLOCKED"
    assert any(i.code == "HARVEST_FAILED" and "symlink" in i.message.lower() for i in result.issues)


def test_symlink_inside_snapshot_rejected(tmp_path: Path) -> None:
    snapshot = tmp_path / "snapshot"
    snapshot.mkdir()
    (snapshot / "metadata.yaml").symlink_to(
        FIXTURES / "singer" / "allow_http_polling.yaml"
    )
    result = harvest_and_import(
        HarvestRequest(
            ecosystem="singer",
            input_mode=HarvestInputMode.STRUCTURED_METADATA_FIXTURE,
            path=snapshot,
            output_dir=tmp_path / "out",
        )
    )
    assert result.package_generated is False
    assert result.validation_status == "BLOCKED"
    assert any(i.code == "HARVEST_FAILED" and "symlink" in i.message.lower() for i in result.issues)


def test_existing_package_output_is_not_overwritten(tmp_path: Path) -> None:
    output_dir = tmp_path / "out"
    request = HarvestRequest(
        ecosystem="singer",
        input_mode=HarvestInputMode.STRUCTURED_METADATA_FIXTURE,
        path=FIXTURES / "singer" / "allow_http_polling.yaml",
        output_dir=output_dir,
    )
    first = harvest_and_import(request)
    assert first.package_generated is True
    assert first.package_path is not None
    sentinel = first.package_path / "operator-note.txt"
    sentinel.write_text("preserve", encoding="utf-8")

    second = harvest_and_import(request)
    assert second.package_generated is False
    assert second.validation_status == "FAIL"
    assert any(i.code == "PACKAGE_BUILD_FAILED" for i in second.issues)
    assert sentinel.read_text(encoding="utf-8") == "preserve"


def test_partial_package_build_failure_is_cleaned(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    output_dir = tmp_path / "out"
    original_write_text = Path.write_text

    def fail_manifest_write(path: Path, *args: object, **kwargs: object) -> int:
        if path.name == "manifest.yaml" and output_dir in path.parents:
            raise OSError("synthetic manifest write failure")
        return original_write_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "write_text", fail_manifest_write)
    result = harvest_and_import(
        HarvestRequest(
            ecosystem="singer",
            input_mode=HarvestInputMode.STRUCTURED_METADATA_FIXTURE,
            path=FIXTURES / "singer" / "allow_http_polling.yaml",
            output_dir=output_dir,
        )
    )
    assert result.package_generated is False
    assert result.validation_status == "FAIL"
    assert any(i.code == "PACKAGE_BUILD_FAILED" for i in result.issues)
    assert output_dir.is_dir()
    assert list(output_dir.iterdir()) == []


def test_symlink_output_dir_rejected(tmp_path: Path) -> None:
    real_output = tmp_path / "real-output"
    real_output.mkdir()
    output_link = tmp_path / "output-link"
    output_link.symlink_to(real_output, target_is_directory=True)
    result = harvest_and_import(
        HarvestRequest(
            ecosystem="singer",
            input_mode=HarvestInputMode.STRUCTURED_METADATA_FIXTURE,
            path=FIXTURES / "singer" / "allow_http_polling.yaml",
            output_dir=output_link,
        )
    )
    assert result.package_generated is False
    assert result.validation_status == "FAIL"
    assert any(i.code == "PACKAGE_BUILD_FAILED" and "symlink" in i.message.lower() for i in result.issues)


def test_symlink_parent_output_path_rejected(tmp_path: Path) -> None:
    real_parent = tmp_path / "real-parent"
    real_parent.mkdir()
    linked_parent = tmp_path / "linked-parent"
    linked_parent.symlink_to(real_parent, target_is_directory=True)
    result = harvest_and_import(
        HarvestRequest(
            ecosystem="singer",
            input_mode=HarvestInputMode.STRUCTURED_METADATA_FIXTURE,
            path=FIXTURES / "singer" / "allow_http_polling.yaml",
            output_dir=linked_parent / "nested",
        )
    )
    assert result.package_generated is False
    assert result.validation_status == "FAIL"
    assert any(i.code == "PACKAGE_BUILD_FAILED" and "symlink" in i.message.lower() for i in result.issues)
    assert not (real_parent / "nested").exists()


def test_review_marks_review_required_no_package(tmp_path: Path) -> None:
    result = harvest_and_import(
        HarvestRequest(
            ecosystem="singer",
            input_mode=HarvestInputMode.STRUCTURED_METADATA_FIXTURE,
            path=FIXTURES / "licenses" / "review_mpl.yaml",
            output_dir=tmp_path,
        )
    )
    assert result.license_decision == LICENSE_DECISION_REVIEW
    assert result.review_required is True
    assert result.package_generated is False
    assert result.candidate is not None
    assert result.validation_status == "SKIPPED"


def test_reference_only_does_not_package_restricted_content(tmp_path: Path) -> None:
    result = harvest_and_import(
        HarvestRequest(
            ecosystem="singer",
            input_mode=HarvestInputMode.STRUCTURED_METADATA_FIXTURE,
            path=FIXTURES / "licenses" / "reference_only_elv2.yaml",
            output_dir=tmp_path,
        )
    )
    assert result.license_decision == LICENSE_DECISION_REFERENCE_ONLY
    assert result.package_generated is False
    assert result.mapping_status == MappingStatus.REFERENCE_ONLY
    assert result.candidate is not None
    # No package tree should be created for the candidate id.
    assert not any(tmp_path.iterdir()) or not (tmp_path / "tap_elv2_ref").exists()


def test_deny_blocks_generation(tmp_path: Path) -> None:
    result = harvest_and_import(
        HarvestRequest(
            ecosystem="singer",
            input_mode=HarvestInputMode.STRUCTURED_METADATA_FIXTURE,
            path=FIXTURES / "licenses" / "deny_via_config.yaml",
            output_dir=tmp_path,
            denied_licenses=frozenset({"MIT"}),
        )
    )
    assert result.license_decision == LICENSE_DECISION_DENY
    assert result.package_generated is False
    assert result.validation_status == "BLOCKED"
    assert any(i.code == "LICENSE_DENY" for i in result.issues)


# ---------------------------------------------------------------------------
# Provenance
# ---------------------------------------------------------------------------


def test_provenance_preserved_in_generated_package(tmp_path: Path) -> None:
    result = harvest_and_import(
        HarvestRequest(
            ecosystem="singer",
            input_mode=HarvestInputMode.STRUCTURED_METADATA_FIXTURE,
            path=FIXTURES / "singer" / "allow_http_polling.yaml",
            output_dir=tmp_path,
        )
    )
    assert result.package_generated is True
    assert result.package_path is not None
    manifest = yaml.safe_load((result.package_path / "manifest.yaml").read_text(encoding="utf-8"))
    up = manifest["upstream_provenance"]
    assert up["upstream_project"] == "tap-acme-events"
    assert up["upstream_path"] == "taps/tap-acme-events"
    assert "abc123deadbeef" in str(up.get("upstream_commit_or_version"))
    assert up["harvester_license_decision"] == LICENSE_DECISION_ALLOW
    assert up["harvester_ecosystem"] == "singer"
    assert manifest.get("license")
    evidence = yaml.safe_load(
        (result.package_path / "harvester_evidence.yaml").read_text(encoding="utf-8")
    )
    assert evidence["license_decision"] == LICENSE_DECISION_ALLOW
    assert evidence["upstream_project"] == "tap-acme-events"
    assert result.candidate is not None
    assert result.candidate.provenance.upstream_commit == "abc123deadbeef"


# ---------------------------------------------------------------------------
# Source Pack generation
# ---------------------------------------------------------------------------


def test_source_pack_does_not_fabricate_unsupported_fields(tmp_path: Path) -> None:
    result = harvest_and_import(
        HarvestRequest(
            ecosystem="singer",
            input_mode=HarvestInputMode.STRUCTURED_METADATA_FIXTURE,
            path=FIXTURES / "singer" / "allow_http_polling.yaml",
            output_dir=tmp_path,
        )
    )
    assert result.package_path is not None
    stream = yaml.safe_load(
        (result.package_path / "streams" / "events.yaml").read_text(encoding="utf-8")
    )
    config = stream.get("config_json") or {}
    assert "event_array_path" not in config
    assert config.get("endpoint") == "/v1/events"
    assert config.get("method") == "GET"
    assert stream.get("checkpoint_defaults", {}).get("cursor_field_path") == "updated_at"
    # Trust auto-promotion must not appear.
    manifest = yaml.safe_load((result.package_path / "manifest.yaml").read_text(encoding="utf-8"))
    assert "trust_tier" not in manifest
    assert manifest.get("capabilities", {}).get("auto_install") is False
    assert manifest.get("capabilities", {}).get("auto_stream_enable") is False


def test_no_secret_included_in_valid_package(tmp_path: Path) -> None:
    result = harvest_and_import(
        HarvestRequest(
            ecosystem="singer",
            input_mode=HarvestInputMode.STRUCTURED_METADATA_FIXTURE,
            path=FIXTURES / "licenses" / "allow_no_secret_values.yaml",
            output_dir=tmp_path,
        )
    )
    assert result.validation_status == "PASS"
    assert result.package_path is not None
    findings = scan_package_secrets(result.package_path)
    assert findings == []


def test_embedded_secret_attempt_fails_validation(tmp_path: Path) -> None:
    # Build a valid package then inject a secret and re-validate via service helper.
    result = harvest_and_import(
        HarvestRequest(
            ecosystem="singer",
            input_mode=HarvestInputMode.STRUCTURED_METADATA_FIXTURE,
            path=FIXTURES / "singer" / "allow_http_polling.yaml",
            output_dir=tmp_path / "out",
        )
    )
    assert result.package_generated is True
    assert result.package_path is not None
    poison = result.package_path / "samples" / "leaked.yaml"
    # Compose at runtime so GitHub push protection does not treat this fixture as a real Stripe secret.
    fixture_secret = "sk_" + "live_" + "THISISASECRETVALUE1234567890"
    poison.write_text(
        yaml.safe_dump({"api_key": fixture_secret}),
        encoding="utf-8",
    )
    status, details, issues = HarvesterService()._validate_package(result.package_path)
    assert status == "FAIL"
    assert details.get("secret_scan") == "FAIL"
    assert any("SECRET" in i.code for i in issues)


def test_never_verified_or_official(tmp_path: Path) -> None:
    for trust in (TrustCandidate.IMPORTED, TrustCandidate.LOCAL_DRAFT):
        out = tmp_path / trust.name
        result = harvest_and_import(
            HarvestRequest(
                ecosystem="singer",
                input_mode=HarvestInputMode.STRUCTURED_METADATA_FIXTURE,
                path=FIXTURES / "singer" / "allow_http_polling.yaml",
                output_dir=out,
                trust_candidate=trust,
            )
        )
        assert result.trust_candidate == trust
        assert result.trust_candidate.value not in {"Verified", "Official"}


# ---------------------------------------------------------------------------
# Singer
# ---------------------------------------------------------------------------


def test_singer_static_snapshot_harvest(tmp_path: Path) -> None:
    snapshot = FIXTURES / "singer" / "tap_snapshot"
    result = harvest_and_import(
        HarvestRequest(
            ecosystem="singer",
            input_mode=HarvestInputMode.LOCAL_REPOSITORY_SNAPSHOT,
            path=snapshot,
            output_dir=tmp_path,
        )
    )
    assert result.candidate is not None
    assert result.candidate.provenance.upstream_project == "tap-acme-users"
    assert result.license_decision == LICENSE_DECISION_ALLOW
    # Replication key from catalog metadata.
    assert any(
        s.checkpoint and s.checkpoint.cursor_field == "updated_at"
        for s in result.candidate.streams
    )
    assert result.package_generated is True
    assert result.validation_status == "PASS"


def test_singer_no_code_execution_markers(tmp_path: Path) -> None:
    # Ensure harvest does not require/create virtualenvs or run taps.
    result = harvest_and_import(
        HarvestRequest(
            ecosystem="singer",
            input_mode=HarvestInputMode.LOCAL_EXTRACTED_DIRECTORY,
            path=FIXTURES / "singer" / "tap_snapshot",
            output_dir=tmp_path,
        )
    )
    assert result.candidate is not None
    assert any("not executed" in n.lower() or "static" in n.lower() for n in result.candidate.notes)


# ---------------------------------------------------------------------------
# OTel
# ---------------------------------------------------------------------------


def test_otel_supported_mapping(tmp_path: Path) -> None:
    result = harvest_and_import(
        HarvestRequest(
            ecosystem="otel",
            input_mode=HarvestInputMode.STRUCTURED_METADATA_FIXTURE,
            path=FIXTURES / "otel" / "supported_http_receiver.yaml",
            output_dir=tmp_path,
        )
    )
    assert result.license_decision == LICENSE_DECISION_ALLOW
    assert result.mapping_status == MappingStatus.MAPPED
    assert result.candidate is not None
    assert result.candidate.proposed_source_type == "HTTP_API_POLLING"
    assert result.package_generated is True
    assert result.validation_status == "PASS"
    assert any("Go" in n or "not executed" in n.lower() or "not ported" in n.lower()
               for n in result.candidate.notes)


def test_otel_unsupported_receiver_stays_knowledge(tmp_path: Path) -> None:
    result = harvest_and_import(
        HarvestRequest(
            ecosystem="otel",
            input_mode=HarvestInputMode.STRUCTURED_METADATA_FIXTURE,
            path=FIXTURES / "otel" / "unsupported_receiver.yaml",
            output_dir=tmp_path,
        )
    )
    assert result.mapping_status == MappingStatus.UNSUPPORTED
    assert result.package_generated is False
    assert result.candidate is not None
    assert result.candidate.proposed_source_type is None


# ---------------------------------------------------------------------------
# Skeletons / regression flags
# ---------------------------------------------------------------------------


def test_fluent_bit_and_telegraf_fixture_backed(tmp_path: Path) -> None:
    fb = harvest_and_import(
        HarvestRequest(
            ecosystem="fluent_bit",
            input_mode=HarvestInputMode.STRUCTURED_METADATA_FIXTURE,
            path=FIXTURES / "fluent_bit" / "harvester.yaml",
            output_dir=tmp_path / "fb",
        )
    )
    assert fb.package_generated is True

    tg = harvest_and_import(
        HarvestRequest(
            ecosystem="telegraf",
            input_mode=HarvestInputMode.STRUCTURED_METADATA_FIXTURE,
            path=FIXTURES / "telegraf" / "harvester.yaml",
            output_dir=tmp_path / "tg",
        )
    )
    assert tg.package_generated is False
    assert tg.mapping_status == MappingStatus.UNSUPPORTED


def test_import_result_structured_dict(tmp_path: Path) -> None:
    result = harvest_and_import(
        HarvestRequest(
            ecosystem="singer",
            input_mode=HarvestInputMode.STRUCTURED_METADATA_FIXTURE,
            path=FIXTURES / "singer" / "allow_http_polling.yaml",
            output_dir=tmp_path,
        )
    )
    payload = result.to_dict()
    assert payload["package_generated"] is True
    assert payload["validation_status"] == "PASS"
    assert "issues" in payload
    assert payload["trust_candidate"] == "Imported"


def test_malformed_metadata_surfaces_issue(tmp_path: Path) -> None:
    # Malformed still parses as mapping via normalizer — use empty/invalid path.
    result = harvest_and_import(
        HarvestRequest(
            ecosystem="singer",
            input_mode=HarvestInputMode.STRUCTURED_METADATA_FIXTURE,
            path=tmp_path / "missing.yaml",
            output_dir=tmp_path / "out",
        )
    )
    assert result.package_generated is False
    assert any(i.code == "INPUT_MISSING" for i in result.issues)
