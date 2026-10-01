"""Build Data Relay draft Source Packs from harvested knowledge (M29.6).

Only evidence-supported fields are emitted. Unknown values stay absent —
never fabricate event_array_path, checkpoint, pagination, API versions, or scopes.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any

import yaml

from app.connectors_registry.harvester.models import (
    HarvestedIntegrationKnowledge,
    MappingStatus,
    TrustCandidate,
)
from app.connectors_registry.harvester.path_safety import assert_no_symlink_components
from app.connectors_registry.license_policy import LicensePolicyResult


def _slugify(value: str) -> str:
    text = value.strip().lower()
    text = re.sub(r"[^a-z0-9]+", "_", text)
    text = re.sub(r"_+", "_", text).strip("_")
    return text or "imported"


def _stream_slug(name: str) -> str:
    return _slugify(name)


def build_manifest_dict(
    knowledge: HarvestedIntegrationKnowledge,
    *,
    license_result: LicensePolicyResult,
    trust_candidate: TrustCandidate,
) -> dict[str, Any]:
    """Construct a Manifest v2 dict from harvested knowledge + license decision."""

    prov = knowledge.provenance
    package_id = _slugify(
        prov.integration_name
        or prov.upstream_project
        or f"{prov.ecosystem}_import"
    )
    version = prov.upstream_version or "0.1.0"
    vendor = prov.vendor or prov.ecosystem or "imported"
    product = prov.product or prov.integration_name or package_id
    name = prov.integration_name or product

    auth_type = (knowledge.auth.auth_type or "bearer").strip().lower()
    # Normalize common aliases to Data Relay auth types.
    auth_aliases = {
        "api_key": "api_key",
        "apikey": "api_key",
        "bearer": "bearer",
        "basic": "basic",
        "oauth2": "oauth2_client_credentials",
        "oauth2_client_credentials": "oauth2_client_credentials",
        "no_auth": "no_auth",
        "none": "no_auth",
    }
    auth_type = auth_aliases.get(auth_type, auth_type)

    streams_refs: list[dict[str, Any]] = []
    for stream in knowledge.streams:
        sid = _stream_slug(stream.name)
        streams_refs.append(
            {
                "id": sid,
                "name": stream.name,
                "template": f"streams/{sid}.yaml",
            }
        )

    source_evidence: list[dict[str, Any]] = []
    for ev in prov.evidence:
        ref = ev.source_path or ev.documentation_ref
        if not ref:
            continue
        source_evidence.append(
            {
                "type": "harvester",
                "ref": ref,
                "notes": ev.notes,
            }
        )
    for stream in knowledge.streams:
        for ev in stream.evidence:
            ref = ev.source_path or ev.documentation_ref
            if not ref:
                continue
            source_evidence.append(
                {
                    "type": "harvester",
                    "ref": ref,
                    "notes": ev.notes or f"stream:{stream.name}",
                }
            )

    if not source_evidence and prov.upstream_path:
        source_evidence.append(
            {
                "type": "harvester",
                "ref": prov.upstream_path,
                "notes": "upstream path from harvest",
            }
        )

    license_meta: dict[str, Any] | str
    if knowledge.license.identifier:
        license_meta = {
            "spdx": knowledge.license.identifier,
            "source": knowledge.license.source,
            "notice_required": knowledge.license.notice_required
            if knowledge.license.notice_required is not None
            else True,
        }
        # Drop nulls for cleaner YAML.
        license_meta = {k: v for k, v in license_meta.items() if v is not None}
    else:
        license_meta = "UNKNOWN"

    upstream_provenance: dict[str, Any] = {
        "upstream_project": prov.upstream_project,
        "upstream_url": prov.upstream_url,
        "upstream_path": prov.upstream_path,
        "upstream_commit_or_version": prov.upstream_commit or prov.upstream_version,
        "license_spdx_or_detected_license": knowledge.license.identifier,
        "license_source": knowledge.license.source,
        "notice_required": knowledge.license.notice_required,
        "modified_from_upstream": True,
        "import_method": prov.import_method or "harvester_static",
        # Platform-derived decision recorded as *evidence notes*, not spoofed
        # platform-owned decision fields on the package (those are stripped).
        "harvester_license_decision": license_result.decision,
        "harvester_license_decision_code": license_result.decision_code,
        "harvester_trust_candidate": trust_candidate.value,
        "harvester_ecosystem": prov.ecosystem,
    }
    upstream_provenance = {k: v for k, v in upstream_provenance.items() if v is not None}

    manifest: dict[str, Any] = {
        "schema_version": "2",
        "id": package_id,
        "package_id": package_id,
        "package_kind": "source",
        "name": name,
        "vendor": vendor,
        "product": product,
        "version": version,
        "pack_version": version,
        "source_type": knowledge.proposed_source_type or "HTTP_API_POLLING",
        "auth": {"type": auth_type},
        "streams": streams_refs,
        "license": license_meta,
        "upstream_provenance": upstream_provenance,
        "capabilities": {
            "harvester_draft": True,
            "auto_install": False,
            "auto_stream_enable": False,
        },
    }
    if source_evidence:
        manifest["source_evidence"] = source_evidence

    # Auth schema ref when we have required field knowledge.
    if knowledge.auth.required_fields:
        manifest["auth"]["schema_ref"] = "auth.yaml"

    return manifest


def build_auth_yaml(knowledge: HarvestedIntegrationKnowledge) -> dict[str, Any] | None:
    """Build auth.yaml when required field hints exist (no secret values)."""

    if not knowledge.auth.required_fields and not knowledge.auth.api_base_url_hint:
        return None

    auth_type = (knowledge.auth.auth_type or "bearer").strip().lower()
    fields: list[dict[str, Any]] = []
    if knowledge.auth.api_base_url_hint or "base_url" in [
        f.lower() for f in knowledge.auth.required_fields
    ]:
        field: dict[str, Any] = {
            "name": "base_url",
            "label": "API Base URL",
            "required": True,
        }
        if knowledge.auth.api_base_url_hint:
            field["description"] = f"Hint from harvest: {knowledge.auth.api_base_url_hint}"
        fields.append(field)

    for name in knowledge.auth.required_fields:
        key = name.strip()
        if not key or key.lower() == "base_url":
            continue
        # Mark obvious secret field names without embedding values.
        is_secret = any(
            token in key.lower()
            for token in ("password", "secret", "token", "key", "credential")
        )
        entry: dict[str, Any] = {
            "name": key,
            "label": key.replace("_", " ").title(),
            "required": True,
        }
        if is_secret:
            entry["secret"] = True
        fields.append(entry)

    # Scopes only when evidenced.
    if knowledge.auth.scopes:
        fields.append(
            {
                "name": "scopes",
                "label": "Scopes",
                "required": False,
                "description": "Documented scopes (evidence-supported): "
                + ", ".join(knowledge.auth.scopes),
            }
        )

    return {"type": auth_type, "fields": fields}


def build_stream_yaml(stream_name: str, knowledge: HarvestedIntegrationKnowledge) -> dict[str, Any]:
    """Build one stream YAML from evidenced fields only."""

    stream = next((s for s in knowledge.streams if s.name == stream_name), None)
    sid = _stream_slug(stream_name)
    source_type = knowledge.proposed_source_type or "HTTP_API_POLLING"

    config_json: dict[str, Any] = {}
    if stream and stream.path:
        config_json["endpoint"] = stream.path
    if stream and stream.http_method:
        config_json["method"] = stream.http_method.upper()
    if stream and stream.query_parameters:
        config_json["query_params"] = dict(stream.query_parameters)
    if stream and stream.request_body_hint is not None:
        config_json["body"] = stream.request_body_hint
    # event_array_path only when explicitly evidenced — never fabricate.
    if stream and stream.event_array_path_hint:
        config_json["event_array_path"] = stream.event_array_path_hint

    payload: dict[str, Any] = {
        "stream_id": sid,
        "name": stream_name,
        "description": f"Harvester draft stream from {knowledge.provenance.ecosystem}",
        "stream_type": source_type,
        "defaults": {
            "enabled": False,
            "status": "STOPPED",
        },
        "config_json": config_json,
        "validation": {
            "required_config_keys": [
                k for k in ("endpoint", "method") if k in config_json
            ],
        },
    }

    if knowledge.runtime.polling_interval_seconds is not None:
        payload["defaults"]["polling_interval"] = knowledge.runtime.polling_interval_seconds

    if (
        knowledge.runtime.rate_limit_max_requests is not None
        and knowledge.runtime.rate_limit_per_seconds is not None
    ):
        payload["rate_limit_json"] = {
            "max_requests": knowledge.runtime.rate_limit_max_requests,
            "per_seconds": knowledge.runtime.rate_limit_per_seconds,
        }

    # Checkpoint only when explicitly present.
    if stream and stream.checkpoint and stream.checkpoint.cursor_field:
        payload["checkpoint_defaults"] = {
            "checkpoint_type": "CUSTOM_FIELD",
            "cursor_field_path": stream.checkpoint.cursor_field,
        }

    return payload


def build_readme(knowledge: HarvestedIntegrationKnowledge, license_result: LicensePolicyResult) -> str:
    """Generate a short README with provenance (no upstream prose copy)."""

    prov = knowledge.provenance
    lines = [
        f"# {prov.integration_name or prov.upstream_project or 'Harvested Connector'}",
        "",
        "Draft Source Pack generated by Data Relay Connector Harvester (M29.6).",
        "",
        "## Provenance",
        "",
        f"- Ecosystem: `{prov.ecosystem}`",
        f"- Upstream project: `{prov.upstream_project or 'unknown'}`",
        f"- Upstream path: `{prov.upstream_path or 'unknown'}`",
        f"- Version/commit: `{prov.upstream_commit or prov.upstream_version or 'unknown'}`",
        f"- Import method: `{prov.import_method or 'harvester_static'}`",
        f"- License: `{knowledge.license.identifier or 'unknown'}`",
        f"- License decision: `{license_result.decision}` ({license_result.decision_code})",
        f"- Mapping status: `{knowledge.mapping_status.value}`",
        "",
        "This package starts as **Imported** / **Local Draft**. It is never",
        "auto-promoted to Verified or Official. It is not auto-installed.",
        "",
        "Only evidence-supported fields are included. Missing fields are intentional.",
        "",
    ]
    if knowledge.notes:
        lines.append("## Notes")
        lines.append("")
        for note in knowledge.notes:
            lines.append(f"- {note}")
        lines.append("")
    return "\n".join(lines)


def write_source_pack(
    knowledge: HarvestedIntegrationKnowledge,
    *,
    output_dir: Path,
    license_result: LicensePolicyResult,
    trust_candidate: TrustCandidate,
) -> Path:
    """Write a draft Source Pack directory. Returns the package root path."""

    if knowledge.mapping_status != MappingStatus.MAPPED:
        raise ValueError(
            f"cannot generate Source Pack for mapping_status={knowledge.mapping_status.value}"
        )
    if not knowledge.proposed_source_type:
        raise ValueError("cannot generate Source Pack without proposed_source_type")

    package_id = _slugify(
        knowledge.provenance.integration_name
        or knowledge.provenance.upstream_project
        or f"{knowledge.provenance.ecosystem}_import"
    )
    assert_no_symlink_components(output_dir, label="harvester output_dir")
    output_dir.mkdir(parents=True, exist_ok=True)
    if not output_dir.is_dir():
        raise ValueError(f"harvester output_dir must be a directory: {output_dir}")

    package_root = output_dir / package_id
    assert_no_symlink_components(package_root, label="harvester package output")
    if package_root.exists() or package_root.is_symlink():
        raise FileExistsError(f"harvester package output already exists: {package_root}")
    package_root.mkdir(parents=False, exist_ok=False)
    try:
        (package_root / "streams").mkdir()
        (package_root / "mappings").mkdir()
        (package_root / "samples").mkdir()
        (package_root / "tests").mkdir()

        manifest = build_manifest_dict(
            knowledge,
            license_result=license_result,
            trust_candidate=trust_candidate,
        )
        (package_root / "manifest.yaml").write_text(
            yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True),
            encoding="utf-8",
        )

        auth_doc = build_auth_yaml(knowledge)
        if auth_doc is not None:
            (package_root / "auth.yaml").write_text(
                yaml.safe_dump(auth_doc, sort_keys=False, allow_unicode=True),
                encoding="utf-8",
            )

        for stream in knowledge.streams:
            sid = _stream_slug(stream.name)
            stream_doc = build_stream_yaml(stream.name, knowledge)
            (package_root / "streams" / f"{sid}.yaml").write_text(
                yaml.safe_dump(stream_doc, sort_keys=False, allow_unicode=True),
                encoding="utf-8",
            )

        (package_root / "README.md").write_text(
            build_readme(knowledge, license_result),
            encoding="utf-8",
        )

        evidence_sidecar = {
            "ecosystem": knowledge.provenance.ecosystem,
            "upstream_project": knowledge.provenance.upstream_project,
            "upstream_path": knowledge.provenance.upstream_path,
            "upstream_version": knowledge.provenance.upstream_version,
            "upstream_commit": knowledge.provenance.upstream_commit,
            "import_method": knowledge.provenance.import_method,
            "license": knowledge.license.identifier,
            "license_decision": license_result.decision,
            "license_decision_code": license_result.decision_code,
            "trust_candidate": trust_candidate.value,
            "mapping_status": knowledge.mapping_status.value,
            "evidence": [
                {
                    "source_path": e.source_path,
                    "documentation_ref": e.documentation_ref,
                    "notes": e.notes,
                    "confidence": e.confidence,
                }
                for e in knowledge.provenance.evidence
            ],
        }
        (package_root / "harvester_evidence.yaml").write_text(
            yaml.safe_dump(evidence_sidecar, sort_keys=False, allow_unicode=True),
            encoding="utf-8",
        )
        return package_root
    except Exception:
        # package_root was created by this call and was proven absent above, so
        # cleanup cannot remove pre-existing operator content.
        shutil.rmtree(package_root, ignore_errors=True)
        raise
