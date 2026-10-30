"""Stream configuration read/write, sample data, incremental test, replay, checkpoint, dedup."""

from __future__ import annotations

import copy
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from sqlalchemy import func, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, joinedload

from app.backfill.schemas import BackfillReplayRequest
from app.backfill import service as backfill_service
from app.checkpoints.models import Checkpoint
from app.checkpoints.repository import get_checkpoint_by_stream_id, upsert_checkpoint
from app.checkpoints.route_delivery_state import reduce_route_delivery_state, strip_route_delivery_state
from app.connectors.models import Connector
from app.destinations.repository import get_destination_by_id
from app.enrichments.models import Enrichment
from app.logs.models import DeliveryLog
from app.mappings.models import Mapping
from app.protection.operator_workflow import list_protection_rules
from app.routes.models import Route
from app.runtime.copy_utils import slim_checkpoint_for_log
from app.runtime.preview_service import run_http_api_test
from app.http.shared_request_builder import build_shared_http_request
from app.runtime.incremental_fetch import (
    build_fetch_window,
    count_records_newer_than_checkpoint,
    get_incremental_display_state,
    normalize_incremental_fetch_config,
    parse_incremental_fetch_config,
    prepare_fetch_checkpoint_context,
    split_checkpoint_for_display,
)
from app.runtime.replay_service import checkpoint_unchanged, replay_delivery_log
from app.runtime.schemas import (
    HttpApiTestRequest,
    StreamCheckpointManageResponse,
    StreamCheckpointResetRequest,
    StreamCheckpointUpdateRequest,
    StreamConfigurationField,
    StreamConfigurationResponse,
    StreamConfigurationSection,
    StreamDeduplicationConfig,
    StreamDeduplicationSaveRequest,
    StreamDedupRuntimeStatus,
    StreamIncrementalTestRequest,
    StreamIncrementalTestResponse,
    StreamIncrementalFetchConfig,
    StreamIncrementalFetchSaveRequest,
    StreamIncrementalFetchStatus,
    StreamReplayRequest,
    StreamReplayResponse,
    StreamSampleDataResponse,
    StreamSampleDataSaveRequest,
)
from app.parsers.event_extractor import extract_events
from app.runners.stream_dedup import apply_stream_dedup, last_dedup_runtime_stats
from app.runners.stream_loader import load_stream_context
from app.runners.stream_runner import StreamRunner
from app.security.secrets import mask_http_headers, mask_secrets
from app.sources.models import Source
from app.streams.models import Stream
from app.streams.repository import get_stream_by_id

logger = logging.getLogger(__name__)

NOT_CONFIGURED = "Not configured"
_WIZARD_SAMPLE_KEY = "wizard_sample_data"
_INCREMENTAL_TEST_KEY = "incremental_test"
_DEDUP_KEY = "deduplication"
_MAX_SAMPLE_EVENTS = 50
_MAX_BODY_PREVIEW = 8000


class StreamNotFoundError(Exception):
    def __init__(self, stream_id: int) -> None:
        super().__init__(stream_id)
        self.stream_id = stream_id


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _display_scalar(value: Any) -> str:
    if value is None:
        return NOT_CONFIGURED
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value).strip()
    return text if text else NOT_CONFIGURED


def _display_json(value: Any) -> str:
    if value is None:
        return NOT_CONFIGURED
    if isinstance(value, str):
        text = value.strip()
        return text if text else NOT_CONFIGURED
    if isinstance(value, (dict, list)):
        if not value:
            return NOT_CONFIGURED
        try:
            return json.dumps(value, indent=2, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            return str(value)
    return _display_scalar(value)


def _field(label: str, value: Any, *, sensitive: bool = False) -> StreamConfigurationField:
    if isinstance(value, (dict, list)):
        display = _display_json(value)
    else:
        display = _display_scalar(value)
    configured = display != NOT_CONFIGURED
    return StreamConfigurationField(label=label, value=display, configured=configured, sensitive=sensitive)


def _section(title: str, fields: list[StreamConfigurationField]) -> StreamConfigurationSection:
    return StreamConfigurationSection(title=title, fields=fields)


def _auth_type_label(auth_json: dict[str, Any]) -> str:
    raw = auth_json.get("auth_type") or auth_json.get("type") or ""
    text = str(raw).strip()
    return text.upper() if text else NOT_CONFIGURED


def _checkpoint_display(checkpoint: dict[str, Any] | None) -> str:
    if not checkpoint:
        return NOT_CONFIGURED
    preview = slim_checkpoint_for_log(checkpoint) or checkpoint
    return _display_json(preview)


def _incremental_body_from_config(cfg: dict[str, Any]) -> str | None:
    inc = cfg.get(_INCREMENTAL_TEST_KEY)
    if isinstance(inc, dict):
        draft = inc.get("request_draft") or inc.get("incremental_request_draft")
        if isinstance(draft, str) and draft.strip():
            return draft.strip()
    draft = cfg.get("incremental_request_draft")
    if isinstance(draft, str) and draft.strip():
        return draft.strip()
    return None


def _load_stream_bundle(db: Session, stream_id: int) -> tuple[Stream, Source | None, Connector | None, Mapping | None, Enrichment | None, list[Route], Checkpoint | None]:
    stream = (
        db.query(Stream)
        .options(joinedload(Stream.source), joinedload(Stream.connector))
        .filter(Stream.id == stream_id)
        .first()
    )
    if stream is None:
        raise StreamNotFoundError(stream_id)

    mapping = db.query(Mapping).filter(Mapping.stream_id == stream_id).first()
    enrichment = db.query(Enrichment).filter(Enrichment.stream_id == stream_id).first()
    routes = (
        db.query(Route)
        .options(joinedload(Route.destination))
        .filter(Route.stream_id == stream_id)
        .order_by(Route.id.asc())
        .all()
    )
    checkpoint_row = get_checkpoint_by_stream_id(db, stream_id)
    source = stream.source
    connector = stream.connector
    return stream, source, connector, mapping, enrichment, routes, checkpoint_row


def _timestamp_conversion_sections(enrichment: Enrichment | None) -> list[StreamConfigurationSection]:
    """Build Configuration-tab sections for Timestamp Conversion enrichment rules."""

    if enrichment is None or not isinstance(enrichment.enrichment_json, dict):
        return [
            _section(
                "Timestamp Conversion",
                [_field("Rules", None)],
            )
        ]

    raw_rules = enrichment.enrichment_json.get("__rules")
    if not isinstance(raw_rules, dict):
        return [
            _section(
                "Timestamp Conversion",
                [_field("Rules", None)],
            )
        ]

    fields: list[StreamConfigurationField] = []
    for target, rule in raw_rules.items():
        if not isinstance(rule, dict):
            continue
        if str(rule.get("type") or "").strip().lower() != "timestamp_conversion":
            continue
        if rule.get("enabled") is False:
            continue
        source = rule.get("source_field") or rule.get("tsSourceField") or ""
        input_fmt = rule.get("input_format") or rule.get("tsInputFormat") or "auto"
        output_fmt = rule.get("output_format") or rule.get("tsOutputFormat") or "utc_iso8601"
        tz = rule.get("timezone") or rule.get("tsTimezoneMode") or "utc"
        if isinstance(tz, dict):
            mode = str(tz.get("mode") or "utc")
            iana = tz.get("iana") or tz.get("timezone")
            tz_display = f"{mode}:{iana}" if iana else mode
        else:
            tz_display = str(tz)
        on_failure = rule.get("on_failure") or rule.get("tsOnFailure") or "keep_original"
        enabled = rule.get("enabled")
        enabled_display = "true" if enabled is not False else "false"
        fields.extend(
            [
                _field("Source Field", source),
                _field("Target Field", target),
                _field("Input Format", input_fmt),
                _field("Output Format", output_fmt),
                _field("Timezone", tz_display),
                _field("On Failure", on_failure),
                _field("Enabled", enabled_display),
            ]
        )

    if not fields:
        fields = [_field("Rules", None)]
    return [_section("Timestamp Conversion", fields)]


def _type_conversion_sections(enrichment: Enrichment | None) -> list[StreamConfigurationSection]:
    """Build Configuration-tab sections for Type Conversion enrichment rules."""

    if enrichment is None or not isinstance(enrichment.enrichment_json, dict):
        return [_section("Type Conversion", [_field("Rules", None)])]

    raw_rules = enrichment.enrichment_json.get("__rules")
    if not isinstance(raw_rules, dict):
        return [_section("Type Conversion", [_field("Rules", None)])]

    fields: list[StreamConfigurationField] = []
    for target, rule in raw_rules.items():
        if not isinstance(rule, dict):
            continue
        if str(rule.get("type") or "").strip().lower() != "type_conversion":
            continue
        if rule.get("enabled") is False:
            continue
        source = rule.get("source_field") or rule.get("tcSourceField") or ""
        target_type = rule.get("target_type") or rule.get("tcTargetType") or ""
        on_failure = rule.get("on_failure") or rule.get("tcOnFailure") or "keep_original"
        enabled = rule.get("enabled")
        enabled_display = "true" if enabled is not False else "false"
        fields.extend(
            [
                _field("Source Field", source),
                _field("Target Field", target),
                _field("Target Type", target_type),
                _field("On Failure", on_failure),
                _field("Enabled", enabled_display),
            ]
        )

    if not fields:
        fields = [_field("Rules", None)]
    return [_section("Type Conversion", fields)]


def _normalize_rule_sections(enrichment: Enrichment | None) -> list[StreamConfigurationSection]:
    """Build Configuration-tab sections for Normalize enrichment rules."""

    if enrichment is None or not isinstance(enrichment.enrichment_json, dict):
        return [_section("Normalize", [_field("Rules", None)])]

    raw_rules = enrichment.enrichment_json.get("__rules")
    if not isinstance(raw_rules, dict):
        return [_section("Normalize", [_field("Rules", None)])]

    fields: list[StreamConfigurationField] = []
    for target, rule in raw_rules.items():
        if not isinstance(rule, dict):
            continue
        if str(rule.get("type") or "").strip().lower() != "normalize":
            continue
        if rule.get("enabled") is False:
            continue
        source = rule.get("source_field") or rule.get("normalizeSourceField") or ""
        operation = (
            rule.get("operation")
            or rule.get("normalizeOperation")
            or rule.get("format")
            or rule.get("normalizeFormat")
            or ""
        )
        on_failure = rule.get("on_failure") or rule.get("normalizeOnFailure") or "keep_original"
        enabled = rule.get("enabled")
        enabled_display = "true" if enabled is not False else "false"
        fields.extend(
            [
                _field("Source Field", source),
                _field("Target Field", target),
                _field("Operation", operation),
                _field("On Failure", on_failure),
                _field("Enabled", enabled_display),
            ]
        )

    if not fields:
        fields = [_field("Rules", None)]
    return [_section("Normalize", fields)]


def _jsonata_template_sections(enrichment: Enrichment | None) -> list[StreamConfigurationSection]:
    """Build Configuration-tab sections for JSONata Template enrichment rules."""

    if enrichment is None or not isinstance(enrichment.enrichment_json, dict):
        return [_section("JSONata Template", [_field("Rules", None)])]

    raw_rules = enrichment.enrichment_json.get("__rules")
    if not isinstance(raw_rules, dict):
        return [_section("JSONata Template", [_field("Rules", None)])]

    template_labels = {
        "copy_field": "Copy Field",
        "rename_field": "Rename Field",
        "concat_fields": "Concat Fields",
        "default_value": "Default Value",
        "coalesce": "Coalesce First Non-empty",
        "conditional_value": "Conditional Value",
        "array_join": "Array Join",
        "extract_nested": "Extract Nested Field",
        "static_value": "Static Value",
        "build_object": "Build Object",
    }

    fields: list[StreamConfigurationField] = []
    for target, rule in raw_rules.items():
        if not isinstance(rule, dict):
            continue
        if str(rule.get("type") or "").strip().lower() != "jsonata":
            continue
        if rule.get("enabled") is False:
            continue
        template = str(rule.get("template") or rule.get("jtTemplate") or "").strip()
        template_name = template_labels.get(template, template or "Advanced JSONata")
        expression = rule.get("expression") or ""
        params = rule.get("template_params") or rule.get("jtParams") or rule.get("templateParams") or {}
        advanced = rule.get("advanced_override")
        if advanced is None:
            advanced = rule.get("jtAdvancedOverride") or rule.get("advancedOverride")
        advanced_display = "true" if advanced is True else "false"
        enabled = rule.get("enabled")
        enabled_display = "true" if enabled is not False else "false"
        fields.extend(
            [
                _field("Template Name", template_name),
                _field("Template", template or None),
                _field("Template Params", params if isinstance(params, (dict, list)) else (params or None)),
                _field("Target Field", rule.get("target_field") or target),
                _field("Generated Expression", expression),
                _field("Expression", expression),
                _field("Advanced Override", advanced_display),
                _field("Enabled", enabled_display),
            ]
        )

    if not fields:
        fields = [_field("Rules", None)]
    return [_section("JSONata Template", fields)]


def get_stream_configuration(db: Session, stream_id: int) -> StreamConfigurationResponse:
    stream, source, connector, mapping, enrichment, routes, checkpoint_row = _load_stream_bundle(db, stream_id)
    cfg = dict(stream.config_json or {})
    masked_cfg = mask_secrets(cfg)
    source_cfg = mask_secrets(dict(source.config_json or {})) if source is not None else {}
    auth_json = mask_secrets(dict(source.auth_json or {})) if source is not None else {}
    rate_limit = dict(stream.rate_limit_json or {})

    checkpoint_value = strip_route_delivery_state(
        dict(checkpoint_row.checkpoint_value_json or {})
        if checkpoint_row is not None and isinstance(checkpoint_row.checkpoint_value_json, dict)
        else None
    )

    method = cfg.get("method") or cfg.get("http_method") or "GET"
    endpoint = cfg.get("endpoint") or cfg.get("url") or source_cfg.get("base_url")
    headers = cfg.get("headers") if isinstance(cfg.get("headers"), dict) else {}
    params = cfg.get("params") if isinstance(cfg.get("params"), dict) else {}
    body = cfg.get("body") if cfg.get("body") is not None else cfg.get("request_body")
    pagination = cfg.get("pagination") if isinstance(cfg.get("pagination"), dict) else {}
    dedup = _normalize_dedup_config(cfg.get(_DEDUP_KEY))
    inc_config = parse_incremental_fetch_config(cfg)
    inc_display = get_incremental_display_state(checkpoint_value, cfg)
    fetch_window = build_fetch_window(config=inc_config, checkpoint=checkpoint_value)

    protection_rules = list_protection_rules(db, stream_id=int(stream_id))
    protection_count = len(protection_rules)

    route_lines: list[str] = []
    for route in routes:
        dest = route.destination
        dest_name = str(dest.name) if dest is not None else f"destination #{route.destination_id}"
        dest_type = str(dest.destination_type) if dest is not None else "unknown"
        route_lines.append(
            f"Route {route.id} → {dest_name} ({dest_type}) — "
            f"{'enabled' if route.enabled else 'disabled'}, policy={route.failure_policy}"
        )

    transform_mode = NOT_CONFIGURED
    transform_summary = NOT_CONFIGURED
    if mapping is not None and isinstance(mapping.field_mappings_json, dict):
        fm = mapping.field_mappings_json
        transform_mode = _display_scalar(fm.get("mapping_mode") or "basic_jsonpath")
        field_count = sum(
            1
            for k, v in fm.items()
            if k not in ("mapping_mode", "transform_rules", "jsonata_expression", "expression", "regex_config")
            and isinstance(v, str)
            and v.strip()
        )
        transform_summary = f"{field_count} field mapping(s)" if field_count else NOT_CONFIGURED

    sections = [
        _section(
            "Stream",
            [
                _field("Name", stream.name),
                _field("Stream Type", stream.stream_type),
                _field("Status", stream.status),
                _field("Enabled", stream.enabled),
                _field("Polling Interval (sec)", stream.polling_interval),
            ],
        ),
        _section(
            "Connector",
            [
                _field("Connector", connector.name if connector is not None else None),
                _field("Connector ID", connector.id if connector is not None else None),
                _field("Source Type", source.source_type if source is not None else None),
            ],
        ),
        _section(
            "Authentication",
            [
                _field("Auth Type", _auth_type_label(auth_json)),
                _field("Auth Config", auth_json, sensitive=True),
            ],
        ),
        _section(
            "Request",
            [
                _field("Request URL", endpoint),
                _field("HTTP Method", str(method).upper()),
                _field("Headers", mask_http_headers({str(k): str(v) for k, v in headers.items()}), sensitive=True),
                _field("Query Parameters", params),
                _field("Body", masked_cfg.get("body") or masked_cfg.get("request_body") or body, sensitive=True),
            ],
        ),
        _section(
            "Pagination",
            [
                _field("Type", pagination.get("type") if pagination else None),
                _field("Cursor Param", pagination.get("cursor_param") if pagination else None),
                _field("Page Size", pagination.get("page_size") if pagination else None),
                _field("Max Pages", pagination.get("max_pages") if pagination else None),
            ],
        ),
        _section(
            "Rate Limit & Timeout",
            [
                _field("Per Minute", rate_limit.get("per_minute")),
                _field("Burst", rate_limit.get("burst")),
                _field("Timeout (sec)", cfg.get("timeout_seconds") or cfg.get("timeout_sec")),
            ],
        ),
        _section(
            "Schedule",
            [
                _field("Polling Interval (sec)", stream.polling_interval),
                _field("Initial Delay (sec)", cfg.get("initial_delay_sec") or cfg.get("initialDelaySec")),
            ],
        ),
        _section(
            "Event Extraction",
            [
                _field("Event Root", mapping.event_root_path if mapping is not None else None),
                _field("Record Path", mapping.event_array_path if mapping is not None else None),
                _field("Raw Payload Mode", mapping.raw_payload_mode if mapping is not None else None),
            ],
        ),
        _section(
            "Incremental Fetch",
            [
                _field(
                    "Incremental field",
                    inc_display.watermark_field or inc_display.cursor_field,
                ),
                _field(
                    "Sync safety",
                    (
                        f"Safe default: wait {inc_display.stability_lag_seconds} seconds before fetching newest records."
                        if (inc_display.strategy or "") == "closed_window_watermark"
                        and inc_display.stability_lag_seconds is not None
                        else (
                            "Cursor-based incremental sync."
                            if (inc_display.strategy or "") == "cursor"
                            else (
                                "Timestamp watermark (no closed-window lag)."
                                if (inc_display.strategy or "") == "timestamp_watermark"
                                else (
                                    "Custom incremental strategy."
                                    if (inc_display.strategy or "") == "custom"
                                    else None
                                )
                            )
                        )
                    ),
                ),
                _field("Strategy (Advanced)", inc_display.strategy),
                _field("Current Fetch Watermark", inc_display.fetch_watermark),
                _field("Current Delivery Checkpoint", _checkpoint_display(inc_display.delivery_checkpoint)),
                _field("Watermark Field (Advanced)", inc_display.watermark_field),
                _field("Cursor Field (Advanced)", inc_display.cursor_field),
                _field("Tie-breaker Field (Advanced)", inc_display.tie_breaker_field),
                _field(
                    "Stability Lag (sec) (Advanced)",
                    inc_display.stability_lag_seconds if inc_display.stability_lag_seconds is not None else None,
                ),
                _field("Connector Cursor (Advanced)", inc_display.connector_cursor),
                _field("Last Fetch Time (Advanced)", inc_display.last_fetch_at),
                _field("Last Delivery Time (Advanced)", inc_display.last_delivery_at),
                _field(
                    "Fetch Window (Advanced)",
                    (
                        f"{inc_display.fetch_window.lower_bound} → {inc_display.fetch_window.upper_bound}"
                        if inc_display.fetch_window
                        else (f"{fetch_window.lower_bound} → {fetch_window.upper_bound}" if fetch_window else None)
                    ),
                ),
            ],
        ),
        _section(
            "Checkpoint",
            [
                _field("Checkpoint Strategy", checkpoint_row.checkpoint_type if checkpoint_row is not None else None),
                _field("Timestamp Field", cfg.get("checkpoint_column") or cfg.get("checkpoint_source_path")),
                _field("Last Checkpoint", _checkpoint_display(checkpoint_value)),
                _field("Current Checkpoint", _checkpoint_display(checkpoint_value)),
            ],
        ),
        _section(
            "Incremental Query",
            [
                _field("Pattern", cfg.get("incremental_request_pattern")),
                _field("Request Draft", _incremental_body_from_config(cfg)),
            ],
        ),
        _section(
            "Destinations & Routes",
            [
                _field("Route Count", len(routes)),
                _field("Routes", "\n".join(route_lines) if route_lines else None),
            ],
        ),
        _section(
            "Transform",
            [
                _field("Mapping Mode", transform_mode),
                _field("Field Mappings", transform_summary),
                _field(
                    "Enrichment",
                    "enabled" if enrichment is not None and enrichment.enabled else ("disabled" if enrichment else None),
                ),
            ],
        ),
        *_timestamp_conversion_sections(enrichment),
        *_type_conversion_sections(enrichment),
        *_normalize_rule_sections(enrichment),
        *_jsonata_template_sections(enrichment),
        _section(
            "Protection",
            [
                _field("Protection Rules", protection_count if protection_count else None),
            ],
        ),
        _section(
            "Retry",
            [
                _field(
                    "Route Failure Policies",
                    ", ".join(sorted({str(r.failure_policy) for r in routes})) if routes else None,
                ),
            ],
        ),
        _section(
            "Deduplication",
            [
                _field("Enabled", dedup.enabled),
                _field("Dedup Key Field", dedup.key_field),
                _field("Custom JSONPath", dedup.custom_jsonpath),
                _field("Duplicate Handling", dedup.duplicate_handling),
                _field("Dedup Scope", dedup.scope),
            ],
        ),
    ]

    return StreamConfigurationResponse(
        stream_id=int(stream.id),
        stream_name=str(stream.name),
        sections=sections,
        message="Stream configuration loaded successfully",
    )


def _sample_data_from_config(cfg: dict[str, Any], mapping: Mapping | None) -> StreamSampleDataResponse:
    raw = cfg.get(_WIZARD_SAMPLE_KEY)
    sample_blob = raw if isinstance(raw, dict) else {}
    union_schema = cfg.get("union_schema") if isinstance(cfg.get("union_schema"), dict) else None
    incremental = cfg.get(_INCREMENTAL_TEST_KEY) if isinstance(cfg.get(_INCREMENTAL_TEST_KEY), dict) else None

    events = sample_blob.get("sample_events")
    if not isinstance(events, list):
        events = []

    last_test = sample_blob.get("last_test_response")
    if not isinstance(last_test, dict):
        last_test = None

    return StreamSampleDataResponse(
        stream_id=int(cfg.get("stream_id") or 0),
        has_sample_data=bool(events or union_schema or last_test),
        last_test_response=last_test,
        sample_events=[e for e in events if isinstance(e, dict)][: _MAX_SAMPLE_EVENTS],
        sample_count=int(sample_blob.get("sample_count") or len(events) or 0),
        union_schema=union_schema,
        event_root_path=(
            sample_blob.get("event_root_path")
            or (mapping.event_root_path if mapping is not None else None)
        ),
        record_path=(
            sample_blob.get("record_path")
            or (mapping.event_array_path if mapping is not None else None)
        ),
        checkpoint_test_result=incremental.get("checkpoint_test_result") if incremental else None,
        incremental_test_result=incremental.get("result") if incremental else None,
        saved_at=sample_blob.get("saved_at"),
        message="Sample data loaded successfully" if (events or union_schema or last_test) else "No sample data saved yet",
    )


def get_stream_sample_data(db: Session, stream_id: int) -> StreamSampleDataResponse:
    stream, _, _, mapping, _, _, _ = _load_stream_bundle(db, stream_id)
    cfg = dict(stream.config_json or {})
    response = _sample_data_from_config(cfg, mapping)
    return response.model_copy(update={"stream_id": int(stream.id)})


def save_stream_sample_data(db: Session, stream_id: int, payload: StreamSampleDataSaveRequest) -> StreamSampleDataResponse:
    stream, _, _, mapping, _, _, _ = _load_stream_bundle(db, stream_id)
    cfg = dict(stream.config_json or {})
    existing = cfg.get(_WIZARD_SAMPLE_KEY)
    sample_blob: dict[str, Any] = copy.deepcopy(existing) if isinstance(existing, dict) else {}

    if payload.last_test_response is not None:
        sample_blob["last_test_response"] = copy.deepcopy(payload.last_test_response)
    if payload.sample_events is not None:
        trimmed = [e for e in payload.sample_events if isinstance(e, dict)][: _MAX_SAMPLE_EVENTS]
        sample_blob["sample_events"] = trimmed
        sample_blob["sample_count"] = len(trimmed)
    if payload.event_root_path is not None:
        sample_blob["event_root_path"] = payload.event_root_path
    if payload.record_path is not None:
        sample_blob["record_path"] = payload.record_path
    sample_blob["saved_at"] = _utcnow().isoformat()

    cfg[_WIZARD_SAMPLE_KEY] = sample_blob
    if payload.union_schema is not None:
        cfg["union_schema"] = copy.deepcopy(payload.union_schema)
    if payload.incremental_test_result is not None or payload.checkpoint_test_result is not None:
        inc = cfg.get(_INCREMENTAL_TEST_KEY)
        inc_blob: dict[str, Any] = copy.deepcopy(inc) if isinstance(inc, dict) else {}
        if payload.incremental_test_result is not None:
            inc_blob["result"] = copy.deepcopy(payload.incremental_test_result)
        if payload.checkpoint_test_result is not None:
            inc_blob["checkpoint_test_result"] = copy.deepcopy(payload.checkpoint_test_result)
        inc_blob["tested_at"] = _utcnow().isoformat()
        cfg[_INCREMENTAL_TEST_KEY] = inc_blob

    stream.config_json = cfg
    db.add(stream)
    db.flush()
    response = _sample_data_from_config(cfg, mapping)
    return response.model_copy(update={"stream_id": int(stream.id), "message": "Sample data saved successfully"})


def _normalize_dedup_config(raw: Any) -> StreamDeduplicationConfig:
    if not isinstance(raw, dict):
        return StreamDeduplicationConfig()
    handling = str(raw.get("duplicate_handling") or "skip_duplicate")
    if handling not in ("skip_duplicate", "keep_latest", "keep_first"):
        handling = "skip_duplicate"
    scope = str(raw.get("scope") or "current_run")
    if scope not in ("current_run", "checkpoint_window", "last_n_hours"):
        scope = "current_run"
    key_field = str(raw.get("key_field") or "event_id").strip() or "event_id"
    custom = raw.get("custom_jsonpath")
    custom_path = str(custom).strip() if isinstance(custom, str) and custom.strip() else None
    return StreamDeduplicationConfig(
        enabled=bool(raw.get("enabled")),
        key_field=key_field,
        custom_jsonpath=custom_path,
        duplicate_handling=handling,  # type: ignore[arg-type]
        scope=scope,  # type: ignore[arg-type]
        window_hours=int(raw["window_hours"]) if isinstance(raw.get("window_hours"), int) else None,
    )


def get_stream_deduplication(db: Session, stream_id: int) -> StreamDedupRuntimeStatus:
    stream, _, _, _, _, _, _ = _load_stream_bundle(db, stream_id)
    cfg = dict(stream.config_json or {})
    base = _normalize_dedup_config(cfg.get(_DEDUP_KEY))
    last_summary = last_dedup_runtime_stats(db, stream_id)
    degraded = isinstance(last_summary, dict) and bool(last_summary.get("degraded"))
    summary_for_response: dict[str, Any] | None
    if degraded:
        summary_for_response = None
    elif isinstance(last_summary, dict):
        summary_for_response = {k: v for k, v in last_summary.items() if k != "degraded"}
    else:
        summary_for_response = None
    last_dup = int(summary_for_response.get("duplicate_events") or 0) if summary_for_response else 0
    return StreamDedupRuntimeStatus(
        enabled=base.enabled,
        key_field=base.key_field,
        custom_jsonpath=base.custom_jsonpath,
        duplicate_handling=base.duplicate_handling,
        scope=base.scope,
        window_hours=base.window_hours,
        last_runtime_duplicate_count=last_dup,
        last_runtime_dedup_summary=summary_for_response,
        last_runtime_stats_degraded=degraded,
    )


def save_stream_deduplication(db: Session, stream_id: int, payload: StreamDeduplicationSaveRequest) -> StreamDeduplicationConfig:
    stream, _, _, _, _, _, _ = _load_stream_bundle(db, stream_id)
    cfg = dict(stream.config_json or {})
    cfg[_DEDUP_KEY] = {
        "enabled": bool(payload.enabled),
        "key_field": payload.key_field,
        "custom_jsonpath": payload.custom_jsonpath,
        "duplicate_handling": payload.duplicate_handling,
        "scope": payload.scope,
        "window_hours": payload.window_hours,
    }
    stream.config_json = cfg
    db.add(stream)
    db.flush()
    return _normalize_dedup_config(cfg[_DEDUP_KEY])


def _last_incremental_runtime_summary(db: Session, stream_id: int) -> dict[str, Any] | None:
    """Best-effort last incremental summary from run_complete logs (never fail the config API)."""

    try:
        # Narrow projection + recent window keeps this off the statement-timeout path on large labs.
        cutoff = _utcnow() - timedelta(days=7)
        row = (
            db.query(DeliveryLog.payload_sample)
            .filter(
                DeliveryLog.stream_id == stream_id,
                DeliveryLog.stage == "run_complete",
                DeliveryLog.created_at >= cutoff,
            )
            .order_by(DeliveryLog.id.desc())
            .limit(1)
            .first()
        )
    except Exception:
        logger.exception("last_incremental_runtime_summary_failed stream_id=%s", stream_id)
        try:
            db.rollback()
        except Exception:
            pass
        return None
    if row is None:
        return None
    payload = row[0] if isinstance(row, tuple) else getattr(row, "payload_sample", None)
    if not isinstance(payload, dict):
        return None
    summary = payload.get("incremental_runtime_summary")
    return summary if isinstance(summary, dict) else None


def get_stream_incremental_fetch(db: Session, stream_id: int) -> StreamIncrementalFetchStatus:
    stream, _, _, _, _, _, checkpoint_row = _load_stream_bundle(db, stream_id)
    cfg = dict(stream.config_json or {})
    inc_raw = cfg.get("incremental_fetch")
    inc_blob = inc_raw if isinstance(inc_raw, dict) else {}
    parsed = parse_incremental_fetch_config(cfg)
    checkpoint_value = (
        dict(checkpoint_row.checkpoint_value_json or {})
        if checkpoint_row is not None and isinstance(checkpoint_row.checkpoint_value_json, dict)
        else None
    )
    display = get_incremental_display_state(checkpoint_value, cfg)
    window = display.fetch_window
    return StreamIncrementalFetchStatus(
        strategy=parsed.strategy,  # type: ignore[arg-type]
        watermark_field=parsed.watermark_field,
        cursor_field=parsed.cursor_field,
        tie_breaker_field=parsed.tie_breaker_field,
        stability_lag_seconds=parsed.stability_lag_seconds,
        initial_lookback_seconds=parsed.initial_lookback_seconds,
        framework_enabled=parsed.framework_enabled,
        fetch_watermark=display.fetch_watermark,
        connector_cursor=display.connector_cursor,
        delivery_checkpoint=display.delivery_checkpoint,
        last_fetch_at=display.last_fetch_at,
        last_delivery_at=display.last_delivery_at,
        fetch_window=(
            {"lower_bound": window.lower_bound, "upper_bound": window.upper_bound} if window is not None else None
        ),
        last_runtime_summary=_last_incremental_runtime_summary(db, stream_id),
    )


def save_stream_incremental_fetch(
    db: Session,
    stream_id: int,
    payload: StreamIncrementalFetchSaveRequest,
) -> StreamIncrementalFetchConfig:
    stream, _, _, _, _, _, _ = _load_stream_bundle(db, stream_id)
    cfg = dict(stream.config_json or {})
    existing = cfg.get("incremental_fetch")
    existing_blob = existing if isinstance(existing, dict) else {}
    patch = normalize_incremental_fetch_config(payload.model_dump(exclude_unset=True))
    merged = {**existing_blob, **patch}
    if not merged.get("strategy"):
        merged.pop("strategy", None)
    cfg["incremental_fetch"] = merged
    stream.config_json = cfg
    db.add(stream)
    db.flush()
    parsed = parse_incremental_fetch_config(cfg)
    return StreamIncrementalFetchConfig(
        strategy=parsed.strategy,  # type: ignore[arg-type]
        watermark_field=parsed.watermark_field,
        cursor_field=parsed.cursor_field,
        tie_breaker_field=parsed.tie_breaker_field,
        stability_lag_seconds=parsed.stability_lag_seconds,
        initial_lookback_seconds=parsed.initial_lookback_seconds,
    )


def run_stream_incremental_test(
    db: Session,
    stream_id: int,
    payload: StreamIncrementalTestRequest,
    *,
    api_origin: str | None = None,
) -> StreamIncrementalTestResponse:
    stream, source, _, mapping, _, _, checkpoint_row = _load_stream_bundle(db, stream_id)
    if source is None:
        raise ValueError("stream has no source")

    before_checkpoint = (
        copy.deepcopy(checkpoint_row.checkpoint_value_json)
        if checkpoint_row is not None and isinstance(checkpoint_row.checkpoint_value_json, dict)
        else {}
    )

    cfg = dict(stream.config_json or {})
    checkpoint_override = payload.checkpoint_override
    if checkpoint_override is None and checkpoint_row is not None:
        checkpoint_override = strip_route_delivery_state(
            dict(checkpoint_row.checkpoint_value_json)
            if isinstance(checkpoint_row.checkpoint_value_json, dict)
            else None
        )

    inc_config = parse_incremental_fetch_config(cfg)
    inc_display = get_incremental_display_state(checkpoint_override, cfg)
    fetch_ctx = prepare_fetch_checkpoint_context(checkpoint_override, cfg)
    fetch_window_obj = build_fetch_window(config=inc_config, checkpoint=checkpoint_override)
    fetch_window_dict = (
        {"lower_bound": fetch_window_obj.lower_bound, "upper_bound": fetch_window_obj.upper_bound}
        if fetch_window_obj
        else None
    )

    stream_config = copy.deepcopy(cfg)
    if payload.request_body is not None:
        stream_config["body"] = payload.request_body

    request_checkpoint = fetch_ctx if inc_config.framework_enabled else checkpoint_override
    test_req = HttpApiTestRequest(
        source_config=dict(source.config_json or {}),
        stream_config=stream_config,
        checkpoint=request_checkpoint,
        connector_id=int(stream.connector_id),
        fetch_sample=True,
    )
    result = run_http_api_test(test_req, db, api_origin=api_origin)

    query_preview: dict[str, Any] | None = None
    try:
        if source is not None:
            plan = build_shared_http_request(
                source_config=dict(source.config_json or {}),
                stream_config=stream_config,
                mode="runtime",
                checkpoint_value=fetch_ctx if inc_config.framework_enabled else checkpoint_override,
            )
            query_preview = {
                "method": plan.method,
                "url": plan.url,
                "params": plan.params,
                "headers": mask_http_headers({str(k): str(v) for k, v in plan.stream_headers.items()}),
                "body": plan.normalized_json_body,
            }
    except Exception as exc:
        logger.debug("incremental_test_query_preview_failed stream_id=%s: %s", stream_id, exc)

    events: list[dict[str, Any]] = []
    extracted = None
    if result.response is not None:
        extracted = result.response.parsed_json
    if extracted is None:
        extracted = result.response_sample
    if isinstance(extracted, list):
        events.extend([e for e in extracted if isinstance(e, dict)][: _MAX_SAMPLE_EVENTS])
    elif isinstance(extracted, dict):
        events.append(extracted)
    elif result.analysis is not None and isinstance(result.analysis.sample_event, dict):
        events.append(result.analysis.sample_event)

    fetched_count = len(events)
    # A successful request that only returns records at or before the checkpoint does not prove the incremental
    # filter works (the runtime would not advance), so report it as a warning instead of plain success.
    newer_record_count = count_records_newer_than_checkpoint(
        events, checkpoint=request_checkpoint, stream_config=stream_config
    )
    no_newer_records = bool(result.ok) and fetched_count > 0 and newer_record_count == 0
    test_status = "error" if not result.ok else ("warning" if no_newer_records else "success")
    warning_code = "NO_NEWER_RECORDS" if no_newer_records else None
    dedup_events, dedup_summary = apply_stream_dedup(
        events,
        stream_config=cfg,
        stream_id=int(stream.id),
        db=db,
        checkpoint=checkpoint_override,
        dry_run=True,
        apply_dedup=True,
    )
    events = dedup_events
    dedup_dict = dedup_summary.to_dict() if dedup_summary is not None else None
    inserted_count = int(dedup_dict.get("inserted") or len(events)) if dedup_dict else len(events)
    duplicate_count = int(dedup_dict.get("duplicate_events") or 0) if dedup_dict else 0

    next_checkpoint_preview = checkpoint_override
    if events:
        next_checkpoint_preview = {"last_success_event": copy.deepcopy(events[-1])}

    unchanged = checkpoint_unchanged(db, stream_id, before_checkpoint)

    if no_newer_records:
        message = (
            f"Incremental test returned {fetched_count} record(s), but none is newer than the checkpoint. "
            "Verify the request applies the checkpoint filter before relying on it."
        )
    else:
        message = str(result.message or ("Incremental test completed" if result.ok else "Incremental test failed"))

    inc_blob = cfg.get(_INCREMENTAL_TEST_KEY)
    inc_store: dict[str, Any] = copy.deepcopy(inc_blob) if isinstance(inc_blob, dict) else {}
    inc_store["result"] = {
        "ok": bool(result.ok),
        "status": test_status,
        "warning_code": warning_code,
        "newer_record_count": newer_record_count,
        "http_status": result.response.status_code if result.response is not None else None,
        "message": message if no_newer_records else result.message,
        "returned_record_count": len(events),
        "substituted_request_body": (
            result.actual_request_sent.json_body_masked
            if result.actual_request_sent is not None
            else None
        ),
    }
    inc_store["checkpoint_test_result"] = {
        "input_checkpoint": checkpoint_override,
        "next_checkpoint_preview": next_checkpoint_preview,
        "checkpoint_unchanged": unchanged,
    }
    inc_store["tested_at"] = _utcnow().isoformat()
    cfg[_INCREMENTAL_TEST_KEY] = inc_store
    stream.config_json = cfg
    db.add(stream)
    db.flush()

    return StreamIncrementalTestResponse(
        stream_id=int(stream.id),
        ok=bool(result.ok),
        http_status=result.response.status_code if result.response is not None else None,
        message=message,
        status=test_status,
        warning_code=warning_code,
        newer_record_count=newer_record_count,
        preview_events=events[:10],
        next_checkpoint_preview=next_checkpoint_preview,
        checkpoint_unchanged=unchanged,
        substituted_request_body=(
            json.dumps(result.actual_request_sent.json_body_masked, default=str)
            if result.actual_request_sent is not None
            and result.actual_request_sent.json_body_masked is not None
            else None
        ),
        event_root_path=mapping.event_root_path if mapping is not None else None,
        record_path=mapping.event_array_path if mapping is not None else None,
        fetched=fetched_count,
        inserted=inserted_count,
        duplicates=duplicate_count,
        dedup_summary=dedup_dict,
        strategy=inc_display.strategy,
        watermark_field=inc_display.watermark_field,
        cursor_field=inc_display.cursor_field,
        fetch_watermark=inc_display.fetch_watermark,
        delivery_checkpoint=inc_display.delivery_checkpoint,
        stability_lag_seconds=inc_display.stability_lag_seconds,
        fetch_window=fetch_window_dict,
        query_preview=query_preview,
    )


def run_stream_operational_replay(db: Session, stream_id: int, payload: StreamReplayRequest) -> StreamReplayResponse:
    mode = payload.mode
    dry_run = bool(payload.dry_run)
    apply_dedup = bool(payload.apply_dedup)

    if mode == "delivery_log":
        if payload.delivery_log_id is None:
            raise ValueError("delivery_log_id is required for delivery_log replay mode")
        before = {}
        ck = get_checkpoint_by_stream_id(db, stream_id)
        if ck is not None and isinstance(ck.checkpoint_value_json, dict):
            before = copy.deepcopy(ck.checkpoint_value_json)
        result = replay_delivery_log(db, int(payload.delivery_log_id), dry_run=dry_run)
        unchanged = checkpoint_unchanged(db, stream_id, before)
        return StreamReplayResponse(
            stream_id=stream_id,
            mode=mode,
            dry_run=dry_run,
            apply_dedup=apply_dedup,
            outcome=result.outcome,
            message=result.message,
            event_count=result.event_count,
            checkpoint_unchanged=unchanged,
            preview_message_count=result.preview_message_count,
        )

    if mode == "time_range":
        if payload.start_time is None or payload.end_time is None:
            raise ValueError("start_time and end_time are required for time_range replay")
        job = backfill_service.replay_stream_backfill(
            db,
            BackfillReplayRequest(
                stream_id=stream_id,
                start_time=payload.start_time,
                end_time=payload.end_time,
                dry_run=dry_run,
                apply_dedup=apply_dedup,
                requested_by=payload.requested_by or "stream_replay_api",
            ),
        )
        delivery = job.delivery_summary_json if isinstance(job.delivery_summary_json, dict) else {}
        return StreamReplayResponse(
            stream_id=stream_id,
            mode=mode,
            dry_run=dry_run,
            apply_dedup=apply_dedup,
            outcome=str(job.status or "completed").lower(),
            message=str(job.error_summary or "Replay job finished"),
            event_count=int(delivery.get("event_count") or 0) if delivery else None,
            checkpoint_unchanged=True,
            backfill_job_id=int(job.id),
            dedup_summary=delivery.get("dedup_summary") if isinstance(delivery, dict) else None,
        )

    if mode == "last_n_minutes":
        minutes = int(payload.last_n_minutes or 60)
        end = _utcnow()
        start = end - timedelta(minutes=minutes)
        job = backfill_service.replay_stream_backfill(
            db,
            BackfillReplayRequest(
                stream_id=stream_id,
                start_time=start,
                end_time=end,
                dry_run=dry_run,
                apply_dedup=apply_dedup,
                requested_by=payload.requested_by or "stream_replay_api",
            ),
        )
        delivery = job.delivery_summary_json if isinstance(job.delivery_summary_json, dict) else {}
        return StreamReplayResponse(
            stream_id=stream_id,
            mode=mode,
            dry_run=dry_run,
            apply_dedup=apply_dedup,
            outcome=str(job.status or "completed").lower(),
            message=str(job.error_summary or f"Replayed last {minutes} minute(s)"),
            event_count=int(delivery.get("event_count") or 0) if delivery else None,
            checkpoint_unchanged=True,
            backfill_job_id=int(job.id),
            dedup_summary=delivery.get("dedup_summary") if isinstance(delivery, dict) else None,
        )

    if mode == "checkpoint_preview":
        context = load_stream_context(db, stream_id, require_enabled_stream=False)
        context.persist_checkpoint = False
        context.dry_run = dry_run
        context.apply_dedup = apply_dedup
        if payload.checkpoint_override is not None:
            context.checkpoint = {"type": "manual_test", "value": copy.deepcopy(payload.checkpoint_override)}
        before = copy.deepcopy(context.checkpoint.get("value")) if isinstance(context.checkpoint, dict) else {}
        runner = StreamRunner()
        summary = runner.run(context, db=db)
        unchanged = checkpoint_unchanged(db, stream_id, before if isinstance(before, dict) else {})
        return StreamReplayResponse(
            stream_id=stream_id,
            mode=mode,
            dry_run=dry_run,
            apply_dedup=apply_dedup,
            outcome=str(summary.get("outcome") or "completed"),
            message=str(summary.get("message") or "Checkpoint preview run completed"),
            event_count=int(summary.get("extracted_event_count") or 0),
            checkpoint_unchanged=unchanged,
            dedup_summary=summary.get("dedup_summary") if isinstance(summary.get("dedup_summary"), dict) else None,
        )

    if mode == "failed_events":
        logs = (
            db.query(DeliveryLog)
            .filter(
                DeliveryLog.stream_id == stream_id,
                DeliveryLog.stage.in_(("route_send_failed", "route_retry_failed")),
            )
            .order_by(DeliveryLog.id.desc())
            .limit(int(payload.limit or 20))
            .all()
        )
        replayed = 0
        last_message = "No failed delivery logs found"
        last_outcome = "no_events"
        for row in logs:
            try:
                result = replay_delivery_log(db, int(row.id), dry_run=dry_run)
                replayed += 1
                last_message = result.message
                last_outcome = result.outcome
            except Exception as exc:
                logger.debug("skip failed replay log_id=%s: %s", row.id, exc)
                continue
        return StreamReplayResponse(
            stream_id=stream_id,
            mode=mode,
            dry_run=dry_run,
            apply_dedup=apply_dedup,
            outcome=last_outcome,
            message=last_message if replayed else "No eligible failed events to replay",
            event_count=replayed,
            checkpoint_unchanged=True,
        )

    raise ValueError(f"unsupported replay mode: {mode}")


# Bound delivery_logs activity scans so high-volume streams degrade instead of 500.
_CHECKPOINT_ACTIVITY_LOOKBACK = timedelta(hours=24)
_CHECKPOINT_ACTIVITY_STATEMENT_TIMEOUT_MS = 5000


def _empty_checkpoint_activity() -> dict[str, datetime | None]:
    return {
        "last_success_at": None,
        "last_failure_at": None,
        "last_collected_event_at": None,
    }


def _checkpoint_activity(db: Session, stream_id: int) -> dict[str, datetime | None]:
    """Derive last success/failure/collected timestamps from recent delivery_logs.

    Scoped to the last 24h with a short ``statement_timeout``. On timeout or DB
    failure, return null activity fields so Checkpoint APIs stay 200.
    """

    since = datetime.now(timezone.utc) - _CHECKPOINT_ACTIVITY_LOOKBACK
    try:
        db.execute(text(f"SET LOCAL statement_timeout = '{int(_CHECKPOINT_ACTIVITY_STATEMENT_TIMEOUT_MS)}ms'"))
        last_success = (
            db.query(func.max(DeliveryLog.created_at))
            .filter(
                DeliveryLog.stream_id == stream_id,
                DeliveryLog.created_at >= since,
                DeliveryLog.stage.in_(("route_send_success", "route_retry_success", "checkpoint_update")),
                DeliveryLog.status == "OK",
            )
            .scalar()
        )
        last_failure = (
            db.query(func.max(DeliveryLog.created_at))
            .filter(
                DeliveryLog.stream_id == stream_id,
                DeliveryLog.created_at >= since,
                DeliveryLog.stage.in_(("route_send_failed", "route_retry_failed", "source_fetch_failed")),
            )
            .scalar()
        )
        last_collected = (
            db.query(func.max(DeliveryLog.created_at))
            .filter(
                DeliveryLog.stream_id == stream_id,
                DeliveryLog.created_at >= since,
                DeliveryLog.stage.in_(("source_fetch_success", "mapping_success", "enrichment_success")),
            )
            .scalar()
        )
        return {
            "last_success_at": last_success,
            "last_failure_at": last_failure,
            "last_collected_event_at": last_collected,
        }
    except OperationalError as exc:
        db.rollback()
        logger.warning(
            "%s",
            {
                "stage": "checkpoint_activity_degraded",
                "stream_id": int(stream_id),
                "error_type": type(exc).__name__,
                "message": str(exc)[:300],
            },
        )
        return _empty_checkpoint_activity()
    finally:
        try:
            db.execute(text("SET LOCAL statement_timeout = '0'"))
        except OperationalError:
            db.rollback()


def get_stream_checkpoint_manage(db: Session, stream_id: int) -> StreamCheckpointManageResponse:
    stream, _, _, _, _, _, checkpoint_row = _load_stream_bundle(db, stream_id)
    # Materialize checkpoint fields before activity: activity may rollback on timeout.
    stream_id_out = int(stream.id)
    stream_cfg = dict(stream.config_json or {})
    checkpoint_type = str(checkpoint_row.checkpoint_type) if checkpoint_row is not None else None
    # Per-Route delivery fingerprints are exposed only as per-Route counts.
    value = reduce_route_delivery_state(
        copy.deepcopy(checkpoint_row.checkpoint_value_json)
        if checkpoint_row is not None and isinstance(checkpoint_row.checkpoint_value_json, dict)
        else None
    )
    updated_at = checkpoint_row.updated_at if checkpoint_row is not None else None

    activity = _checkpoint_activity(db, stream_id)
    split = split_checkpoint_for_display(value, stream_cfg)
    return StreamCheckpointManageResponse(
        stream_id=stream_id_out,
        checkpoint_type=checkpoint_type,
        checkpoint_value=slim_checkpoint_for_log(value) if value else None,
        framework_enabled=bool(split.get("framework_enabled")),
        checkpoint_mode=str(split.get("checkpoint_mode") or "legacy"),
        fetch_checkpoint=split.get("fetch_checkpoint"),
        delivery_checkpoint=split.get("delivery_checkpoint"),
        legacy_checkpoint=split.get("legacy_checkpoint"),
        updated_at=updated_at,
        last_success_at=activity["last_success_at"],
        last_failure_at=activity["last_failure_at"],
        last_collected_event_at=activity["last_collected_event_at"],
    )


def update_stream_checkpoint(db: Session, stream_id: int, payload: StreamCheckpointUpdateRequest) -> StreamCheckpointManageResponse:
    _load_stream_bundle(db, stream_id)
    upsert_checkpoint(
        db,
        stream_id=stream_id,
        checkpoint_type=str(payload.checkpoint_type or "manual_edit"),
        checkpoint_value_json=copy.deepcopy(payload.checkpoint_value),
    )
    db.flush()
    return get_stream_checkpoint_manage(db, stream_id)


def reset_stream_checkpoint(db: Session, stream_id: int, payload: StreamCheckpointResetRequest) -> StreamCheckpointManageResponse:
    _load_stream_bundle(db, stream_id)
    row = get_checkpoint_by_stream_id(db, stream_id)
    if row is not None:
        db.delete(row)
        db.flush()
    return get_stream_checkpoint_manage(db, stream_id)
