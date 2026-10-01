"""OpenTelemetry Collector Contrib static metadata harvester (M29.6).

Extracts receiver/exporter *metadata* only where safely representable.
Does NOT port Go runtime code or pretend every OTel receiver maps to
HTTP_API_POLLING.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping

import yaml

from app.connectors_registry.harvester.models import (
    AuthKnowledge,
    EvidenceRef,
    HarvestInputMode,
    HarvestedIntegrationKnowledge,
    LicenseKnowledge,
    MappingStatus,
    ProvenanceKnowledge,
    StreamKnowledge,
)
from app.connectors_registry.harvester.normalizer import normalize_harvested_dict
from app.connectors_registry.harvester.sources.base import HarvesterSourceAdapter

_STRUCTURED_NAMES = (
    "harvester.json",
    "harvester.yaml",
    "harvester.yml",
    "metadata.yaml",
    "metadata.yml",
    "metadata.json",
)

# OTel component types that can map to Data Relay when REST evidence exists.
_HTTP_POLL_HINTS = frozenset({"http", "httpclient", "rest", "polling", "scraper"})
_WEBHOOK_HINTS = frozenset({"webhook", "httplistener", "receiver_http"})


def _load_structured(path: Path) -> Any:
    suffix = path.suffix.lower()
    if suffix == ".json":
        return json.loads(path.read_text(encoding="utf-8"))
    if suffix in {".yaml", ".yml"}:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    raise ValueError(f"unsupported structured metadata format: {path}")


def _find_metadata(root: Path) -> Path | None:
    for name in _STRUCTURED_NAMES:
        candidate = root / name
        if candidate.is_file():
            return candidate
    if root.is_dir():
        for child in sorted(root.iterdir()):
            if child.is_dir() and not child.name.startswith("."):
                for name in ("metadata.yaml", "metadata.yml", "harvester.yaml", "harvester.json"):
                    candidate = child / name
                    if candidate.is_file():
                        return candidate
    return None


def _map_otel_component(data: Mapping[str, Any]) -> tuple[MappingStatus, str | None, str]:
    """Decide whether an OTel component maps to a Data Relay source type."""

    explicit = data.get("data_relay_source_type") or data.get("proposed_source_type")
    if explicit:
        st = str(explicit).strip().upper()
        from app.connectors_registry.harvester.models import SUPPORTED_DATA_RELAY_SOURCE_TYPES

        if st in SUPPORTED_DATA_RELAY_SOURCE_TYPES:
            return MappingStatus.MAPPED, st, f"explicit Data Relay mapping declared: {st}"
        return (
            MappingStatus.UNSUPPORTED,
            None,
            f"declared mapping {st!r} is not a supported Data Relay source type",
        )

    status = data.get("mapping_status")
    if status:
        try:
            ms = MappingStatus(str(status).strip().upper())
        except ValueError:
            ms = MappingStatus.UNKNOWN
        if ms != MappingStatus.MAPPED:
            return ms, None, str(data.get("mapping_reason") or f"explicit mapping_status={ms.value}")

    component_type = str(data.get("type") or data.get("component_type") or "").lower()
    stability = str(data.get("stability") or data.get("status", {}).get("class", "")
                    if isinstance(data.get("status"), Mapping)
                    else data.get("stability") or "").lower()
    transport = str(data.get("transport") or data.get("protocol") or "").lower()
    tags = data.get("tags") if isinstance(data.get("tags"), list) else []
    tag_set = {str(t).lower() for t in tags}

    # Never auto-map pure push/receiver without HTTP poll contract evidence.
    if component_type in {"exporter", "processor", "extension", "connector"}:
        return (
            MappingStatus.UNSUPPORTED,
            None,
            f"OTel {component_type} is not mapped to Data Relay Source Pack generation",
        )

    # Receiver with explicit HTTP poll evidence in fixture.
    endpoints = data.get("endpoints") or data.get("streams") or []
    has_http_endpoint = False
    if isinstance(endpoints, list):
        for ep in endpoints:
            if not isinstance(ep, Mapping):
                continue
            if ep.get("path") and ep.get("http_method") or ep.get("method"):
                has_http_endpoint = True
                break

    if has_http_endpoint or transport in _HTTP_POLL_HINTS or bool(tag_set & _HTTP_POLL_HINTS):
        return (
            MappingStatus.MAPPED,
            "HTTP_API_POLLING",
            "OTel metadata includes HTTP polling endpoint evidence",
        )

    if transport in _WEBHOOK_HINTS or bool(tag_set & _WEBHOOK_HINTS):
        return (
            MappingStatus.MAPPED,
            "WEBHOOK_RECEIVER",
            "OTel metadata includes webhook/HTTP listener evidence",
        )

    # Default: knowledge/reference only — do not invent HTTP_API_POLLING.
    return (
        MappingStatus.UNSUPPORTED,
        None,
        (
            f"OTel component {data.get('name') or component_type or 'unknown'!r} "
            "has no clean Data Relay source-type mapping; retained as knowledge only"
            + (f" (stability={stability})" if stability else "")
        ),
    )


class OpenTelemetryHarvesterAdapter(HarvesterSourceAdapter):
    """OpenTelemetry Collector Contrib static knowledge adapter."""

    ecosystem = "otel"

    def harvest(
        self,
        *,
        path: Path,
        input_mode: HarvestInputMode,
        fixture_overrides: Mapping[str, Any] | None = None,
    ) -> HarvestedIntegrationKnowledge:
        root = Path(path)

        if input_mode == HarvestInputMode.STRUCTURED_METADATA_FIXTURE:
            if root.is_file():
                data = _load_structured(root)
                meta_path = root.name
            else:
                found = _find_metadata(root)
                if found is None:
                    raise ValueError(f"no OTel structured metadata under {root}")
                data = _load_structured(found)
                meta_path = found.name
            if not isinstance(data, Mapping):
                raise ValueError("OTel structured metadata must be a mapping")
            merged = dict(data)
            if fixture_overrides:
                merged.update(dict(fixture_overrides))
            return self._from_structured(merged, evidence_path=meta_path, input_mode=input_mode)

        if not root.is_dir():
            raise ValueError(f"OTel harvest path must be a directory for {input_mode.value}: {root}")

        found = _find_metadata(root)
        if found is None:
            raise ValueError(f"no OTel metadata.yaml / harvester fixture under {root}")
        data = _load_structured(found)
        if not isinstance(data, Mapping):
            raise ValueError("OTel metadata must be a mapping")
        merged = dict(data)
        if fixture_overrides:
            merged.update(dict(fixture_overrides))
        return self._from_structured(merged, evidence_path=found.name, input_mode=input_mode)

    def _from_structured(
        self,
        data: Mapping[str, Any],
        *,
        evidence_path: str,
        input_mode: HarvestInputMode,
    ) -> HarvestedIntegrationKnowledge:
        # If already in normalized harvester shape, use shared normalizer.
        if "identity" in data or "proposed_source_type" in data or "streams" in data:
            merged = dict(data)
            if "ecosystem" not in merged and "identity" not in merged:
                merged["ecosystem"] = "otel"
            # Apply mapping resolution when not fully specified.
            if "mapping_status" not in merged and "proposed_source_type" not in merged:
                status, proposed, reason = _map_otel_component(data)
                merged["mapping_status"] = status.value
                if proposed:
                    merged["proposed_source_type"] = proposed
                merged["mapping_reason"] = reason
            knowledge = normalize_harvested_dict(
                merged,
                default_ecosystem="otel",
                default_import_method=input_mode.value,
            )
            if not knowledge.provenance.evidence:
                knowledge.provenance.evidence.append(
                    EvidenceRef(source_path=evidence_path, confidence="medium")
                )
            knowledge.notes.append("Harvested from static OTel metadata; Go code was not executed.")
            return knowledge

        # Classic OTel contrib metadata.yaml shape (simplified).
        name = str(data.get("name") or data.get("type") or "otel_component")
        status, proposed, reason = _map_otel_component(data)
        license_id = None
        if isinstance(data.get("license"), str):
            license_id = data["license"]
        elif isinstance(data.get("license"), Mapping):
            license_id = str(
                data["license"].get("spdx")
                or data["license"].get("identifier")
                or data["license"].get("name")
                or ""
            ) or None

        streams: list[StreamKnowledge] = []
        endpoints = data.get("endpoints") or data.get("streams") or []
        if isinstance(endpoints, list):
            for ep in endpoints:
                if not isinstance(ep, Mapping):
                    continue
                sname = str(ep.get("name") or ep.get("id") or "default")
                method = ep.get("http_method") or ep.get("method")
                path_val = ep.get("path") or ep.get("endpoint")
                streams.append(
                    StreamKnowledge(
                        name=sname,
                        http_method=str(method).upper() if method else None,
                        path=str(path_val) if path_val else None,
                        event_array_path_hint=(
                            str(ep["event_array_path"]) if ep.get("event_array_path") else None
                        ),
                        evidence=[EvidenceRef(source_path=evidence_path, confidence="medium")],
                    )
                )

        auth = AuthKnowledge()
        if isinstance(data.get("auth"), Mapping):
            auth = AuthKnowledge(
                auth_type=str(data["auth"].get("type") or data["auth"].get("auth_type") or "")
                or None,
                api_base_url_hint=(
                    str(data["auth"]["base_url"]) if data["auth"].get("base_url") else None
                ),
                required_fields=[
                    str(x)
                    for x in (data["auth"].get("required_fields") or [])
                    if str(x).strip()
                ],
                evidence=[EvidenceRef(source_path=evidence_path, confidence="low")],
            )

        return HarvestedIntegrationKnowledge(
            provenance=ProvenanceKnowledge(
                ecosystem="otel",
                upstream_project=str(data.get("github_project") or "opentelemetry-collector-contrib"),
                vendor="OpenTelemetry",
                product=name,
                integration_name=name,
                upstream_version=str(data["version"]) if data.get("version") else None,
                upstream_path=str(data.get("path") or evidence_path),
                import_method=input_mode.value,
                evidence=[EvidenceRef(source_path=evidence_path, confidence="medium")],
            ),
            license=LicenseKnowledge(
                identifier=license_id,
                source=str(data.get("license_source") or "otel_metadata") if license_id else None,
            ),
            auth=auth,
            streams=streams,
            proposed_source_type=proposed,
            mapping_status=status,
            mapping_reason=reason,
            notes=[
                "Harvested from static OTel Collector Contrib metadata; Go runtime was not ported.",
            ],
        )
