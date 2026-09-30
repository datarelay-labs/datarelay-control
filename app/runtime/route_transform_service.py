"""Route-scoped transform operator API (M13.2) — mapping/enrichment CRUD with dual-read."""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.enrichments.models import Enrichment
from app.mappings.models import Mapping
from app.route_transform.models import RouteEnrichment, RouteMapping
from app.routes.models import Route
from app.runners.route_transform_config import resolve_route_transform_config
from app.runtime.control_service import MappingPathValidationError, RouteNotFoundError, _assert_mapping_paths_relative_to_extracted_event
from app.runtime.schemas import (
    MappingUIConfigEnrichment,
    MappingUIConfigMapping,
    RouteEnrichmentUISaveRequest,
    RouteEnrichmentUISaveResponse,
    RouteMappingUISaveRequest,
    RouteMappingUISaveResponse,
    RouteEnrichmentUIConfigResponse,
    RouteMappingUIConfigResponse,
    RouteTransformEffectiveResponse,
)


def _load_route(db: Session, route_id: int) -> Route:
    route = db.query(Route).filter(Route.id == route_id).first()
    if route is None:
        raise RouteNotFoundError(route_id)
    return route


def _stream_mapping_row(db: Session, stream_id: int) -> Mapping | None:
    return db.query(Mapping).filter(Mapping.stream_id == stream_id).first()


def _stream_enrichment_row(db: Session, stream_id: int) -> Enrichment | None:
    return db.query(Enrichment).filter(Enrichment.stream_id == stream_id).first()


def _mapping_config_from_row(row: Mapping | RouteMapping | None, *, exists: bool) -> MappingUIConfigMapping:
    if row is None:
        return MappingUIConfigMapping(
            exists=False,
            event_array_path=None,
            event_root_path=None,
            field_mappings={},
            raw_payload_mode=None,
        )
    event_array_path = getattr(row, "event_array_path", None)
    event_root_path = getattr(row, "event_root_path", None)
    return MappingUIConfigMapping(
        exists=exists,
        event_array_path=event_array_path,
        event_root_path=event_root_path,
        field_mappings=dict(getattr(row, "field_mappings_json", None) or {}),
        raw_payload_mode=getattr(row, "raw_payload_mode", None),
    )


def _enrichment_config_from_row(row: Enrichment | RouteEnrichment | None, *, exists: bool) -> MappingUIConfigEnrichment:
    if row is None:
        return MappingUIConfigEnrichment(
            exists=False,
            enabled=False,
            enrichment={},
            override_policy=None,
        )
    return MappingUIConfigEnrichment(
        exists=exists,
        enabled=bool(getattr(row, "enabled", True)),
        enrichment=dict(getattr(row, "enrichment_json", None) or {}),
        override_policy=str(getattr(row, "override_policy", None) or "KEEP_EXISTING"),
    )


def get_route_mapping_ui_config(db: Session, route_id: int) -> RouteMappingUIConfigResponse:
    route = _load_route(db, route_id)
    stream_id = int(route.stream_id)
    stream_mapping = _stream_mapping_row(db, stream_id)
    route_mapping = db.query(RouteMapping).filter(RouteMapping.route_id == route_id).first()

    inherit = route_mapping is None
    effective = _mapping_config_from_row(
        route_mapping if route_mapping is not None else stream_mapping,
        exists=route_mapping is not None or stream_mapping is not None,
    )
    if stream_mapping is not None:
        effective.event_array_path = stream_mapping.event_array_path
        effective.event_root_path = stream_mapping.event_root_path
    stream_out = _mapping_config_from_row(stream_mapping, exists=stream_mapping is not None)

    return RouteMappingUIConfigResponse(
        route_id=route_id,
        stream_id=stream_id,
        inherit_stream_mapping=inherit,
        mapping=effective,
        stream_mapping=stream_out,
        message="Route mapping UI config loaded successfully",
    )


def get_route_enrichment_ui_config(db: Session, route_id: int) -> RouteEnrichmentUIConfigResponse:
    route = _load_route(db, route_id)
    stream_id = int(route.stream_id)
    stream_enrichment = _stream_enrichment_row(db, stream_id)
    route_enrichment = db.query(RouteEnrichment).filter(RouteEnrichment.route_id == route_id).first()

    inherit = route_enrichment is None
    effective = _enrichment_config_from_row(
        route_enrichment if route_enrichment is not None else stream_enrichment,
        exists=route_enrichment is not None or stream_enrichment is not None,
    )
    stream_out = _enrichment_config_from_row(stream_enrichment, exists=stream_enrichment is not None)

    return RouteEnrichmentUIConfigResponse(
        route_id=route_id,
        stream_id=stream_id,
        inherit_stream_enrichment=inherit,
        enrichment=effective,
        stream_enrichment=stream_out,
        message="Route enrichment UI config loaded successfully",
    )


def save_route_mapping_ui_config(
    db: Session,
    route_id: int,
    payload: RouteMappingUISaveRequest,
) -> RouteMappingUISaveResponse:
    route = _load_route(db, route_id)
    stream_id = int(route.stream_id)
    stream_mapping = _stream_mapping_row(db, stream_id)
    route_mapping = db.query(RouteMapping).filter(RouteMapping.route_id == route_id).first()

    if payload.inherit:
        if route_mapping is not None:
            db.delete(route_mapping)
        db.commit()
        return RouteMappingUISaveResponse(
            route_id=route_id,
            stream_id=stream_id,
            mapping_saved=True,
            inherit_stream_mapping=True,
            message="Route mapping override cleared; stream mapping inherited.",
        )

    if payload.mapping is None:
        raise ValueError("mapping is required when inherit is false")

    fields = dict(payload.mapping.field_mappings)
    event_array_path = stream_mapping.event_array_path if stream_mapping is not None else payload.mapping.event_array_path
    event_root_path = stream_mapping.event_root_path if stream_mapping is not None else payload.mapping.event_root_path
    _assert_mapping_paths_relative_to_extracted_event(fields, event_array_path, event_root_path)

    if route_mapping is None:
        route_mapping = RouteMapping(
            route_id=route_id,
            field_mappings_json=fields,
            raw_payload_mode=payload.mapping.raw_payload_mode,
        )
        db.add(route_mapping)
    else:
        route_mapping.field_mappings_json = fields
        route_mapping.raw_payload_mode = payload.mapping.raw_payload_mode

    db.commit()
    return RouteMappingUISaveResponse(
        route_id=route_id,
        stream_id=stream_id,
        mapping_saved=True,
        inherit_stream_mapping=False,
        message="Route mapping override saved successfully.",
    )


def save_route_enrichment_ui_config(
    db: Session,
    route_id: int,
    payload: RouteEnrichmentUISaveRequest,
) -> RouteEnrichmentUISaveResponse:
    route = _load_route(db, route_id)
    stream_id = int(route.stream_id)
    route_enrichment = db.query(RouteEnrichment).filter(RouteEnrichment.route_id == route_id).first()

    if payload.inherit:
        if route_enrichment is not None:
            db.delete(route_enrichment)
        db.commit()
        return RouteEnrichmentUISaveResponse(
            route_id=route_id,
            stream_id=stream_id,
            enrichment_saved=True,
            inherit_stream_enrichment=True,
            message="Route enrichment override cleared; stream enrichment inherited.",
        )

    if payload.enrichment is None:
        raise ValueError("enrichment is required when inherit is false")

    fields = dict(payload.enrichment.enrichment)
    if route_enrichment is None:
        route_enrichment = RouteEnrichment(
            route_id=route_id,
            enrichment_json=fields,
            override_policy=payload.enrichment.override_policy,
            enabled=payload.enrichment.enabled,
        )
        db.add(route_enrichment)
    else:
        route_enrichment.enrichment_json = fields
        route_enrichment.override_policy = payload.enrichment.override_policy
        route_enrichment.enabled = payload.enrichment.enabled

    db.commit()
    return RouteEnrichmentUISaveResponse(
        route_id=route_id,
        stream_id=stream_id,
        enrichment_saved=True,
        inherit_stream_enrichment=False,
        message="Route enrichment override saved successfully.",
    )


def build_route_transform_effective(
    *,
    route_id: int,
    stream_id: int,
    route_mapping: RouteMapping | None,
    route_enrichment: RouteEnrichment | None,
    stream_mapping: Mapping | None,
    stream_enrichment: Enrichment | None,
) -> RouteTransformEffectiveResponse:
    """Assemble transform effective response from preloaded rows (no DB I/O)."""

    resolved = resolve_route_transform_config(
        route_mapping=route_mapping,
        route_enrichment=route_enrichment,
        stream_mapping=stream_mapping,
        stream_enrichment=stream_enrichment,
        stream_field_mappings=dict(stream_mapping.field_mappings_json or {}) if stream_mapping else {},
        stream_enrichment_json=dict(stream_enrichment.enrichment_json or {}) if stream_enrichment else {},
        stream_override_policy=str(stream_enrichment.override_policy) if stream_enrichment else "KEEP_EXISTING",
    )

    mapping_source = str(resolved.mapping_source)
    enrichment_source = str(resolved.enrichment_source)
    fallback_used = mapping_source == "stream" or enrichment_source == "stream"

    if mapping_source == "stream" and enrichment_source == "stream":
        persisted_source = "stream"
        processing_status = "Inherited"
    elif mapping_source == "route" and enrichment_source == "route":
        persisted_source = "route"
        processing_status = "Overridden"
    else:
        persisted_source = "mixed"
        processing_status = "Mixed"

    return RouteTransformEffectiveResponse(
        route_id=route_id,
        stream_id=stream_id,
        persisted_source=persisted_source,  # type: ignore[arg-type]
        mapping_source=mapping_source,  # type: ignore[arg-type]
        enrichment_source=enrichment_source,  # type: ignore[arg-type]
        fallback_used=fallback_used,
        mapping_count=len(resolved.field_mappings or {}),
        enrichment_count=len(resolved.enrichment or {}),
        effective_field_mappings=dict(resolved.field_mappings or {}),
        effective_enrichment=dict(resolved.enrichment or {}),
        effective_override_policy=str(resolved.override_policy or "KEEP_EXISTING"),
        processing_status=processing_status,  # type: ignore[arg-type]
        message="Route transform effective config resolved successfully",
    )


def get_route_transform_effective(db: Session, route_id: int) -> RouteTransformEffectiveResponse:
    route = _load_route(db, route_id)
    stream_id = int(route.stream_id)
    stream_mapping = _stream_mapping_row(db, stream_id)
    stream_enrichment = _stream_enrichment_row(db, stream_id)
    route_mapping = db.query(RouteMapping).filter(RouteMapping.route_id == route_id).first()
    route_enrichment = db.query(RouteEnrichment).filter(RouteEnrichment.route_id == route_id).first()
    return build_route_transform_effective(
        route_id=route_id,
        stream_id=stream_id,
        route_mapping=route_mapping,
        route_enrichment=route_enrichment,
        stream_mapping=stream_mapping,
        stream_enrichment=stream_enrichment,
    )
