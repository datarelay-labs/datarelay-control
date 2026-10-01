"""In-memory connector registry models."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


PackageKind = Literal["source", "stream_extension"]


class ConnectorAuthManifest(BaseModel):
    """Auth section of a connector manifest."""

    model_config = ConfigDict(extra="allow")

    type: str = Field(..., min_length=1)
    schema_ref: str | None = None
    lab_supported: bool | None = None


class ConnectorStreamRef(BaseModel):
    """Stream template reference within a connector module."""

    model_config = ConfigDict(extra="allow")

    id: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1)
    template: str | None = None
    default_mapping: str | None = None
    default_enrichment: str | None = None
    sample: str | None = None


class SourceEvidenceItem(BaseModel):
    """One evidence citation for Manifest v2 / Source Pack metadata."""

    model_config = ConfigDict(extra="allow")

    type: str = Field(..., min_length=1)
    ref: str = Field(..., min_length=1)
    captured_at: str | None = None
    notes: str | None = None


class PackageRequirement(BaseModel):
    """Declared package dependency (parsed only in M29.1; resolved later)."""

    model_config = ConfigDict(extra="allow")

    package_id: str = Field(..., min_length=1)
    version: str | None = None


class LicenseMetadata(BaseModel):
    """Structured license metadata when not a plain SPDX string."""

    model_config = ConfigDict(extra="allow")

    spdx: str | None = None
    name: str | None = None
    source: str | None = None
    notice_required: bool | None = None


class UpstreamProvenance(BaseModel):
    """Upstream provenance metadata (parse/validate only in M29.1)."""

    model_config = ConfigDict(extra="allow")

    upstream_project: str | None = None
    upstream_url: str | None = None
    upstream_path: str | None = None
    upstream_commit_or_version: str | None = None
    license_spdx_or_detected_license: str | None = None
    license_source: str | None = None
    notice_required: bool | None = None
    modified_from_upstream: bool | None = None
    import_method: str | None = None


class ConnectorManifest(BaseModel):
    """Parsed connector manifest (M17.5.1 + M29.1 Manifest v2 fields)."""

    model_config = ConfigDict(extra="allow")

    id: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1)
    vendor: str = Field(..., min_length=1)
    version: str = Field(..., min_length=1)
    source_type: str = Field(..., min_length=1)
    auth: ConnectorAuthManifest
    streams: list[ConnectorStreamRef] = Field(default_factory=list)
    capabilities: dict[str, Any] = Field(default_factory=dict)

    # Manifest v2 (optional on disk; normalized in-memory where applicable)
    schema_version: str | None = None
    package_id: str | None = None
    package_kind: PackageKind | None = None
    pack_version: str | None = None
    api_version: str | None = None
    source_evidence: list[SourceEvidenceItem] | None = None
    requires: PackageRequirement | list[PackageRequirement] | None = None
    license: str | LicenseMetadata | None = None
    upstream_provenance: UpstreamProvenance | None = None

    @field_validator("package_kind", mode="before")
    @classmethod
    def _empty_package_kind_as_none(cls, value: Any) -> Any:
        if value is None:
            return None
        if isinstance(value, str) and not value.strip():
            return None
        return value


class ConnectorResourcesSummary(BaseModel):
    """Resource counts and presence flags for a connector module."""

    streams_count: int = 0
    mappings_count: int = 0
    enrichments_count: int = 0
    has_api_test: bool = False
    has_docs: bool = False


class DocsMetadata(BaseModel):
    """Non-raw docs.md metadata (summary / first heading only)."""

    path: str
    title: str | None = None
    summary: str | None = None
    line_count: int = 0


class ConnectorModuleResources(BaseModel):
    """Resolved artifact payloads loaded from a connector module directory."""

    model_config = ConfigDict(extra="allow")

    streams: dict[str, dict[str, Any]] = Field(default_factory=dict)
    mappings: dict[str, dict[str, Any]] = Field(default_factory=dict)
    enrichments: dict[str, dict[str, Any]] = Field(default_factory=dict)
    api_test: dict[str, Any] | None = None
    docs: DocsMetadata | None = None
    auth_schema: dict[str, Any] | None = None
    summary: ConnectorResourcesSummary = Field(default_factory=ConnectorResourcesSummary)


ConnectorModuleStatus = Literal["valid", "invalid"]


@dataclass
class ConnectorModuleEntry:
    """Loaded connector module stored in the registry cache."""

    manifest: ConnectorManifest | None
    module_dir: Path
    manifest_path: Path
    status: ConnectorModuleStatus = "valid"
    errors: list[Any] = field(default_factory=list)
    resources: ConnectorModuleResources = field(default_factory=ConnectorModuleResources)
    connector_id: str = ""

    def __post_init__(self) -> None:
        if not self.connector_id and self.manifest is not None:
            self.connector_id = self.manifest.id


@dataclass
class RegistryLoadResult:
    """Outcome of a registry scan."""

    modules: dict[str, ConnectorModuleEntry] = field(default_factory=dict)
    issues: list[Any] = field(default_factory=list)
