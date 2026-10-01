"""Connector Harvester / External Import Pipeline (M29.6).

Deterministic, static-input harvest of integration knowledge into Data Relay
draft Source Packs. No AI translation, no auto-install, no remote acquisition
in V1, and no upstream code execution.
"""

from app.connectors_registry.harvester.models import (
    HarvestInputMode,
    HarvestRequest,
    ImportResult,
    MappingStatus,
    TrustCandidate,
)
from app.connectors_registry.harvester.registry import (
    HarvesterSourceRegistry,
    UnknownHarvesterAdapterError,
    build_default_harvester_registry,
)
from app.connectors_registry.harvester.service import (
    INDEPENDENT_NETWORK_POLICY_ADDED,
    REMOTE_ACQUISITION_IMPLEMENTED,
    SHARED_ACQUISITION_POLICY_REUSED,
    HarvesterService,
    harvest_and_import,
)

__all__ = [
    "HarvesterService",
    "HarvesterSourceRegistry",
    "HarvestInputMode",
    "HarvestRequest",
    "ImportResult",
    "INDEPENDENT_NETWORK_POLICY_ADDED",
    "MappingStatus",
    "REMOTE_ACQUISITION_IMPLEMENTED",
    "SHARED_ACQUISITION_POLICY_REUSED",
    "TrustCandidate",
    "UnknownHarvesterAdapterError",
    "build_default_harvester_registry",
    "harvest_and_import",
]
