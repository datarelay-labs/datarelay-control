"""Tests for advanced enrichment rule execution."""

from __future__ import annotations

import pytest

from app.enrichers.enrichment_engine import apply_enrichment, apply_enrichments
from app.enrichers.field_paths import get_field_value
from app.enrichers.rule_executor import execute_enrichment
from app.runtime.errors import EnrichmentError
from app.runtime.preview_service import run_enrichment_exec_preview
from app.runtime.schemas import EnrichmentExecPreviewRequest


def test_static_enrichment_unchanged() -> None:
    base = {"vendor": "orig", "severity": "high"}
    enriched = apply_enrichment(
        base,
        {"vendor": "Cybereason", "product": "EDR"},
        override_policy="KEEP_EXISTING",
    )
    assert enriched["vendor"] == "orig"
    assert enriched["product"] == "EDR"


def test_rules_not_leaked_into_payload() -> None:
    enrichment = {
        "vendor": "Acme",
        "__rules": {
            "metadata.severity": {
                "type": "calculated",
                "expression": "concat('sev-', {{severity}})",
                "enabled": True,
            }
        },
    }
    event = {"severity": "high"}
    out = apply_enrichment(event, enrichment)
    assert "__rules" not in out
    assert out["vendor"] == "Acme"
    assert out["metadata"]["severity"] == "sev-high"


def test_calculated_concat_field_refs() -> None:
    enrichment = {
        "__rules": {
            "metadata.full_name": {
                "type": "calculated",
                "expression": "concat({{user.first}}, ' ', {{user.last}})",
                "enabled": True,
            }
        }
    }
    event = {"user": {"first": "Ada", "last": "Lovelace"}}
    out = apply_enrichment(event, enrichment)
    assert out["metadata"]["full_name"] == "Ada Lovelace"


def test_calculated_legacy_ternary() -> None:
    enrichment = {
        "__rules": {
            "metadata.severity": {
                "type": "calculated",
                "expression": "eventName.includes('Delete') ? 8 : eventName.includes('Create') ? 5 : 3",
                "enabled": True,
            }
        }
    }
    out = apply_enrichment({"eventName": "CreateBucket"}, enrichment)
    assert out["metadata"]["severity"] == 5
    out2 = apply_enrichment({"eventName": "DeleteBucket"}, enrichment)
    assert out2["metadata"]["severity"] == 8
    out3 = apply_enrichment({"eventName": "RunInstances"}, enrichment)
    assert out3["metadata"]["severity"] == 3


def test_invalid_calculated_logs_warning_and_skips() -> None:
    enrichment = {
        "__rules": {
            "metadata.bad": {
                "type": "calculated",
                "expression": "totally_invalid_syntax {{{",
                "enabled": True,
            }
        }
    }
    result = execute_enrichment({"id": "1"}, enrichment)
    out = result.event
    assert "metadata" not in out or "bad" not in out.get("metadata", {})
    assert any(w.code == "calculated_expression_failed" for w in result.warnings)


def test_lookup_success() -> None:
    enrichment = {
        "__rules": {
            "metadata.region_name": {
                "type": "lookup",
                "lookup_table": "aws_regions",
                "lookup_key_field": "region",
                "enabled": True,
            }
        }
    }
    out = apply_enrichment({"region": "us-east-1"}, enrichment)
    assert out["metadata"]["region_name"] == "US East (N. Virginia)"


def test_lookup_prefers_key_field_over_lookup_key_field_alias() -> None:
    """Runtime resolves key_field before lookup_key_field when both differ."""
    enrichment = {
        "__rules": {
            "metadata.region_name": {
                "type": "lookup",
                "lookup_table": "aws_regions",
                "key_field": "region",
                "lookup_key_field": "other_region",
                "enabled": True,
            }
        }
    }
    out = apply_enrichment({"region": "us-east-1", "other_region": "eu-west-1"}, enrichment)
    assert out["metadata"]["region_name"] == "US East (N. Virginia)"


def test_conditional_falsy_default_falls_through_to_conditional_default() -> None:
    """Python truthiness: empty default aliases fall through to conditionalDefault."""
    enrichment = {
        "__rules": {
            "metadata.outcome": {
                "type": "conditional",
                "conditions": [{"when": "severity == never", "then": "matched"}],
                "default": [],
                "conditionalDefault": {"reason": "unmatched"},
                "enabled": True,
            }
        }
    }
    out = apply_enrichment({"severity": "high"}, enrichment)
    assert out["metadata"]["outcome"] == {"reason": "unmatched"}


def test_lookup_miss_skips_field() -> None:
    enrichment = {
        "__rules": {
            "metadata.region_name": {
                "type": "lookup",
                "lookup_table": "aws_regions",
                "lookup_key_field": "region",
                "enabled": True,
            }
        }
    }
    result = execute_enrichment({"region": "unknown-region-xyz"}, enrichment)
    assert get_field_value(result.event, "metadata.region_name") is None
    assert any(w.code == "lookup_miss" for w in result.warnings)


def test_conditional_equals() -> None:
    enrichment = {
        "__rules": {
            "metadata.outcome": {
                "type": "conditional",
                "conditions": [
                    {"when": "severity == high", "then": "alert"},
                    {"when": "severity == low", "then": "info"},
                ],
                "default": "unknown",
                "enabled": True,
            }
        }
    }
    out = apply_enrichment({"severity": "high"}, enrichment)
    assert out["metadata"]["outcome"] == "alert"


def test_normalize_iso8601() -> None:
    enrichment = {
        "__rules": {
            "metadata.timestamp": {
                "type": "normalize",
                "source_field": "created_at",
                "format": "iso8601",
                "enabled": True,
            }
        }
    }
    out = apply_enrichment({"created_at": "2026-01-15T10:00:00Z"}, enrichment)
    assert str(out["metadata"]["timestamp"]).startswith("2026-01-15")


def test_override_policy_keep_existing_nested() -> None:
    enrichment = {
        "__rules": {
            "metadata.outcome": {
                "type": "conditional",
                "conditions": [{"when": "severity == high", "then": "alert"}],
                "default": "info",
                "enabled": True,
            }
        }
    }
    event = {"metadata": {"outcome": "keep"}, "severity": "high"}
    out = apply_enrichment(event, enrichment, override_policy="KEEP_EXISTING")
    assert out["metadata"]["outcome"] == "keep"


def test_override_policy_error_on_conflict_raises() -> None:
    enrichment = {"vendor": "New"}
    with pytest.raises(EnrichmentError):
        apply_enrichment({"vendor": "Old"}, enrichment, override_policy="ERROR_ON_CONFLICT")


def test_type_array_rules_format() -> None:
    enrichment = {
        "__rules": {
            "calculated": [
                {
                    "target_field": "metadata.label",
                    "expression": "upper({{code}})",
                }
            ]
        }
    }
    out = apply_enrichment({"code": "abc"}, enrichment)
    assert out["metadata"]["label"] == "ABC"


def test_preview_runtime_consistency() -> None:
    enrichment = {
        "vendor": "Acme",
        "__rules": {
            "metadata.severity": {
                "type": "calculated",
                "expression": "eventName.includes('Delete') ? 8 : 5",
                "enabled": True,
            },
            "metadata.region_name": {
                "type": "lookup",
                "lookup_table": "aws_regions",
                "lookup_key_field": "region",
                "enabled": True,
            },
        },
    }
    mapped = {"eventName": "CreateBucket", "region": "us-west-2"}
    runtime_out = apply_enrichment(mapped, enrichment)
    preview = run_enrichment_exec_preview(
        EnrichmentExecPreviewRequest(mapped_event=mapped, enrichment=enrichment)
    )
    assert preview.final_event == runtime_out


def test_apply_enrichments_batch() -> None:
    enrichment = {"tenant": "default"}
    out = apply_enrichments([{"id": "1"}, {"id": "2"}], enrichment)
    assert out[0]["tenant"] == "default"
    assert out[1]["tenant"] == "default"


def test_execute_enrichment_returns_warnings() -> None:
    result = execute_enrichment(
        {"region": "missing"},
        {
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
    assert result.warnings
    assert result.warnings[0].code == "lookup_miss"
