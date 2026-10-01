"""HTTP routes for Connector Registry catalog APIs."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from app.connectors_registry.lifecycle_router import router as lifecycle_router
from app.connectors_registry.schemas import (
    ConnectorRegistryDetail,
    ConnectorRegistryListResponse,
    ConnectorRegistryReloadResponse,
    ConnectorRegistryResourcesRead,
)
from app.connectors_registry.service import (
    get_connector_manifest,
    get_connector_resources,
    list_connector_summaries,
    list_migration_matrix,
    reload_registry,
)

router = APIRouter()
# Lifecycle routes (/packages/...) must be registered before /{connector_id}.
router.include_router(lifecycle_router)


@router.get("/", response_model=ConnectorRegistryListResponse)
async def list_connectors_registry() -> ConnectorRegistryListResponse:
    """List connector modules discovered from configured registry roots."""

    rows = list_connector_summaries()
    return ConnectorRegistryListResponse(
        connectors=rows,
        count=len(rows),
        migration_matrix=list_migration_matrix(),
    )


@router.post("/reload", response_model=ConnectorRegistryReloadResponse)
async def post_connectors_registry_reload() -> ConnectorRegistryReloadResponse:
    """Rescan builtin and installed package roots and refresh the in-memory cache."""

    return reload_registry()


@router.get("/{connector_id}", response_model=ConnectorRegistryDetail)
async def get_connectors_registry_detail(connector_id: str) -> ConnectorRegistryDetail:
    """Return the resolved connector module including resource summary."""

    found = get_connector_manifest(connector_id)
    if found is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error_code": "CONNECTOR_MODULE_NOT_FOUND",
                "message": f"connector module not found: {connector_id}",
            },
        )
    return found


@router.get("/{connector_id}/resources", response_model=ConnectorRegistryResourcesRead)
async def get_connectors_registry_resources(connector_id: str) -> ConnectorRegistryResourcesRead:
    """Return resolved streams, mappings, enrichments, api_test, and docs metadata."""

    found = get_connector_resources(connector_id)
    if found is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error_code": "CONNECTOR_MODULE_NOT_FOUND",
                "message": f"connector module not found: {connector_id}",
            },
        )
    return found
