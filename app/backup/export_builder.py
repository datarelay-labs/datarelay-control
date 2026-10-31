"""Build portable JSON configuration bundles (secrets masked)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.backup.export_validation import build_export_integrity_report
from app.backup.schemas import ExportKind
from app.checkpoints.models import Checkpoint
from app.connectors.models import Connector
from app.destinations.models import Destination
from app.enrichments.models import Enrichment
from app.mappings.models import Mapping
from app.route_classification.models import RouteClassificationRule
from app.route_policy.models import RoutePolicyRule
from app.route_protection.models import RouteProtectionRule
from app.route_transform.models import RouteEnrichment, RouteMapping
from app.routes.models import Route
from app.security.secrets import mask_config_payload, mask_http_headers, mask_secrets, mask_secrets_and_pem
from app.sources.models import Source
from app.streams.models import Stream


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.isoformat()


def _connector_dict(c: Connector) -> dict[str, Any]:
    return {
        "id": c.id,
        "name": c.name,
        "product_group": c.product_group,
        "description": c.description,
        "status": c.status,
        "created_at": _iso(c.created_at),
        "updated_at": _iso(c.updated_at),
    }


def _mask_source_auth_json(auth: dict[str, Any]) -> dict[str, Any]:
    base = mask_secrets(dict(auth or {}))
    ph = base.get("preflight_headers")
    if isinstance(ph, dict):
        try:
            base["preflight_headers"] = mask_http_headers({str(k): str(v) for k, v in ph.items()})
        except Exception:
            base["preflight_headers"] = mask_secrets(ph)
    return base


def _source_dict(s: Source) -> dict[str, Any]:
    auth = _mask_source_auth_json(dict(s.auth_json or {}))
    return {
        "id": s.id,
        "connector_id": s.connector_id,
        "source_type": s.source_type,
        "config_json": mask_secrets(dict(s.config_json or {})),
        "auth_json": auth,
        "enabled": s.enabled,
        "created_at": _iso(s.created_at),
        "updated_at": _iso(s.updated_at),
    }


def _stream_dict(st: Stream) -> dict[str, Any]:
    return {
        "id": st.id,
        "connector_id": st.connector_id,
        "source_id": st.source_id,
        "name": st.name,
        "stream_type": st.stream_type,
        "config_json": mask_config_payload(dict(st.config_json or {})),
        "polling_interval": st.polling_interval,
        "enabled": st.enabled,
        "status": st.status,
        "rate_limit_json": dict(st.rate_limit_json or {}),
        "created_at": _iso(st.created_at),
        "updated_at": _iso(st.updated_at),
    }


def _mapping_dict(m: Mapping) -> dict[str, Any]:
    return {
        "id": m.id,
        "stream_id": m.stream_id,
        "event_array_path": m.event_array_path,
        "event_root_path": m.event_root_path,
        "field_mappings_json": dict(m.field_mappings_json or {}),
        "raw_payload_mode": m.raw_payload_mode,
        "created_at": _iso(m.created_at),
        "updated_at": _iso(m.updated_at),
    }


def _enrichment_dict(e: Enrichment) -> dict[str, Any]:
    return {
        "id": e.id,
        "stream_id": e.stream_id,
        "enrichment_json": dict(e.enrichment_json or {}),
        "override_policy": e.override_policy,
        "enabled": e.enabled,
        "created_at": _iso(e.created_at),
        "updated_at": _iso(e.updated_at),
    }


def _destination_dict(d: Destination) -> dict[str, Any]:
    return {
        "id": d.id,
        "name": d.name,
        "destination_type": d.destination_type,
        "config_json": mask_config_payload(dict(d.config_json or {}), mask_all_header_values=True),
        "rate_limit_json": dict(d.rate_limit_json or {}),
        "enabled": d.enabled,
        "created_at": _iso(d.created_at),
        "updated_at": _iso(d.updated_at),
    }


def _route_children_by_route(db: Session, route_ids: list[int]) -> dict[int, dict[str, Any]]:
    """Route-level processing state keyed by Route id (protection, classification, policy, transform).

    Children are embedded on each exported Route under optional keys that are only present when the Route
    has such rows, so bundles for Routes without children are unchanged and older bundles still import.
    Protection findings belong to the source Stream and are never exported. Route enrichment values are
    masked like other exported config because they are operator-entered static values.
    """
    out: dict[int, dict[str, Any]] = {}
    if not route_ids:
        return out

    def _slot(route_id: int) -> dict[str, Any]:
        return out.setdefault(int(route_id), {})

    for p in (
        db.query(RouteProtectionRule)
        .filter(RouteProtectionRule.route_id.in_(route_ids))
        .order_by(RouteProtectionRule.id.asc())
        .all()
    ):
        _slot(p.route_id).setdefault("protection_rules", []).append(
            {
                "field_path": p.field_path,
                "sensitivity_class": p.sensitivity_class,
                "protection_mode": p.protection_mode,
                "enabled": p.enabled,
                "created_by": p.created_by,
            }
        )
    for c in (
        db.query(RouteClassificationRule)
        .filter(RouteClassificationRule.route_id.in_(route_ids))
        .order_by(RouteClassificationRule.id.asc())
        .all()
    ):
        _slot(c.route_id).setdefault("classification_rules", []).append(
            {
                "name": c.name,
                "enabled": c.enabled,
                "condition_json": dict(c.condition_json or {}),
                "classification_level": c.classification_level,
            }
        )
    for pr in (
        db.query(RoutePolicyRule)
        .filter(RoutePolicyRule.route_id.in_(route_ids))
        .order_by(RoutePolicyRule.id.asc())
        .all()
    ):
        _slot(pr.route_id).setdefault("policy_rules", []).append(
            {
                "name": pr.name,
                "enabled": pr.enabled,
                "condition_json": dict(pr.condition_json or {}),
                "action_type": pr.action_type,
            }
        )
    for rm in db.query(RouteMapping).filter(RouteMapping.route_id.in_(route_ids)).order_by(RouteMapping.id.asc()).all():
        _slot(rm.route_id)["route_mapping"] = {
            "field_mappings_json": dict(rm.field_mappings_json or {}),
            "raw_payload_mode": rm.raw_payload_mode,
        }
    for re_ in (
        db.query(RouteEnrichment).filter(RouteEnrichment.route_id.in_(route_ids)).order_by(RouteEnrichment.id.asc()).all()
    ):
        _slot(re_.route_id)["route_enrichment"] = {
            "enrichment_json": mask_secrets_and_pem(dict(re_.enrichment_json or {})),
            "override_policy": re_.override_policy,
            "enabled": re_.enabled,
        }
    return out


def _route_rows(db: Session, routes: list[Route]) -> list[dict[str, Any]]:
    dest_names = _destination_name_map(db, {int(r.destination_id) for r in routes})
    children = _route_children_by_route(db, [int(r.id) for r in routes])
    rows: list[dict[str, Any]] = []
    for r in routes:
        row = _route_dict(r, destination_name=dest_names.get(int(r.destination_id)))
        row.update(children.get(int(r.id), {}))
        rows.append(row)
    return rows


def _route_dict(r: Route, *, destination_name: str | None = None) -> dict[str, Any]:
    dest_id = int(r.destination_id)
    ref: dict[str, Any] = {"id": dest_id}
    if destination_name:
        ref["name"] = destination_name
    row: dict[str, Any] = {
        "id": r.id,
        "stream_id": r.stream_id,
        "destination_id": dest_id,
        "destination_ref": ref,
        "enabled": r.enabled,
        "failure_policy": r.failure_policy,
        "formatter_config_json": dict(r.formatter_config_json or {}),
        "rate_limit_json": dict(r.rate_limit_json or {}),
        "status": r.status,
        "disable_reason": r.disable_reason,
        "created_at": _iso(r.created_at),
        "updated_at": _iso(r.updated_at),
    }
    if destination_name:
        row["destination_name"] = destination_name
    return row


def _destination_name_map(db: Session, dest_ids: set[int]) -> dict[int, str]:
    if not dest_ids:
        return {}
    rows = db.query(Destination).filter(Destination.id.in_(dest_ids)).all()
    return {int(d.id): str(d.name) for d in rows}


def _checkpoint_dict(c: Checkpoint) -> dict[str, Any]:
    return {
        "id": c.id,
        "stream_id": c.stream_id,
        "checkpoint_type": c.checkpoint_type,
        "checkpoint_value_json": mask_secrets_and_pem(dict(c.checkpoint_value_json or {})),
        "updated_at": _iso(c.updated_at),
    }


def _base_bundle(*, export_kind: ExportKind, options: dict[str, Any]) -> dict[str, Any]:
    return {
        "version": 2,
        "export_kind": export_kind,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "export_options": options,
        "template_metadata": {},
        "connectors": [],
        "sources": [],
        "streams": [],
        "mappings": [],
        "enrichments": [],
        "destinations": [],
        "routes": [],
        "checkpoints": [],
    }


def build_workspace_export(
    db: Session,
    *,
    include_checkpoints: bool,
    include_destinations: bool,
) -> dict[str, Any]:
    payload = _base_bundle(
        export_kind="workspace",
        options={"include_checkpoints": include_checkpoints, "include_destinations": include_destinations},
    )
    payload["connectors"] = [_connector_dict(r) for r in db.query(Connector).order_by(Connector.id.asc()).all()]
    payload["sources"] = [_source_dict(r) for r in db.query(Source).order_by(Source.id.asc()).all()]
    payload["streams"] = [_stream_dict(r) for r in db.query(Stream).order_by(Stream.id.asc()).all()]
    payload["mappings"] = [_mapping_dict(r) for r in db.query(Mapping).order_by(Mapping.id.asc()).all()]
    payload["enrichments"] = [_enrichment_dict(r) for r in db.query(Enrichment).order_by(Enrichment.id.asc()).all()]
    if include_destinations:
        payload["destinations"] = [_destination_dict(r) for r in db.query(Destination).order_by(Destination.id.asc()).all()]
    routes = db.query(Route).order_by(Route.id.asc()).all()
    payload["routes"] = _route_rows(db, routes)
    if include_checkpoints:
        payload["checkpoints"] = [_checkpoint_dict(r) for r in db.query(Checkpoint).order_by(Checkpoint.id.asc()).all()]
    payload["export_integrity"] = build_export_integrity_report(payload)
    return payload


def build_connector_export(
    db: Session,
    connector_id: int,
    *,
    include_streams: bool,
    include_routes: bool,
    include_checkpoints: bool,
    include_destinations: bool,
) -> dict[str, Any]:
    c = db.get(Connector, connector_id)
    if c is None:
        return {}
    payload = _base_bundle(
        export_kind="connector",
        options={
            "connector_id": connector_id,
            "include_streams": include_streams,
            "include_routes": include_routes,
            "include_checkpoints": include_checkpoints,
            "include_destinations": include_destinations,
        },
    )
    payload["connectors"] = [_connector_dict(c)]
    sources = db.query(Source).filter(Source.connector_id == connector_id).order_by(Source.id.asc()).all()
    payload["sources"] = [_source_dict(s) for s in sources]
    if not include_streams:
        payload["export_integrity"] = build_export_integrity_report(payload)
        return payload
    streams = db.query(Stream).filter(Stream.connector_id == connector_id).order_by(Stream.id.asc()).all()
    stream_ids = [int(s.id) for s in streams]
    payload["streams"] = [_stream_dict(s) for s in streams]
    if stream_ids:
        payload["mappings"] = [
            _mapping_dict(m)
            for m in db.query(Mapping).filter(Mapping.stream_id.in_(stream_ids)).order_by(Mapping.id.asc()).all()
        ]
        payload["enrichments"] = [
            _enrichment_dict(e)
            for e in db.query(Enrichment).filter(Enrichment.stream_id.in_(stream_ids)).order_by(Enrichment.id.asc()).all()
        ]
        if include_checkpoints:
            payload["checkpoints"] = [
                _checkpoint_dict(x)
                for x in db.query(Checkpoint).filter(Checkpoint.stream_id.in_(stream_ids)).order_by(Checkpoint.id.asc()).all()
            ]
        if include_routes:
            routes = db.query(Route).filter(Route.stream_id.in_(stream_ids)).order_by(Route.id.asc()).all()
            payload["routes"] = _route_rows(db, routes)
            if include_destinations:
                dest_ids = {int(r.destination_id) for r in routes}
                if dest_ids:
                    dest_rows = (
                        db.query(Destination).filter(Destination.id.in_(dest_ids)).order_by(Destination.id.asc()).all()
                    )
                    payload["destinations"] = [_destination_dict(d) for d in dest_rows]
    payload["export_integrity"] = build_export_integrity_report(payload)
    return payload


def build_stream_export(
    db: Session,
    stream_id: int,
    *,
    include_routes: bool,
    include_checkpoints: bool,
    include_destinations: bool,
) -> dict[str, Any]:
    st = db.get(Stream, stream_id)
    if st is None:
        return {}
    conn = db.get(Connector, st.connector_id)
    src = db.get(Source, st.source_id)
    if conn is None or src is None:
        return {}
    payload = _base_bundle(
        export_kind="stream",
        options={
            "stream_id": stream_id,
            "include_routes": include_routes,
            "include_checkpoints": include_checkpoints,
            "include_destinations": include_destinations,
        },
    )
    payload["connectors"] = [_connector_dict(conn)]
    payload["sources"] = [_source_dict(src)]
    payload["streams"] = [_stream_dict(st)]
    m = db.query(Mapping).filter(Mapping.stream_id == stream_id).first()
    if m:
        payload["mappings"] = [_mapping_dict(m)]
    e = db.query(Enrichment).filter(Enrichment.stream_id == stream_id).first()
    if e:
        payload["enrichments"] = [_enrichment_dict(e)]
    if include_checkpoints:
        cp = db.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).first()
        if cp:
            payload["checkpoints"] = [_checkpoint_dict(cp)]
    if include_routes:
        routes = db.query(Route).filter(Route.stream_id == stream_id).order_by(Route.id.asc()).all()
        payload["routes"] = _route_rows(db, routes)
        if include_destinations and routes:
            dest_ids = {int(r.destination_id) for r in routes}
            dest_rows = db.query(Destination).filter(Destination.id.in_(dest_ids)).order_by(Destination.id.asc()).all()
            payload["destinations"] = [_destination_dict(d) for d in dest_rows]
    payload["export_integrity"] = build_export_integrity_report(payload)
    return payload


def canonical_bundle_json(bundle: dict[str, Any]) -> str:
    """Deterministic JSON for hashing (sorted keys)."""

    return json.dumps(bundle, sort_keys=True, separators=(",", ":"), default=str)
