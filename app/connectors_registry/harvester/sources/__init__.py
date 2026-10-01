"""Harvester source adapters package."""

from app.connectors_registry.harvester.sources.base import HarvesterSourceAdapter
from app.connectors_registry.harvester.sources.fluent_bit import FluentBitHarvesterAdapter
from app.connectors_registry.harvester.sources.otel import OpenTelemetryHarvesterAdapter
from app.connectors_registry.harvester.sources.singer import (
    MeltanoHarvesterAdapter,
    SingerHarvesterAdapter,
)
from app.connectors_registry.harvester.sources.telegraf import TelegrafHarvesterAdapter

__all__ = [
    "FluentBitHarvesterAdapter",
    "HarvesterSourceAdapter",
    "MeltanoHarvesterAdapter",
    "OpenTelemetryHarvesterAdapter",
    "SingerHarvesterAdapter",
    "TelegrafHarvesterAdapter",
]
