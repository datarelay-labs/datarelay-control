"""Mapping engine — JSONPath field extraction only (no enrichment, no formatting).

Pipeline position: EventExtractor → **Mapping** → Enrichment → Formatter → Destination.
"""

from __future__ import annotations

from typing import Any

from app.runtime.copy_utils import copy_json_value

from app.mappers.full_event_mapping import (
    FieldTransformRuleResult,
    apply_field_transform_rules,
    apply_full_event_mapping,
    extract_basic_jsonpath_mappings,
    extract_field_transform_rules,
    is_full_event_mapping,
)
from app.mappers.mapping_results import MappingApplyResult, MappingEventError, MappingFieldError
from app.mappers.pass_through import merge_unknown_field_pass_through
from app.mappers.unmapped_policy import should_pass_through_unmapped
from app.parsers.event_extractor import extract_events
from app.parsers.jsonpath_parser import compile_jsonpath, extract_one_compiled
from app.runtime.errors import MappingError, ParserError


def apply_mapping_with_transform_results(
    event: dict[str, Any],
    field_mappings: dict[str, Any] | None,
) -> tuple[dict[str, Any], list[FieldTransformRuleResult]]:
    """Project one event through the persisted Mapping config and expose per-field advanced evidence."""

    if not isinstance(event, dict):
        raise MappingError(f"apply_mapping expects dict event, got {type(event).__name__}")

    fm = field_mappings or {}
    if not fm:
        return copy_json_value(event), []

    if is_full_event_mapping(fm):
        mapped, errors, _warnings = apply_full_event_mapping(event, fm)
        if errors:
            raise MappingError(errors[0])
        return mapped, []

    basic = extract_basic_jsonpath_mappings(fm)
    compiled = compile_mappings(basic)
    pass_unmapped = should_pass_through_unmapped(fm)
    mapped = apply_compiled_mapping(
        event,
        compiled,
        source_json_paths=tuple(basic.values()) if pass_unmapped else None,
    )
    rules = extract_field_transform_rules(fm, "transform_rules")
    if not rules:
        return mapped, []

    transformed, results = apply_field_transform_rules(
        event,
        rules,
        initial_output=mapped,
    )
    return transformed, results


def apply_mapping(event: dict[str, Any], field_mappings: dict[str, Any] | None) -> dict[str, Any]:
    """Project ``event`` through basic, full-event, and persisted per-field Mapping rules."""

    mapped, transform_results = apply_mapping_with_transform_results(event, field_mappings)
    first_error = next((result for result in transform_results if not result.success), None)
    if first_error is not None:
        raise MappingError(first_error.error_message or first_error.error_code or "Advanced transform failed")
    return mapped


def apply_mappings(events: list[dict[str, Any]], field_mappings: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Apply :func:`apply_mapping` to each event independently."""

    fm = field_mappings or {}
    if is_full_event_mapping(fm) or extract_field_transform_rules(fm, "transform_rules"):
        return [apply_mapping(event, fm) for event in events]

    basic = extract_basic_jsonpath_mappings(fm)
    compiled = compile_mappings(basic)
    pass_unmapped = should_pass_through_unmapped(fm)
    return apply_compiled_mappings(
        events,
        compiled,
        source_json_paths=tuple(basic.values()) if pass_unmapped else None,
    )


def apply_mappings_with_results(
    events: list[dict[str, Any]],
    field_mappings: dict[str, Any] | None,
) -> list[MappingApplyResult]:
    """Batch mapping with per-event structured errors for runtime delivery_logs.

    Thin compatibility wrapper over :func:`apply_mappings` for StreamRunner.
    Simple JSONPath mappings produce no field-level errors; invalid events yield
    structured ``event_error`` entries instead of aborting the whole batch.
    """

    fm = field_mappings or {}
    if is_full_event_mapping(fm):
        results: list[MappingApplyResult] = []
        for event in events:
            if not isinstance(event, dict):
                results.append(
                    MappingApplyResult(
                        mapped_event={},
                        event_error=MappingEventError(
                            error_code="MAPPING_EVENT_INVALID",
                            error_message=(
                                f"apply_mapping expects dict event, got {type(event).__name__}"
                            ),
                        ),
                    )
                )
                continue
            try:
                mapped, errors, warnings = apply_full_event_mapping(event, fm)
                if errors:
                    results.append(
                        MappingApplyResult(
                            mapped_event={},
                            event_error=MappingEventError(
                                error_code="MAPPING_FAILED",
                                error_message=errors[0],
                            ),
                        )
                    )
                    continue
                field_errors = [
                    MappingFieldError(
                        rule_id=None,
                        output_field="",
                        error_code="MAPPING_FIELD_WARNING",
                        error_message=w,
                    )
                    for w in warnings
                ]
                results.append(MappingApplyResult(mapped_event=mapped, field_errors=field_errors))
            except MappingError as exc:
                results.append(
                    MappingApplyResult(
                        mapped_event={},
                        event_error=MappingEventError(
                            error_code="MAPPING_FAILED",
                            error_message=str(exc),
                        ),
                    )
                )
        return results

    basic = extract_basic_jsonpath_mappings(fm)
    compiled = compile_mappings(basic)
    pass_unmapped = should_pass_through_unmapped(fm)
    source_paths = tuple(basic.values()) if pass_unmapped else None
    advanced_rules = extract_field_transform_rules(fm, "transform_rules")
    results = []
    for event in events:
        if not isinstance(event, dict):
            results.append(
                MappingApplyResult(
                    mapped_event={},
                    event_error=MappingEventError(
                        error_code="MAPPING_EVENT_INVALID",
                        error_message=(
                            f"apply_mapping expects dict event, got {type(event).__name__}"
                        ),
                    ),
                )
            )
            continue
        mapped_event = apply_compiled_mapping(
            event,
            compiled,
            source_json_paths=source_paths,
        )
        transform_results: list[FieldTransformRuleResult] = []
        if advanced_rules:
            mapped_event, transform_results = apply_field_transform_rules(
                event,
                advanced_rules,
                initial_output=mapped_event,
            )
        field_errors = [
            MappingFieldError(
                rule_id=result.rule_id,
                output_field=result.output_field,
                error_code=result.error_code or "ADVANCED_TRANSFORM_FAILED",
                error_message=result.error_message or "Advanced transform failed",
            )
            for result in transform_results
            if not result.success
        ]
        results.append(
            MappingApplyResult(
                mapped_event=mapped_event,
                field_errors=field_errors,
            )
        )
    return results


def compile_mappings(field_mappings: dict[str, str]) -> dict[str, Any]:
    """Compile mapping JSONPath expressions once for reuse across events."""

    if not field_mappings:
        return {}

    compiled: dict[str, Any] = {}
    for out_field, jsonpath_expr in field_mappings.items():
        try:
            compiled[out_field] = compile_jsonpath(jsonpath_expr)
        except ParserError as exc:
            raise MappingError(
                f"Invalid JSONPath for output field {out_field!r}: {jsonpath_expr!r}"
            ) from exc
    return compiled


def apply_compiled_mapping(
    event: dict[str, Any],
    compiled_mappings: dict[str, Any],
    *,
    source_json_paths: tuple[str, ...] | None = None,
) -> dict[str, Any]:
    """Apply precompiled JSONPath expressions to a single event."""

    if not isinstance(event, dict):
        raise MappingError(f"apply_compiled_mapping expects dict event, got {type(event).__name__}")

    if not compiled_mappings:
        return copy_json_value(event)

    output: dict[str, Any] = {}
    for out_field, compiled_expr in compiled_mappings.items():
        value = extract_one_compiled(compiled_expr, event, default=None)
        output[out_field] = copy_json_value(value)

    paths = source_json_paths if source_json_paths is not None else None
    if paths is not None:
        return merge_unknown_field_pass_through(event, output, paths)
    return output


def apply_compiled_mappings(
    events: list[dict[str, Any]],
    compiled_mappings: dict[str, Any],
    *,
    source_json_paths: tuple[str, ...] | None = None,
) -> list[dict[str, Any]]:
    """Apply compiled mappings to all events with one compile step."""

    return [
        apply_compiled_mapping(event, compiled_mappings, source_json_paths=source_json_paths)
        for event in events
    ]


def build_preview(
    raw_response: Any,
    event_array_path: str | None,
    field_mappings: dict[str, Any],
    enrichment: dict[str, Any],
    override_policy: str = "KEEP_EXISTING",
    event_root_path: str | None = None,
) -> list[dict[str, Any]]:
    """Run extract → map → enrich for UI preview (no I/O, no checkpoint).

    Order:
        ``raw_response`` → :func:`extract_events` → :func:`apply_mappings`
        → :func:`apply_enrichments`.

    This helper does not send data or touch persistence.
    """

    # Local import keeps enrichment module free of mapper imports at load time.
    from app.enrichers.enrichment_engine import apply_enrichments

    extracted = extract_events(raw_response, event_array_path, event_root_path)
    mapped = apply_mappings(extracted, field_mappings)
    return apply_enrichments(mapped, enrichment, override_policy=override_policy)


class Mapper:
    """Thin façade over mapping functions for dependency injection / tests."""

    def apply_mapping(self, event: dict[str, Any], field_mappings: dict[str, str]) -> dict[str, Any]:
        """Delegate to :func:`apply_mapping`."""

        return apply_mapping(event, field_mappings)

    def apply_mappings(self, events: list[dict[str, Any]], field_mappings: dict[str, str]) -> list[dict[str, Any]]:
        """Delegate to :func:`apply_mappings`."""

        return apply_mappings(events, field_mappings)
