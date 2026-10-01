"""AI Connector Builder models (M29.7).

AI output is always untrusted draft content. Confidence never grants Marketplace
trust. Supported source types are reused from the harvester contract.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Mapping

from app.connectors_registry.harvester.models import (
    SUPPORTED_DATA_RELAY_SOURCE_TYPES,
    HarvestedIntegrationKnowledge,
    TrustCandidate,
)

# Re-export for Builder consumers — do not hardcode a separate capability set.
SUPPORTED_SOURCE_TYPES = SUPPORTED_DATA_RELAY_SOURCE_TYPES

UNKNOWN = "UNKNOWN"


class Confidence(str, Enum):
    HIGH = "HIGH"
    MEDIUM = "MEDIUM"
    LOW = "LOW"
    UNKNOWN = "UNKNOWN"


class EvidenceSourceKind(str, Enum):
    """Evidence priority order (highest first)."""

    SAMPLE = "sample"
    OPENAPI = "openapi"
    HARVESTED = "harvested"
    DOCUMENTATION = "documentation"
    SCRIPT = "script"
    AI_INFERENCE = "ai_inference"


# Explicit priority: lower index = higher confidence / wins conflicts.
EVIDENCE_PRIORITY: tuple[EvidenceSourceKind, ...] = (
    EvidenceSourceKind.SAMPLE,
    EvidenceSourceKind.OPENAPI,
    EvidenceSourceKind.HARVESTED,
    EvidenceSourceKind.DOCUMENTATION,
    EvidenceSourceKind.SCRIPT,
    EvidenceSourceKind.AI_INFERENCE,
)

EVIDENCE_PRIORITY_RANK: dict[EvidenceSourceKind, int] = {
    kind: idx for idx, kind in enumerate(EVIDENCE_PRIORITY)
}


class BuilderStatus(str, Enum):
    READY_DRAFT = "READY_DRAFT"
    NEEDS_REVIEW = "NEEDS_REVIEW"
    INCOMPLETE = "INCOMPLETE"
    BLOCKED = "BLOCKED"


class BuilderTrustCandidate(str, Enum):
    """Builder may only propose Local Draft or Imported Draft."""

    LOCAL_DRAFT = "Local Draft"
    IMPORTED_DRAFT = "Imported Draft"


@dataclass(frozen=True)
class EvidencedValue:
    """A generated fact with evidence metadata."""

    value: Any
    evidence_source: EvidenceSourceKind
    confidence: Confidence
    inferred: bool = False
    source_ref: str | None = None
    notes: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "value": self.value,
            "evidence_source": self.evidence_source.value,
            "confidence": self.confidence.value,
            "inferred": self.inferred,
            "source_ref": self.source_ref,
            "notes": self.notes,
        }


@dataclass
class OpenQuestion:
    code: str
    message: str
    field: str | None = None
    severity: str = "warning"  # error | warning | info

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "field": self.field,
            "severity": self.severity,
        }


@dataclass
class EvidenceConflict:
    field: str
    values: list[dict[str, Any]]
    winner: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "field": self.field,
            "values": list(self.values),
            "winner": self.winner,
        }


@dataclass
class SampleEvidence:
    """Live or user-provided API sample JSON."""

    payload: Any
    label: str = "sample"
    notes: str | None = None


@dataclass
class OpenApiEvidence:
    """Raw OpenAPI/Swagger document (dict or YAML/JSON text already parsed)."""

    document: Mapping[str, Any]
    label: str = "openapi"


@dataclass
class DocumentationEvidence:
    text: str
    label: str = "documentation"
    structured: Mapping[str, Any] | None = None


@dataclass
class ScriptReferenceEvidence:
    """Existing script/config as REFERENCE TEXT ONLY — never executed."""

    text: str
    label: str = "script"
    language_hint: str | None = None


@dataclass
class UserIntent:
    vendor: str | None = None
    product: str | None = None
    desired_streams: list[str] = field(default_factory=list)
    known_api_base_url: str | None = None
    known_auth_type: str | None = None
    notes: str | None = None


@dataclass
class BuilderConstraints:
    """Hard constraints sent to providers / enforced post-translation."""

    supported_source_types: frozenset[str] = SUPPORTED_SOURCE_TYPES
    allow_inferred_facts: bool = False
    require_evidence_for_endpoints: bool = True
    max_documentation_chars: int = 20_000
    max_script_chars: int = 20_000


@dataclass
class BuilderRequest:
    """Normalized Builder input — bounded evidence only (no credentials)."""

    intent: UserIntent = field(default_factory=UserIntent)
    harvested_knowledge: HarvestedIntegrationKnowledge | None = None
    openapi: OpenApiEvidence | None = None
    sample: SampleEvidence | None = None
    documentation: DocumentationEvidence | None = None
    script_reference: ScriptReferenceEvidence | None = None
    constraints: BuilderConstraints = field(default_factory=BuilderConstraints)
    output_dir: Path | None = None
    trust_candidate: BuilderTrustCandidate = BuilderTrustCandidate.LOCAL_DRAFT
    provider_name: str = "fixture"
    # Optional externally supplied structured translation (manual / agent path).
    supplied_translation: Mapping[str, Any] | None = None
    # License policy overrides when harvested knowledge is present.
    denied_licenses: frozenset[str] = frozenset()
    force_review_licenses: frozenset[str] = frozenset()
    force_reference_only_licenses: frozenset[str] = frozenset()


@dataclass
class OpenApiSummary:
    """Deterministic OpenAPI extraction (before AI interpretation)."""

    servers: list[str] = field(default_factory=list)
    base_url: str | None = None
    paths: list[dict[str, Any]] = field(default_factory=list)
    security_schemes: list[dict[str, Any]] = field(default_factory=list)
    auth_hints: list[str] = field(default_factory=list)
    raw_info: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "servers": list(self.servers),
            "base_url": self.base_url,
            "paths": list(self.paths),
            "security_schemes": list(self.security_schemes),
            "auth_hints": list(self.auth_hints),
            "raw_info": dict(self.raw_info),
        }


@dataclass
class ScriptClues:
    """Static clues extracted from script text (never executed)."""

    endpoints: list[str] = field(default_factory=list)
    methods: list[str] = field(default_factory=list)
    header_names: list[str] = field(default_factory=list)
    auth_shape_hints: list[str] = field(default_factory=list)
    pagination_hints: list[str] = field(default_factory=list)
    checkpoint_hints: list[str] = field(default_factory=list)
    response_path_hints: list[str] = field(default_factory=list)
    secrets_redacted: bool = False
    redaction_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "endpoints": list(self.endpoints),
            "methods": list(self.methods),
            "header_names": list(self.header_names),
            "auth_shape_hints": list(self.auth_shape_hints),
            "pagination_hints": list(self.pagination_hints),
            "checkpoint_hints": list(self.checkpoint_hints),
            "response_path_hints": list(self.response_path_hints),
            "secrets_redacted": self.secrets_redacted,
            "redaction_count": self.redaction_count,
        }


@dataclass
class BoundedProviderRequest:
    """Provider-facing request: only required, redacted evidence."""

    vendor: str | None
    product: str | None
    desired_streams: list[str]
    supported_source_types: list[str]
    auth_capabilities: list[str]
    harvested_knowledge: dict[str, Any] | None
    openapi_summary: dict[str, Any] | None
    sample_evidence: Any | None
    documentation_evidence: str | None
    script_reference: dict[str, Any] | None
    constraints: dict[str, Any]
    requested_output_schema: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "vendor": self.vendor,
            "product": self.product,
            "desired_streams": list(self.desired_streams),
            "supported_source_types": list(self.supported_source_types),
            "auth_capabilities": list(self.auth_capabilities),
            "harvested_knowledge": self.harvested_knowledge,
            "openapi_summary": self.openapi_summary,
            "sample_evidence": self.sample_evidence,
            "documentation_evidence": self.documentation_evidence,
            "script_reference": self.script_reference,
            "constraints": dict(self.constraints),
            "requested_output_schema": self.requested_output_schema,
        }


@dataclass
class StreamTranslation:
    name: str
    source_type: str | None = None
    method: EvidencedValue | None = None
    path: EvidencedValue | None = None
    params: dict[str, Any] = field(default_factory=dict)
    body_template: Any = None
    event_array_path: EvidencedValue | None = None
    pagination: dict[str, Any] | None = None
    checkpoint: EvidencedValue | None = None
    mapping: dict[str, Any] | None = None
    open_questions: list[OpenQuestion] = field(default_factory=list)


@dataclass
class StructuredTranslationResult:
    """Schema-constrained AI translation result (untrusted draft)."""

    vendor: EvidencedValue | None = None
    product: EvidencedValue | None = None
    api_family_version: EvidencedValue | None = None
    auth_type: EvidencedValue | None = None
    auth_required_fields: list[str] = field(default_factory=list)
    auth_scopes: list[str] = field(default_factory=list)
    streams: list[StreamTranslation] = field(default_factory=list)
    runtime_hints: dict[str, Any] = field(default_factory=dict)
    open_questions: list[OpenQuestion] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class BuilderIssue:
    code: str
    message: str
    severity: str = "error"

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "severity": self.severity}


@dataclass
class BuilderResult:
    """Structured M29.7 Builder pipeline result."""

    status: BuilderStatus
    package_generated: bool
    package_path: Path | None
    validation_status: str  # PASS | FAIL | SKIPPED | BLOCKED
    validation_issues: list[BuilderIssue] = field(default_factory=list)
    open_questions: list[OpenQuestion] = field(default_factory=list)
    conflicts: list[EvidenceConflict] = field(default_factory=list)
    confidence_summary: dict[str, Any] = field(default_factory=dict)
    evidence_summary: dict[str, Any] = field(default_factory=dict)
    license_decision: str | None = None
    license_decision_code: str | None = None
    license_decision_reason: str | None = None
    trust_candidate: BuilderTrustCandidate = BuilderTrustCandidate.LOCAL_DRAFT
    translation: StructuredTranslationResult | None = None
    validation_details: dict[str, Any] = field(default_factory=dict)
    provider_name: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status.value,
            "package_generated": self.package_generated,
            "package_path": str(self.package_path) if self.package_path else None,
            "validation_status": self.validation_status,
            "validation_issues": [i.to_dict() for i in self.validation_issues],
            "open_questions": [q.to_dict() for q in self.open_questions],
            "conflicts": [c.to_dict() for c in self.conflicts],
            "confidence_summary": dict(self.confidence_summary),
            "evidence_summary": dict(self.evidence_summary),
            "license_decision": self.license_decision,
            "license_decision_code": self.license_decision_code,
            "license_decision_reason": self.license_decision_reason,
            "trust_candidate": self.trust_candidate.value,
            "validation_details": dict(self.validation_details),
            "provider_name": self.provider_name,
        }


def trust_from_harvester(candidate: TrustCandidate) -> BuilderTrustCandidate:
    if candidate == TrustCandidate.LOCAL_DRAFT:
        return BuilderTrustCandidate.LOCAL_DRAFT
    return BuilderTrustCandidate.IMPORTED_DRAFT
