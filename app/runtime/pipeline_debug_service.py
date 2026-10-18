"""Stream pipeline debugger — read-only preview of one sample event through mapping → delivery."""

from __future__ import annotations

import copy
import json
from typing import Any

from sqlalchemy.orm import Session, joinedload

from app.destinations.models import Destination
from app.enrichments.models import Enrichment
from app.formatters.message_prefix import compact_event_json
from app.mappers.mapper import apply_mappings
from app.enrichers.enrichment_engine import apply_enrichments
from app.mappings.models import Mapping
from app.parsers.event_extractor import extract_events
from app.routes.models import Route
from app.runtime.errors import EnrichmentError, MappingError, ParserError, PreviewRequestError
from app.runtime.preview_service import build_route_delivery_preview_messages
from app.runtime.schemas import (
    PipelineDebugRequest,
    PipelineDebugResponse,
    PipelineDebugRouteItem,
)
from app.streams.models import Stream


_META_COPY_KEYS = (
    "s3_bucket",
    "s3_key",
    "s3_last_modified",
    "s3_etag",
    "s3_size",
    "gdc_db_watermark",
    "gdc_db_order_value",
    "remote_path",
    "remote_mtime",
    "remote_size",
    "gdc_remote_path",
    "gdc_remote_mtime",
    "gdc_remote_size",
    "gdc_remote_offset",
    "gdc_remote_hash",
    "gdc_remote_protocol",
    "gdc_remote_host",
)


def _copy_source_metadata(raw_event: dict[str, Any], enriched_event: dict[str, Any]) -> None:
    for key in _META_COPY_KEYS:
        if key in raw_event and key not in enriched_event:
            enriched_event[key] = raw_event[key]


def _stored_sample_payload(source_config: dict[str, Any]) -> tuple[Any | None, str | None]:
    for key in ("sample_payload", "raw_sample_payload"):
        if key in source_config and source_config[key] is not None:
            return source_config[key], None

    preview = source_config.get("payload_preview")
    if preview is None:
        return None, None
    if not isinstance(preview, str):
        return preview, None

    text = preview.strip()
    if not text:
        return None, None
    try:
        return json.loads(text), None
    except json.JSONDecodeError:
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        if len(lines) > 1:
            try:
                return [json.loads(line) for line in lines], None
            except json.JSONDecodeError:
                pass
    return None, "Webhook payload_preview is not valid JSON or NDJSON."


def _resolve_raw_response(
    *,
    raw_event: Any | None,
    source_config: dict[str, Any],
    warnings: list[str],
    errors: list[str],
) -> Any | None:
    if raw_event is not None:
        return raw_event
    stored, stored_error = _stored_sample_payload(source_config)
    if stored_error is not None:
        errors.append(stored_error)
        return None
    if stored is not None:
        return stored
    errors.append(
        "No raw_event provided and no source sample_payload/raw_sample_payload/payload_preview is configured. "
        "Provide raw_event or configure a webhook sample payload on the source."
    )
    return None


def _formatter_summary(resolved: dict[str, Any], destination_type: str) -> dict[str, Any]:
    out: dict[str, Any] = {
        "destination_type": destination_type,
        "message_prefix_enabled": resolved.get("message_prefix_enabled"),
        "message_prefix_template": resolved.get("message_prefix_template"),
    }
    for key in (
        "message_format",
        "host",
        "port",
        "protocol",
        "url",
        "payload_mode",
        "batch_size",
        "tls_verify",
    ):
        if key in resolved and resolved[key] is not None:
            out[key] = resolved[key]
    return out


def run_stream_pipeline_debug(
    db: Session,
    stream_id: int,
    payload: PipelineDebugRequest,
) -> PipelineDebugResponse:
    """Run mapping → enrichment → format preview for one event; no send, checkpoint, or delivery_logs."""

    warnings: list[str] = []
    errors: list[str] = []

    stream = (
        db.query(Stream)
        .options(joinedload(Stream.source))
        .filter(Stream.id == int(stream_id))
        .first()
    )
    if stream is None:
        raise PreviewRequestError(
            404,
            {"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )

    mapping = db.query(Mapping).filter(Mapping.stream_id == int(stream_id)).first()
    enrichment = db.query(Enrichment).filter(Enrichment.stream_id == int(stream_id)).first()

    field_mappings = (
        {str(k): str(v) for k, v in (mapping.field_mappings_json or {}).items()} if mapping else {}
    )
    event_array_path = mapping.event_array_path if mapping else None
    event_root_path = mapping.event_root_path if mapping else None
    enrichment_cfg = dict(enrichment.enrichment_json or {}) if enrichment else {}
    override_policy = str(enrichment.override_policy or "KEEP_EXISTING") if enrichment else "KEEP_EXISTING"

    if not field_mappings:
        warnings.append("No field mappings configured for this stream; mapped_event will match extracted raw shape.")

    source_config = dict(stream.source.config_json or {}) if stream.source is not None else {}
    raw_response = _resolve_raw_response(
        raw_event=payload.raw_event,
        source_config=source_config,
        warnings=warnings,
        errors=errors,
    )
    if raw_response is None:
        return PipelineDebugResponse(
            stream_id=int(stream_id),
            raw_event=None,
            mapped_event=None,
            enriched_event=None,
            formatted_payload=None,
            routes=[],
            warnings=warnings,
            errors=errors,
        )

    try:
        events = extract_events(raw_response, event_array_path, event_root_path)
    except (MappingError, ParserError) as exc:
        errors.append(str(exc))
        return PipelineDebugResponse(
            stream_id=int(stream_id),
            raw_event=raw_response if isinstance(raw_response, dict) else None,
            mapped_event=None,
            enriched_event=None,
            formatted_payload=None,
            routes=[],
            warnings=warnings,
            errors=errors,
        )

    if not events:
        errors.append("Event extraction produced zero events from the sample payload.")
        return PipelineDebugResponse(
            stream_id=int(stream_id),
            raw_event=raw_response if isinstance(raw_response, dict) else None,
            mapped_event=None,
            enriched_event=None,
            formatted_payload=None,
            routes=[],
            warnings=warnings,
            errors=errors,
        )

    if len(events) > 1:
        warnings.append(
            f"Sample payload contains {len(events)} events; pipeline debugger uses only the first event."
        )

    raw_event_out = copy.deepcopy(events[0])

    try:
        mapped_events = apply_mappings(events[:1], field_mappings)
    except MappingError as exc:
        errors.append(str(exc))
        return PipelineDebugResponse(
            stream_id=int(stream_id),
            raw_event=raw_event_out,
            mapped_event=None,
            enriched_event=None,
            formatted_payload=None,
            routes=[],
            warnings=warnings,
            errors=errors,
        )

    mapped_event = copy.deepcopy(mapped_events[0])

    try:
        enriched_events = apply_enrichments(mapped_events, enrichment_cfg, override_policy)
    except EnrichmentError as exc:
        errors.append(str(exc))
        return PipelineDebugResponse(
            stream_id=int(stream_id),
            raw_event=raw_event_out,
            mapped_event=mapped_event,
            enriched_event=None,
            formatted_payload=None,
            routes=[],
            warnings=warnings,
            errors=errors,
        )

    enriched_event = copy.deepcopy(enriched_events[0])
    _copy_source_metadata(raw_event_out, enriched_event)
    from app.classification.service import classify_events_for_preview
    from app.protection.policy_engine import evaluate_batch as evaluate_policy_batch
    from app.protection.policy_service import evaluate_policies_for_preview
    from app.protection.service import commit_identity_vault_after_preview, protect_events_for_delivery
    from app.sensitive_detection.context import build_sensitive_detection_context

    detection_context = build_sensitive_detection_context(
        stream_id=int(stream_id),
        events=[enriched_event],
    )
    classify_events_for_preview(
        db,
        stream_id=int(stream_id),
        enriched_events=[enriched_event],
        detection_context=detection_context,
    )
    protected_events, _ = protect_events_for_delivery(
        db,
        stream_id=int(stream_id),
        enriched_events=[enriched_event],
    )
    commit_identity_vault_after_preview(db, int(stream_id))
    policy_result = evaluate_policy_batch(
        db,
        stream_id=int(stream_id),
        events=protected_events or [enriched_event],
        findings=detection_context.findings if detection_context else None,
    )
    matched_policies = evaluate_policies_for_preview(
        db,
        stream_id=int(stream_id),
        enriched_events=protected_events or [enriched_event],
        policy_result=policy_result,
    )
    from app.dynamic_routing.dynamic_routing_service import evaluate_dynamic_routes_for_preview

    selected_destinations = evaluate_dynamic_routes_for_preview(
        db,
        stream_id=int(stream_id),
        enriched_events=protected_events or [enriched_event],
        detection_context=detection_context,
    )
    delivery_event = protected_events[0] if protected_events else enriched_event
    formatted_payload = compact_event_json(delivery_event)

    routes = (
        db.query(Route)
        .options(joinedload(Route.destination))
        .filter(Route.stream_id == int(stream_id))
        .order_by(Route.id.asc())
        .all()
    )

    route_items: list[PipelineDebugRouteItem] = []
    for route in routes:
        destination = route.destination
        dest_type = str(destination.destination_type or "").strip().upper() if destination else ""
        route_item = PipelineDebugRouteItem(
            route_id=int(route.id),
            destination_id=int(route.destination_id),
            destination_type=dest_type or "UNKNOWN",
            formatter_summary={},
            delivery_preview=None,
        )

        if not bool(route.enabled):
            warnings.append(f"Route {route.id} is disabled; delivery preview still generated when possible.")
        if destination is None:
            errors.append(f"Route {route.id} has no destination row.")
            route_items.append(route_item)
            continue
        if not bool(destination.enabled):
            warnings.append(f"Destination {destination.id} for route {route.id} is disabled.")

        try:
            preview_messages, resolved = build_route_delivery_preview_messages(
                route=route,
                destination=destination,
                stream_row=stream,
                events=[delivery_event],
            )
        except PreviewRequestError as exc:
            detail = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
            errors.append(
                f"Route {route.id} delivery preview failed: {detail.get('message', detail)}"
            )
            route_item.formatter_summary = _formatter_summary(
                dict(detail) if isinstance(detail, dict) else {},
                dest_type,
            )
            route_items.append(route_item)
            continue
        except Exception as exc:
            errors.append(f"Route {route.id} delivery preview failed: {exc}")
            route_items.append(route_item)
            continue

        delivery_preview: Any
        if len(preview_messages) == 1:
            delivery_preview = preview_messages[0]
        else:
            delivery_preview = preview_messages

        route_item.formatter_summary = _formatter_summary(resolved, dest_type)
        route_item.delivery_preview = delivery_preview
        route_items.append(route_item)

    if not routes:
        warnings.append("No routes configured for this stream.")

    return PipelineDebugResponse(
        stream_id=int(stream_id),
        raw_event=raw_event_out,
        mapped_event=mapped_event,
        enriched_event=enriched_event,
        formatted_payload=formatted_payload,
        routes=route_items,
        matched_policies=matched_policies,
        selected_destinations=selected_destinations,
        warnings=warnings,
        errors=errors,
    )
