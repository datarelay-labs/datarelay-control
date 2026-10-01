"""Evidence normalization, priority reconciliation, and OpenAPI/script helpers."""

from __future__ import annotations

import json
import re
from typing import Any, Mapping

from app.connectors_registry.builder.models import (
    EVIDENCE_PRIORITY_RANK,
    UNKNOWN,
    BoundedProviderRequest,
    BuilderRequest,
    Confidence,
    DocumentationEvidence,
    EvidenceConflict,
    EvidenceSourceKind,
    EvidencedValue,
    OpenApiSummary,
    OpenQuestion,
    ScriptClues,
)
from app.connectors_registry.harvester.models import HarvestedIntegrationKnowledge
from app.connectors_registry.package_secret_scan import (
    _BEARER_INLINE,
    _LITERAL_TOKENISH,
    _PEM_PRIVATE_KEY,
    _SECRET_KEY_PATTERN,
    _is_placeholder,
    _looks_like_literal_secret,
)

_REDACTED = "***REDACTED***"

_ENDPOINT_RE = re.compile(
    r"""(?ix)
    (?:https?://[^\s'\"<>]+)|
    (?:['\"](/(?:v\d+/)?[A-Za-z0-9_./{}%-]+)['\"])|
    (?:(?:url|endpoint|path)\s*=\s*['\"]([^'\"]+)['\"])
    """
)
_METHOD_RE = re.compile(
    r"""(?ix)\b(?:method\s*=\s*['\"]?(GET|POST|PUT|PATCH|DELETE)['\"]?
    |requests\.(get|post|put|patch|delete)
    |\.(get|post|put|patch|delete)\s*\()"""
)
_HEADER_RE = re.compile(
    r"""(?ix)(?:headers?\s*[\[=]\s*\{[^}]*['\"]([A-Za-z0-9_-]+)['\"]
    |['\"]([A-Za-z0-9_-]+)['\"]\s*:\s*['\"][^'\"]*['\"])"""
)
_PAGINATION_HINT_RE = re.compile(
    r"(?i)\b(cursor|next_page|page_token|offset|limit|continuation|next_link|page_size)\b"
)
_CHECKPOINT_HINT_RE = re.compile(
    r"(?i)\b(updated_at|created_at|since|watermark|replication_key|checkpoint|cursor_field)\b"
)
_RESPONSE_PATH_HINT_RE = re.compile(
    r"""(?ix)(?:\[['\"]?(data|items|results|events|records)['\"]?\]
    |\.(?:data|items|results|events|records)\b
    |\$\.(?:data|items|results|events|records))"""
)
_AUTH_HINT_RE = re.compile(
    r"(?i)\b(Authorization|Bearer|api[_-]?key|X-Api-Key|Basic\s+|oauth2?)\b"
)


def redact_secrets_in_text(text: str) -> tuple[str, int]:
    """Redact likely secret literals from free text. Returns (redacted, count)."""

    if not text:
        return text, 0
    count = 0
    out = text

    def _sub_pem(match: re.Match[str]) -> str:
        nonlocal count
        count += 1
        return _REDACTED

    out, n = _PEM_PRIVATE_KEY.subn(_REDACTED, out)
    count += n

    def _bearer_sub(match: re.Match[str]) -> str:
        nonlocal count
        token = match.group(1)
        if _is_placeholder(token):
            return match.group(0)
        count += 1
        return match.group(0).replace(token, _REDACTED)

    out = _BEARER_INLINE.sub(_bearer_sub, out)

    lines: list[str] = []
    for line in out.splitlines():
        kv = re.match(
            r"(?i)^(\s*(?:['\"]?)([A-Za-z0-9_.-]+)(?:['\"]?)\s*[:=]\s*)(.+?)(\s*)$",
            line,
        )
        if kv:
            prefix, key, raw_val, suffix = kv.group(1), kv.group(2), kv.group(3), kv.group(4)
            val = raw_val.strip().strip(",").strip("'\"")
            if _SECRET_KEY_PATTERN.match(key) and _looks_like_literal_secret(
                val, field_context=True
            ):
                count += 1
                quote = "'" if "'" in raw_val else ('"' if '"' in raw_val else "")
                lines.append(f"{prefix}{quote}{_REDACTED}{quote}{suffix}")
                continue
            if _LITERAL_TOKENISH.match(val) and not _is_placeholder(val):
                count += 1
                quote = "'" if "'" in raw_val else ('"' if '"' in raw_val else "")
                lines.append(f"{prefix}{quote}{_REDACTED}{quote}{suffix}")
                continue
        lines.append(line)
    return "\n".join(lines), count


def redact_secrets_in_value(value: Any) -> tuple[Any, int]:
    """Recursively redact secret-like values before provider-facing serialization."""

    if isinstance(value, Mapping):
        out: dict[str, Any] = {}
        count = 0
        for raw_key, item in value.items():
            key = str(raw_key)
            if key.strip().lower() == "secret" and isinstance(item, bool):
                out[key] = item
                continue
            if (
                _SECRET_KEY_PATTERN.match(key.strip())
                and isinstance(item, (str, int, float, bool))
                and _looks_like_literal_secret(str(item), field_context=True)
            ):
                out[key] = _REDACTED
                count += 1
                continue
            redacted, nested_count = redact_secrets_in_value(item)
            out[key] = redacted
            count += nested_count
        return out, count

    if isinstance(value, list):
        out_list: list[Any] = []
        count = 0
        for item in value:
            redacted, nested_count = redact_secrets_in_value(item)
            out_list.append(redacted)
            count += nested_count
        return out_list, count

    if isinstance(value, str):
        return redact_secrets_in_text(value)

    return value, 0


def extract_openapi_summary(document: Mapping[str, Any]) -> OpenApiSummary:
    """Deterministically extract OpenAPI facts before AI interpretation."""

    servers: list[str] = []
    raw_servers = document.get("servers")
    if isinstance(raw_servers, list):
        for entry in raw_servers:
            if isinstance(entry, dict) and isinstance(entry.get("url"), str):
                servers.append(entry["url"].strip())
            elif isinstance(entry, str):
                servers.append(entry.strip())

    # Swagger 2.0 host/basePath/schemes
    host = document.get("host")
    base_path = document.get("basePath") or ""
    schemes = document.get("schemes") or ["https"]
    if isinstance(host, str) and host.strip():
        scheme = schemes[0] if isinstance(schemes, list) and schemes else "https"
        servers.append(f"{scheme}://{host.strip()}{base_path}")

    base_url = servers[0] if servers else None

    paths: list[dict[str, Any]] = []
    raw_paths = document.get("paths")
    if isinstance(raw_paths, dict):
        for path_key, path_item in raw_paths.items():
            if not isinstance(path_item, dict):
                continue
            for method, operation in path_item.items():
                method_u = str(method).upper()
                if method_u not in {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}:
                    continue
                op = operation if isinstance(operation, dict) else {}
                params = op.get("parameters") if isinstance(op.get("parameters"), list) else []
                paths.append(
                    {
                        "path": str(path_key),
                        "method": method_u,
                        "operation_id": op.get("operationId"),
                        "summary": op.get("summary"),
                        "parameters": [
                            {
                                "name": p.get("name"),
                                "in": p.get("in"),
                                "required": p.get("required"),
                            }
                            for p in params
                            if isinstance(p, dict)
                        ],
                        "request_body": bool(op.get("requestBody")),
                        "responses": sorted(
                            str(k) for k in (op.get("responses") or {}).keys()
                        )
                        if isinstance(op.get("responses"), dict)
                        else [],
                    }
                )

    security_schemes: list[dict[str, Any]] = []
    auth_hints: list[str] = []
    components = document.get("components")
    schemes_map: Any = None
    if isinstance(components, dict):
        schemes_map = components.get("securitySchemes")
    if schemes_map is None:
        schemes_map = document.get("securityDefinitions")
    if isinstance(schemes_map, dict):
        for name, scheme in schemes_map.items():
            if not isinstance(scheme, dict):
                continue
            entry = {
                "name": name,
                "type": scheme.get("type"),
                "scheme": scheme.get("scheme"),
                "in": scheme.get("in"),
                "flows": list((scheme.get("flows") or {}).keys())
                if isinstance(scheme.get("flows"), dict)
                else None,
            }
            security_schemes.append({k: v for k, v in entry.items() if v is not None})
            hint = str(scheme.get("type") or name).lower()
            if hint:
                auth_hints.append(hint)

    info = document.get("info") if isinstance(document.get("info"), dict) else {}
    return OpenApiSummary(
        servers=servers,
        base_url=base_url,
        paths=paths,
        security_schemes=security_schemes,
        auth_hints=sorted(set(auth_hints)),
        raw_info={
            "title": info.get("title"),
            "version": info.get("version"),
            "openapi": document.get("openapi") or document.get("swagger"),
        },
    )


def inspect_script_text(text: str) -> tuple[str, ScriptClues]:
    """Statically inspect script text. Never execute / import / subprocess."""

    redacted, redaction_count = redact_secrets_in_text(text)
    endpoints: list[str] = []
    for match in _ENDPOINT_RE.finditer(redacted):
        for group in match.groups():
            if group and group.startswith("/"):
                endpoints.append(group)
        full = match.group(0)
        if full.startswith("http"):
            endpoints.append(full.strip("'\""))
    methods = sorted(
        {
            (m.group(1) or m.group(2) or m.group(3) or "").upper()
            for m in _METHOD_RE.finditer(redacted)
            if (m.group(1) or m.group(2) or m.group(3))
        }
    )
    headers: list[str] = []
    for m in _HEADER_RE.finditer(redacted):
        for g in m.groups():
            if g:
                headers.append(g)
    clues = ScriptClues(
        endpoints=sorted(set(endpoints)),
        methods=methods,
        header_names=sorted(set(headers)),
        auth_shape_hints=sorted({m.group(0) for m in _AUTH_HINT_RE.finditer(redacted)}),
        pagination_hints=sorted({m.group(1).lower() for m in _PAGINATION_HINT_RE.finditer(redacted)}),
        checkpoint_hints=sorted({m.group(1).lower() for m in _CHECKPOINT_HINT_RE.finditer(redacted)}),
        response_path_hints=sorted(
            {m.group(1).lower() for m in _RESPONSE_PATH_HINT_RE.finditer(redacted) if m.group(1)}
        ),
        secrets_redacted=redaction_count > 0,
        redaction_count=redaction_count,
    )
    return redacted, clues


def harvested_to_dict(knowledge: HarvestedIntegrationKnowledge) -> dict[str, Any]:
    """Serialize harvested knowledge for bounded provider input (no secrets)."""

    return {
        "vendor": knowledge.provenance.vendor,
        "product": knowledge.provenance.product,
        "integration_name": knowledge.provenance.integration_name,
        "ecosystem": knowledge.provenance.ecosystem,
        "upstream_version": knowledge.provenance.upstream_version,
        "license": knowledge.license.identifier,
        "proposed_source_type": knowledge.proposed_source_type,
        "mapping_status": knowledge.mapping_status.value,
        "auth": {
            "auth_type": knowledge.auth.auth_type,
            "api_base_url_hint": knowledge.auth.api_base_url_hint,
            "required_fields": list(knowledge.auth.required_fields),
            "scopes": list(knowledge.auth.scopes),
        },
        "streams": [
            {
                "name": s.name,
                "http_method": s.http_method,
                "path": s.path,
                "query_parameters": dict(s.query_parameters),
                "event_array_path_hint": s.event_array_path_hint,
                "pagination": (
                    {"style": s.pagination.style, "param_name": s.pagination.param_name}
                    if s.pagination
                    else None
                ),
                "checkpoint": (
                    {
                        "cursor_field": s.checkpoint.cursor_field,
                        "time_field": s.checkpoint.time_field,
                        "id_field": s.checkpoint.id_field,
                    }
                    if s.checkpoint
                    else None
                ),
            }
            for s in knowledge.streams
        ],
        "runtime": {
            "rate_limit_max_requests": knowledge.runtime.rate_limit_max_requests,
            "rate_limit_per_seconds": knowledge.runtime.rate_limit_per_seconds,
            "polling_interval_seconds": knowledge.runtime.polling_interval_seconds,
        },
        "notes": list(knowledge.notes),
    }


def truncate(text: str | None, limit: int) -> str | None:
    if text is None:
        return None
    if len(text) <= limit:
        return text
    return text[:limit] + "\n…[truncated]"


def collect_known_endpoints(request: BuilderRequest, openapi: OpenApiSummary | None, clues: ScriptClues | None) -> set[str]:
    """Union of endpoints supported by non-AI evidence."""

    known: set[str] = set()
    if openapi:
        for p in openapi.paths:
            path = p.get("path")
            if isinstance(path, str) and path.strip():
                known.add(path.strip())
    if request.harvested_knowledge:
        for stream in request.harvested_knowledge.streams:
            if stream.path:
                known.add(stream.path.strip())
    if clues:
        for ep in clues.endpoints:
            known.add(ep.strip())
    if request.documentation and request.documentation.structured:
        for key in ("endpoints", "paths"):
            raw = request.documentation.structured.get(key)
            if isinstance(raw, list):
                for item in raw:
                    if isinstance(item, str):
                        known.add(item.strip())
                    elif isinstance(item, dict) and isinstance(item.get("path"), str):
                        known.add(item["path"].strip())
    return {k for k in known if k}


def evidenced(
    value: Any,
    source: EvidenceSourceKind,
    confidence: Confidence,
    *,
    inferred: bool = False,
    source_ref: str | None = None,
    notes: str | None = None,
) -> EvidencedValue:
    return EvidencedValue(
        value=value,
        evidence_source=source,
        confidence=confidence,
        inferred=inferred,
        source_ref=source_ref,
        notes=notes,
    )


def pick_by_priority(
    candidates: list[EvidencedValue],
) -> tuple[EvidencedValue | None, EvidenceConflict | None]:
    """Select winning value by evidence priority; surface conflicts."""

    usable = [c for c in candidates if c.value not in (None, "", UNKNOWN)]
    if not usable:
        return None, None
    # Prefer higher priority (lower rank); among ties keep first.
    usable_sorted = sorted(
        usable,
        key=lambda c: (
            EVIDENCE_PRIORITY_RANK.get(c.evidence_source, 99),
            0 if not c.inferred else 1,
        ),
    )
    winner = usable_sorted[0]
    distinct = []
    seen_vals: set[str] = set()
    for c in usable_sorted:
        key = json.dumps(c.value, sort_keys=True, default=str)
        if key in seen_vals:
            continue
        seen_vals.add(key)
        distinct.append(c)
    conflict = None
    if len(distinct) > 1:
        conflict = EvidenceConflict(
            field="value",
            values=[c.to_dict() for c in distinct],
            winner=winner.to_dict(),
        )
    return winner, conflict


def reconcile_field(
    field_name: str,
    candidates: list[EvidencedValue],
    conflicts: list[EvidenceConflict],
    open_questions: list[OpenQuestion],
) -> EvidencedValue | None:
    winner, conflict = pick_by_priority(candidates)
    if conflict is not None:
        conflict.field = field_name
        conflicts.append(conflict)
        open_questions.append(
            OpenQuestion(
                code="EVIDENCE_CONFLICT",
                message=f"Conflicting evidence for {field_name}; using higher-priority source",
                field=field_name,
                severity="warning",
            )
        )
    return winner


def sample_path_resolves(sample: Any, path: str | None) -> bool:
    """Validate a JSONPath-like / dotted path against sample JSON."""

    if not path or path in (UNKNOWN, "$"):
        return path == "$"
    try:
        from app.parsers.jsonpath_parser import find_values

        values = find_values(sample, path)
        return len(values) > 0
    except Exception:
        # Fallback: simple dotted path without $.
        cur = sample
        cleaned = path[2:] if path.startswith("$.") else path.lstrip("$.")
        if not cleaned:
            return True
        for part in cleaned.split("."):
            if isinstance(cur, dict) and part in cur:
                cur = cur[part]
            else:
                return False
        return True


AUTH_CAPABILITIES = [
    "api_key",
    "bearer",
    "basic",
    "oauth2_client_credentials",
    "no_auth",
]


def build_bounded_provider_request(
    request: BuilderRequest,
    *,
    openapi_summary: OpenApiSummary | None,
    script_redacted: str | None,
    script_clues: ScriptClues | None,
    documentation_text: str | None,
) -> BoundedProviderRequest:
    harvested = (
        harvested_to_dict(request.harvested_knowledge)
        if request.harvested_knowledge is not None
        else None
    )
    sample_payload = None
    if request.sample is not None:
        sample_payload, _ = redact_secrets_in_value(request.sample.payload)

    script_ref = None
    if script_redacted is not None and script_clues is not None:
        script_ref = {
            "text": truncate(script_redacted, request.constraints.max_script_chars),
            "clues": script_clues.to_dict(),
            "label": request.script_reference.label if request.script_reference else "script",
        }
    return BoundedProviderRequest(
        vendor=request.intent.vendor
        or (request.harvested_knowledge.provenance.vendor if request.harvested_knowledge else None),
        product=request.intent.product
        or (request.harvested_knowledge.provenance.product if request.harvested_knowledge else None),
        desired_streams=list(request.intent.desired_streams),
        supported_source_types=sorted(request.constraints.supported_source_types),
        auth_capabilities=list(AUTH_CAPABILITIES),
        harvested_knowledge=harvested,
        openapi_summary=openapi_summary.to_dict() if openapi_summary else None,
        sample_evidence=sample_payload,
        documentation_evidence=truncate(
            documentation_text, request.constraints.max_documentation_chars
        ),
        script_reference=script_ref,
        constraints={
            "no_fabricate": True,
            "unknown_when_unsupported": True,
            "supported_source_types": sorted(request.constraints.supported_source_types),
            "allow_inferred_facts": request.constraints.allow_inferred_facts,
            "require_evidence_for_endpoints": request.constraints.require_evidence_for_endpoints,
        },
        requested_output_schema="StructuredTranslationResult/v1",
    )


def documentation_text(doc: DocumentationEvidence | None) -> str | None:
    if doc is None:
        return None
    redacted, _ = redact_secrets_in_text(doc.text or "")
    return redacted
