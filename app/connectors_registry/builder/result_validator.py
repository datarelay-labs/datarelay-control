"""Strict structured translation result validation (no free-form config)."""

from __future__ import annotations

from typing import Any, Mapping

from app.connectors_registry.builder.models import (
    UNKNOWN,
    Confidence,
    EvidenceSourceKind,
    EvidencedValue,
    OpenQuestion,
    StreamTranslation,
    StructuredTranslationResult,
    SUPPORTED_SOURCE_TYPES,
)

_CONFIDENCE = {c.value for c in Confidence}
_SOURCES = {s.value for s in EvidenceSourceKind}


class StructuredResultValidationError(ValueError):
    def __init__(self, message: str, *, issues: list[str] | None = None) -> None:
        self.issues = issues or [message]
        super().__init__(message)


def _parse_evidenced(raw: Any, *, field: str) -> EvidencedValue | None:
    if raw is None:
        return None
    if isinstance(raw, str):
        # Bare strings are rejected — free-form config not accepted.
        raise StructuredResultValidationError(
            f"{field} must be an evidenced object, not a bare string"
        )
    if not isinstance(raw, Mapping):
        raise StructuredResultValidationError(f"{field} must be an object")
    if "value" not in raw:
        raise StructuredResultValidationError(f"{field}.value is required")
    source_raw = str(raw.get("evidence_source") or EvidenceSourceKind.AI_INFERENCE.value)
    if source_raw not in _SOURCES:
        raise StructuredResultValidationError(
            f"{field}.evidence_source invalid: {source_raw!r}"
        )
    conf_raw = str(raw.get("confidence") or Confidence.UNKNOWN.value).upper()
    if conf_raw not in _CONFIDENCE:
        raise StructuredResultValidationError(f"{field}.confidence invalid: {conf_raw!r}")
    inferred = bool(raw.get("inferred", source_raw == EvidenceSourceKind.AI_INFERENCE.value))
    if inferred and conf_raw == Confidence.HIGH.value:
        raise StructuredResultValidationError(
            f"{field}: AI inference alone cannot be HIGH confidence"
        )
    return EvidencedValue(
        value=raw.get("value"),
        evidence_source=EvidenceSourceKind(source_raw),
        confidence=Confidence(conf_raw),
        inferred=inferred,
        source_ref=str(raw["source_ref"]) if raw.get("source_ref") is not None else None,
        notes=str(raw["notes"]) if raw.get("notes") is not None else None,
    )


def _parse_open_questions(raw: Any) -> list[OpenQuestion]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise StructuredResultValidationError("open_questions must be a list")
    out: list[OpenQuestion] = []
    for item in raw:
        if not isinstance(item, Mapping):
            raise StructuredResultValidationError("open_question entries must be objects")
        out.append(
            OpenQuestion(
                code=str(item.get("code") or "OPEN"),
                message=str(item.get("message") or ""),
                field=str(item["field"]) if item.get("field") is not None else None,
                severity=str(item.get("severity") or "warning"),
            )
        )
    return out


def parse_structured_translation(raw: Mapping[str, Any]) -> StructuredTranslationResult:
    """Parse and strictly validate provider output. Rejects free-form config."""

    if not isinstance(raw, Mapping):
        raise StructuredResultValidationError("translation result must be an object")

    # Reject free-form package blobs.
    forbidden_top = {"manifest", "files", "executable", "scripts", "code"}
    bad = forbidden_top & set(raw.keys())
    if bad:
        raise StructuredResultValidationError(
            f"free-form package keys not accepted: {sorted(bad)}"
        )

    identity = raw.get("identity") if isinstance(raw.get("identity"), Mapping) else {}
    auth = raw.get("auth") if isinstance(raw.get("auth"), Mapping) else {}

    streams_raw = raw.get("streams")
    if streams_raw is None:
        streams_raw = []
    if not isinstance(streams_raw, list):
        raise StructuredResultValidationError("streams must be a list")

    streams: list[StreamTranslation] = []
    issues: list[str] = []
    for idx, entry in enumerate(streams_raw):
        if not isinstance(entry, Mapping):
            issues.append(f"streams[{idx}] must be an object")
            continue
        name = str(entry.get("name") or "").strip()
        if not name:
            issues.append(f"streams[{idx}].name is required")
            continue
        source_type = entry.get("source_type")
        if source_type is not None:
            st = str(source_type).strip()
            if st and st != UNKNOWN and st not in SUPPORTED_SOURCE_TYPES:
                issues.append(f"streams[{idx}].source_type unsupported: {st!r}")
        try:
            method = _parse_evidenced(entry.get("method"), field=f"streams[{idx}].method")
            path = _parse_evidenced(entry.get("path"), field=f"streams[{idx}].path")
            event_array = _parse_evidenced(
                entry.get("event_array_path"), field=f"streams[{idx}].event_array_path"
            )
            checkpoint = _parse_evidenced(
                entry.get("checkpoint"), field=f"streams[{idx}].checkpoint"
            )
        except StructuredResultValidationError as exc:
            issues.extend(exc.issues)
            continue
        streams.append(
            StreamTranslation(
                name=name,
                source_type=str(source_type) if source_type is not None else None,
                method=method,
                path=path,
                params=dict(entry.get("params") or {})
                if isinstance(entry.get("params"), dict)
                else {},
                body_template=entry.get("body_template"),
                event_array_path=event_array,
                pagination=dict(entry["pagination"])
                if isinstance(entry.get("pagination"), dict)
                else entry.get("pagination"),
                checkpoint=checkpoint,
                mapping=dict(entry["mapping"])
                if isinstance(entry.get("mapping"), dict)
                else None,
                open_questions=_parse_open_questions(entry.get("open_questions")),
            )
        )

    if issues:
        raise StructuredResultValidationError(
            "; ".join(issues),
            issues=issues,
        )

    try:
        vendor = _parse_evidenced(identity.get("vendor"), field="identity.vendor")
        product = _parse_evidenced(identity.get("product"), field="identity.product")
        api_ver = _parse_evidenced(
            identity.get("api_family_version"), field="identity.api_family_version"
        )
        auth_type = _parse_evidenced(auth.get("auth_type"), field="auth.auth_type")
    except StructuredResultValidationError:
        raise

    required_fields = auth.get("required_fields") or []
    if not isinstance(required_fields, list):
        raise StructuredResultValidationError("auth.required_fields must be a list")
    scopes = auth.get("scopes") or []
    if not isinstance(scopes, list):
        raise StructuredResultValidationError("auth.scopes must be a list")

    runtime = raw.get("runtime_hints") if isinstance(raw.get("runtime_hints"), Mapping) else {}

    return StructuredTranslationResult(
        vendor=vendor,
        product=product,
        api_family_version=api_ver,
        auth_type=auth_type,
        auth_required_fields=[str(x) for x in required_fields],
        auth_scopes=[str(x) for x in scopes],
        streams=streams,
        runtime_hints=dict(runtime),
        open_questions=_parse_open_questions(raw.get("open_questions")),
        raw=dict(raw),
    )
