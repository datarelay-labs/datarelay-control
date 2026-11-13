"""Operators the Calculated / Conditional editors offer must be evaluated and validated (F-152/F-153/F-235)."""

from __future__ import annotations

import pytest

from app.enrichers.enrichment_engine import apply_enrichment
from app.enrichers.expression_evaluator import (
    ExpressionEvaluationError,
    evaluate_calculated_expression,
    expression_syntax_error,
)
from app.enrichers.rule_executor import execute_enrichment
from app.enrichers.rule_validation import validate_calculated_expression, validate_enrichment_json


@pytest.mark.parametrize(
    ("expression", "expected"),
    [
        ("event_severity * 2", 8),
        ("event_severity >= 3 ? 8 : 3", 8),
        ("event_severity > 4 ? 'high' : 'low'", "low"),
        ("event_severity <= 4 && status == 'ok' ? 1 : 0", 1),
        ("event_severity < 3 || status === 'ok' ? 'a' : 'b'", "a"),
        ("event_severity - 1 + 2 * 3", 9),
        ("event_severity / 2", 2),
        ("event_severity % 3", 1),
        ("status == ok ? 1 : 2", 1),
        ("status != 'ok' ? 1 : 2", 2),
        ("upper(status) == 'OK' ? 1 : 0", 1),
        ("{{ event_severity }} >= 3 ? 8 : 3", 8),
        ("eventName.includes('Delete') ? 8 : 5", 8),
    ],
)
def test_calculated_operators_evaluate(expression: str, expected: object) -> None:
    event = {"event_severity": 4, "status": "ok", "eventName": "DeleteUser"}
    assert evaluate_calculated_expression(expression, event) == expected


def test_calculated_numeric_strings_compare_as_numbers() -> None:
    assert evaluate_calculated_expression("severity >= 3 ? 'hi' : 'lo'", {"severity": "10"}) == "hi"


def test_calculated_non_numeric_operand_is_reported_not_silent() -> None:
    with pytest.raises(ExpressionEvaluationError, match="not numeric"):
        evaluate_calculated_expression("missing_field * 2", {})


def test_calculated_rule_produces_sev_fields_in_pipeline() -> None:
    enrichment = {
        "__rules": {
            "sev_double": {"type": "calculated", "expression": "event_severity * 2", "enabled": True},
            "sev_band": {"type": "calculated", "expression": "event_severity >= 3 ? 8 : 3", "enabled": True},
        }
    }
    out = apply_enrichment({"event_severity": 4}, enrichment)
    assert out["sev_double"] == 8
    assert out["sev_band"] == 8


@pytest.mark.parametrize(
    ("when", "severity", "matches"),
    [
        ("event_severity >= 3", 4, True),
        ("event_severity >= 3", 2, False),
        ("event_severity > 5", 6, True),
        ("event_severity <= 2", 2, True),
        ("event_severity < 2", 2, False),
        ("event_severity == 2", 2, True),
        ("event_severity != 2", 3, True),
        ("event_severity >= 3 && event_severity < 6", 5, True),
        ("event_severity >= 3 && event_severity < 6", 6, False),
        ("event_severity >= '3'", "4", True),
    ],
)
def test_conditional_comparisons_match(when: str, severity: object, matches: bool) -> None:
    rule = {
        "type": "conditional",
        "target_field": "level",
        "conditions": [{"when": when, "then": "hit"}],
        "default": "miss",
    }
    result = execute_enrichment({"event_severity": severity}, {"__rules": {"level": rule}}, emit_logs=False)
    assert result.event["level"] == ("hit" if matches else "miss")


def test_conditional_unsupported_condition_warns_with_reason() -> None:
    rule = {
        "type": "conditional",
        "target_field": "level",
        "conditions": [{"when": "event_severity >=", "then": "hit"}],
        "default": "miss",
    }
    result = execute_enrichment({"event_severity": 4}, {"__rules": {"level": rule}}, emit_logs=False)
    assert result.event["level"] == "miss"
    assert any(w.code == "conditional_invalid" and "Unrecognized condition syntax" in w.message for w in result.warnings)


def test_validation_accepts_every_offered_operator() -> None:
    for expression in (
        "event_severity * 2",
        "event_severity >= 3 ? 8 : 3",
        "eventName.includes('Delete') ? 8 : 5",
        "concat('a', {{ x }})",
        "status",
        "now_utc()",
    ):
        assert validate_calculated_expression(expression) == [], expression


@pytest.mark.parametrize("expression", ["event_severity >=", "a $ b", "unknown_fn(1)", "x ? 1"])
def test_validation_rejects_unsupported_calculated_expression(expression: str) -> None:
    issues = validate_calculated_expression(expression)
    assert any(i.severity == "error" and i.code.startswith("calculated_expression_") for i in issues), expression
    assert expression_syntax_error(expression) is not None


def test_validation_rejects_unsupported_conditional_when() -> None:
    result = validate_enrichment_json(
        {
            "__rules": {
                "level": {
                    "type": "conditional",
                    "target_field": "level",
                    "conditions": [{"when": "event_severity >=", "then": "hit"}],
                    "default": "miss",
                    "enabled": True,
                }
            }
        }
    )
    assert not result.ok
    assert any(i.code == "conditional_invalid" and i.severity == "error" for i in result.issues)


def test_validation_accepts_supported_conditional_when() -> None:
    result = validate_enrichment_json(
        {
            "__rules": {
                "level": {
                    "type": "conditional",
                    "target_field": "level",
                    "conditions": [
                        {"when": "event_severity >= 3", "then": "high"},
                        {"when": "exists user", "then": "x"},
                        {"when": "name contains adm", "then": "y"},
                    ],
                    "default": "low",
                    "enabled": True,
                }
            }
        }
    )
    assert result.ok, [i.message for i in result.issues]


def _preview(enrichment: dict[str, object]):
    from app.runtime.preview_service import run_final_event_draft_preview
    from app.runtime.schemas import FinalEventDraftPreviewRequest

    return run_final_event_draft_preview(
        FinalEventDraftPreviewRequest(
            payload={"items": [{"event_severity": 4}]},
            event_array_path="$.items",
            field_mappings={"event_severity": "$.event_severity"},
            enrichment=enrichment,
            max_events=1,
        )
    )


def test_preview_reports_failed_calculated_rule_instead_of_staying_silent() -> None:
    resp = _preview(
        {"__rules": {"sev": {"type": "calculated", "expression": "event_severity >=", "enabled": True}}}
    )
    failures = [r for r in resp.enrichment_transform_results if not r.success]
    assert [f.error_code for f in failures] == ["CALCULATED_EXPRESSION_FAILED"]
    assert failures[0].output_field == "sev"
    assert "sev" not in resp.final_events[0]


def test_preview_supported_calculated_rule_has_no_failures() -> None:
    resp = _preview(
        {"__rules": {"sev": {"type": "calculated", "expression": "event_severity >= 3 ? 8 : 3", "enabled": True}}}
    )
    assert resp.final_events[0]["sev"] == 8
    assert [r for r in resp.enrichment_transform_results if not r.success] == []


def test_preview_surfaces_transform_engine_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    """F-172: Route Processing preview must carry TRANSFORM_ENGINE_UNAVAILABLE for JSONata rules."""

    import builtins

    real_import = builtins.__import__

    def fake_import(name: str, *args: object, **kwargs: object):
        if name == "jsonata":
            raise ImportError("jsonata missing")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    resp = _preview(
        {
            "__rules": {
                "label": {"type": "jsonata", "expression": "$string(event_severity)", "enabled": True},
            }
        }
    )
    codes = {r.error_code for r in resp.enrichment_transform_results if not r.success}
    assert "TRANSFORM_ENGINE_UNAVAILABLE" in codes
