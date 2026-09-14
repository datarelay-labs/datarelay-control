"""HTTP routes for configuration export, import preview/apply, and clone."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.backup.curl_parser import build_curl_import_draft, parse_curl_command
from app.backup.postman_parser import build_postman_import_draft, parse_postman_collection
from app.backup.schemas import (
    CloneConnectorBody,
    CloneResponse,
    CloneStreamBody,
    ConnectorExportQuery,
    CurlParseRequest,
    CurlParseResponse,
    ImportApplyRequest,
    ImportApplyResponse,
    ImportPreviewRequest,
    ImportPreviewResponse,
    PostmanParseRequest,
    PostmanParseResponse,
    PostmanRequestSummary,
    StreamExportQuery,
    WorkspaceExportQuery,
)
from app.backup.service import (
    apply_import,
    clone_connector,
    clone_stream,
    export_connector_bundle,
    export_stream_bundle,
    export_workspace_bundle,
    preview_import,
)
from app.database import get_db
from app.platform_admin import journal
from app.streams.models import Stream

router = APIRouter()


def _audit_export(
    db: Session,
    request: Request,
    *,
    action: str,
    entity_type: str,
    entity_id: int | None,
    details: dict[str, Any] | None = None,
) -> None:
    journal.record_audit_event(
        db,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        details=details or {},
        request=request,
    )
    db.commit()


def _json_attachment(data: dict[str, Any], filename: str) -> JSONResponse:
    return JSONResponse(
        content=data,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/connectors/{connector_id}/export", response_model=None)
def export_connector(
    connector_id: int,
    request: Request,
    db: Session = Depends(get_db),
    include_streams: bool = Query(True),
    include_routes: bool = Query(True),
    include_checkpoints: bool = Query(True),
    include_destinations: bool = Query(False),
) -> JSONResponse:
    q = ConnectorExportQuery(
        include_streams=include_streams,
        include_routes=include_routes,
        include_checkpoints=include_checkpoints,
        include_destinations=include_destinations,
    )
    bundle = export_connector_bundle(
        db,
        connector_id,
        include_streams=q.include_streams,
        include_routes=q.include_routes,
        include_checkpoints=q.include_checkpoints,
        include_destinations=q.include_destinations,
    )
    if not bundle.get("connectors"):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error_code": "CONNECTOR_NOT_FOUND", "message": str(connector_id)},
        )
    _audit_export(
        db,
        request,
        action="BACKUP_EXPORT_CONNECTOR",
        entity_type="CONNECTOR",
        entity_id=int(connector_id),
        details={"include_streams": q.include_streams, "include_routes": q.include_routes},
    )
    return _json_attachment(bundle, f"gdc-connector-{connector_id}-export.json")


@router.get("/streams/{stream_id}/export", response_model=None)
def export_stream(
    stream_id: int,
    request: Request,
    db: Session = Depends(get_db),
    include_routes: bool = Query(True),
    include_checkpoints: bool = Query(True),
    include_destinations: bool = Query(False),
) -> JSONResponse:
    q = StreamExportQuery(
        include_routes=include_routes,
        include_checkpoints=include_checkpoints,
        include_destinations=include_destinations,
    )
    bundle = export_stream_bundle(
        db,
        stream_id,
        include_routes=q.include_routes,
        include_checkpoints=q.include_checkpoints,
        include_destinations=q.include_destinations,
    )
    if not bundle.get("streams"):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error_code": "STREAM_NOT_FOUND", "message": str(stream_id)},
        )
    _audit_export(
        db,
        request,
        action="BACKUP_EXPORT_STREAM",
        entity_type="STREAM",
        entity_id=int(stream_id),
        details={"include_routes": q.include_routes},
    )
    return _json_attachment(bundle, f"gdc-stream-{stream_id}-export.json")


@router.get("/workspace/export", response_model=None)
def export_workspace(
    request: Request,
    db: Session = Depends(get_db),
    include_checkpoints: bool = Query(True),
    include_destinations: bool = Query(True),
) -> JSONResponse:
    q = WorkspaceExportQuery(include_checkpoints=include_checkpoints, include_destinations=include_destinations)
    bundle = export_workspace_bundle(
        db,
        include_checkpoints=q.include_checkpoints,
        include_destinations=q.include_destinations,
    )
    _audit_export(
        db,
        request,
        action="BACKUP_EXPORT_WORKSPACE",
        entity_type="WORKSPACE",
        entity_id=None,
        details={"include_checkpoints": q.include_checkpoints, "include_destinations": q.include_destinations},
    )
    return _json_attachment(bundle, "gdc-workspace-export.json")


@router.post("/curl/parse", response_model=CurlParseResponse)
def parse_curl_import(body: CurlParseRequest, request: Request, db: Session = Depends(get_db)) -> CurlParseResponse:
    parsed = parse_curl_command(body.curl_command)
    if parsed.parse_errors:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error_code": "CURL_PARSE_FAILED", "parse_errors": parsed.parse_errors, "warnings": parsed.warnings},
        )
    draft = build_curl_import_draft(parsed, connector_name=body.connector_name)
    journal.record_audit_event(
        db,
        action="CURL_IMPORT_PARSED",
        entity_type="CONNECTOR",
        entity_id=None,
        details={"connector_name": body.connector_name, "warning_count": len(parsed.warnings)},
        request=request,
    )
    db.commit()
    return CurlParseResponse(
        ok=True,
        draft=draft,
        warnings=[*parsed.warnings, *draft.get("warnings", [])],
        parse_errors=[],
    )


@router.post("/postman/parse", response_model=PostmanParseResponse)
def parse_postman_import(body: PostmanParseRequest, request: Request, db: Session = Depends(get_db)) -> PostmanParseResponse:
    parsed = parse_postman_collection(body.collection)
    if parsed.parse_errors:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error_code": "POSTMAN_PARSE_FAILED",
                "parse_errors": parsed.parse_errors,
                "warnings": parsed.warnings,
            },
        )
    items = [
        PostmanRequestSummary(
            item_id=i.item_id,
            name=i.name,
            folder_path=i.folder_path,
            method=i.method,
            url_preview=i.url_preview,
        )
        for i in parsed.items
    ]
    draft: dict[str, Any] | None = None
    warnings = list(parsed.warnings)
    if body.item_id:
        draft, draft_warnings, draft_errors = build_postman_import_draft(
            body.collection,
            item_id=body.item_id,
            connector_name=body.connector_name,
        )
        warnings.extend(draft_warnings)
        if draft_errors:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={
                    "error_code": "POSTMAN_PARSE_FAILED",
                    "parse_errors": draft_errors,
                    "warnings": warnings,
                },
            )
        journal.record_audit_event(
            db,
            action="POSTMAN_IMPORT_PARSED",
            entity_type="CONNECTOR",
            entity_id=None,
            details={"item_id": body.item_id, "connector_name": body.connector_name, "warning_count": len(warnings)},
            request=request,
        )
        db.commit()
    return PostmanParseResponse(ok=True, items=items, draft=draft, warnings=warnings, parse_errors=[])


@router.post("/import/preview", response_model=ImportPreviewResponse)
def import_preview(body: ImportPreviewRequest, db: Session = Depends(get_db)) -> ImportPreviewResponse:
    return preview_import(db, body.bundle, body.mode, dry_run=body.dry_run)


@router.post("/import/apply", response_model=ImportApplyResponse)
def import_apply(
    body: ImportApplyRequest, request: Request, db: Session = Depends(get_db)
) -> ImportApplyResponse:
    try:
        return apply_import(db, body, request=request)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error_code": "IMPORT_APPLY_FAILED", "message": str(exc)},
        ) from exc


@router.post("/connectors/{connector_id}/clone", response_model=CloneResponse)
def post_clone_connector(
    connector_id: int,
    body: CloneConnectorBody = Body(default_factory=CloneConnectorBody),
    db: Session = Depends(get_db),
) -> CloneResponse:
    suffix = body.name_suffix or " (copy)"
    cid, sids, path = clone_connector(db, connector_id, name_suffix=suffix)
    return CloneResponse(connector_id=cid, stream_ids=sids, redirect_path=path)


@router.post("/streams/{stream_id}/clone", response_model=CloneResponse)
def post_clone_stream(
    stream_id: int,
    body: CloneStreamBody = Body(default_factory=CloneStreamBody),
    db: Session = Depends(get_db),
) -> CloneResponse:
    suffix = body.name_suffix or " (copy)"
    new_id = clone_stream(db, stream_id, name_suffix=suffix)
    st = db.get(Stream, new_id)
    cid = int(st.connector_id) if st else 0
    return CloneResponse(connector_id=cid, stream_ids=[new_id], redirect_path=f"/streams/{new_id}/runtime")
