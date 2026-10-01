"""Deterministic fixture / manual translation providers (no network)."""

from __future__ import annotations

from typing import Any, Mapping

from app.connectors_registry.builder.models import BoundedProviderRequest
from app.connectors_registry.builder.providers.base import AITranslationProvider


def _ev(
    value: Any,
    source: str,
    confidence: str,
    *,
    inferred: bool = False,
    source_ref: str | None = None,
) -> dict[str, Any]:
    return {
        "value": value,
        "evidence_source": source,
        "confidence": confidence,
        "inferred": inferred,
        "source_ref": source_ref,
    }


class FixtureTranslationProvider(AITranslationProvider):
    """Deterministic provider that maps bounded evidence → structured result.

    Production network AI providers are intentionally deferred.
    """

    name = "fixture"

    def translate(self, request: BoundedProviderRequest) -> Mapping[str, Any]:
        open_questions: list[dict[str, Any]] = []
        vendor = request.vendor or "UNKNOWN"
        product = request.product or "UNKNOWN"

        # Prefer harvested / openapi / script clues over invention.
        auth_type = "UNKNOWN"
        auth_fields: list[str] = []
        auth_source = "ai_inference"
        auth_conf = "UNKNOWN"
        auth_inferred = True

        streams: list[dict[str, Any]] = []

        if request.harvested_knowledge:
            hk = request.harvested_knowledge
            vendor = hk.get("vendor") or vendor
            product = hk.get("product") or product
            auth = hk.get("auth") or {}
            if auth.get("auth_type"):
                auth_type = str(auth["auth_type"])
                auth_source = "harvested"
                auth_conf = "HIGH"
                auth_inferred = False
            auth_fields = list(auth.get("required_fields") or [])
            source_type = hk.get("proposed_source_type") or "HTTP_API_POLLING"
            for stream in hk.get("streams") or []:
                streams.append(
                    {
                        "name": stream.get("name") or "events",
                        "source_type": source_type,
                        "method": _ev(
                            stream.get("http_method") or "UNKNOWN",
                            "harvested" if stream.get("http_method") else "ai_inference",
                            "HIGH" if stream.get("http_method") else "UNKNOWN",
                            inferred=not bool(stream.get("http_method")),
                        ),
                        "path": _ev(
                            stream.get("path") or "UNKNOWN",
                            "harvested" if stream.get("path") else "ai_inference",
                            "HIGH" if stream.get("path") else "UNKNOWN",
                            inferred=not bool(stream.get("path")),
                        ),
                        "params": dict(stream.get("query_parameters") or {}),
                        "event_array_path": _ev(
                            stream.get("event_array_path_hint") or "UNKNOWN",
                            "harvested" if stream.get("event_array_path_hint") else "ai_inference",
                            "MEDIUM" if stream.get("event_array_path_hint") else "UNKNOWN",
                            inferred=not bool(stream.get("event_array_path_hint")),
                        ),
                        "checkpoint": _ev(
                            (stream.get("checkpoint") or {}).get("cursor_field") or "UNKNOWN",
                            "harvested"
                            if (stream.get("checkpoint") or {}).get("cursor_field")
                            else "ai_inference",
                            "MEDIUM"
                            if (stream.get("checkpoint") or {}).get("cursor_field")
                            else "UNKNOWN",
                            inferred=not bool(
                                (stream.get("checkpoint") or {}).get("cursor_field")
                            ),
                        ),
                        "pagination": stream.get("pagination"),
                        "mapping": None,
                    }
                )

        if request.openapi_summary and not streams:
            paths = request.openapi_summary.get("paths") or []
            auth_hints = request.openapi_summary.get("auth_hints") or []
            if auth_hints and auth_type == "UNKNOWN":
                hint = str(auth_hints[0]).lower()
                if "api" in hint and "key" in hint:
                    auth_type = "api_key"
                elif "http" in hint or "bearer" in hint:
                    auth_type = "bearer"
                elif "oauth" in hint:
                    auth_type = "oauth2_client_credentials"
                else:
                    auth_type = hint
                auth_source = "openapi"
                auth_conf = "HIGH"
                auth_inferred = False
            desired = set(request.desired_streams) if request.desired_streams else None
            for entry in paths:
                name = entry.get("operation_id") or entry.get("path", "stream").strip("/").replace(
                    "/", "_"
                ) or "stream"
                if desired and name not in desired and entry.get("path") not in desired:
                    # Still include if no explicit filter match on operation — include all GET.
                    if entry.get("method") != "GET":
                        continue
                if entry.get("method") not in {"GET", "POST"}:
                    continue
                streams.append(
                    {
                        "name": name,
                        "source_type": "HTTP_API_POLLING",
                        "method": _ev(entry.get("method"), "openapi", "HIGH"),
                        "path": _ev(entry.get("path"), "openapi", "HIGH"),
                        "params": {},
                        "event_array_path": _ev("UNKNOWN", "ai_inference", "UNKNOWN", inferred=True),
                        "checkpoint": _ev("UNKNOWN", "ai_inference", "UNKNOWN", inferred=True),
                        "pagination": {"type": "UNKNOWN"},
                        "mapping": None,
                    }
                )
            if not paths:
                open_questions.append(
                    {
                        "code": "MISSING_OPENAPI_PATHS",
                        "message": "OpenAPI provided but no paths extracted",
                        "field": "streams",
                        "severity": "error",
                    }
                )

        # Sample-driven event array hint (deterministic, not hallucinated).
        if request.sample_evidence is not None and streams:
            sample = request.sample_evidence
            candidate_path = None
            if isinstance(sample, dict):
                for key in ("items", "data", "results", "events", "records"):
                    if isinstance(sample.get(key), list):
                        candidate_path = f"$.{key}"
                        break
            for stream in streams:
                current = (stream.get("event_array_path") or {}).get("value")
                if current in (None, "UNKNOWN") and candidate_path:
                    stream["event_array_path"] = _ev(
                        candidate_path, "sample", "HIGH", source_ref="sample_evidence"
                    )

        # Script clues as low-confidence fill when still unknown.
        script = request.script_reference or {}
        clues = script.get("clues") or {}
        if clues and not streams:
            endpoints = clues.get("endpoints") or []
            methods = clues.get("methods") or ["GET"]
            if endpoints:
                streams.append(
                    {
                        "name": request.desired_streams[0] if request.desired_streams else "events",
                        "source_type": "HTTP_API_POLLING",
                        "method": _ev(methods[0] if methods else "GET", "script", "MEDIUM"),
                        "path": _ev(endpoints[0], "script", "MEDIUM"),
                        "params": {},
                        "event_array_path": _ev(
                            f"$.{clues['response_path_hints'][0]}"
                            if clues.get("response_path_hints")
                            else "UNKNOWN",
                            "script" if clues.get("response_path_hints") else "ai_inference",
                            "LOW" if clues.get("response_path_hints") else "UNKNOWN",
                            inferred=not bool(clues.get("response_path_hints")),
                        ),
                        "checkpoint": _ev(
                            clues["checkpoint_hints"][0]
                            if clues.get("checkpoint_hints")
                            else "UNKNOWN",
                            "script" if clues.get("checkpoint_hints") else "ai_inference",
                            "LOW" if clues.get("checkpoint_hints") else "UNKNOWN",
                            inferred=not bool(clues.get("checkpoint_hints")),
                        ),
                        "pagination": {
                            "type": clues["pagination_hints"][0]
                            if clues.get("pagination_hints")
                            else "UNKNOWN"
                        },
                        "mapping": None,
                    }
                )

        if not streams:
            open_questions.append(
                {
                    "code": "NO_STREAMS",
                    "message": "Insufficient evidence to propose streams",
                    "field": "streams",
                    "severity": "error",
                }
            )

        for stream in streams:
            if (stream.get("path") or {}).get("value") in (None, "UNKNOWN"):
                open_questions.append(
                    {
                        "code": "MISSING_ENDPOINT",
                        "message": f"Endpoint unresolved for stream {stream.get('name')}",
                        "field": f"streams.{stream.get('name')}.path",
                        "severity": "error",
                    }
                )
            if (stream.get("checkpoint") or {}).get("value") in (None, "UNKNOWN"):
                open_questions.append(
                    {
                        "code": "MISSING_CHECKPOINT",
                        "message": f"Checkpoint unresolved for stream {stream.get('name')}",
                        "field": f"streams.{stream.get('name')}.checkpoint",
                        "severity": "warning",
                    }
                )

        api_version = "UNKNOWN"
        api_source = "ai_inference"
        api_conf = "UNKNOWN"
        api_inferred = True
        if request.openapi_summary and (request.openapi_summary.get("raw_info") or {}).get("version"):
            api_version = request.openapi_summary["raw_info"]["version"]
            api_source = "openapi"
            api_conf = "HIGH"
            api_inferred = False
        elif request.harvested_knowledge and request.harvested_knowledge.get("upstream_version"):
            api_version = request.harvested_knowledge["upstream_version"]
            api_source = "harvested"
            api_conf = "MEDIUM"
            api_inferred = False

        return {
            "identity": {
                "vendor": _ev(
                    vendor,
                    "harvested" if request.harvested_knowledge else "documentation",
                    "HIGH" if vendor != "UNKNOWN" else "UNKNOWN",
                    inferred=vendor == "UNKNOWN",
                ),
                "product": _ev(
                    product,
                    "harvested" if request.harvested_knowledge else "documentation",
                    "HIGH" if product != "UNKNOWN" else "UNKNOWN",
                    inferred=product == "UNKNOWN",
                ),
                "api_family_version": _ev(
                    api_version, api_source, api_conf, inferred=api_inferred
                ),
            },
            "auth": {
                "auth_type": _ev(auth_type, auth_source, auth_conf, inferred=auth_inferred),
                "required_fields": auth_fields,
                "scopes": list(
                    (request.harvested_knowledge or {}).get("auth", {}).get("scopes") or []
                ),
            },
            "streams": streams,
            "runtime_hints": {
                "rate_limit": None,
                "polling_interval_seconds": (
                    (request.harvested_knowledge or {})
                    .get("runtime", {})
                    .get("polling_interval_seconds")
                ),
                "timeout_seconds": None,
            },
            "open_questions": open_questions,
        }


class ManualTranslationProvider(AITranslationProvider):
    """Passthrough provider for externally supplied structured translation.

    Used by external agents (Cursor/ChatGPT/Claude) that produce the schema
    locally and submit it for validation/package generation.
    """

    name = "manual"

    def __init__(self, response: Mapping[str, Any] | None = None) -> None:
        self._response = dict(response or {})

    def set_response(self, response: Mapping[str, Any]) -> None:
        self._response = dict(response)

    def translate(self, request: BoundedProviderRequest) -> Mapping[str, Any]:
        if not self._response:
            raise ValueError(
                "manual provider requires a supplied StructuredTranslationResult "
                "(set via BuilderRequest.supplied_translation or set_response)"
            )
        return dict(self._response)
