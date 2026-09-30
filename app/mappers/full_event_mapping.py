"""Full-event mapping modes (JSONata / regex config) for preview and runtime."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from app.parsers.jsonpath_parser import extract_one
from app.runtime.copy_utils import copy_json_value
from app.runtime.errors import MappingError

FIELD_MAPPINGS_META_KEYS = frozenset(
    {
        "transform_rules",
        "advanced_fields",
        "mapping_mode",
        "jsonata_expression",
        "regex_rules",
        "preserve_source_fields",
        "unmapped_fields_policy",
    }
)

_FULL_EVENT_JSONATA = "full_event_jsonata"
_FULL_EVENT_REGEX = "full_event_regex"


@dataclass(frozen=True, slots=True)
class FieldTransformRuleResult:
    output_field: str
    mode: str
    rule_id: str | None
    success: bool
    value: Any = None
    recovered_via_default: bool = False
    warning_message: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    executed: bool = True
    blocked: bool = False


def _field_rule_default(rule: dict[str, Any]) -> tuple[bool, Any]:
    if "default_value" in rule:
        return True, copy_json_value(rule.get("default_value"))
    if "fallback_value" in rule:
        return True, copy_json_value(rule.get("fallback_value"))
    return False, None


def _field_rule_result_error(
    *,
    output_field: str,
    mode: str,
    rule_id: str | None,
    code: str,
    message: str,
) -> FieldTransformRuleResult:
    return FieldTransformRuleResult(
        output_field=output_field,
        mode=mode,
        rule_id=rule_id,
        success=False,
        error_code=code,
        error_message=message,
    )


def evaluate_field_transform_rule(
    event: dict[str, Any],
    rule: dict[str, Any],
) -> FieldTransformRuleResult:
    """Evaluate one persisted per-field JSONata/Regex rule against the current event context."""

    mode = str(rule.get("mode") or rule.get("type") or "").strip().lower()
    output_field = str(rule.get("output_field") or rule.get("field") or rule.get("target_field") or "").strip()
    rule_id = str(rule.get("rule_id") or rule.get("id") or "").strip() or None
    default_present, default_value = _field_rule_default(rule)

    if not output_field:
        return _field_rule_result_error(
            output_field="",
            mode=mode,
            rule_id=rule_id,
            code="TRANSFORM_OUTPUT_FIELD_REQUIRED",
            message="Advanced transform output field is required.",
        )

    if mode == "jsonata":
        expression = str(rule.get("expression") or "").strip()
        if not expression:
            return _field_rule_result_error(
                output_field=output_field,
                mode=mode,
                rule_id=rule_id,
                code="JSONATA_EXPRESSION_REQUIRED",
                message=f"{output_field}: JSONata expression is required.",
            )
        try:
            import jsonata  # type: ignore[import-untyped]
        except ImportError:
            return _field_rule_result_error(
                output_field=output_field,
                mode=mode,
                rule_id=rule_id,
                code="TRANSFORM_ENGINE_UNAVAILABLE",
                message="JSONata engine is not installed in the runtime environment.",
            )
        try:
            value = jsonata.Jsonata(expression).evaluate(event)
        except Exception as exc:  # noqa: BLE001 - expression errors are returned as bounded field evidence
            return _field_rule_result_error(
                output_field=output_field,
                mode=mode,
                rule_id=rule_id,
                code="JSONATA_EVALUATION_FAILED",
                message=f"{output_field}: JSONata evaluation failed: {exc}",
            )
        if value is None and default_present:
            return FieldTransformRuleResult(
                output_field=output_field,
                mode=mode,
                rule_id=rule_id,
                success=True,
                value=default_value,
                recovered_via_default=True,
                warning_message=f"{output_field}: JSONata produced null/missing output; used default.",
            )
        return FieldTransformRuleResult(
            output_field=output_field,
            mode=mode,
            rule_id=rule_id,
            success=True,
            value=copy_json_value(value),
        )

    if mode == "regex_extract":
        source_path = str(rule.get("source_path") or rule.get("path") or "").strip()
        pattern = str(rule.get("pattern") or "").strip()
        if not source_path or not pattern:
            return _field_rule_result_error(
                output_field=output_field,
                mode=mode,
                rule_id=rule_id,
                code="REGEX_RULE_INVALID",
                message=f"{output_field}: source_path and pattern are required.",
            )
        group_raw = rule.get("group", rule.get("capture_group", 1))
        try:
            group_idx = int(group_raw)
        except (TypeError, ValueError):
            group_idx = -1
        if group_idx < 1:
            return _field_rule_result_error(
                output_field=output_field,
                mode=mode,
                rule_id=rule_id,
                code="REGEX_GROUP_INVALID",
                message=f"{output_field}: capture group must be a positive integer.",
            )

        raw_value = extract_one(event, source_path, default=None)
        source_text = _coerce_regex_source(raw_value)
        if source_text is None:
            if default_present:
                return FieldTransformRuleResult(
                    output_field=output_field,
                    mode=mode,
                    rule_id=rule_id,
                    success=True,
                    value=default_value,
                    recovered_via_default=True,
                    warning_message=f"{output_field}: regex source missing; used default.",
                )
            return _field_rule_result_error(
                output_field=output_field,
                mode=mode,
                rule_id=rule_id,
                code="REGEX_SOURCE_MISSING",
                message=f"{output_field}: source at {source_path} is missing.",
            )

        try:
            compiled = re.compile(pattern)
        except re.error as exc:
            return _field_rule_result_error(
                output_field=output_field,
                mode=mode,
                rule_id=rule_id,
                code="REGEX_PATTERN_INVALID",
                message=f"{output_field}: invalid regex pattern ({exc}).",
            )

        match = compiled.search(source_text)
        if match is not None and group_idx <= len(match.groups()):
            captured = match.group(group_idx)
            if captured is not None:
                return FieldTransformRuleResult(
                    output_field=output_field,
                    mode=mode,
                    rule_id=rule_id,
                    success=True,
                    value=captured,
                )

        if default_present:
            return FieldTransformRuleResult(
                output_field=output_field,
                mode=mode,
                rule_id=rule_id,
                success=True,
                value=default_value,
                recovered_via_default=True,
                warning_message=f"{output_field}: regex did not match; used default.",
            )
        return _field_rule_result_error(
            output_field=output_field,
            mode=mode,
            rule_id=rule_id,
            code="REGEX_NO_MATCH",
            message=f"{output_field}: regex pattern did not match.",
        )

    return _field_rule_result_error(
        output_field=output_field,
        mode=mode,
        rule_id=rule_id,
        code="TRANSFORM_MODE_UNSUPPORTED",
        message=f"{output_field}: unsupported advanced transform mode {mode!r}.",
    )


def extract_field_transform_rules(
    config: dict[str, Any] | None,
    key: str,
) -> list[dict[str, Any]]:
    if not isinstance(config, dict):
        return []
    raw = config.get(key)
    if not isinstance(raw, list):
        return []
    return [dict(item) for item in raw if isinstance(item, dict)]


def apply_field_transform_rules(
    event: dict[str, Any],
    rules: list[dict[str, Any]],
    *,
    initial_output: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], list[FieldTransformRuleResult]]:
    """Apply ordered per-field transforms while exposing the same runtime results to preview/debug."""

    output = copy_json_value(initial_output) if isinstance(initial_output, dict) else {}
    context = copy_json_value(event)
    if isinstance(output, dict):
        context.update(copy_json_value(output))

    results: list[FieldTransformRuleResult] = []
    for rule in rules:
        result = evaluate_field_transform_rule(context, rule)
        results.append(result)
        if not result.success or not result.output_field:
            continue
        output[result.output_field] = copy_json_value(result.value)
        context[result.output_field] = copy_json_value(result.value)
    return output, results


def get_mapping_mode(field_mappings: dict[str, Any] | None) -> str | None:
    if not isinstance(field_mappings, dict):
        return None
    raw = field_mappings.get("mapping_mode")
    if raw is None:
        return None
    mode = str(raw).strip().lower()
    return mode or None


def is_full_event_mapping(field_mappings: dict[str, Any] | None) -> bool:
    mode = get_mapping_mode(field_mappings)
    return mode in {_FULL_EVENT_JSONATA, _FULL_EVENT_REGEX}


def extract_basic_jsonpath_mappings(field_mappings: dict[str, Any] | None) -> dict[str, str]:
    """Plain JSONPath output→path entries; skips meta keys and non-string values."""

    if not isinstance(field_mappings, dict):
        return {}
    out: dict[str, str] = {}
    for key, value in field_mappings.items():
        if key in FIELD_MAPPINGS_META_KEYS or str(key).startswith("_"):
            continue
        if isinstance(value, str):
            path = value.strip()
            if path:
                out[str(key)] = path
    return out


def _coerce_regex_source(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, (list, dict)):
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    return str(value)


def _parse_regex_rules(field_mappings: dict[str, Any]) -> list[dict[str, Any]]:
    raw = field_mappings.get("regex_rules")
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, dict)]


def apply_full_event_regex_mapping(
    event: dict[str, Any],
    field_mappings: dict[str, Any],
) -> tuple[dict[str, Any], list[str], list[str]]:
    preserve = field_mappings.get("preserve_source_fields") is True
    base: dict[str, Any] = copy_json_value(event) if preserve else {}
    errors: list[str] = []
    warnings: list[str] = []
    rules = _parse_regex_rules(field_mappings)
    if not rules:
        errors.append('Full-event regex mapping requires a non-empty "regex_rules" array.')
        return base, errors, warnings

    for index, rule in enumerate(rules):
        output_field = str(rule.get("output_field") or rule.get("field") or "").strip()
        source_path = str(rule.get("source_path") or rule.get("path") or "").strip()
        pattern = str(rule.get("pattern") or "").strip()
        if not output_field or not source_path or not pattern:
            errors.append(f"regex_rules[{index}]: output_field, source_path, and pattern are required")
            continue

        group_raw = rule.get("capture_group", rule.get("group", 1))
        try:
            group_idx = int(group_raw)
        except (TypeError, ValueError):
            errors.append(f"regex_rules[{index}]: group must be an integer")
            continue
        if group_idx < 0:
            errors.append(f"regex_rules[{index}]: group must be non-negative")
            continue

        default_value = rule.get("default_value", rule.get("default"))

        raw_value = extract_one(event, source_path, default=None)
        source_text = _coerce_regex_source(raw_value)
        if source_text is None:
            if default_value is not None:
                base[output_field] = copy_json_value(default_value)
                warnings.append(f"{output_field}: source missing; used default")
            else:
                errors.append(f"{output_field}: source at {source_path} is missing")
            continue

        try:
            compiled = re.compile(pattern)
            match = compiled.search(source_text)
            capture_idx = group_idx if group_idx > 0 else 1
            if match is not None and capture_idx <= len(match.groups()):
                captured = match.group(capture_idx)
                if captured is not None:
                    base[output_field] = captured
                    continue
            if default_value is not None:
                base[output_field] = copy_json_value(default_value)
                warnings.append(f"{output_field}: no match; used default")
            else:
                errors.append(f"{output_field}: pattern did not match")
        except re.error as exc:
            errors.append(f"{output_field}: invalid pattern ({exc})")

    return base, errors, warnings


def apply_full_event_jsonata_mapping(
    event: dict[str, Any],
    field_mappings: dict[str, Any],
) -> tuple[dict[str, Any], list[str], list[str]]:
    expression = str(field_mappings.get("jsonata_expression") or "").strip()
    if not expression:
        return {}, ["Full-event JSONata mapping requires a non-empty jsonata_expression."], []

    try:
        import jsonata  # type: ignore[import-untyped]
    except ImportError as exc:
        raise MappingError(
            "JSONata engine is not installed; add jsonata-python to the runtime environment."
        ) from exc

    try:
        evaluator = jsonata.Jsonata(expression)
        result = evaluator.evaluate(event)
    except Exception as exc:  # noqa: BLE001 — surface expression errors to callers
        return {}, [f"JSONata evaluation failed: {exc}"], []

    if not isinstance(result, dict):
        return (
            {},
            ["JSONata must return a JSON object (not a string, number, boolean, array, or null)."],
            [],
        )

    return copy_json_value(result), [], []


def apply_full_event_mapping(
    event: dict[str, Any],
    field_mappings: dict[str, Any],
) -> tuple[dict[str, Any], list[str], list[str]]:
    if not isinstance(event, dict):
        raise MappingError(f"apply_full_event_mapping expects dict event, got {type(event).__name__}")

    mode = get_mapping_mode(field_mappings)
    if mode == _FULL_EVENT_JSONATA:
        return apply_full_event_jsonata_mapping(event, field_mappings)
    if mode == _FULL_EVENT_REGEX:
        return apply_full_event_regex_mapping(event, field_mappings)
    raise MappingError(f"Unsupported full-event mapping mode: {mode!r}")


__all__ = [
    "FIELD_MAPPINGS_META_KEYS",
    "FieldTransformRuleResult",
    "apply_field_transform_rules",
    "apply_full_event_jsonata_mapping",
    "apply_full_event_mapping",
    "apply_full_event_regex_mapping",
    "evaluate_field_transform_rule",
    "extract_basic_jsonpath_mappings",
    "extract_field_transform_rules",
    "get_mapping_mode",
    "is_full_event_mapping",
]
