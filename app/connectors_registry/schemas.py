"""Pydantic schemas for Connector Registry HTTP APIs."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from app.connectors_registry.models import (
    ConnectorAuthManifest,
    ConnectorManifest,
    ConnectorModuleResources,
    ConnectorResourcesSummary,
    ConnectorStreamRef,
    DocsMetadata,
)


class ConnectorValidationErrorRead(BaseModel):
    """Single validation issue exposed via API."""

    rule_id: str
    message: str
    path: str | None = None


MigrationStatusRead = Literal["module_based", "legacy", "migration_pending"]


class ConnectorRegistrySummary(BaseModel):
    """List view for connector catalog."""

    id: str
    name: str
    vendor: str
    version: str
    source_type: str
    auth_type: str
    stream_count: int
    capabilities: dict[str, Any] = Field(default_factory=dict)
    status: Literal["valid", "invalid"] = "valid"
    migration_status: MigrationStatusRead = "migration_pending"
    migration_label: str = "Pending"
    legacy_template_id: str | None = None
    error_count: int = 0
    migration_error_count: int = 0
    resources: ConnectorResourcesSummary = Field(default_factory=ConnectorResourcesSummary)
    # Manifest v2 additive fields (backward compatible)
    pack_version: str | None = None
    package_id: str | None = None
    package_kind: str | None = None
    # M29.2 platform-derived registry origin (not trusted from package files)
    installed_from: str | None = None
    requires: Any | None = None


class ResolvedConnectorRead(BaseModel):
    """Resolved connector module with loaded resource summary."""

    id: str
    name: str
    vendor: str
    version: str
    source_type: str
    auth: ConnectorAuthManifest
    auth_schema: dict[str, Any] | None = None
    streams: list[ConnectorStreamRef] = Field(default_factory=list)
    capabilities: dict[str, Any] = Field(default_factory=dict)
    status: Literal["valid", "invalid"] = "valid"
    errors: list[ConnectorValidationErrorRead] = Field(default_factory=list)
    resources: ConnectorResourcesSummary = Field(default_factory=ConnectorResourcesSummary)
    module_dir: str
    manifest_path: str
    manifest: ConnectorManifest | None = None
    # Manifest v2 additive fields (backward compatible)
    pack_version: str | None = None
    package_id: str | None = None
    package_kind: str | None = None
    # M29.2 platform-derived registry origin (not trusted from package files)
    installed_from: str | None = None
    requires: Any | None = None


class ConnectorRegistryDetail(BaseModel):
    """Full resolved payload for a single connector module."""

    id: str
    resolved: ResolvedConnectorRead


class ConnectorRegistryResourcesRead(BaseModel):
    """Resolved resource payloads for one connector module."""

    id: str
    status: Literal["valid", "invalid"] = "valid"
    streams: dict[str, dict[str, Any]] = Field(default_factory=dict)
    mappings: dict[str, dict[str, Any]] = Field(default_factory=dict)
    enrichments: dict[str, dict[str, Any]] = Field(default_factory=dict)
    api_test: dict[str, Any] | None = None
    docs: DocsMetadata | None = None
    auth_schema: dict[str, Any] | None = None
    resources: ConnectorResourcesSummary = Field(default_factory=ConnectorResourcesSummary)
    errors: list[ConnectorValidationErrorRead] = Field(default_factory=list)


class ConnectorRegistryReloadResponse(BaseModel):
    """Admin reload outcome."""

    loaded_count: int
    connector_ids: list[str]
    issue_count: int
    issues: list[dict[str, str | None]]


class ConnectorRegistryListResponse(BaseModel):
    """Wrapper for list endpoint (stable envelope)."""

    connectors: list[ConnectorRegistrySummary]
    count: int
    migration_matrix: list[dict[str, str]] = Field(default_factory=list)
