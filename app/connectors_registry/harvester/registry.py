"""Registry dispatch for Harvester source adapters (M29.6)."""

from __future__ import annotations

from typing import Iterable

from app.connectors_registry.harvester.sources.base import HarvesterSourceAdapter


class UnknownHarvesterAdapterError(KeyError):
    """Raised when no adapter is registered for the requested ecosystem."""

    def __init__(self, ecosystem: str) -> None:
        self.ecosystem = ecosystem
        super().__init__(f"unknown harvester ecosystem adapter: {ecosystem!r}")


class HarvesterSourceRegistry:
    """Maps ecosystem keys to :class:`HarvesterSourceAdapter` instances."""

    def __init__(self) -> None:
        self._by_ecosystem: dict[str, HarvesterSourceAdapter] = {}

    def register(self, adapter: HarvesterSourceAdapter) -> None:
        key = adapter.ecosystem.strip().lower()
        if not key:
            raise ValueError("adapter.ecosystem must be a non-empty string")
        self._by_ecosystem[key] = adapter

    def get(self, ecosystem: str) -> HarvesterSourceAdapter:
        key = (ecosystem or "").strip().lower()
        adapter = self._by_ecosystem.get(key)
        if adapter is None:
            raise UnknownHarvesterAdapterError(key)
        return adapter

    def known_ecosystems(self) -> list[str]:
        return sorted(self._by_ecosystem.keys())

    def register_many(self, adapters: Iterable[HarvesterSourceAdapter]) -> None:
        for adapter in adapters:
            self.register(adapter)


def build_default_harvester_registry() -> HarvesterSourceRegistry:
    """Construct the default M29.6 adapter registry."""

    # Lazy imports keep adapter modules isolated and avoid circular imports.
    from app.connectors_registry.harvester.sources.fluent_bit import FluentBitHarvesterAdapter
    from app.connectors_registry.harvester.sources.otel import OpenTelemetryHarvesterAdapter
    from app.connectors_registry.harvester.sources.singer import (
        MeltanoHarvesterAdapter,
        SingerHarvesterAdapter,
    )
    from app.connectors_registry.harvester.sources.telegraf import TelegrafHarvesterAdapter

    registry = HarvesterSourceRegistry()
    registry.register_many(
        [
            SingerHarvesterAdapter(),
            MeltanoHarvesterAdapter(),
            OpenTelemetryHarvesterAdapter(),
            FluentBitHarvesterAdapter(),
            TelegrafHarvesterAdapter(),
        ]
    )
    return registry
