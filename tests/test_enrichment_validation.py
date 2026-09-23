"""Static enrichment validation and hardening (no DB)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.enrichers.enrichment_engine import apply_enrichment
from app.enrichers.payload_safety import sanitize_delivery_event
from app.enrichers.rule_validation import validate_enrichment_json
from app.main import app
from app.runtime.preview_service import run_enrichment_exec_preview, run_enrichment_validate
from app.runtime.schemas import EnrichmentExecPreviewRequest, EnrichmentValidateRequest


def test_validate_missing_target_field() -> None:
    result = validate_enrichment_json(
        {
            "__rules": {
                "calculated": [
                    {"type": "calculated", "expression": "concat('a')", "enabled": True},
                ]
            }
        }
    )
    assert not result.ok
    assert any(i.code == "missing_target_field" for i in result.issues)


def test_validate_invalid_lookup_table() -> None:
    result = validate_enrichment_json(
        {
            "__rules": {
                "metadata.region": {
                    "type": "lookup",
                    "lookup_table": "not_a_real_table",
                    "lookup_key_field": "region",
                    "enabled": True,
                }
            }
        }
    )
    assert not result.ok
    assert any(i.code == "invalid_lookup_table" for i in result.issues)


def test_validate_lookup_prefers_key_field_alias_over_lookup_key_field() -> None:
    """Validation must resolve aliases in the same order as rule_executor."""
    # key_field is valid; conflicting lookup_key_field is intentionally invalid.
    # If validation preferred lookup_key_field, this would fail closed incorrectly.
    result = validate_enrichment_json(
        {
            "__rules": {
                "metadata.region": {
                    "type": "lookup",
                    "lookup_table": "aws_regions",
                    "key_field": "region",
                    "lookup_key_field": "bad..path",
                    "enabled": True,
                }
            }
        }
    )
    assert result.ok
    assert not any(i.code == "invalid_field_path" for i in result.issues)


def test_validate_invalid_normalize_format() -> None:
    result = validate_enrichment_json(
        {
            "__rules": {
                "metadata.ts": {
                    "type": "normalize",
                    "source_field": "created_at",
                    "format": "unix_ms",
                    "enabled": True,
                }
            }
        }
    )
    assert not result.ok
    assert any(i.code == "invalid_normalize_format" for i in result.issues)


def test_validate_duplicate_target_warning() -> None:
    result = validate_enrichment_json(
        {
            "vendor": "A",
            "__rules": {
                "vendor": {"type": "calculated", "expression": "concat('b')", "enabled": True},
            },
        }
    )
    assert any(i.code == "duplicate_target_field" and i.severity == "warning" for i in result.issues)


def test_validate_api_endpoint() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/enrichment-validate",
        json={
            "enrichment": {
                "__rules": {
                    "bad..path": {
                        "type": "static",
                        "enabled": True,
                    }
                }
            }
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert any(i["code"] == "invalid_field_path" for i in body["issues"])


def test_preview_warnings_propagation() -> None:
    preview = run_enrichment_exec_preview(
        EnrichmentExecPreviewRequest(
            mapped_event={"region": "unknown-xyz"},
            enrichment={
                "__rules": {
                    "metadata.region_name": {
                        "type": "lookup",
                        "lookup_table": "aws_regions",
                        "lookup_key_field": "region",
                        "enabled": True,
                    }
                }
            },
        )
    )
    assert preview.warnings
    assert preview.warnings[0].code == "lookup_miss"
    assert preview.warnings[0].rule_type == "lookup"
    assert preview.warnings[0].target_field == "metadata.region_name"
    assert preview.duration_ms >= 0


def test_invalid_rule_does_not_mutate_unrelated_fields() -> None:
    event = {"severity": "high", "metadata": {"keep": 1}}
    out = apply_enrichment(
        event,
        {
            "__rules": {
                "metadata.bad": {
                    "type": "calculated",
                    "expression": "{{{{broken",
                    "enabled": True,
                },
                "metadata.ok": {
                    "type": "calculated",
                    "expression": "concat('ok')",
                    "enabled": True,
                },
            }
        },
    )
    assert out["severity"] == "high"
    assert out["metadata"]["keep"] == 1
    assert out["metadata"]["ok"] == "ok"
    assert "bad" not in out.get("metadata", {})


def test_malformed_target_path_does_not_crash() -> None:
    out = apply_enrichment(
        {"id": "1"},
        {
            "__rules": {
                "bad..path": {
                    "type": "calculated",
                    "expression": "concat('x')",
                    "enabled": True,
                }
            }
        },
    )
    assert out["id"] == "1"
    assert "bad" not in out


def test_sanitize_strips_internal_keys() -> None:
    dirty = {
        "id": "1",
        "__rules": {"x": 1},
        "__preview": True,
        "nested": {"__computed": {"y": 2}, "ok": 3},
    }
    clean = sanitize_delivery_event(dirty)
    assert "__rules" not in clean
    assert "__preview" not in clean
    assert clean["nested"]["ok"] == 3
    assert "__computed" not in clean["nested"]


def test_validate_service_wrapper() -> None:
    res = run_enrichment_validate(
        EnrichmentValidateRequest(
            enrichment={
                "__rules": {
                    "metadata.x": {
                        "type": "calculated",
                        "expression": "",
                        "enabled": True,
                    }
                }
            }
        )
    )
    assert res.ok is False
    assert any(i.code == "calculated_expression_empty" for i in res.issues)
