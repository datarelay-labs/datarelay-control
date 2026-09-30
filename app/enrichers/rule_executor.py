"""Advanced enrichment rule execution (static + calculated/lookup/conditional/normalize)."""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from app.enrichers.expression_evaluator import ExpressionEvaluationError, evaluate_calculated_expression
from app.mappers.full_event_mapping import FieldTransformRuleResult, evaluate_field_transform_rule
from app.runtime.copy_utils import copy_event_dict, copy_json_value
from app.enrichers.field_paths import get_field_value, has_field_value, is_valid_field_path, set_field_value
from app.enrichers.lookup_tables import lookup_value
from app.enrichers.payload_safety import sanitize_delivery_event
from app.runtime.errors import EnrichmentError

logger = logging.getLogger(__name__)

_OVERRIDE_KEEP_EXISTING = "KEEP_EXISTING"
_OVERRIDE_FORCE = "OVERRIDE"
_OVERRIDE_ERROR = "ERROR_ON_CONFLICT"

_RESERVED_KEYS = frozenset({"__rules", "__computed", "advanced_fields"})

_RULE_TYPES = frozenset({"static", "calculated", "lookup", "conditional", "normalize", "jsonata", "regex_extract"})


@dataclass
class EnrichmentWarning:
    code: str
    message: str
    rule_type: str | None = None
    target_field: str | None = None

    def to_log_dict(self) -> dict[str, Any]:
        return {
            "stage": "enrichment",
            "code": self.code,
            "message": self.message,
            "rule_type": self.rule_type,
            "target_field": self.target_field,
        }


@dataclass(frozen=True, slots=True)
class EnrichmentFieldError:
    """Field-level enrichment transform failure for runtime delivery_logs."""

    rule_id: str | None
    output_field: str
    error_code: str
    error_message: str
    sample_value: str | None = None

    def to_delivery_log_fields(self) -> dict[str, Any]:
        return {
            "rule_id": self.rule_id,
            "output_field": self.output_field,
            "error_code": self.error_code,
            "error_message": self.error_message,
            "sample_value": self.sample_value,
        }


@dataclass
class EnrichmentBatchResult:
    events: list[dict[str, Any]]
    warnings: list[EnrichmentWarning] = field(default_factory=list)
    field_errors: list[EnrichmentFieldError] = field(default_factory=list)
    duration_ms: int = 0
    warning_count: int = 0


@dataclass
class EnrichmentExecutionResult:
    event: dict[str, Any]
    warnings: list[EnrichmentWarning] = field(default_factory=list)
    field_errors: list[EnrichmentFieldError] = field(default_factory=list)
    transform_results: list[FieldTransformRuleResult] = field(default_factory=list)
    duration_ms: int = 0


@dataclass
class EnrichmentTraceStepResult:
    step_index: int
    rule_type: str
    target_field: str
    executed: bool = True
    blocked: bool = False
    before_present: bool = False
    before_value: Any = None
    after_present: bool = False
    after_value: Any = None
    changed: bool = False
    warnings: list[EnrichmentWarning] = field(default_factory=list)
    error_message: str | None = None


@dataclass
class EnrichmentTraceExecutionResult:
    event: dict[str, Any]
    steps: list[EnrichmentTraceStepResult] = field(default_factory=list)
    duration_ms: int = 0


def _log_warning(warning: EnrichmentWarning) -> None:
    logger.warning("%s", warning.to_log_dict())


def _dedupe_warnings(warnings: list[EnrichmentWarning]) -> list[EnrichmentWarning]:
    seen: set[tuple[str, str | None, str]] = set()
    out: list[EnrichmentWarning] = []
    for w in warnings:
        key = (w.code, w.target_field, w.message)
        if key in seen:
            continue
        seen.add(key)
        out.append(w)
    return out


def _emit_batch_warnings(warnings: list[EnrichmentWarning]) -> None:
    for w in _dedupe_warnings(warnings):
        _log_warning(w)


def _validate_policy(policy: str) -> str:
    allowed = {_OVERRIDE_KEEP_EXISTING, _OVERRIDE_FORCE, _OVERRIDE_ERROR}
    if policy not in allowed:
        raise EnrichmentError(
            f"Unknown override_policy {policy!r}; expected one of {sorted(allowed)}"
        )
    return policy


def _is_json_like(value: Any) -> bool:
    if value is None or isinstance(value, bool | int | float | str):
        return True
    if isinstance(value, dict):
        return all(isinstance(k, str) and _is_json_like(v) for k, v in value.items())
    if isinstance(value, list):
        return all(_is_json_like(item) for item in value)
    return False


def _resolve_static_template(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    normalized = value.strip().replace(" ", "").lower()
    if normalized == "{{now_utc}}":
        return datetime.now(UTC).isoformat().replace("+00:00", "Z")
    return value


def _normalize_rule_dict(
    rule: dict[str, Any],
    *,
    default_target: str | None = None,
) -> dict[str, Any] | None:
    rule_type = str(rule.get("type") or rule.get("mode") or "").strip().lower()
    if rule_type not in _RULE_TYPES:
        return None
    target = str(
        rule.get("target_field")
        or rule.get("fieldName")
        or rule.get("field_name")
        or default_target
        or ""
    ).strip()
    if not target:
        return None
    if rule.get("enabled") is False:
        return None
    out = dict(rule)
    out["type"] = rule_type
    out["target_field"] = target
    return out


def _iter_advanced_rules(enrichment: dict[str, Any]) -> list[dict[str, Any]]:
    rules: list[dict[str, Any]] = []

    raw_rules = enrichment.get("__rules")
    if isinstance(raw_rules, dict):
        for key, value in raw_rules.items():
            key_type = str(key).strip().lower()
            if isinstance(value, dict) and "type" in value:
                normalized = _normalize_rule_dict(value, default_target=str(key))
                if normalized:
                    rules.append(normalized)
            elif isinstance(value, list):
                for item in value:
                    if not isinstance(item, dict):
                        continue
                    merged = dict(item)
                    if key_type in _RULE_TYPES and "type" not in merged:
                        merged["type"] = key_type
                    normalized = _normalize_rule_dict(merged)
                    if normalized:
                        rules.append(normalized)

    raw_computed = enrichment.get("__computed")
    if isinstance(raw_computed, dict):
        for key, value in raw_computed.items():
            if not isinstance(value, dict):
                continue
            expr = value.get("expression")
            if not isinstance(expr, str):
                continue
            rules.append(
                {
                    "type": "calculated",
                    "target_field": str(key),
                    "expression": expr,
                    "enabled": True,
                }
            )

    raw_advanced = enrichment.get("advanced_fields")
    if isinstance(raw_advanced, list):
        for item in raw_advanced:
            if not isinstance(item, dict):
                continue
            merged = dict(item)
            mode = str(merged.get("mode") or "").strip().lower()
            if mode not in {"jsonata", "regex_extract"}:
                continue
            merged["type"] = mode
            merged["target_field"] = str(
                merged.get("target_field")
                or merged.get("output_field")
                or merged.get("field")
                or ""
            ).strip()
            normalized = _normalize_rule_dict(merged)
            if normalized:
                rules.append(normalized)

    return rules


def _split_static_fields(enrichment: dict[str, Any]) -> dict[str, Any]:
    static: dict[str, Any] = {}
    for key, value in enrichment.items():
        if key in _RESERVED_KEYS:
            continue
        if isinstance(value, dict) and "type" in value:
            continue
        static[key] = _resolve_static_template(value)
    return static


def _should_apply(target: str, event: dict[str, Any], policy: str) -> bool:
    if policy == _OVERRIDE_FORCE:
        return True
    if has_field_value(event, target):
        if policy == _OVERRIDE_ERROR:
            raise EnrichmentError(
                f"Enrichment field {target!r} conflicts with existing event field "
                f"(override_policy={policy})"
            )
        return False
    return True


def _apply_static_fields(
    event: dict[str, Any],
    static_fields: dict[str, Any],
    policy: str,
) -> dict[str, Any]:
    base = copy_event_dict(event)
    for key, value in static_fields.items():
        if not isinstance(key, str) or not key.strip():
            continue
        if not _is_json_like(value):
            raise EnrichmentError(
                f"Enrichment value for field {key!r} must be JSON-like; got {type(value).__name__}"
            )
        target = key.strip()
        if not _should_apply(target, base, policy):
            continue
        if not is_valid_field_path(target):
            continue
        if "." in target:
            set_field_value(base, target, value)
        else:
            base[target] = copy_json_value(value)
    return base


def _parse_condition(when: str) -> tuple[str, str, str] | None:
    """Return ``(operator, field, operand)``."""

    text = when.strip()
    if not text:
        return None
    lower = text.lower()
    if lower.startswith("exists "):
        return ("exists", text[7:].strip(), "")
    if " contains " in lower:
        field, _, operand = text.partition(" contains ")
        return ("contains", field.strip(), operand.strip().strip("'\""))
    m = re.match(r"^(.+?)\s*===\s*['\"]([^'\"]*)['\"]\s*$", text)
    if m:
        return ("equals", m.group(1).strip(), m.group(2))
    m = re.match(r"^(.+?)\s*!==\s*['\"]([^'\"]*)['\"]\s*$", text)
    if m:
        return ("not_equals", m.group(1).strip(), m.group(2))
    m = re.match(r"^(.+?)\s*==\s*['\"]?([^'\"]+)['\"]?\s*$", text)
    if m:
        return ("equals", m.group(1).strip(), m.group(2))
    m = re.match(r"^(.+?)\s*!=\s*['\"]?([^'\"]+)['\"]?\s*$", text)
    if m:
        return ("not_equals", m.group(1).strip(), m.group(2))
    m = re.match(
        r"^([A-Za-z_][A-Za-z0-9_.]*)\s*\.includes\s*\(\s*['\"]([^'\"]*)['\"]\s*\)\s*$",
        text,
    )
    if m:
        return ("contains", m.group(1), m.group(2))
    return None


def _evaluate_condition(when: str, event: dict[str, Any]) -> bool:
    parsed = _parse_condition(when)
    if parsed is None:
        return False
    op, field, operand = parsed
    val = get_field_value(event, field)
    if val is None:
        val = event.get(field)
    if op == "exists":
        return val is not None and str(val) != ""
    if op == "equals":
        return str(val) == operand
    if op == "not_equals":
        return str(val) != operand
    if op == "contains":
        return operand in str(val or "")
    return False


def _apply_calculated(
    event: dict[str, Any],
    rule: dict[str, Any],
    policy: str,
    warnings: list[EnrichmentWarning],
) -> None:
    target = str(rule["target_field"])
    expression = str(rule.get("expression") or "")
    if not _should_apply(target, event, policy):
        return
    try:
        value = evaluate_calculated_expression(expression, event)
    except ExpressionEvaluationError as exc:
        warning = EnrichmentWarning(
            code="calculated_expression_failed",
            message=str(exc),
            rule_type="calculated",
            target_field=target,
        )
        warnings.append(warning)
        return
    if not set_field_value(event, target, value):
        warnings.append(
            EnrichmentWarning(
                code="invalid_field_path",
                message=f"Could not write calculated field {target!r}",
                rule_type="calculated",
                target_field=target,
            )
        )
        return


def _apply_lookup(
    event: dict[str, Any],
    rule: dict[str, Any],
    policy: str,
    warnings: list[EnrichmentWarning],
) -> None:
    target = str(rule["target_field"])
    table = str(rule.get("lookup_table") or rule.get("lookupTable") or "")
    key_field = str(
        rule.get("key_field")
        or rule.get("lookup_key_field")
        or rule.get("lookupKeyField")
        or ""
    ).strip()
    if not table or not key_field:
        warning = EnrichmentWarning(
            code="invalid_rule_definition",
            message="Lookup rule requires lookup_table and key_field",
            rule_type="lookup",
            target_field=target,
        )
        warnings.append(warning)
        return
    if not _should_apply(target, event, policy):
        return
    raw_key = get_field_value(event, key_field)
    if raw_key is None:
        raw_key = event.get(key_field)
    if raw_key is None or str(raw_key).strip() == "":
        warning = EnrichmentWarning(
            code="lookup_key_missing",
            message=f"Lookup key field {key_field!r} is missing on event",
            rule_type="lookup",
            target_field=target,
        )
        warnings.append(warning)
        return
    resolved = lookup_value(table, str(raw_key))
    if resolved is None:
        warning = EnrichmentWarning(
            code="lookup_miss",
            message=f"No lookup value for key {raw_key!r} in table {table!r}",
            rule_type="lookup",
            target_field=target,
        )
        warnings.append(warning)
        return
    set_field_value(event, target, resolved)


def _apply_conditional(
    event: dict[str, Any],
    rule: dict[str, Any],
    policy: str,
    warnings: list[EnrichmentWarning],
) -> None:
    target = str(rule["target_field"])
    if not _should_apply(target, event, policy):
        return
    conditions = rule.get("conditions")
    if not isinstance(conditions, list):
        warning = EnrichmentWarning(
            code="conditional_invalid",
            message="Conditional rule requires conditions list",
            rule_type="conditional",
            target_field=target,
        )
        warnings.append(warning)
        return
    value: Any = rule.get("default") or rule.get("conditionalDefault") or ""
    matched = False
    for item in conditions:
        if not isinstance(item, dict):
            continue
        when = str(item.get("when") or "")
        if when and _evaluate_condition(when, event):
            value = item.get("then", "")
            matched = True
            break
        if when.strip() and not _parse_condition(when):
            warnings.append(
                EnrichmentWarning(
                    code="conditional_invalid",
                    message=f"Unrecognized condition syntax: {when!r}",
                    rule_type="conditional",
                    target_field=target,
                )
            )
    if not matched and not str(value).strip():
        warnings.append(
            EnrichmentWarning(
                code="conditional_invalid",
                message="No condition matched and default is empty",
                rule_type="conditional",
                target_field=target,
            )
        )
    set_field_value(event, target, value)


def _normalize_value(raw: Any, fmt: str) -> Any:
    text = str(raw) if raw is not None else ""
    fmt_key = fmt.strip().lower()
    if fmt_key == "lowercase":
        return text.lower()
    if fmt_key == "uppercase":
        return text.upper()
    if fmt_key == "trim":
        return text.strip()
    if fmt_key in {"iso8601", "iso_8601"}:
        try:
            if isinstance(raw, (int, float)):
                return datetime.fromtimestamp(float(raw), tz=UTC).isoformat().replace("+00:00", "Z")
            return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(UTC).isoformat().replace(
                "+00:00", "Z"
            )
        except (TypeError, ValueError) as exc:
            raise ValueError(str(exc)) from exc
    raise ValueError(f"Unsupported normalize format {fmt!r}")


def _apply_normalize(
    event: dict[str, Any],
    rule: dict[str, Any],
    policy: str,
    warnings: list[EnrichmentWarning],
) -> None:
    target = str(rule["target_field"])
    source = str(
        rule.get("source_field")
        or rule.get("normalizeSourceField")
        or rule.get("sourceField")
        or ""
    ).strip()
    fmt = str(rule.get("format") or rule.get("normalizeFormat") or "iso8601")
    if not source:
        warning = EnrichmentWarning(
            code="invalid_rule_definition",
            message="Normalize rule requires source_field",
            rule_type="normalize",
            target_field=target,
        )
        warnings.append(warning)
        return
    if not _should_apply(target, event, policy):
        return
    raw = get_field_value(event, source)
    if raw is None:
        raw = event.get(source)
    try:
        value = _normalize_value(raw, fmt)
    except ValueError as exc:
        warning = EnrichmentWarning(
            code="normalize_failed",
            message=str(exc),
            rule_type="normalize",
            target_field=target,
        )
        warnings.append(warning)
        return
    set_field_value(event, target, value)


def _apply_advanced_rule(
    event: dict[str, Any],
    rule: dict[str, Any],
    policy: str,
    warnings: list[EnrichmentWarning],
    field_errors: list[EnrichmentFieldError] | None = None,
    transform_results: list[FieldTransformRuleResult] | None = None,
) -> None:
    rule_type = str(rule.get("type") or rule.get("mode") or "")
    if rule_type == "calculated":
        _apply_calculated(event, rule, policy, warnings)
    elif rule_type == "lookup":
        _apply_lookup(event, rule, policy, warnings)
    elif rule_type == "conditional":
        _apply_conditional(event, rule, policy, warnings)
    elif rule_type == "normalize":
        _apply_normalize(event, rule, policy, warnings)
    elif rule_type in {"jsonata", "regex_extract"}:
        rule_id = str(rule.get("rule_id") or rule.get("id") or "").strip() or None
        target = str(
            rule.get("target_field")
            or rule.get("output_field")
            or rule.get("field")
            or ""
        ).strip()
        if not target:
            failure = FieldTransformRuleResult(
                output_field="",
                mode=rule_type,
                rule_id=rule_id,
                success=False,
                error_code="TRANSFORM_OUTPUT_FIELD_REQUIRED",
                error_message="Advanced transform output field is required.",
            )
            if transform_results is not None:
                transform_results.append(failure)
            if field_errors is not None:
                field_errors.append(
                    EnrichmentFieldError(
                        rule_id=rule_id,
                        output_field="",
                        error_code=failure.error_code or "TRANSFORM_OUTPUT_FIELD_REQUIRED",
                        error_message=failure.error_message or "Advanced transform output field is required.",
                    )
                )
            return
        if not _should_apply(target, event, policy):
            if transform_results is not None:
                existing_value = (
                    get_field_value(event, target)
                    if has_field_value(event, target)
                    else None
                )
                transform_results.append(
                    FieldTransformRuleResult(
                        output_field=target,
                        mode=rule_type,
                        rule_id=rule_id,
                        success=True,
                        value=copy_json_value(existing_value),
                        warning_message=f"{target}: existing value kept by override policy.",
                        executed=False,
                        blocked=True,
                    )
                )
            return

        result = evaluate_field_transform_rule(event, rule)
        if not result.success:
            if transform_results is not None:
                transform_results.append(result)
            if field_errors is not None:
                field_errors.append(
                    EnrichmentFieldError(
                        rule_id=result.rule_id,
                        output_field=result.output_field,
                        error_code=result.error_code or "ADVANCED_TRANSFORM_FAILED",
                        error_message=result.error_message or "Advanced transform failed",
                    )
                )
            return

        if not set_field_value(event, target, result.value):
            write_failure = FieldTransformRuleResult(
                output_field=target,
                mode=result.mode,
                rule_id=result.rule_id,
                success=False,
                value=copy_json_value(result.value),
                recovered_via_default=result.recovered_via_default,
                warning_message=result.warning_message,
                error_code="INVALID_FIELD_PATH",
                error_message=f"Could not write advanced transform field {target!r}",
                executed=True,
                blocked=False,
            )
            if transform_results is not None:
                transform_results.append(write_failure)
            if field_errors is not None:
                field_errors.append(
                    EnrichmentFieldError(
                        rule_id=result.rule_id,
                        output_field=target,
                        error_code=write_failure.error_code or "INVALID_FIELD_PATH",
                        error_message=write_failure.error_message or f"Could not write advanced transform field {target!r}",
                    )
                )
            return

        if transform_results is not None:
            transform_results.append(result)
        if result.recovered_via_default:
            warnings.append(
                EnrichmentWarning(
                    code="transform_default_used",
                    message=result.warning_message or f"{target}: used default value",
                    rule_type=rule_type,
                    target_field=target,
                )
            )
    else:
        warning = EnrichmentWarning(
            code="invalid_rule_definition",
            message=f"Unsupported rule type {rule_type!r}",
            rule_type=rule_type,
            target_field=str(rule.get("target_field") or ""),
        )
        warnings.append(warning)


def _trace_value(
    event: dict[str, Any],
    target_field: str,
) -> tuple[bool, Any]:
    present = has_field_value(event, target_field)
    value = get_field_value(event, target_field) if present else None
    return present, copy_json_value(value)


def execute_enrichment_trace(
    event: dict[str, Any],
    enrichment: dict[str, Any],
    override_policy: str = _OVERRIDE_KEEP_EXISTING,
    *,
    through_step: int | None = None,
) -> EnrichmentTraceExecutionResult:
    """Trace the existing enrichment engine without changing runtime semantics.

    Runtime order is preserved exactly: top-level static fields first, followed by
    normalized advanced rules. This is a read-only preview/debug helper.
    """

    started = time.monotonic()
    policy = _validate_policy(override_policy)
    if not isinstance(event, dict):
        raise EnrichmentError(f"execute_enrichment expects dict event, got {type(event).__name__}")

    current = copy_event_dict(event)
    steps: list[EnrichmentTraceStepResult] = []
    plan: list[tuple[str, str, Any]] = []

    for target, value in _split_static_fields(enrichment).items():
        plan.append(("static", str(target), value))
    for rule in _iter_advanced_rules(enrichment):
        plan.append((str(rule.get("type") or ""), str(rule.get("target_field") or ""), rule))

    failed = False
    for step_index, (rule_type, target_field, payload) in enumerate(plan):
        if through_step is not None and step_index > through_step:
            break

        if failed:
            steps.append(
                EnrichmentTraceStepResult(
                    step_index=step_index,
                    rule_type=rule_type,
                    target_field=target_field,
                    executed=False,
                    blocked=True,
                )
            )
            continue

        before_present, before_value = _trace_value(current, target_field)
        warnings: list[EnrichmentWarning] = []
        field_errors: list[EnrichmentFieldError] = []
        transform_results: list[FieldTransformRuleResult] = []
        error_message: str | None = None

        try:
            if rule_type == "static":
                current = _apply_static_fields(current, {target_field: payload}, policy)
            else:
                _apply_advanced_rule(
                    current,
                    payload,
                    policy,
                    warnings,
                    field_errors,
                    transform_results,
                )
        except EnrichmentError as exc:
            error_message = str(exc)
            failed = True
        if error_message is None and field_errors:
            error_message = field_errors[0].error_message
            failed = True

        after_present, after_value = _trace_value(current, target_field)
        transform_result = transform_results[-1] if transform_results else None
        inferred_keep_existing_block = (
            transform_result is None
            and policy == _OVERRIDE_KEEP_EXISTING
            and before_present
            and error_message is None
            and not field_errors
            and not warnings
            and before_present == after_present
            and before_value == after_value
        )
        blocked = (
            transform_result.blocked
            if transform_result is not None
            else inferred_keep_existing_block
        )
        executed = (
            transform_result.executed
            if transform_result is not None
            else not blocked
        )
        steps.append(
            EnrichmentTraceStepResult(
                step_index=step_index,
                rule_type=rule_type,
                target_field=target_field,
                executed=executed,
                blocked=blocked,
                before_present=before_present,
                before_value=before_value,
                after_present=after_present,
                after_value=after_value,
                changed=(before_present != after_present or before_value != after_value),
                warnings=warnings,
                error_message=error_message,
            )
        )

    safe_event = sanitize_delivery_event(current)
    return EnrichmentTraceExecutionResult(
        event=safe_event,
        steps=steps,
        duration_ms=max(0, int((time.monotonic() - started) * 1000)),
    )


def execute_enrichment(
    event: dict[str, Any],
    enrichment: dict[str, Any],
    override_policy: str = _OVERRIDE_KEEP_EXISTING,
    *,
    emit_logs: bool = True,
) -> EnrichmentExecutionResult:
    """Apply static fields and advanced rules; never inject ``__rules`` into output."""

    started = time.monotonic()
    policy = _validate_policy(override_policy)
    if not isinstance(event, dict):
        raise EnrichmentError(f"execute_enrichment expects dict event, got {type(event).__name__}")
    if not enrichment:
        safe = sanitize_delivery_event(copy_event_dict(event))
        return EnrichmentExecutionResult(
            event=safe,
            duration_ms=max(0, int((time.monotonic() - started) * 1000)),
        )

    warnings: list[EnrichmentWarning] = []
    field_errors: list[EnrichmentFieldError] = []
    transform_results: list[FieldTransformRuleResult] = []
    static_fields = _split_static_fields(enrichment)
    advanced_rules = _iter_advanced_rules(enrichment)

    try:
        result_event = _apply_static_fields(event, static_fields, policy)
    except EnrichmentError:
        raise

    for rule in advanced_rules:
        try:
            _apply_advanced_rule(
                result_event,
                rule,
                policy,
                warnings,
                field_errors,
                transform_results,
            )
        except EnrichmentError:
            raise

    safe_event = sanitize_delivery_event(result_event)
    duration_ms = max(0, int((time.monotonic() - started) * 1000))
    if emit_logs:
        for w in warnings:
            _log_warning(w)
    return EnrichmentExecutionResult(
        event=safe_event,
        warnings=warnings,
        field_errors=field_errors,
        transform_results=transform_results,
        duration_ms=duration_ms,
    )


def execute_enrichments(
    events: list[dict[str, Any]],
    enrichment: dict[str, Any],
    override_policy: str = _OVERRIDE_KEEP_EXISTING,
) -> list[dict[str, Any]]:
    """Apply :func:`execute_enrichment` to each event (batch warnings logged once)."""

    return execute_enrichments_batch(events, enrichment, override_policy=override_policy).events


def execute_enrichments_batch(
    events: list[dict[str, Any]],
    enrichment: dict[str, Any],
    override_policy: str = _OVERRIDE_KEEP_EXISTING,
) -> EnrichmentBatchResult:
    """Apply enrichment to a batch; aggregate warnings and emit one log summary."""

    started = time.monotonic()
    if not events:
        return EnrichmentBatchResult(events=[], duration_ms=0)

    out_events: list[dict[str, Any]] = []
    all_warnings: list[EnrichmentWarning] = []
    all_field_errors: list[EnrichmentFieldError] = []
    for ev in events:
        result = execute_enrichment(ev, enrichment, override_policy=override_policy, emit_logs=False)
        out_events.append(result.event)
        all_warnings.extend(result.warnings)
        all_field_errors.extend(result.field_errors)

    deduped = _dedupe_warnings(all_warnings)
    _emit_batch_warnings(deduped)
    duration_ms = max(0, int((time.monotonic() - started) * 1000))
    if deduped:
        logger.info(
            "%s",
            {
                "stage": "enrichment",
                "message": "enrichment batch completed with warnings",
                "warning_count": len(deduped),
                "duration_ms": duration_ms,
                "event_count": len(out_events),
            },
        )

    return EnrichmentBatchResult(
        events=out_events,
        warnings=deduped,
        field_errors=all_field_errors,
        duration_ms=duration_ms,
        warning_count=len(deduped),
    )
