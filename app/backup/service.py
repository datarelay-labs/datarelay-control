"""Export, import apply, and clone orchestration (administrative DB writes only — not StreamRunner)."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.backup.export_builder import (
    build_connector_export,
    build_stream_export,
    build_workspace_export,
)
from app.backup.import_validator import ValidationOutcome, preview_token_for, validate_import_bundle
from app.backup.operational_purge import clear_operational_entities
from app.backup.schemas import (
    FullRestorePurgePreview,
    ImportApplyEntityIds,
    ImportApplyRequest,
    ImportApplyResponse,
    ImportClassificationSummary,
    ImportPreviewConflict,
    ImportPreviewFinding,
    ImportPreviewResponse,
    ImportPreviewWarning,
    PreviewEntityCounts,
)
from app.checkpoints.models import Checkpoint
from app.connectors.models import Connector
from app.destinations.models import Destination
from app.enrichments.models import Enrichment
from app.mappings.models import Mapping
from app.platform_admin.models import PlatformAuditEvent
from app.routes.models import Route
from app.sources.models import Source
from app.platform_admin import journal
from app.streams.models import Stream

_IMPORT_APPLY_OPERATION_ACTION = "IMPORT_APPLY_OPERATION"


def _strip_mask_placeholders(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _strip_mask_placeholders(v) for k, v in value.items() if v != "********"}
    if isinstance(value, list):
        return [_strip_mask_placeholders(v) for v in value if v != "********"]
    return value


def _normalize_idempotency_key(raw: str | None) -> str | None:
    if raw is None:
        return None
    key = str(raw).strip()
    if not key:
        return None
    if len(key) > 128:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error_code": "IMPORT_IDEMPOTENCY_KEY_INVALID",
                "message": "idempotency_key must be 1..128 characters.",
            },
        )
    return key


def _acquire_import_apply_idempotency_lock(db: Session, idempotency_key: str) -> None:
    """Serialize concurrent apply retries for the same operation key within a transaction."""

    bind = db.get_bind()
    dialect = getattr(getattr(bind, "dialect", None), "name", "") or ""
    if dialect != "postgresql":
        return
    lock_key = f"import_apply_idempotency:{idempotency_key}"
    db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:lock_key))"), {"lock_key": lock_key})


def _find_completed_import_apply(db: Session, idempotency_key: str) -> ImportApplyResponse | None:
    rows = (
        db.query(PlatformAuditEvent)
        .filter(PlatformAuditEvent.action == _IMPORT_APPLY_OPERATION_ACTION)
        .order_by(PlatformAuditEvent.id.desc())
        .limit(200)
        .all()
    )
    for row in rows:
        details = row.details_json if isinstance(row.details_json, dict) else {}
        if str(details.get("idempotency_key") or "") != idempotency_key:
            continue
        if str(details.get("status") or "") != "completed":
            continue
        response_payload = details.get("response")
        if not isinstance(response_payload, dict):
            continue
        try:
            replay = ImportApplyResponse.model_validate(response_payload)
        except Exception:
            continue
        return replay.model_copy(update={"idempotent_replay": True, "idempotency_key": idempotency_key})
    return None


def _record_import_apply_operation(
    db: Session,
    *,
    idempotency_key: str,
    mode: str,
    response: ImportApplyResponse,
) -> None:
    journal.record_audit_event(
        db,
        action=_IMPORT_APPLY_OPERATION_ACTION,
        actor_username="system",
        entity_type="IMPORT_APPLY",
        details={
            "idempotency_key": idempotency_key,
            "status": "completed",
            "mode": mode,
            "response": response.model_dump(mode="json"),
        },
    )


def preview_import(db: Session, bundle: dict[str, Any], mode: str, *, dry_run: bool = True) -> ImportPreviewResponse:
    if dry_run:
        nested = db.begin_nested()
        try:
            outcome = validate_import_bundle(db, bundle, mode=mode)
        finally:
            nested.rollback()
    else:
        outcome = validate_import_bundle(db, bundle, mode=mode)
    token = preview_token_for(bundle, mode)
    counts = PreviewEntityCounts(**{k: int(outcome.counts.get(k, 0)) for k in PreviewEntityCounts.model_fields})
    cs = outcome.classification_summary or {}
    classification = ImportClassificationSummary(
        safe_create=int(cs.get("safe_create", 0)),
        overwrite_candidate=int(cs.get("overwrite_candidate", 0)),
        blocked=int(cs.get("blocked", 0)),
    )
    finding_models: list[ImportPreviewFinding] = []
    for f in outcome.findings:
        if not isinstance(f, dict):
            continue
        cls = f.get("classification")
        if cls not in ("safe_create", "overwrite_candidate", "blocked"):
            continue
        finding_models.append(
            ImportPreviewFinding(
                classification=cls,
                entity_type=str(f.get("entity_type") or "unknown"),
                code=str(f.get("code") or "UNKNOWN"),
                message=str(f.get("message") or ""),
                details=f.get("details") if isinstance(f.get("details"), dict) else None,
            )
        )
    purge_preview = None
    if outcome.full_restore_purge:
        purge_preview = FullRestorePurgePreview(**outcome.full_restore_purge)

    return ImportPreviewResponse(
        ok=outcome.ok,
        export_kind=outcome.export_kind,
        counts=counts,
        conflicts=[
            ImportPreviewConflict(code=str(c["code"]), message=str(c["message"]), details=c.get("details"))
            for c in outcome.conflicts
        ],
        warnings=[ImportPreviewWarning(code=str(w["code"]), message=str(w["message"])) for w in outcome.warnings],
        unsupported_items=list(outcome.unsupported),
        findings=finding_models,
        classification_summary=classification,
        dry_run=dry_run,
        full_restore_purge=purge_preview,
        preview_token=token,
    )


def _assert_apply_allowed(db: Session, body: ImportApplyRequest) -> ValidationOutcome:
    outcome = validate_import_bundle(db, body.bundle, mode=body.mode)
    if not outcome.ok:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error_code": "IMPORT_VALIDATION_FAILED", "conflicts": outcome.conflicts},
        )
    expected = preview_token_for(body.bundle, body.mode)
    if not body.preview_token or body.preview_token != expected:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error_code": "IMPORT_PREVIEW_TOKEN_MISMATCH", "message": "Call /import/preview first and pass preview_token."},
        )
    if not body.confirm:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error_code": "IMPORT_CONFIRM_REQUIRED", "message": "Set confirm=true after reviewing preview."},
        )
    if body.mode == "full_restore" and not body.confirm_destructive:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error_code": "IMPORT_DESTRUCTIVE_CONFIRM_REQUIRED",
                "message": "Set confirm_destructive=true after acknowledging full restore will replace operational configuration.",
            },
        )
    if body.mode == "full_restore":
        from app.streams.runtime_eligibility import reconcile_and_list_active_streams_for_destructive_ops

        active = reconcile_and_list_active_streams_for_destructive_ops(db, limit=20)
        if active:
            names = [label for _sid, label in active]
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "error_code": "FULL_RESTORE_BLOCKED_STREAM_ACTIVE",
                    "message": "Stop all active streams (and wait for workers to exit) before applying a full restore.",
                    "running_streams": names,
                    "active_streams": names,
                },
            )
    return outcome


def apply_import(db: Session, body: ImportApplyRequest) -> ImportApplyResponse:
    idempotency_key = _normalize_idempotency_key(body.idempotency_key)
    if idempotency_key is not None:
        _acquire_import_apply_idempotency_lock(db, idempotency_key)
        prior = _find_completed_import_apply(db, idempotency_key)
        if prior is not None:
            return prior

    _assert_apply_allowed(db, body)
    bundle = deepcopy(body.bundle)
    mode = body.mode
    suffix = (body.clone_name_suffix or " (copy)") if mode == "clone" else ""
    preserve_runtime_state = mode == "full_restore"

    replaced_preview: FullRestorePurgePreview | None = None
    if mode == "full_restore":
        purge = clear_operational_entities(db)
        replaced_preview = FullRestorePurgePreview(**purge.as_dict())

    connectors = bundle.get("connectors") or []
    sources = bundle.get("sources") or []
    streams = bundle.get("streams") or []
    mappings = bundle.get("mappings") or []
    enrichments = bundle.get("enrichments") or []
    destinations = bundle.get("destinations") or []
    routes = bundle.get("routes") or []
    checkpoints = bundle.get("checkpoints") or []

    dest_old_to_new: dict[int, int] = {}
    for d in destinations:
        if not isinstance(d, dict):
            continue
        old_id = int(d["id"])
        row = Destination(
            name=str(d.get("name") or f"imported-destination-{old_id}"),
            destination_type=str(d.get("destination_type") or "WEBHOOK_POST"),
            config_json=_strip_mask_placeholders(dict(d.get("config_json") or {})),
            rate_limit_json=dict(d.get("rate_limit_json") or {}),
            enabled=bool(d.get("enabled", True)),
        )
        db.add(row)
        db.flush()
        dest_old_to_new[old_id] = int(row.id)

    conn_old_to_new: dict[int, int] = {}
    created_connectors: list[int] = []
    for c in connectors:
        if not isinstance(c, dict):
            continue
        old_id = int(c["id"])
        name = str(c.get("name") or "imported-connector")
        if suffix:
            name = name + suffix
        conn_status = str(c.get("status") or "STOPPED") if preserve_runtime_state else "STOPPED"
        row = Connector(
            name=name,
            product_group=c.get("product_group"),
            description=c.get("description"),
            status=conn_status,
        )
        db.add(row)
        db.flush()
        conn_old_to_new[old_id] = int(row.id)
        created_connectors.append(int(row.id))

    src_old_to_new: dict[int, int] = {}
    created_sources: list[int] = []
    for s in sources:
        if not isinstance(s, dict):
            continue
        old_id = int(s["id"])
        new_cid = conn_old_to_new.get(int(s.get("connector_id", -1)))
        if new_cid is None:
            continue
        auth_json = _strip_mask_placeholders(dict(s.get("auth_json") or {}))
        if not auth_json:
            auth_json = {"auth_type": "no_auth"}
        elif not auth_json.get("auth_type"):
            auth_json = {**auth_json, "auth_type": "no_auth"}
        row = Source(
            connector_id=new_cid,
            source_type=str(s.get("source_type") or "HTTP_API_POLLING"),
            config_json=_strip_mask_placeholders(dict(s.get("config_json") or {})),
            auth_json=auth_json,
            enabled=bool(s.get("enabled", True)) if preserve_runtime_state else False,
        )
        db.add(row)
        db.flush()
        src_old_to_new[old_id] = int(row.id)
        created_sources.append(int(row.id))

    stream_old_to_new: dict[int, int] = {}
    created_streams: list[int] = []
    for st in streams:
        if not isinstance(st, dict):
            continue
        old_id = int(st["id"])
        new_cid = conn_old_to_new.get(int(st.get("connector_id", -1)))
        new_sid = src_old_to_new.get(int(st.get("source_id", -1)))
        if new_cid is None or new_sid is None:
            continue
        name = str(st.get("name") or "imported-stream")
        if suffix:
            name = name + suffix
        stream_enabled = bool(st.get("enabled", True)) if preserve_runtime_state else False
        stream_status = str(st.get("status") or "STOPPED") if preserve_runtime_state else "STOPPED"
        row = Stream(
            connector_id=new_cid,
            source_id=new_sid,
            name=name,
            stream_type=str(st.get("stream_type") or "HTTP_API_POLLING"),
            config_json=_strip_mask_placeholders(dict(st.get("config_json") or {})),
            polling_interval=int(st.get("polling_interval") or 60),
            enabled=stream_enabled,
            status=stream_status,
            rate_limit_json=dict(st.get("rate_limit_json") or {}),
        )
        db.add(row)
        db.flush()
        stream_old_to_new[old_id] = int(row.id)
        created_streams.append(int(row.id))

    for m in mappings:
        if not isinstance(m, dict):
            continue
        new_sid = stream_old_to_new.get(int(m.get("stream_id", -1)))
        if new_sid is None:
            continue
        row = Mapping(
            stream_id=new_sid,
            event_array_path=m.get("event_array_path"),
            event_root_path=m.get("event_root_path"),
            field_mappings_json=dict(m.get("field_mappings_json") or {}),
            raw_payload_mode=m.get("raw_payload_mode"),
        )
        db.add(row)

    for e in enrichments:
        if not isinstance(e, dict):
            continue
        new_sid = stream_old_to_new.get(int(e.get("stream_id", -1)))
        if new_sid is None:
            continue
        row = Enrichment(
            stream_id=new_sid,
            enrichment_json=dict(e.get("enrichment_json") or {}),
            override_policy=str(e.get("override_policy") or "KEEP_EXISTING"),
            enabled=bool(e.get("enabled", True)),
        )
        db.add(row)

    if mode != "clone":
        for c in checkpoints:
            if not isinstance(c, dict):
                continue
            new_sid = stream_old_to_new.get(int(c.get("stream_id", -1)))
            if new_sid is None:
                continue
            row = Checkpoint(
                stream_id=new_sid,
                checkpoint_type=str(c.get("checkpoint_type") or "CUSTOM_FIELD"),
                checkpoint_value_json=dict(c.get("checkpoint_value_json") or {}),
            )
            db.add(row)

    created_dest_ids = list(dest_old_to_new.values())
    unresolved_route_destinations: list[dict[str, Any]] = []
    for r in routes:
        if not isinstance(r, dict):
            continue
        new_stream = stream_old_to_new.get(int(r.get("stream_id", -1)))
        if new_stream is None:
            continue
        old_dest = int(r.get("destination_id", -1))
        if old_dest not in dest_old_to_new:
            unresolved_route_destinations.append(
                {
                    "route_export_id": r.get("id"),
                    "destination_export_id": old_dest,
                    "stream_id": new_stream,
                }
            )
            continue
        new_dest = int(dest_old_to_new[old_dest])
        row = Route(
            stream_id=new_stream,
            destination_id=new_dest,
            enabled=bool(r.get("enabled", True)),
            failure_policy=str(r.get("failure_policy") or "LOG_AND_CONTINUE"),
            formatter_config_json=dict(r.get("formatter_config_json") or {}),
            rate_limit_json=dict(r.get("rate_limit_json") or {}),
            status=str(r.get("status") or "ENABLED"),
            disable_reason=r.get("disable_reason"),
        )
        db.add(row)

    if unresolved_route_destinations:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error_code": "IMPORT_ROUTE_DESTINATION_UNMAPPED",
                "message": (
                    "Import refused to bind routes to foreign destination IDs. "
                    "Every route destination_id must remap via destinations included in the bundle."
                ),
                "unresolved": unresolved_route_destinations[:20],
            },
        )

    audit_details: dict[str, Any] = {
        "mode": mode,
        "streams_created": len(created_streams),
        "connectors_created": len(created_connectors),
        "destinations_created": len(dest_old_to_new),
    }
    if replaced_preview is not None:
        audit_details["replaced"] = replaced_preview.model_dump()
    if idempotency_key is not None:
        audit_details["idempotency_key"] = idempotency_key
    journal.record_audit_event(
        db,
        action="FULL_RESTORE_APPLIED" if mode == "full_restore" else "IMPORT_APPLIED",
        actor_username="system",
        details=audit_details,
    )

    redirect_path = None
    if len(created_streams) == 1:
        redirect_path = f"/streams/{created_streams[0]}/runtime"
    elif len(created_connectors) == 1:
        redirect_path = f"/connectors/{created_connectors[0]}"

    response = ImportApplyResponse(
        ok=True,
        created=ImportApplyEntityIds(
            connector_ids=created_connectors,
            source_ids=created_sources,
            stream_ids=created_streams,
            destination_ids=created_dest_ids,
        ),
        replaced=replaced_preview,
        redirect_path=redirect_path,
        idempotency_key=idempotency_key,
        idempotent_replay=False,
    )
    if idempotency_key is not None:
        _record_import_apply_operation(
            db,
            idempotency_key=idempotency_key,
            mode=mode,
            response=response.model_copy(update={"idempotent_replay": False}),
        )
    db.commit()
    return response


def clone_connector(db: Session, connector_id: int, name_suffix: str) -> tuple[int, list[int], str]:
    bundle = build_connector_export(
        db,
        connector_id,
        include_streams=True,
        include_routes=True,
        include_checkpoints=False,
        include_destinations=False,
    )
    if not bundle.get("connectors"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"error_code": "CONNECTOR_NOT_FOUND", "message": str(connector_id)})
    body = ImportApplyRequest(
        bundle=bundle,
        mode="clone",
        confirm=True,
        preview_token=preview_token_for(bundle, "clone"),
        clone_name_suffix=name_suffix,
    )
    res = apply_import(db, body)
    cid = res.created.connector_ids[0]
    sids = list(res.created.stream_ids)
    path = res.redirect_path or f"/connectors/{cid}"
    return cid, sids, path


def clone_stream(db: Session, stream_id: int, name_suffix: str) -> int:
    st = db.get(Stream, stream_id)
    if st is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"error_code": "STREAM_NOT_FOUND", "message": str(stream_id)})

    name = str(st.name or "stream") + name_suffix
    new_stream = Stream(
        connector_id=st.connector_id,
        source_id=st.source_id,
        name=name,
        stream_type=st.stream_type,
        config_json=deepcopy(st.config_json or {}),
        polling_interval=int(st.polling_interval or 60),
        enabled=False,
        status="STOPPED",
        rate_limit_json=deepcopy(st.rate_limit_json or {}),
    )
    db.add(new_stream)
    db.flush()
    new_id = int(new_stream.id)

    m = db.query(Mapping).filter(Mapping.stream_id == stream_id).first()
    if m:
        db.add(
            Mapping(
                stream_id=new_id,
                event_array_path=m.event_array_path,
                event_root_path=m.event_root_path,
                field_mappings_json=deepcopy(m.field_mappings_json or {}),
                raw_payload_mode=m.raw_payload_mode,
            )
        )
    e = db.query(Enrichment).filter(Enrichment.stream_id == stream_id).first()
    if e:
        db.add(
            Enrichment(
                stream_id=new_id,
                enrichment_json=deepcopy(e.enrichment_json or {}),
                override_policy=e.override_policy,
                enabled=e.enabled,
            )
        )
    for r in db.query(Route).filter(Route.stream_id == stream_id).all():
        db.add(
            Route(
                stream_id=new_id,
                destination_id=int(r.destination_id),
                enabled=r.enabled,
                failure_policy=r.failure_policy,
                formatter_config_json=deepcopy(r.formatter_config_json or {}),
                rate_limit_json=deepcopy(r.rate_limit_json or {}),
                status=r.status,
                disable_reason=r.disable_reason,
            )
        )
    db.commit()
    return new_id


def export_workspace_bundle(
    db: Session,
    *,
    include_checkpoints: bool,
    include_destinations: bool,
) -> dict[str, Any]:
    return build_workspace_export(db, include_checkpoints=include_checkpoints, include_destinations=include_destinations)


def export_connector_bundle(
    db: Session,
    connector_id: int,
    *,
    include_streams: bool,
    include_routes: bool,
    include_checkpoints: bool,
    include_destinations: bool,
) -> dict[str, Any]:
    return build_connector_export(
        db,
        connector_id,
        include_streams=include_streams,
        include_routes=include_routes,
        include_checkpoints=include_checkpoints,
        include_destinations=include_destinations,
    )


def export_stream_bundle(
    db: Session,
    stream_id: int,
    *,
    include_routes: bool,
    include_checkpoints: bool,
    include_destinations: bool,
) -> dict[str, Any]:
    return build_stream_export(
        db,
        stream_id,
        include_routes=include_routes,
        include_checkpoints=include_checkpoints,
        include_destinations=include_destinations,
    )
