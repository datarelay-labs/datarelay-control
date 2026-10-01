"""Stream template → ORM row materialization from Connector Registry resources."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.connector_templates.errors import MaterializationError
from app.connectors.models import Connector
from app.connectors_registry.lifecycle_provenance import attach_provenance
from app.connectors_registry.models import ConnectorManifest, ConnectorModuleEntry, ConnectorStreamRef
from app.enrichments.models import Enrichment
from app.mappings.models import Mapping
from app.sources.models import Source
from app.streams.models import Stream


def _resolve_source(db: Session, connector: Connector) -> Source:
    source = (
        db.query(Source)
        .filter(Source.connector_id == connector.id)
        .order_by(Source.id.asc())
        .first()
    )
    if source is None:
        raise MaterializationError(
            error_code="SOURCE_NOT_FOUND",
            message=f"no source found for connector_id={connector.id}",
        )
    return source


def _stream_ref_for_template(manifest: ConnectorManifest, template_id: str) -> ConnectorStreamRef | None:
    for stream_ref in manifest.streams:
        if stream_ref.id == template_id:
            return stream_ref
    return None


def _mapping_key(stream_ref: ConnectorStreamRef) -> str | None:
    if not stream_ref.default_mapping:
        return None
    return Path(stream_ref.default_mapping).stem


def _enrichment_key(stream_ref: ConnectorStreamRef) -> str | None:
    if not stream_ref.default_enrichment:
        return None
    return Path(stream_ref.default_enrichment).stem


def _build_stream_row(
    *,
    connector: Connector,
    source: Source,
    template_id: str,
    stream_template: dict[str, Any],
    manifest: ConnectorManifest,
) -> Stream:
    defaults = dict(stream_template.get("defaults") or {})
    config_json = dict(stream_template.get("config_json") or {})
    rate_limit_json = dict(stream_template.get("rate_limit_json") or {})

    stream_name = str(stream_template.get("name") or stream_ref_display_name(manifest, template_id) or template_id).strip()
    stream_type = str(
        stream_template.get("stream_type")
        or manifest.source_type
        or source.source_type
        or "HTTP_API_POLLING"
    )
    polling_interval = int(defaults.get("polling_interval") or 60)
    enabled = bool(defaults.get("enabled", False))
    status = str(defaults.get("status") or "STOPPED")

    package_id = (manifest.package_id or manifest.id or "").strip()
    pack_version = (manifest.pack_version or manifest.version or "").strip()
    if package_id and pack_version:
        config_json = attach_provenance(
            config_json,
            package_id=package_id,
            pack_version=pack_version,
        )

    return Stream(
        name=stream_name,
        connector_id=connector.id,
        source_id=source.id,
        stream_type=stream_type,
        config_json=config_json,
        polling_interval=polling_interval,
        enabled=enabled,
        status=status,
        rate_limit_json=rate_limit_json,
    )


def stream_ref_display_name(manifest: ConnectorManifest, template_id: str) -> str | None:
    ref = _stream_ref_for_template(manifest, template_id)
    return ref.name if ref is not None else None


def _build_mapping_row(stream_id: int, mapping_preset: dict[str, Any]) -> Mapping:
    return Mapping(
        stream_id=stream_id,
        event_array_path=mapping_preset.get("event_array_path"),
        event_root_path=mapping_preset.get("event_root_path"),
        field_mappings_json=dict(mapping_preset.get("field_mappings_json") or {}),
        raw_payload_mode=mapping_preset.get("raw_payload_mode"),
    )


def _build_enrichment_row(stream_id: int, enrichment_preset: dict[str, Any]) -> Enrichment:
    return Enrichment(
        stream_id=stream_id,
        enrichment_json=dict(enrichment_preset.get("enrichment_json") or {}),
        override_policy=str(enrichment_preset.get("override_policy") or "KEEP_EXISTING"),
        enabled=bool(enrichment_preset.get("enabled", True)),
    )


def _build_checkpoint_row(stream_id: int, stream_template: dict[str, Any]) -> Checkpoint:
    checkpoint_defaults = dict(stream_template.get("checkpoint_defaults") or {})
    return Checkpoint(
        stream_id=stream_id,
        checkpoint_type=str(checkpoint_defaults.get("checkpoint_type") or "CUSTOM_FIELD"),
        checkpoint_value_json=dict(checkpoint_defaults.get("checkpoint_value_json") or {}),
    )


def materialize_stream_template(
    db: Session,
    *,
    connector: Connector,
    entry: ConnectorModuleEntry,
    template_id: str,
) -> dict[str, Any]:
    """Materialize one stream template into Stream + Mapping + Enrichment + Checkpoint rows."""

    manifest = entry.manifest
    if manifest is None:
        raise MaterializationError(
            error_code="INVALID_MODULE",
            message=f"module manifest missing: {entry.connector_id}",
            rule_id="TPL-005",
        )

    stream_template = entry.resources.streams.get(template_id)
    if stream_template is None:
        raise MaterializationError(
            error_code="STREAM_TEMPLATE_NOT_FOUND",
            message=f"stream template not found: {template_id}",
            rule_id="TPL-004",
        )

    stream_ref = _stream_ref_for_template(manifest, template_id)
    if stream_ref is None:
        raise MaterializationError(
            error_code="STREAM_TEMPLATE_NOT_FOUND",
            message=f"stream template not registered in manifest: {template_id}",
            rule_id="TPL-004",
        )

    mapping_key = _mapping_key(stream_ref)
    if not mapping_key:
        raise MaterializationError(
            error_code="MAPPING_PRESET_NOT_FOUND",
            message=f"default_mapping not declared for template: {template_id}",
            rule_id="TPL-003",
        )
    mapping_preset = entry.resources.mappings.get(mapping_key)
    if mapping_preset is None:
        raise MaterializationError(
            error_code="MAPPING_PRESET_NOT_FOUND",
            message=f"mapping preset not found: {mapping_key}",
            rule_id="TPL-003",
        )

    enrichment_key = _enrichment_key(stream_ref)
    enrichment_preset: dict[str, Any] = {}
    if enrichment_key:
        enrichment_preset = entry.resources.enrichments.get(enrichment_key) or {}

    source = _resolve_source(db, connector)
    stream_row = _build_stream_row(
        connector=connector,
        source=source,
        template_id=template_id,
        stream_template=stream_template,
        manifest=manifest,
    )
    db.add(stream_row)
    db.flush()

    mapping_row = _build_mapping_row(stream_row.id, mapping_preset)
    db.add(mapping_row)
    db.flush()

    enrichment_row = _build_enrichment_row(stream_row.id, enrichment_preset)
    db.add(enrichment_row)
    db.flush()

    checkpoint_row = _build_checkpoint_row(stream_row.id, stream_template)
    db.add(checkpoint_row)
    db.flush()

    return {
        "template_id": template_id,
        "stream_id": int(stream_row.id),
        "stream_name": str(stream_row.name),
        "mapping_id": int(mapping_row.id),
        "enrichment_id": int(enrichment_row.id),
        "checkpoint_id": int(checkpoint_row.id),
        "stream_type": str(stream_row.stream_type),
        "enabled": bool(stream_row.enabled),
        "status": str(stream_row.status),
        "config_json": dict(stream_row.config_json or {}),
        "rate_limit_json": dict(stream_row.rate_limit_json or {}),
    }
