"""Bounded prompt / request contract for AI translation providers."""

from __future__ import annotations

from typing import Any

from app.connectors_registry.builder.models import BoundedProviderRequest

SYSTEM_CONTRACT = """You are a Data Relay Connector Builder translator.
Return ONLY schema-constrained StructuredTranslationResult JSON.
Rules:
- Never invent endpoints, auth scopes, pagination tokens, event_array_path,
  checkpoint fields, API versions, or rate limits without evidence.
- When evidence is missing, use UNKNOWN and add an open_question.
- Mark inferred=true only for AI inference; never treat inference as HIGH confidence.
- Supported source types only: HTTP_API_POLLING, WEBHOOK_RECEIVER, S3_OBJECT_POLLING,
  DATABASE_QUERY, REMOTE_FILE_POLLING. Unsupported types must be open questions.
- Do not include credentials, tokens, passwords, or private keys.
- Output is untrusted draft configuration only.
"""

OUTPUT_SCHEMA_HINT: dict[str, Any] = {
    "identity": {
        "vendor": {"value": "string|UNKNOWN", "evidence_source": "…", "confidence": "HIGH|MEDIUM|LOW|UNKNOWN", "inferred": False},
        "product": {"value": "string|UNKNOWN", "evidence_source": "…", "confidence": "…", "inferred": False},
        "api_family_version": {"value": "string|UNKNOWN", "evidence_source": "…", "confidence": "…", "inferred": False},
    },
    "auth": {
        "auth_type": {"value": "string|UNKNOWN", "evidence_source": "…", "confidence": "…", "inferred": False},
        "required_fields": ["non-secret field names only"],
        "scopes": ["only when evidenced"],
    },
    "streams": [
        {
            "name": "string",
            "source_type": "HTTP_API_POLLING|…|UNKNOWN",
            "method": {"value": "GET|…|UNKNOWN", "evidence_source": "…", "confidence": "…", "inferred": False},
            "path": {"value": "/path|UNKNOWN", "evidence_source": "…", "confidence": "…", "inferred": False},
            "params": {},
            "body_template": None,
            "event_array_path": {"value": "$.items|UNKNOWN", "evidence_source": "…", "confidence": "…", "inferred": False},
            "pagination": {"type": "UNKNOWN|cursor|offset|page|next_link", "request_fields": [], "response_fields": []},
            "checkpoint": {"value": "field|UNKNOWN", "evidence_source": "…", "confidence": "…", "inferred": False},
            "mapping": {"source_fields": [], "output_fields": []},
        }
    ],
    "runtime_hints": {
        "rate_limit": None,
        "polling_interval_seconds": None,
        "timeout_seconds": None,
    },
    "open_questions": [
        {"code": "MISSING_FACT", "message": "…", "field": "…", "severity": "warning|error"}
    ],
}


def render_provider_prompt(request: BoundedProviderRequest) -> dict[str, Any]:
    """Machine-readable provider payload (not free-form chat dump)."""

    return {
        "system_contract": SYSTEM_CONTRACT,
        "request": request.to_dict(),
        "output_schema": OUTPUT_SCHEMA_HINT,
        "output_schema_id": request.requested_output_schema,
    }
