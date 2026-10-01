"""Singer / Meltano static metadata harvester (M29.6).

Extracts tap identity, config/auth schema, catalog/stream schema, and
replication-key hints from static files/fixtures only.

Does NOT:
- execute a tap
- install Python dependencies
- run discovery commands
- perform HTTP/Git network I/O
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping

import yaml

from app.connectors_registry.harvester.models import (
    AuthKnowledge,
    CheckpointKnowledge,
    EvidenceRef,
    HarvestInputMode,
    HarvestedIntegrationKnowledge,
    LicenseKnowledge,
    MappingStatus,
    ProvenanceKnowledge,
    SchemaFieldKnowledge,
    StreamKnowledge,
)
from app.connectors_registry.harvester.normalizer import normalize_harvested_dict
from app.connectors_registry.harvester.sources.base import HarvesterSourceAdapter

_STRUCTURED_NAMES = (
    "harvester.json",
    "harvester.yaml",
    "harvester.yml",
    "metadata.json",
    "metadata.yaml",
    "metadata.yml",
)


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _load_yaml(path: Path) -> Any:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _load_structured(path: Path) -> Any:
    suffix = path.suffix.lower()
    if suffix == ".json":
        return _load_json(path)
    if suffix in {".yaml", ".yml"}:
        return _load_yaml(path)
    raise ValueError(f"unsupported structured metadata format: {path}")


def _find_first(root: Path, names: tuple[str, ...]) -> Path | None:
    for name in names:
        candidate = root / name
        if candidate.is_file():
            return candidate
    # Also search one level deep for tap packages.
    if root.is_dir():
        for child in sorted(root.iterdir()):
            if not child.is_dir() or child.name.startswith("."):
                continue
            for name in names:
                candidate = child / name
                if candidate.is_file():
                    return candidate
    return None


def _schema_properties_to_fields(schema: Mapping[str, Any]) -> list[SchemaFieldKnowledge]:
    props = schema.get("properties")
    if not isinstance(props, Mapping):
        return []
    required_raw = schema.get("required") or []
    required_set = {str(x) for x in required_raw} if isinstance(required_raw, list) else set()
    fields: list[SchemaFieldKnowledge] = []
    for name, spec in props.items():
        type_hint = None
        if isinstance(spec, Mapping):
            t = spec.get("type")
            if isinstance(t, list):
                type_hint = ",".join(str(x) for x in t)
            elif t is not None:
                type_hint = str(t)
        fields.append(
            SchemaFieldKnowledge(
                name=str(name),
                type_hint=type_hint,
                required=str(name) in required_set if required_set else None,
            )
        )
    return fields


def _auth_from_config_schema(config_schema: Mapping[str, Any], evidence_path: str) -> AuthKnowledge:
    props = config_schema.get("properties")
    if not isinstance(props, Mapping):
        return AuthKnowledge()
    required_raw = config_schema.get("required") or []
    required = [str(x) for x in required_raw] if isinstance(required_raw, list) else []
    # Heuristic auth type from property names (knowledge only).
    keys = {str(k).lower() for k in props.keys()}
    auth_type = None
    if "api_key" in keys or "api_token" in keys or "token" in keys:
        auth_type = "api_key"
    elif "username" in keys and "password" in keys:
        auth_type = "basic"
    elif "client_id" in keys and "client_secret" in keys:
        auth_type = "oauth2_client_credentials"
    elif "access_token" in keys:
        auth_type = "bearer"

    base_url = None
    for key in ("base_url", "api_url", "start_date"):  # start_date is not URL — skip as base
        if key in ("base_url", "api_url") and key in props:
            base_url = None  # hint only when default present
            default = props[key].get("default") if isinstance(props[key], Mapping) else None
            if isinstance(default, str) and default.strip():
                base_url = default.strip()

    return AuthKnowledge(
        auth_type=auth_type,
        api_base_url_hint=base_url,
        required_fields=required,
        evidence=[EvidenceRef(source_path=evidence_path, confidence="medium")],
    )


def _streams_from_catalog(catalog: Mapping[str, Any], evidence_path: str) -> list[StreamKnowledge]:
    streams_raw = catalog.get("streams")
    if not isinstance(streams_raw, list):
        return []
    streams: list[StreamKnowledge] = []
    for entry in streams_raw:
        if not isinstance(entry, Mapping):
            continue
        stream_obj = entry.get("stream") if isinstance(entry.get("stream"), Mapping) else entry
        if not isinstance(stream_obj, Mapping):
            continue
        name = stream_obj.get("tap_stream_id") or stream_obj.get("stream") or stream_obj.get("name")
        if not name:
            continue
        schema = stream_obj.get("schema") if isinstance(stream_obj.get("schema"), Mapping) else {}
        metadata_list = stream_obj.get("metadata") if isinstance(stream_obj.get("metadata"), list) else []
        replication_key = None
        for meta in metadata_list:
            if not isinstance(meta, Mapping):
                continue
            breadcrumb = meta.get("breadcrumb")
            md = meta.get("metadata")
            if breadcrumb == [] and isinstance(md, Mapping):
                replication_key = md.get("replication-key") or md.get("replication_key")
                if replication_key:
                    replication_key = str(replication_key)
        # Also accept top-level replication_key on stream object (fixture convenience).
        if not replication_key:
            rk = stream_obj.get("replication_key") or entry.get("replication_key")
            if rk:
                replication_key = str(rk)

        # REST endpoint metadata only when explicitly present (never invent).
        http_method = stream_obj.get("http_method") or entry.get("http_method")
        path = stream_obj.get("path") or stream_obj.get("endpoint") or entry.get("path")
        event_array = stream_obj.get("event_array_path") or entry.get("event_array_path")

        checkpoint = None
        if replication_key:
            checkpoint = CheckpointKnowledge(
                cursor_field=str(replication_key),
                evidence=[EvidenceRef(source_path=evidence_path, confidence="medium")],
            )

        streams.append(
            StreamKnowledge(
                name=str(name),
                http_method=str(http_method).upper() if http_method else None,
                path=str(path) if path else None,
                event_array_path_hint=str(event_array) if event_array else None,
                checkpoint=checkpoint,
                schema_fields=_schema_properties_to_fields(schema),
                evidence=[EvidenceRef(source_path=evidence_path, confidence="medium")],
            )
        )
    return streams


class SingerHarvesterAdapter(HarvesterSourceAdapter):
    """Singer / Meltano static knowledge adapter."""

    ecosystem = "singer"

    def harvest(
        self,
        *,
        path: Path,
        input_mode: HarvestInputMode,
        fixture_overrides: Mapping[str, Any] | None = None,
    ) -> HarvestedIntegrationKnowledge:
        root = Path(path)

        # Structured fixture / pre-normalized metadata takes precedence.
        if input_mode == HarvestInputMode.STRUCTURED_METADATA_FIXTURE:
            if root.is_file():
                data = _load_structured(root)
            else:
                structured = _find_first(root, _STRUCTURED_NAMES)
                if structured is None:
                    raise ValueError(f"no structured Singer metadata found under {root}")
                data = _load_structured(structured)
            if not isinstance(data, Mapping):
                raise ValueError("Singer structured metadata must be a mapping")
            merged = dict(data)
            if fixture_overrides:
                merged.update(dict(fixture_overrides))
            if "ecosystem" not in merged and "identity" not in merged:
                merged["ecosystem"] = "singer"
            return normalize_harvested_dict(
                merged,
                default_ecosystem="singer",
                default_import_method=input_mode.value,
            )

        if not root.is_dir():
            raise ValueError(f"Singer harvest path must be a directory for {input_mode.value}: {root}")

        # Prefer explicit harvester metadata if present in snapshot.
        structured = _find_first(root, _STRUCTURED_NAMES)
        if structured is not None:
            data = _load_structured(structured)
            if isinstance(data, Mapping):
                merged = dict(data)
                if fixture_overrides:
                    merged.update(dict(fixture_overrides))
                return normalize_harvested_dict(
                    merged,
                    default_ecosystem="singer",
                    default_import_method=input_mode.value,
                )

        return self._harvest_static_tap_layout(root, input_mode=input_mode)

    def _harvest_static_tap_layout(
        self,
        root: Path,
        *,
        input_mode: HarvestInputMode,
    ) -> HarvestedIntegrationKnowledge:
        evidence: list[EvidenceRef] = []
        tap_name = root.name
        vendor = "singer"
        version = None
        license_id = None

        # meltano.yml / singer.yml identity
        for name in ("meltano.yml", "meltano.yaml", "singer.yml", "singer.yaml"):
            candidate = root / name
            if not candidate.is_file():
                continue
            data = _load_yaml(candidate)
            evidence.append(EvidenceRef(source_path=str(candidate.name), confidence="medium"))
            if isinstance(data, Mapping):
                if isinstance(data.get("plugins"), Mapping):
                    extractors = data["plugins"].get("extractors")
                    if isinstance(extractors, list) and extractors:
                        first = extractors[0]
                        if isinstance(first, Mapping):
                            tap_name = str(first.get("name") or tap_name)
                            version = (
                                str(first["version"]) if first.get("version") is not None else version
                            )
                tap_name = str(data.get("name") or data.get("tap") or tap_name)
                if data.get("license"):
                    license_id = str(data["license"])
                if data.get("version"):
                    version = str(data["version"])

        # config schema
        auth = AuthKnowledge()
        config_schema_path = _find_first(
            root,
            ("config.schema.json", "tap_config.schema.json", "config_schema.json"),
        )
        if config_schema_path is not None:
            schema = _load_json(config_schema_path)
            if isinstance(schema, Mapping):
                auth = _auth_from_config_schema(schema, config_schema_path.name)
                evidence.append(
                    EvidenceRef(source_path=config_schema_path.name, confidence="medium")
                )

        # catalog
        streams: list[StreamKnowledge] = []
        catalog_path = _find_first(root, ("catalog.json", "tap_catalog.json", "discover.json"))
        if catalog_path is not None:
            catalog = _load_json(catalog_path)
            if isinstance(catalog, Mapping):
                streams = _streams_from_catalog(catalog, catalog_path.name)
                evidence.append(EvidenceRef(source_path=catalog_path.name, confidence="medium"))

        # LICENSE file detection (identifier only — not legal advice).
        for lic_name in ("LICENSE", "LICENSE.md", "LICENSE.txt"):
            lic_path = root / lic_name
            if lic_path.is_file():
                text = lic_path.read_text(encoding="utf-8", errors="replace")[:2000]
                upper = text.upper()
                if "MIT LICENSE" in upper or upper.strip().startswith("MIT"):
                    license_id = license_id or "MIT"
                elif "APACHE LICENSE" in upper and "2.0" in upper:
                    license_id = license_id or "Apache-2.0"
                evidence.append(EvidenceRef(source_path=lic_name, confidence="low"))
                break

        # Mapping: only HTTP_API_POLLING when at least one stream has explicit REST path+method.
        http_streams = [s for s in streams if s.path and s.http_method]
        if http_streams:
            mapping_status = MappingStatus.MAPPED
            proposed = "HTTP_API_POLLING"
            mapping_reason = "Singer catalog streams include explicit REST path+method evidence"
            # Prefer only streams that map cleanly for packaging.
            streams = http_streams
        elif streams:
            mapping_status = MappingStatus.UNSUPPORTED
            proposed = None
            mapping_reason = (
                "Singer streams present but no explicit REST endpoint metadata; "
                "knowledge retained without executable Source Pack mapping"
            )
        else:
            mapping_status = MappingStatus.UNSUPPORTED
            proposed = None
            mapping_reason = "no Singer catalog/streams found"

        return HarvestedIntegrationKnowledge(
            provenance=ProvenanceKnowledge(
                ecosystem="singer",
                upstream_project=tap_name,
                vendor=vendor,
                product=tap_name,
                integration_name=tap_name,
                upstream_version=version,
                upstream_path=str(root.name),
                import_method=input_mode.value,
                evidence=evidence,
            ),
            license=LicenseKnowledge(identifier=license_id, source="static_file" if license_id else None),
            auth=auth,
            streams=streams,
            proposed_source_type=proposed,
            mapping_status=mapping_status,
            mapping_reason=mapping_reason,
            notes=[
                "Harvested from static Singer/Meltano files only; tap was not executed.",
            ],
        )


# Meltano is the same adapter surface under an alias ecosystem key.
class MeltanoHarvesterAdapter(SingerHarvesterAdapter):
    """Alias adapter registered as ``meltano`` (same static extraction)."""

    ecosystem = "meltano"
