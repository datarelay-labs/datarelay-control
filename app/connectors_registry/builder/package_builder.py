"""Deterministic Source Pack generation from StructuredTranslationResult.

AI must NOT write arbitrary files. Only declarative V1 content is emitted.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any

import yaml

from app.connectors_registry.builder.models import (
    UNKNOWN,
    BuilderTrustCandidate,
    StructuredTranslationResult,
)
from app.connectors_registry.harvester.path_safety import assert_no_symlink_components
from app.connectors_registry.license_policy import LicensePolicyResult


def _slugify(value: str) -> str:
    text = value.strip().lower()
    text = re.sub(r"[^a-z0-9]+", "_", text)
    text = re.sub(r"_+", "_", text).strip("_")
    return text or "builder_draft"


def _ev_value(ev: Any) -> Any:
    if ev is None:
        return None
    value = ev.value
    if value in (None, "", UNKNOWN):
        return None
    return value


def build_manifest_dict(
    translation: StructuredTranslationResult,
    *,
    license_result: LicensePolicyResult | None,
    trust_candidate: BuilderTrustCandidate,
    source_type: str,
) -> dict[str, Any]:
    vendor = _ev_value(translation.vendor) or "unknown"
    product = _ev_value(translation.product) or "builder_draft"
    package_id = _slugify(f"{vendor}_{product}")
    version = _ev_value(translation.api_family_version) or "0.1.0-draft"
    auth_type = (_ev_value(translation.auth_type) or "bearer")
    if isinstance(auth_type, str):
        auth_type = auth_type.strip().lower()

    streams_refs = []
    for stream in translation.streams:
        sid = _slugify(stream.name)
        streams_refs.append(
            {
                "id": sid,
                "name": stream.name,
                "template": f"streams/{sid}.yaml",
            }
        )

    evidence: list[dict[str, Any]] = []
    for label, ev in (
        ("vendor", translation.vendor),
        ("auth_type", translation.auth_type),
        ("api_version", translation.api_family_version),
    ):
        if ev is None:
            continue
        evidence.append(
            {
                "type": "builder",
                "ref": ev.source_ref or ev.evidence_source.value,
                "notes": f"{label}:{ev.confidence.value}:inferred={ev.inferred}",
            }
        )
    for stream in translation.streams:
        for label, ev in (
            ("endpoint", stream.path),
            ("method", stream.method),
            ("event_array_path", stream.event_array_path),
            ("checkpoint", stream.checkpoint),
        ):
            if ev is None or _ev_value(ev) is None:
                continue
            evidence.append(
                {
                    "type": "builder",
                    "ref": ev.source_ref or ev.evidence_source.value,
                    "notes": f"stream:{stream.name}:{label}:{ev.confidence.value}",
                }
            )

    license_meta: dict[str, Any] | str = "UNKNOWN"
    if license_result is not None and license_result.declared.license_identifier:
        license_meta = {"spdx": license_result.declared.license_identifier}

    upstream: dict[str, Any] = {
        "import_method": "ai_builder",
        "modified_from_upstream": True,
        "builder_trust_candidate": trust_candidate.value,
    }
    if license_result is not None:
        upstream["builder_license_decision"] = license_result.decision
        upstream["builder_license_decision_code"] = license_result.decision_code

    manifest: dict[str, Any] = {
        "schema_version": "2",
        "id": package_id,
        "package_id": package_id,
        "package_kind": "source",
        "name": product,
        "vendor": vendor,
        "product": product,
        "version": str(version),
        "pack_version": str(version),
        "source_type": source_type,
        "auth": {"type": auth_type},
        "streams": streams_refs,
        "license": license_meta,
        "upstream_provenance": {k: v for k, v in upstream.items() if v is not None},
        "capabilities": {
            "builder_draft": True,
            "auto_install": False,
            "auto_stream_enable": False,
            "auto_credential_create": False,
        },
    }
    if evidence:
        manifest["source_evidence"] = evidence
    if translation.auth_required_fields:
        manifest["auth"]["schema_ref"] = "auth.yaml"
    return manifest


def build_auth_yaml(translation: StructuredTranslationResult) -> dict[str, Any] | None:
    if not translation.auth_required_fields and not translation.auth_scopes:
        return None
    auth_type = (_ev_value(translation.auth_type) or "bearer")
    fields: list[dict[str, Any]] = []
    for name in translation.auth_required_fields:
        key = str(name).strip()
        if not key:
            continue
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
            entry["description"] = "Secret value supplied at install time (not embedded)."
        fields.append(entry)
    if translation.auth_scopes:
        fields.append(
            {
                "name": "scopes",
                "label": "Scopes",
                "required": False,
                "description": "Evidence-supported scopes: "
                + ", ".join(translation.auth_scopes),
            }
        )
    return {"type": auth_type, "fields": fields}


def build_stream_yaml(
    stream_name: str,
    translation: StructuredTranslationResult,
    *,
    default_source_type: str,
) -> dict[str, Any]:
    stream = next((s for s in translation.streams if s.name == stream_name), None)
    sid = _slugify(stream_name)
    source_type = (
        (stream.source_type if stream and stream.source_type not in (None, UNKNOWN) else None)
        or default_source_type
    )
    config_json: dict[str, Any] = {}
    if stream:
        path = _ev_value(stream.path)
        method = _ev_value(stream.method)
        event_path = _ev_value(stream.event_array_path)
        if path:
            config_json["endpoint"] = path
        if method:
            config_json["method"] = str(method).upper()
        if stream.params:
            config_json["query_params"] = dict(stream.params)
        if stream.body_template is not None:
            config_json["body"] = stream.body_template
        if event_path:
            config_json["event_array_path"] = event_path

    payload: dict[str, Any] = {
        "stream_id": sid,
        "name": stream_name,
        "description": "AI Builder draft stream (untrusted; review required)",
        "stream_type": source_type,
        "defaults": {
            "enabled": False,
            "status": "STOPPED",
        },
        "config_json": config_json,
        "validation": {
            "required_config_keys": [k for k in ("endpoint", "method") if k in config_json],
        },
    }
    polling = translation.runtime_hints.get("polling_interval_seconds")
    if isinstance(polling, int):
        payload["defaults"]["polling_interval"] = polling
    rate = translation.runtime_hints.get("rate_limit")
    if isinstance(rate, dict) and rate.get("max_requests") and rate.get("per_seconds"):
        payload["rate_limit_json"] = {
            "max_requests": rate["max_requests"],
            "per_seconds": rate["per_seconds"],
        }
    if stream:
        checkpoint = _ev_value(stream.checkpoint)
        if checkpoint:
            payload["checkpoint_defaults"] = {
                "checkpoint_type": "CUSTOM_FIELD",
                "cursor_field_path": checkpoint,
            }
    return payload


def build_readme(
    translation: StructuredTranslationResult,
    *,
    trust_candidate: BuilderTrustCandidate,
    license_result: LicensePolicyResult | None,
) -> str:
    vendor = _ev_value(translation.vendor) or "unknown"
    product = _ev_value(translation.product) or "builder draft"
    lines = [
        f"# {product}",
        "",
        "Draft Source Pack generated by Data Relay AI Connector Builder (M29.7).",
        "",
        "AI output is **untrusted draft content**. It does not grant Marketplace trust.",
        "",
        "## Identity",
        "",
        f"- Vendor: `{vendor}`",
        f"- Product: `{product}`",
        f"- Trust candidate: `{trust_candidate.value}`",
        "",
        "This package starts as **Local Draft** or **Imported Draft** only.",
        "It is never auto-promoted to Verified or Official.",
        "It is not auto-installed; streams are not auto-created or enabled;",
        "credentials are not auto-created.",
        "",
    ]
    if license_result is not None:
        lines.extend(
            [
                "## License",
                "",
                f"- Decision: `{license_result.decision}` ({license_result.decision_code})",
                f"- Reason: {license_result.decision_reason}",
                "",
            ]
        )
    if translation.open_questions:
        lines.append("## Open questions")
        lines.append("")
        for q in translation.open_questions:
            lines.append(f"- `{q.code}`: {q.message}")
        lines.append("")
    return "\n".join(lines)


def write_source_pack(
    translation: StructuredTranslationResult,
    *,
    output_dir: Path,
    trust_candidate: BuilderTrustCandidate,
    license_result: LicensePolicyResult | None = None,
    sample_payload: Any | None = None,
) -> Path:
    """Write declarative V1 Source Pack. No executable files."""

    if not translation.streams:
        raise ValueError("cannot generate Source Pack without streams")

    # Resolve package-level source type from first supported stream.
    source_type = "HTTP_API_POLLING"
    for stream in translation.streams:
        if stream.source_type and stream.source_type != UNKNOWN:
            source_type = stream.source_type
            break

    for stream in translation.streams:
        if not _ev_value(stream.path) or not _ev_value(stream.method):
            raise ValueError(
                f"unresolved required fields for stream {stream.name!r} "
                "(endpoint/method required for READY_DRAFT package)"
            )

    vendor = _ev_value(translation.vendor) or "unknown"
    product = _ev_value(translation.product) or "builder_draft"
    package_id = _slugify(f"{vendor}_{product}")
    assert_no_symlink_components(output_dir, label="builder output_dir")
    output_dir.mkdir(parents=True, exist_ok=True)
    if not output_dir.is_dir():
        raise ValueError(f"builder output_dir must be a directory: {output_dir}")

    package_root = output_dir / package_id
    assert_no_symlink_components(package_root, label="builder package output")
    if package_root.exists() or package_root.is_symlink():
        raise FileExistsError(f"builder package output already exists: {package_root}")
    package_root.mkdir(parents=False, exist_ok=False)
    (package_root / "streams").mkdir()
    (package_root / "mappings").mkdir()
    (package_root / "samples").mkdir()
    (package_root / "tests").mkdir()

    manifest = build_manifest_dict(
        translation,
        license_result=license_result,
        trust_candidate=trust_candidate,
        source_type=source_type,
    )
    (package_root / "manifest.yaml").write_text(
        yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )

    auth_doc = build_auth_yaml(translation)
    if auth_doc is not None:
        (package_root / "auth.yaml").write_text(
            yaml.safe_dump(auth_doc, sort_keys=False, allow_unicode=True),
            encoding="utf-8",
        )

    for stream in translation.streams:
        sid = _slugify(stream.name)
        stream_doc = build_stream_yaml(
            stream.name, translation, default_source_type=source_type
        )
        (package_root / "streams" / f"{sid}.yaml").write_text(
            yaml.safe_dump(stream_doc, sort_keys=False, allow_unicode=True),
            encoding="utf-8",
        )
        if stream.mapping:
            (package_root / "mappings" / f"{sid}.yaml").write_text(
                yaml.safe_dump(stream.mapping, sort_keys=False, allow_unicode=True),
                encoding="utf-8",
            )

    if sample_payload is not None:
        import json

        (package_root / "samples" / "response.json").write_text(
            json.dumps(sample_payload, indent=2, default=str),
            encoding="utf-8",
        )

    (package_root / "README.md").write_text(
        build_readme(
            translation,
            trust_candidate=trust_candidate,
            license_result=license_result,
        ),
        encoding="utf-8",
    )

    # Builder evidence sidecar (facts only).
    sidecar = {
        "builder": "m29.7",
        "trust_candidate": trust_candidate.value,
        "open_questions": [q.to_dict() for q in translation.open_questions],
        "streams": [
            {
                "name": s.name,
                "path": s.path.to_dict() if s.path else None,
                "method": s.method.to_dict() if s.method else None,
                "event_array_path": s.event_array_path.to_dict()
                if s.event_array_path
                else None,
                "checkpoint": s.checkpoint.to_dict() if s.checkpoint else None,
            }
            for s in translation.streams
        ],
    }
    (package_root / "builder_evidence.yaml").write_text(
        yaml.safe_dump(sidecar, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )
    return package_root
