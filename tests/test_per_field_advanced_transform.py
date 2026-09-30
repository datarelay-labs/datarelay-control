"""Per-field JSONata/Regex transform runtime parity."""

from __future__ import annotations

import pytest

from app.enrichers.rule_executor import execute_enrichment
from app.enrichers.rule_validation import validate_enrichment_json
from app.mappers.mapper import apply_mapping, apply_mappings_with_results
from app.runtime.preview_service import run_final_event_draft_preview, run_transform_preview
from app.runtime.schemas import FinalEventDraftPreviewRequest, TransformPreviewRequest


def _regex_rule(*, default: object | None = None) -> dict[str, object]:
    rule: dict[str, object] = {
        "rule_id": "extract-src",
        "mode": "regex_extract",
        "output_field": "source_ip",
        "source_path": "$.message",
        "pattern": r"src=(\d+\.\d+\.\d+\.\d+)",
        "group": 1,
    }
    if default is not None:
        rule["default_value"] = default
    return rule

def test_mapping_transform_rules_execute_regex() -> None:
    event = {"message": "src=10.20.30.40 action=allow", "vendor": "acme"}
    mapped = apply_mapping(
        event,
        {
            "message": "$.message",
            "transform_rules": [_regex_rule()],
        },
    )
    assert mapped["message"] == event["message"]
    assert mapped["source_ip"] == "10.20.30.40"


def test_mapping_regex_default_is_runtime_backed_in_preview() -> None:
    rule = _regex_rule(default="0.0.0.0")
    res = run_transform_preview(
        TransformPreviewRequest(
            stage="mapping",
            sample_event={"message": "no source ip here"},
            field_mappings={"message": "$.message", "transform_rules": [rule]},
        )
    )
    assert res.save_blocked is False
    assert res.transformed_result["source_ip"] == "0.0.0.0"
    assert res.field_results[0].recovered_via_default is True

    assert res.field_results[0].value == "0.0.0.0"
    assert any(w.code == "TRANSFORM_DEFAULT_USED" for w in res.warnings)


def test_mapping_invalid_regex_is_structured_runtime_error() -> None:
    rule = {**_regex_rule(), "pattern": "("}
    batch = apply_mappings_with_results(
        [{"message": "src=10.0.0.1"}],
        {"message": "$.message", "transform_rules": [rule]},
    )
    assert len(batch) == 1
    assert batch[0].mapped_event["message"] == "src=10.0.0.1"
    assert batch[0].field_errors
    assert batch[0].field_errors[0].error_code == "REGEX_PATTERN_INVALID"

    preview = run_transform_preview(
        TransformPreviewRequest(
            stage="mapping",
            sample_event={"message": "src=10.0.0.1"},
            field_mappings={"message": "$.message", "transform_rules": [rule]},
        )
    )
    assert preview.save_blocked is True
    assert preview.errors[0].code == "REGEX_PATTERN_INVALID"

def test_final_event_preview_executes_mapping_and_enrichment_advanced_rules() -> None:
    result = run_final_event_draft_preview(
        FinalEventDraftPreviewRequest(
            payload={"items": [{"message": "src=198.51.100.7 action=deny"}]},
            event_array_path="$.items",
            field_mappings={
                "message": "$.message",
                "transform_rules": [_regex_rule()],
            },
            enrichment={
                "advanced_fields": [
                    {
                        "mode": "regex_extract",
                        "output_field": "action",
                        "source_path": "$.message",
                        "pattern": r"action=(\w+)",
                        "group": 1,
                    }
                ]
            },
            override_policy="KEEP_EXISTING",
            max_events=5,
        )
    )
    assert result.final_events[0]["source_ip"] == "198.51.100.7"
    assert result.final_events[0]["action"] == "deny"
    assert "advanced_fields" not in result.final_events[0]


def test_enrichment_advanced_fields_execute_without_config_leak() -> None:
    result = execute_enrichment(
        {"message": "src=192.0.2.25 action=allow"},
        {"advanced_fields": [_regex_rule()]},
        override_policy="KEEP_EXISTING",
        emit_logs=False,
    )
    assert result.event["source_ip"] == "192.0.2.25"
    assert "advanced_fields" not in result.event
    assert result.field_errors == []
    assert len(result.transform_results) == 1


def test_enrichment_default_evidence_matches_runtime() -> None:
    rule = _regex_rule(default="unknown")
    preview = run_transform_preview(
        TransformPreviewRequest(
            stage="enrichment",
            sample_event={"message": "no match"},
            enrichment={"advanced_fields": [rule]},
            override_policy="KEEP_EXISTING",
        )
    )
    assert preview.save_blocked is False
    assert preview.transformed_result["source_ip"] == "unknown"

    assert preview.field_results[0].recovered_via_default is True
    assert any(w.code == "transform_default_used" for w in preview.warnings)


def test_enrichment_validation_covers_advanced_fields() -> None:
    valid = validate_enrichment_json({"advanced_fields": [_regex_rule()]})
    assert valid.ok is True

    invalid = validate_enrichment_json(
        {
            "advanced_fields": [
                {
                    "mode": "regex_extract",
                    "output_field": "source_ip",
                    "source_path": "$.message",
                    "pattern": "(",
                    "group": 1,
                }
            ]
        }
    )
    assert invalid.ok is False
    assert any(issue.code == "regex_pattern_invalid" for issue in invalid.issues)


@pytest.fixture
def jsonata_available() -> None:
    pytest.importorskip("jsonata")

def test_mapping_transform_rules_execute_jsonata(jsonata_available: None) -> None:
    mapped = apply_mapping(
        {"username": "alice", "domain": "example.com"},
        {
            "transform_rules": [
                {
                    "mode": "jsonata",
                    "output_field": "principal",
                    "expression": 'username & "@" & domain',
                }
            ]
        },
    )
    assert mapped["principal"] == "alice@example.com"


def test_enrichment_advanced_fields_execute_jsonata(jsonata_available: None) -> None:
    result = execute_enrichment(
        {"vendor": "acme", "product": "edr"},
        {
            "advanced_fields": [
                {
                    "mode": "jsonata",
                    "output_field": "event_source",
                    "expression": 'vendor & "_" & product',
                }
            ]
        },
        emit_logs=False,
    )
    assert result.event["event_source"] == "acme_edr"
