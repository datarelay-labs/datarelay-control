"""Pydantic schemas for configuration export, import, and clone APIs."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

ExportKind = Literal["workspace", "connector", "stream"]
# Phase 1 contract (specs/015): additive + clone only. full_restore is retired.
ImportMode = Literal["additive", "clone"]
PreviewClassification = Literal["safe_create", "overwrite_candidate", "blocked"]
# E-124: explicit choice when an imported connector/destination name already exists.
NameConflictChoice = Literal["skip", "rename"]


class ConnectorExportQuery(BaseModel):
    """Query flags for connector JSON export."""

    include_streams: bool = Field(default=True, description="Include streams and dependent rows.")
    include_routes: bool = Field(default=True, description="Include routes when streams are included.")
    include_checkpoints: bool = Field(default=True, description="Include checkpoint rows when streams are included.")
    include_destinations: bool = Field(
        default=False,
        description="Embed referenced destinations (masked) for portability across environments.",
    )


class StreamExportQuery(BaseModel):
    """Query flags for stream JSON export."""

    include_routes: bool = Field(default=True)
    include_checkpoints: bool = Field(default=True)
    include_destinations: bool = Field(
        default=False,
        description="Embed destinations referenced by routes (masked).",
    )


class WorkspaceExportQuery(BaseModel):
    """Workspace snapshot export options."""

    include_checkpoints: bool = Field(default=True)
    include_destinations: bool = Field(default=True, description="Include all destinations (masked).")


class ImportPreviewRequest(BaseModel):
    bundle: dict[str, Any]
    # str (not Literal) so retired mode=full_restore can be rejected with FULL_RESTORE_RETIRED
    # instead of a generic schema 422 that could be mistaken for silent drop.
    mode: str = Field(default="additive", description="Import mode: additive or clone. full_restore is retired.")
    dry_run: bool = Field(
        default=True,
        description=(
            "When true, the server validates under a PostgreSQL SAVEPOINT and rolls back so preview "
            "cannot persist incidental writes."
        ),
    )


class PreviewEntityCounts(BaseModel):
    connectors: int = 0
    sources: int = 0
    streams: int = 0
    mappings: int = 0
    enrichments: int = 0
    destinations: int = 0
    routes: int = 0
    checkpoints: int = 0


class ImportPreviewConflict(BaseModel):
    code: str
    message: str
    details: dict[str, Any] | None = None


class ImportPreviewWarning(BaseModel):
    code: str
    message: str


class ImportClassificationSummary(BaseModel):
    safe_create: int = 0
    overwrite_candidate: int = 0
    blocked: int = 0


class ImportNameConflict(BaseModel):
    """An imported connector/destination whose final display name already exists (E-124)."""

    entity_type: Literal["connector", "destination"]
    name: str
    export_id: int | None = None
    existing_ids: list[int] = Field(default_factory=list)
    message: str = ""


class ImportPreviewFinding(BaseModel):
    classification: PreviewClassification
    entity_type: str
    code: str
    message: str
    details: dict[str, Any] | None = None


class ImportPreviewResponse(BaseModel):
    ok: bool
    export_kind: str | None = None
    counts: PreviewEntityCounts
    conflicts: list[ImportPreviewConflict] = Field(default_factory=list)
    warnings: list[ImportPreviewWarning] = Field(default_factory=list)
    unsupported_items: list[str] = Field(default_factory=list)
    findings: list[ImportPreviewFinding] = Field(default_factory=list)
    classification_summary: ImportClassificationSummary = Field(default_factory=ImportClassificationSummary)
    name_conflicts: list[ImportNameConflict] = Field(
        default_factory=list,
        description="Connectors/destinations whose name already exists; apply requires on_name_conflict.",
    )
    requires_name_conflict_choice: bool = Field(
        default=False, description="True when apply needs on_name_conflict because name_conflicts is not empty."
    )
    name_conflict_choices: list[str] = Field(default_factory=lambda: ["skip", "rename"])
    dry_run: bool = Field(default=True, description="Echo of the request dry_run flag.")
    preview_token: str = Field(
        description="SHA256 of canonical bundle JSON and mode; resend on apply for double confirmation.",
    )


class ImportApplyRequest(BaseModel):
    bundle: dict[str, Any]
    mode: str = Field(default="additive", description="Import mode: additive or clone. full_restore is retired.")
    confirm: bool = Field(default=False, description="Must be true to persist.")
    confirm_destructive: bool = Field(
        default=False,
        description=(
            "Ignored. Retained for client compatibility with retired mode=full_restore; "
            "destructive JSON restore is not supported."
        ),
    )
    preview_token: str = Field(
        default="",
        description="Integrity token from /import/preview (bundle+mode). Not an apply idempotency key.",
    )
    idempotency_key: str | None = Field(
        default=None,
        max_length=128,
        description=(
            "Durable apply operation identity. When set, a successfully completed apply with the "
            "same key returns the prior result and does not recreate objects. Distinct from preview_token."
        ),
    )
    clone_name_suffix: str = Field(default=" (copy)", max_length=64, description="Appended to connector/stream names when mode=clone.")
    on_name_conflict: NameConflictChoice | None = Field(
        default=None,
        description=(
            "Required when the preview lists name_conflicts. skip: do not create connectors/destinations whose "
            "name already exists (and nothing that depends on them). rename: create them under a new unique "
            "name ('<name> (2)'). Without it the apply is refused and nothing is written."
        ),
    )


class ImportApplyEntityIds(BaseModel):
    connector_ids: list[int] = Field(default_factory=list)
    source_ids: list[int] = Field(default_factory=list)
    stream_ids: list[int] = Field(default_factory=list)
    destination_ids: list[int] = Field(default_factory=list)


class ImportSecretReentry(BaseModel):
    """A created connector/destination whose secrets were masked in the bundle and must be re-entered."""

    entity_type: Literal["connector", "destination"]
    entity_id: int
    name: str
    source_type: str | None = None
    fields: list[str] = Field(default_factory=list)
    blocks_operation: bool = Field(
        default=False,
        description="True when the created entity cannot work until the listed secrets are re-entered.",
    )
    message: str = ""
    edit_path: str = ""


class ImportSkippedEntity(BaseModel):
    entity_type: Literal["connector", "destination", "route"]
    name: str
    export_id: int | None = None
    reason: Literal["NAME_EXISTS", "DESTINATION_SKIPPED"]
    existing_ids: list[int] = Field(default_factory=list)


class ImportRenamedEntity(BaseModel):
    entity_type: Literal["connector", "destination"]
    name: str
    new_name: str
    entity_id: int


class ImportApplyResponse(BaseModel):
    ok: bool
    created: ImportApplyEntityIds
    skipped: list[ImportSkippedEntity] = Field(default_factory=list)
    renamed: list[ImportRenamedEntity] = Field(default_factory=list)
    secrets_to_reenter: list[ImportSecretReentry] = Field(default_factory=list)
    redirect_path: str | None = None
    idempotency_key: str | None = Field(
        default=None,
        description="Echo of the request idempotency_key when apply idempotency was used.",
    )
    idempotent_replay: bool = Field(
        default=False,
        description="True when this response was replayed from a prior successful apply with the same key.",
    )


class CloneConnectorBody(BaseModel):
    name_suffix: str = Field(default=" (copy)", max_length=64)


class CloneStreamBody(BaseModel):
    name_suffix: str = Field(default=" (copy)", max_length=64)


class CloneResponse(BaseModel):
    connector_id: int
    stream_ids: list[int] = Field(default_factory=list)
    redirect_path: str


class CurlParseRequest(BaseModel):
    curl_command: str = Field(min_length=1, description="Raw curl command pasted by the operator.")
    connector_name: str | None = Field(default=None, max_length=256)


class CurlParseResponse(BaseModel):
    ok: bool
    draft: dict[str, Any] | None = None
    warnings: list[str] = Field(default_factory=list)
    parse_errors: list[str] = Field(default_factory=list)


class PostmanRequestSummary(BaseModel):
    item_id: str
    name: str
    folder_path: str = ""
    method: str = "GET"
    url_preview: str = ""


class PostmanParseRequest(BaseModel):
    collection: dict[str, Any] = Field(description="Postman Collection v2.x JSON object.")
    item_id: str | None = Field(
        default=None,
        description="When set, build a connector/stream draft for this request only.",
    )
    connector_name: str | None = Field(default=None, max_length=256)


class PostmanParseResponse(BaseModel):
    ok: bool
    items: list[PostmanRequestSummary] = Field(default_factory=list)
    draft: dict[str, Any] | None = None
    warnings: list[str] = Field(default_factory=list)
    parse_errors: list[str] = Field(default_factory=list)
