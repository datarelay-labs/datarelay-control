"""Normalize raw harvested payloads into HarvestedIntegrationKnowledge (M29.6)."""

from __future__ import annotations

from typing import Any, Mapping

from app.connectors_registry.harvester.models import (
    AuthKnowledge,
    CheckpointKnowledge,
    ContentReuseClass,
    EvidenceRef,
    HarvestedIntegrationKnowledge,
    LicenseKnowledge,
    MappingStatus,
    PaginationKnowledge,
    ProvenanceKnowledge,
    RuntimeHints,
    SchemaFieldKnowledge,
    StreamKnowledge,
    SUPPORTED_DATA_RELAY_SOURCE_TYPES,
)


def _as_optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _evidence_list(raw: Any) -> list[EvidenceRef]:
    if not isinstance(raw, list):
        return []
    items: list[EvidenceRef] = []
    for entry in raw:
        if not isinstance(entry, Mapping):
            continue
        items.append(
            EvidenceRef(
                source_path=_as_optional_str(entry.get("source_path") or entry.get("path")),
                documentation_ref=_as_optional_str(
                    entry.get("documentation_ref") or entry.get("ref")
                ),
                notes=_as_optional_str(entry.get("notes")),
                confidence=_as_optional_str(entry.get("confidence")) or "low",
            )
        )
    return items


def _schema_fields(raw: Any) -> list[SchemaFieldKnowledge]:
    if not isinstance(raw, list):
        return []
    fields: list[SchemaFieldKnowledge] = []
    for entry in raw:
        if not isinstance(entry, Mapping):
            continue
        name = _as_optional_str(entry.get("name"))
        if not name:
            continue
        fields.append(
            SchemaFieldKnowledge(
                name=name,
                type_hint=_as_optional_str(entry.get("type") or entry.get("type_hint")),
                required=bool(entry["required"]) if "required" in entry else None,
                description=_as_optional_str(entry.get("description")),
            )
        )
    return fields


def _pagination(raw: Any) -> PaginationKnowledge | None:
    if not isinstance(raw, Mapping):
        return None
    style = _as_optional_str(raw.get("style") or raw.get("type"))
    param = _as_optional_str(raw.get("param_name") or raw.get("param"))
    if not style and not param:
        return None
    return PaginationKnowledge(
        style=style,
        param_name=param,
        evidence=_evidence_list(raw.get("evidence")),
    )


def _checkpoint(raw: Any) -> CheckpointKnowledge | None:
    if not isinstance(raw, Mapping):
        return None
    cursor = _as_optional_str(raw.get("cursor_field") or raw.get("replication_key"))
    time_field = _as_optional_str(raw.get("time_field"))
    id_field = _as_optional_str(raw.get("id_field"))
    if not cursor and not time_field and not id_field:
        return None
    return CheckpointKnowledge(
        cursor_field=cursor,
        time_field=time_field,
        id_field=id_field,
        evidence=_evidence_list(raw.get("evidence")),
    )


def _streams(raw: Any) -> list[StreamKnowledge]:
    if not isinstance(raw, list):
        return []
    streams: list[StreamKnowledge] = []
    for entry in raw:
        if not isinstance(entry, Mapping):
            continue
        name = _as_optional_str(entry.get("name") or entry.get("stream") or entry.get("id"))
        if not name:
            continue
        query = entry.get("query_parameters") or entry.get("query_params") or {}
        if not isinstance(query, dict):
            query = {}
        streams.append(
            StreamKnowledge(
                name=name,
                http_method=_as_optional_str(entry.get("http_method") or entry.get("method")),
                path=_as_optional_str(entry.get("path") or entry.get("endpoint")),
                query_parameters=dict(query),
                request_body_hint=entry.get("request_body_hint") or entry.get("body"),
                event_array_path_hint=_as_optional_str(entry.get("event_array_path")),
                pagination=_pagination(entry.get("pagination")),
                checkpoint=_checkpoint(entry.get("checkpoint") or entry.get("replication")),
                schema_fields=_schema_fields(entry.get("schema_fields") or entry.get("fields")),
                evidence=_evidence_list(entry.get("evidence")),
            )
        )
    return streams


def _auth(raw: Any) -> AuthKnowledge:
    if not isinstance(raw, Mapping):
        return AuthKnowledge()
    required = raw.get("required_fields") or raw.get("required") or []
    if not isinstance(required, list):
        required = []
    scopes = raw.get("scopes") or []
    if not isinstance(scopes, list):
        scopes = []
    return AuthKnowledge(
        auth_type=_as_optional_str(raw.get("auth_type") or raw.get("type")),
        api_base_url_hint=_as_optional_str(
            raw.get("api_base_url_hint") or raw.get("base_url") or raw.get("api_base_url")
        ),
        required_fields=[str(x).strip() for x in required if str(x).strip()],
        scopes=[str(x).strip() for x in scopes if str(x).strip()],
        evidence=_evidence_list(raw.get("evidence")),
    )


def _runtime(raw: Any) -> RuntimeHints:
    if not isinstance(raw, Mapping):
        return RuntimeHints()
    return RuntimeHints(
        rate_limit_max_requests=(
            int(raw["rate_limit_max_requests"])
            if raw.get("rate_limit_max_requests") is not None
            else None
        ),
        rate_limit_per_seconds=(
            int(raw["rate_limit_per_seconds"])
            if raw.get("rate_limit_per_seconds") is not None
            else None
        ),
        polling_interval_seconds=(
            int(raw["polling_interval_seconds"])
            if raw.get("polling_interval_seconds") is not None
            else None
        ),
        evidence=_evidence_list(raw.get("evidence")),
    )


def resolve_mapping_status(
    *,
    proposed_source_type: str | None,
    explicit_status: str | None = None,
    reason: str | None = None,
) -> tuple[MappingStatus, str | None, str | None]:
    """Resolve mapping status against supported Data Relay source capabilities."""

    if explicit_status:
        status_key = explicit_status.strip().upper()
        try:
            status = MappingStatus(status_key)
        except ValueError:
            status = MappingStatus.UNKNOWN
        if status == MappingStatus.MAPPED and proposed_source_type:
            st = proposed_source_type.strip().upper()
            if st not in SUPPORTED_DATA_RELAY_SOURCE_TYPES:
                return (
                    MappingStatus.UNSUPPORTED,
                    None,
                    reason
                    or f"proposed_source_type {st!r} is not a supported Data Relay source capability",
                )
            return status, st, reason
        return status, proposed_source_type, reason

    if not proposed_source_type:
        return (
            MappingStatus.UNSUPPORTED,
            None,
            reason or "no proposed_source_type; cannot generate executable Source Pack",
        )

    st = proposed_source_type.strip().upper()
    if st in SUPPORTED_DATA_RELAY_SOURCE_TYPES:
        return MappingStatus.MAPPED, st, reason
    return (
        MappingStatus.UNSUPPORTED,
        None,
        reason or f"unsupported Data Relay source_type mapping: {st!r}",
    )


def normalize_harvested_dict(
    raw: Mapping[str, Any],
    *,
    default_ecosystem: str,
    default_import_method: str | None = None,
) -> HarvestedIntegrationKnowledge:
    """Normalize a structured metadata dict into HarvestedIntegrationKnowledge."""

    identity = raw.get("identity") if isinstance(raw.get("identity"), Mapping) else {}
    provenance_raw = raw.get("provenance") if isinstance(raw.get("provenance"), Mapping) else {}
    license_raw = raw.get("license") if isinstance(raw.get("license"), Mapping) else {}
    if isinstance(raw.get("license"), str):
        license_raw = {"identifier": raw.get("license")}

    ecosystem = (
        _as_optional_str(identity.get("ecosystem"))  # type: ignore[union-attr]
        or _as_optional_str(provenance_raw.get("ecosystem"))  # type: ignore[union-attr]
        or _as_optional_str(raw.get("ecosystem"))
        or default_ecosystem
    )

    proposed = _as_optional_str(raw.get("proposed_source_type") or raw.get("source_type"))
    mapping_status, proposed_resolved, mapping_reason = resolve_mapping_status(
        proposed_source_type=proposed,
        explicit_status=_as_optional_str(raw.get("mapping_status")),
        reason=_as_optional_str(raw.get("mapping_reason")),
    )

    reuse_raw = _as_optional_str(raw.get("content_reuse")) or "KNOWLEDGE"
    try:
        content_reuse = ContentReuseClass(reuse_raw.upper())
    except ValueError:
        content_reuse = ContentReuseClass.KNOWLEDGE

    notes_raw = raw.get("notes") or []
    notes = [str(n) for n in notes_raw] if isinstance(notes_raw, list) else []

    return HarvestedIntegrationKnowledge(
        provenance=ProvenanceKnowledge(
            ecosystem=ecosystem.strip().lower(),
            upstream_project=_as_optional_str(
                identity.get("upstream_project")  # type: ignore[union-attr]
                or provenance_raw.get("upstream_project")  # type: ignore[union-attr]
                or raw.get("upstream_project")
            ),
            vendor=_as_optional_str(
                identity.get("vendor") or provenance_raw.get("vendor") or raw.get("vendor")  # type: ignore[union-attr]
            ),
            product=_as_optional_str(
                identity.get("product") or provenance_raw.get("product") or raw.get("product")  # type: ignore[union-attr]
            ),
            integration_name=_as_optional_str(
                identity.get("integration_name")  # type: ignore[union-attr]
                or identity.get("name")  # type: ignore[union-attr]
                or provenance_raw.get("integration_name")  # type: ignore[union-attr]
                or raw.get("integration_name")
                or raw.get("name")
            ),
            upstream_version=_as_optional_str(
                identity.get("upstream_version")  # type: ignore[union-attr]
                or provenance_raw.get("upstream_version")  # type: ignore[union-attr]
                or identity.get("version")  # type: ignore[union-attr]
                or raw.get("upstream_version")
            ),
            upstream_commit=_as_optional_str(
                identity.get("upstream_commit")  # type: ignore[union-attr]
                or provenance_raw.get("upstream_commit")  # type: ignore[union-attr]
                or raw.get("upstream_commit")
            ),
            upstream_path=_as_optional_str(
                identity.get("upstream_path")  # type: ignore[union-attr]
                or provenance_raw.get("upstream_path")  # type: ignore[union-attr]
                or raw.get("upstream_path")
            ),
            upstream_url=_as_optional_str(
                provenance_raw.get("upstream_url") or raw.get("upstream_url")  # type: ignore[union-attr]
            ),
            import_method=_as_optional_str(
                provenance_raw.get("import_method")  # type: ignore[union-attr]
                or raw.get("import_method")
                or default_import_method
            ),
            evidence=_evidence_list(provenance_raw.get("evidence") or raw.get("evidence")),  # type: ignore[union-attr]
        ),
        license=LicenseKnowledge(
            identifier=_as_optional_str(
                license_raw.get("identifier")  # type: ignore[union-attr]
                or license_raw.get("spdx")  # type: ignore[union-attr]
                or license_raw.get("name")  # type: ignore[union-attr]
            ),
            source=_as_optional_str(license_raw.get("source")),  # type: ignore[union-attr]
            notice_required=(
                bool(license_raw["notice_required"])  # type: ignore[index]
                if isinstance(license_raw, Mapping) and "notice_required" in license_raw
                else None
            ),
        ),
        auth=_auth(raw.get("auth") or raw.get("connection")),
        streams=_streams(raw.get("streams") or raw.get("endpoints")),
        runtime=_runtime(raw.get("runtime") or raw.get("runtime_hints")),
        proposed_source_type=proposed_resolved,
        mapping_status=mapping_status,
        mapping_reason=mapping_reason,
        content_reuse=content_reuse,
        notes=notes,
        raw_metadata=dict(raw),
    )
