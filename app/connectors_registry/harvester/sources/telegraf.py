"""Telegraf harvester adapter skeleton (M29.6).

V1 supports structured fixtures only. Full Telegraf plugin TOML harvest remains
future work — no arbitrary code execution.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping

import yaml

from app.connectors_registry.harvester.models import (
    EvidenceRef,
    HarvestInputMode,
    HarvestedIntegrationKnowledge,
    MappingStatus,
    ProvenanceKnowledge,
)
from app.connectors_registry.harvester.normalizer import normalize_harvested_dict
from app.connectors_registry.harvester.sources.base import HarvesterSourceAdapter


class TelegrafHarvesterAdapter(HarvesterSourceAdapter):
    """Telegraf knowledge adapter (fixture-backed skeleton)."""

    ecosystem = "telegraf"

    def harvest(
        self,
        *,
        path: Path,
        input_mode: HarvestInputMode,
        fixture_overrides: Mapping[str, Any] | None = None,
    ) -> HarvestedIntegrationKnowledge:
        root = Path(path)
        if input_mode != HarvestInputMode.STRUCTURED_METADATA_FIXTURE and not (
            root.is_file()
            or (root.is_dir() and any((root / n).is_file() for n in ("harvester.yaml", "harvester.json")))
        ):
            return HarvestedIntegrationKnowledge(
                provenance=ProvenanceKnowledge(
                    ecosystem="telegraf",
                    upstream_project="telegraf",
                    vendor="InfluxData",
                    product="telegraf",
                    integration_name=root.name,
                    upstream_path=str(root),
                    import_method=input_mode.value,
                    evidence=[EvidenceRef(source_path=str(root), confidence="low")],
                ),
                mapping_status=MappingStatus.UNSUPPORTED,
                mapping_reason=(
                    "Telegraf adapter is fixture-backed in M29.6 V1; "
                    "provide structured harvester.yaml metadata"
                ),
                notes=["Telegraf full plugin harvest not implemented in V1."],
            )

        data_path = root if root.is_file() else None
        if data_path is None:
            for name in ("harvester.yaml", "harvester.yml", "harvester.json"):
                candidate = root / name
                if candidate.is_file():
                    data_path = candidate
                    break
        if data_path is None:
            raise ValueError(f"no Telegraf structured fixture at {root}")

        if data_path.suffix.lower() == ".json":
            data = json.loads(data_path.read_text(encoding="utf-8"))
        else:
            data = yaml.safe_load(data_path.read_text(encoding="utf-8"))
        if not isinstance(data, Mapping):
            raise ValueError("Telegraf fixture must be a mapping")
        merged = dict(data)
        if fixture_overrides:
            merged.update(dict(fixture_overrides))
        merged.setdefault("ecosystem", "telegraf")
        return normalize_harvested_dict(
            merged,
            default_ecosystem="telegraf",
            default_import_method=input_mode.value,
        )
