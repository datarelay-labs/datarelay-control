"""Serialize and apply operator configuration snapshots (streams, mappings, routes, destinations)."""

from __future__ import annotations

import copy
from typing import Any

from sqlalchemy.orm import Session

from app.destinations.config_validation import validate_destination_config
from app.destinations.models import Destination
from app.mappings.models import Mapping
from app.routes.models import Route
from app.security.secrets import mask_config_payload, preserve_masked_secrets
from app.streams.models import Stream

KIND_STREAM = "STREAM_CONFIG"
KIND_MAPPING = "MAPPING_CONFIG"
KIND_ROUTE = "ROUTE_CONFIG"
KIND_DESTINATION = "DESTINATION_CONFIG"

ENTITY_STREAM = "STREAM_CONFIG"
ENTITY_MAPPING = "MAPPING_CONFIG"
ENTITY_ROUTE = "ROUTE_CONFIG"
ENTITY_DESTINATION = "DESTINATION_CONFIG"


def serialize_stream_config(stream: Stream) -> dict[str, Any]:
    return {
        "kind": KIND_STREAM,
        "stream_id": int(stream.id),
        "name": str(stream.name or ""),
        "enabled": bool(stream.enabled),
        "polling_interval": int(stream.polling_interval or 60),
        "config_json": mask_config_payload(copy.deepcopy(stream.config_json or {})),
        "rate_limit_json": copy.deepcopy(stream.rate_limit_json or {}),
    }


def serialize_mapping_for_stream(db: Session, stream_id: int) -> dict[str, Any]:
    m = db.query(Mapping).filter(Mapping.stream_id == int(stream_id)).first()
    if m is None:
        return {
            "kind": KIND_MAPPING,
            "stream_id": int(stream_id),
            "_absent": True,
            "mapping_id": None,
            "event_array_path": None,
            "event_root_path": None,
            "field_mappings_json": {},
            "raw_payload_mode": None,
        }
    return serialize_mapping_row(m)


def serialize_mapping_row(m: Mapping) -> dict[str, Any]:
    return {
        "kind": KIND_MAPPING,
        "stream_id": int(m.stream_id),
        "_absent": False,
        "mapping_id": int(m.id),
        "event_array_path": m.event_array_path,
        "event_root_path": m.event_root_path,
        "field_mappings_json": copy.deepcopy(m.field_mappings_json or {}),
        "raw_payload_mode": m.raw_payload_mode,
    }


def serialize_route_config(route: Route) -> dict[str, Any]:
    return {
        "kind": KIND_ROUTE,
        "route_id": int(route.id),
        "stream_id": int(route.stream_id),
        "destination_id": int(route.destination_id),
        "enabled": bool(route.enabled),
        "failure_policy": str(route.failure_policy or "LOG_AND_CONTINUE"),
        "formatter_config_json": copy.deepcopy(route.formatter_config_json or {}),
        "rate_limit_json": copy.deepcopy(route.rate_limit_json or {}),
        "status": str(route.status or "ENABLED"),
        "disable_reason": route.disable_reason,
    }


def serialize_destination_config(destination: Destination) -> dict[str, Any]:
    return {
        "kind": KIND_DESTINATION,
        "destination_id": int(destination.id),
        "name": str(destination.name or ""),
        "destination_type": str(destination.destination_type or ""),
        "enabled": bool(destination.enabled),
        "config_json": mask_config_payload(
            copy.deepcopy(destination.config_json or {}),
            mask_all_header_values=True,
        ),
        "rate_limit_json": copy.deepcopy(destination.rate_limit_json or {}),
    }


def _expected_kind_for_entity_type(entity_type: str) -> str:
    return {
        ENTITY_STREAM: KIND_STREAM,
        ENTITY_MAPPING: KIND_MAPPING,
        ENTITY_ROUTE: KIND_ROUTE,
        ENTITY_DESTINATION: KIND_DESTINATION,
    }[entity_type]


def validate_snapshot_for_entity(entity_type: str, snapshot: dict[str, Any]) -> None:
    kind = _expected_kind_for_entity_type(entity_type)
    if str(snapshot.get("kind") or "") != kind:
        raise ValueError(f"snapshot kind mismatch: expected {kind}, got {snapshot.get('kind')}")


def apply_stream_config(db: Session, snap: dict[str, Any]) -> None:
    sid = int(snap["stream_id"])
    row = db.query(Stream).filter(Stream.id == sid).first()
    if row is None:
        raise ValueError(f"stream not found: {sid}")
    row.name = str(snap.get("name") or row.name)
    row.enabled = bool(snap.get("enabled", row.enabled))
    row.polling_interval = int(snap.get("polling_interval", row.polling_interval or 60))
    incoming_cfg = copy.deepcopy(snap.get("config_json") or {})
    row.config_json = preserve_masked_secrets(incoming_cfg, dict(row.config_json or {}))
    row.rate_limit_json = copy.deepcopy(snap.get("rate_limit_json") or {})


def apply_mapping_config(db: Session, snap: dict[str, Any]) -> None:
    stream_id = int(snap["stream_id"])
    if snap.get("_absent") is True:
        existing = db.query(Mapping).filter(Mapping.stream_id == stream_id).first()
        if existing is not None:
            db.delete(existing)
        return

    m = db.query(Mapping).filter(Mapping.stream_id == stream_id).first()
    if m is None:
        m = Mapping(
            stream_id=stream_id,
            event_array_path=snap.get("event_array_path"),
            event_root_path=snap.get("event_root_path"),
            field_mappings_json=copy.deepcopy(snap.get("field_mappings_json") or {}),
            raw_payload_mode=snap.get("raw_payload_mode"),
        )
        db.add(m)
        return
    m.event_array_path = snap.get("event_array_path")
    m.event_root_path = snap.get("event_root_path")
    m.field_mappings_json = copy.deepcopy(snap.get("field_mappings_json") or {})
    m.raw_payload_mode = snap.get("raw_payload_mode")


def apply_route_config(db: Session, snap: dict[str, Any]) -> None:
    rid = int(snap["route_id"])
    row = db.query(Route).filter(Route.id == rid).first()
    if row is None:
        raise ValueError(f"route not found: {rid}")
    row.enabled = bool(snap.get("enabled", row.enabled))
    row.failure_policy = str(snap.get("failure_policy", row.failure_policy))
    row.formatter_config_json = copy.deepcopy(snap.get("formatter_config_json") or {})
    row.rate_limit_json = copy.deepcopy(snap.get("rate_limit_json") or {})
    row.status = str(snap.get("status", row.status or "ENABLED"))
    dr = snap.get("disable_reason")
    row.disable_reason = str(dr) if dr is not None else None


def apply_destination_config(db: Session, snap: dict[str, Any]) -> None:
    did = int(snap["destination_id"])
    row = db.query(Destination).filter(Destination.id == did).first()
    if row is None:
        raise ValueError(f"destination not found: {did}")
    dtype = str(snap.get("destination_type", row.destination_type))
    cfg = preserve_masked_secrets(
        copy.deepcopy(snap.get("config_json") or {}),
        dict(row.config_json or {}),
    )
    validate_destination_config(dtype, cfg)
    row.name = str(snap.get("name", row.name))
    row.destination_type = dtype
    row.enabled = bool(snap.get("enabled", row.enabled))
    row.config_json = cfg
    row.rate_limit_json = copy.deepcopy(snap.get("rate_limit_json") or {})


def apply_snapshot_for_entity(db: Session, entity_type: str, snapshot: dict[str, Any]) -> None:
    validate_snapshot_for_entity(entity_type, snapshot)
    if entity_type == ENTITY_STREAM:
        apply_stream_config(db, snapshot)
    elif entity_type == ENTITY_MAPPING:
        apply_mapping_config(db, snapshot)
    elif entity_type == ENTITY_ROUTE:
        apply_route_config(db, snapshot)
    elif entity_type == ENTITY_DESTINATION:
        apply_destination_config(db, snapshot)
    else:
        raise ValueError(f"unsupported entity_type for apply: {entity_type}")
