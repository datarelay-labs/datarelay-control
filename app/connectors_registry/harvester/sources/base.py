"""Harvester source adapter contract (M29.6).

Adapters extract metadata/knowledge only. They MUST NOT execute upstream
connector code, install upstream dependencies, or perform arbitrary HTTP.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Mapping

from app.connectors_registry.harvester.models import (
    HarvestInputMode,
    HarvestedIntegrationKnowledge,
)


class HarvesterSourceAdapter(ABC):
    """Isolated ecosystem adapter — registry-dispatched, no giant if/elif."""

    #: Stable ecosystem key used by HarvesterSourceRegistry (e.g. ``singer``).
    ecosystem: str

    @abstractmethod
    def harvest(
        self,
        *,
        path: Path,
        input_mode: HarvestInputMode,
        fixture_overrides: Mapping[str, Any] | None = None,
    ) -> HarvestedIntegrationKnowledge:
        """Extract normalized integration knowledge from deterministic local input.

        Implementations MUST:
        - read static files / structured fixtures only
        - never execute upstream code
        - never call requests/httpx/urllib/git clone
        - never install upstream dependencies
        """

    def supports_input_mode(self, input_mode: HarvestInputMode) -> bool:
        """Return whether this adapter accepts the given V1 input mode."""

        return input_mode in {
            HarvestInputMode.LOCAL_EXTRACTED_DIRECTORY,
            HarvestInputMode.LOCAL_REPOSITORY_SNAPSHOT,
            HarvestInputMode.STRUCTURED_METADATA_FIXTURE,
        }
