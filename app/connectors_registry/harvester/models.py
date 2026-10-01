"""Normalized harvested connector knowledge models (M29.6).

These models represent integration *knowledge* only — never executable
upstream connector/runtime code.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Mapping


# Data Relay source capabilities eligible for draft package generation.
SUPPORTED_DATA_RELAY_SOURCE_TYPES: frozenset[str] = frozenset(
    {
        "HTTP_API_POLLING",
        "WEBHOOK_RECEIVER",
        "S3_OBJECT_POLLING",
        "DATABASE_QUERY",
        "REMOTE_FILE_POLLING",
    }
)


class HarvestInputMode(str, Enum):
    """Deterministic V1 input modes (no unrestricted Internet crawling)."""

    LOCAL_EXTRACTED_DIRECTORY = "local_extracted_directory"
    LOCAL_REPOSITORY_SNAPSHOT = "local_repository_snapshot"
    STRUCTURED_METADATA_FIXTURE = "structured_metadata_fixture"


class MappingStatus(str, Enum):
    """How harvested knowledge maps to Data Relay source contracts."""

    MAPPED = "MAPPED"
    UNSUPPORTED = "UNSUPPORTED"
    REFERENCE_ONLY = "REFERENCE_ONLY"
    UNKNOWN = "UNKNOWN"


class ContentReuseClass(str, Enum):
    """FACT/KNOWLEDGE vs potentially copyrighted/restricted content."""

    FACT = "FACT"
    KNOWLEDGE = "KNOWLEDGE"
    COPYABLE = "COPYABLE"
    RESTRICTED = "RESTRICTED"


class TrustCandidate(str, Enum):
    """Harvester may only propose Local Draft or Imported — never Verified/Official."""

    LOCAL_DRAFT = "Local Draft"
    IMPORTED = "Imported"


@dataclass(frozen=True)
class EvidenceRef:
    """Citation for a harvested fact or generated field."""

    source_path: str | None = None
    documentation_ref: str | None = None
    notes: str | None = None
    confidence: str = "low"  # low | medium | high


@dataclass
class AuthKnowledge:
    """Auth/connection hints extracted from upstream metadata."""

    auth_type: str | None = None
    api_base_url_hint: str | None = None
    required_fields: list[str] = field(default_factory=list)
    scopes: list[str] = field(default_factory=list)
    evidence: list[EvidenceRef] = field(default_factory=list)


@dataclass
class PaginationKnowledge:
    """Pagination model when explicitly present upstream."""

    style: str | None = None  # page | offset | cursor | next_link | token
    param_name: str | None = None
    evidence: list[EvidenceRef] = field(default_factory=list)


@dataclass
class CheckpointKnowledge:
    """Checkpoint / replication-key candidates when explicitly present."""

    cursor_field: str | None = None
    time_field: str | None = None
    id_field: str | None = None
    evidence: list[EvidenceRef] = field(default_factory=list)


@dataclass
class SchemaFieldKnowledge:
    """One schema field definition when available."""

    name: str
    type_hint: str | None = None
    required: bool | None = None
    description: str | None = None


@dataclass
class StreamKnowledge:
    """One stream / endpoint knowledge record."""

    name: str
    http_method: str | None = None
    path: str | None = None
    query_parameters: dict[str, Any] = field(default_factory=dict)
    request_body_hint: Any = None
    event_array_path_hint: str | None = None
    pagination: PaginationKnowledge | None = None
    checkpoint: CheckpointKnowledge | None = None
    schema_fields: list[SchemaFieldKnowledge] = field(default_factory=list)
    evidence: list[EvidenceRef] = field(default_factory=list)


@dataclass
class RuntimeHints:
    """Optional runtime guidance — only when evidenced."""

    rate_limit_max_requests: int | None = None
    rate_limit_per_seconds: int | None = None
    polling_interval_seconds: int | None = None
    evidence: list[EvidenceRef] = field(default_factory=list)


@dataclass
class LicenseKnowledge:
    """Declared/detected license metadata (decision is platform-derived)."""

    identifier: str | None = None
    source: str | None = None
    notice_required: bool | None = None


@dataclass
class ProvenanceKnowledge:
    """Upstream identity and harvest provenance."""

    ecosystem: str
    upstream_project: str | None = None
    vendor: str | None = None
    product: str | None = None
    integration_name: str | None = None
    upstream_version: str | None = None
    upstream_commit: str | None = None
    upstream_path: str | None = None
    upstream_url: str | None = None
    import_method: str | None = None
    evidence: list[EvidenceRef] = field(default_factory=list)


@dataclass
class HarvestedIntegrationKnowledge:
    """Normalized intermediate model: integration knowledge only."""

    provenance: ProvenanceKnowledge
    license: LicenseKnowledge = field(default_factory=LicenseKnowledge)
    auth: AuthKnowledge = field(default_factory=AuthKnowledge)
    streams: list[StreamKnowledge] = field(default_factory=list)
    runtime: RuntimeHints = field(default_factory=RuntimeHints)
    # Proposed Data Relay source_type when evidence supports a clean mapping.
    proposed_source_type: str | None = None
    mapping_status: MappingStatus = MappingStatus.UNKNOWN
    mapping_reason: str | None = None
    # Content classification for reuse safety.
    content_reuse: ContentReuseClass = ContentReuseClass.KNOWLEDGE
    # Free-form notes / unsupported reasons (never executable code).
    notes: list[str] = field(default_factory=list)
    raw_metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class HarvestRequest:
    """Deterministic harvest request (local/snapshot/fixture only in V1)."""

    ecosystem: str
    input_mode: HarvestInputMode
    path: Path
    output_dir: Path | None = None
    trust_candidate: TrustCandidate = TrustCandidate.IMPORTED
    # Optional administrator license policy overrides.
    denied_licenses: frozenset[str] = frozenset()
    force_review_licenses: frozenset[str] = frozenset()
    force_reference_only_licenses: frozenset[str] = frozenset()
    # Extra metadata for fixture mode (merged into structured input).
    fixture_overrides: Mapping[str, Any] | None = None


@dataclass
class ImportIssue:
    """Structured issue recorded during harvest / package generation."""

    code: str
    message: str
    severity: str = "error"  # error | warning | info


@dataclass
class ImportResult:
    """Structured M29.6 import pipeline result."""

    source: str
    candidate: HarvestedIntegrationKnowledge | None
    license_decision: str | None
    license_decision_code: str | None
    license_decision_reason: str | None
    mapping_status: MappingStatus
    package_generated: bool
    package_path: Path | None
    validation_status: str  # PASS | FAIL | SKIPPED | BLOCKED
    issues: list[ImportIssue] = field(default_factory=list)
    evidence: list[EvidenceRef] = field(default_factory=list)
    confidence: str = "low"
    review_required: bool = False
    trust_candidate: TrustCandidate = TrustCandidate.IMPORTED
    validation_details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Serialize for tests / operator-facing APIs (no secrets)."""

        return {
            "source": self.source,
            "license_decision": self.license_decision,
            "license_decision_code": self.license_decision_code,
            "license_decision_reason": self.license_decision_reason,
            "mapping_status": self.mapping_status.value,
            "package_generated": self.package_generated,
            "package_path": str(self.package_path) if self.package_path else None,
            "validation_status": self.validation_status,
            "issues": [
                {"code": i.code, "message": i.message, "severity": i.severity}
                for i in self.issues
            ],
            "confidence": self.confidence,
            "review_required": self.review_required,
            "trust_candidate": self.trust_candidate.value,
            "validation_details": dict(self.validation_details),
            "evidence": [
                {
                    "source_path": e.source_path,
                    "documentation_ref": e.documentation_ref,
                    "notes": e.notes,
                    "confidence": e.confidence,
                }
                for e in self.evidence
            ],
        }
