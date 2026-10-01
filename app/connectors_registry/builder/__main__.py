"""CLI entrypoint: python -m app.connectors_registry.builder

Example:

  python -m app.connectors_registry.builder \\
    --input builder-input.json \\
    --provider fixture \\
    --output ./draft-out
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import yaml

from app.connectors_registry.builder.models import (
    BuilderRequest,
    BuilderTrustCandidate,
    DocumentationEvidence,
    OpenApiEvidence,
    SampleEvidence,
    ScriptReferenceEvidence,
    UserIntent,
)
from app.connectors_registry.builder.service import build_connector_draft
from app.connectors_registry.harvester.normalizer import normalize_harvested_dict
from app.connectors_registry.harvester.path_safety import assert_no_symlink_components


_MAX_STRUCTURED_INPUT_BYTES = 8 * 1024 * 1024
_MAX_TEXT_INPUT_BYTES = 2 * 1024 * 1024


def _read_input_text(path: Path, *, max_bytes: int) -> str:
    try:
        assert_no_symlink_components(path, label="builder input path")
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    if not path.is_file():
        raise SystemExit(f"builder input must be a regular file: {path}")
    if path.stat().st_size > max_bytes:
        raise SystemExit(f"builder input exceeds {max_bytes} bytes: {path}")
    return path.read_text(encoding="utf-8")


def _load_mapping(path: Path) -> dict[str, Any]:
    text = _read_input_text(path, max_bytes=_MAX_STRUCTURED_INPUT_BYTES)
    if path.suffix.lower() in {".yaml", ".yml"}:
        loaded = yaml.safe_load(text)
    else:
        loaded = json.loads(text)
    if not isinstance(loaded, dict):
        raise SystemExit(f"input must be a mapping: {path}")
    return loaded


def _request_from_dict(data: dict[str, Any], *, output_dir: Path | None, provider: str) -> BuilderRequest:
    intent_raw = data.get("intent") if isinstance(data.get("intent"), dict) else {}
    intent = UserIntent(
        vendor=intent_raw.get("vendor") or data.get("vendor"),
        product=intent_raw.get("product") or data.get("product"),
        desired_streams=list(intent_raw.get("desired_streams") or data.get("desired_streams") or []),
        known_api_base_url=intent_raw.get("known_api_base_url"),
        known_auth_type=intent_raw.get("known_auth_type"),
        notes=intent_raw.get("notes"),
    )

    harvested = None
    if isinstance(data.get("harvested_knowledge"), dict):
        harvested = normalize_harvested_dict(
            data["harvested_knowledge"],
            default_ecosystem=str(data.get("ecosystem") or "builder"),
        )

    openapi = None
    if isinstance(data.get("openapi"), dict):
        openapi = OpenApiEvidence(document=data["openapi"])
    elif isinstance(data.get("openapi_path"), str):
        openapi = OpenApiEvidence(document=_load_mapping(Path(data["openapi_path"])))

    sample = None
    if "sample" in data:
        sample = SampleEvidence(payload=data["sample"])
    elif isinstance(data.get("sample_path"), str):
        sample_path = Path(data["sample_path"])
        sample = SampleEvidence(
            payload=json.loads(
                _read_input_text(sample_path, max_bytes=_MAX_STRUCTURED_INPUT_BYTES)
            )
        )

    documentation = None
    if isinstance(data.get("documentation"), str):
        documentation = DocumentationEvidence(text=data["documentation"])
    elif isinstance(data.get("documentation"), dict):
        documentation = DocumentationEvidence(
            text=str(data["documentation"].get("text") or ""),
            structured=data["documentation"].get("structured"),
        )

    script = None
    if isinstance(data.get("script"), str):
        script = ScriptReferenceEvidence(text=data["script"])
    elif isinstance(data.get("script_path"), str):
        script = ScriptReferenceEvidence(
            text=_read_input_text(
                Path(data["script_path"]),
                max_bytes=_MAX_TEXT_INPUT_BYTES,
            )
        )

    trust_raw = str(data.get("trust_candidate") or "Local Draft")
    trust = (
        BuilderTrustCandidate.IMPORTED_DRAFT
        if "import" in trust_raw.lower()
        else BuilderTrustCandidate.LOCAL_DRAFT
    )

    return BuilderRequest(
        intent=intent,
        harvested_knowledge=harvested,
        openapi=openapi,
        sample=sample,
        documentation=documentation,
        script_reference=script,
        output_dir=output_dir,
        trust_candidate=trust,
        provider_name=provider,
        supplied_translation=data.get("supplied_translation")
        if isinstance(data.get("supplied_translation"), dict)
        else None,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.connectors_registry.builder",
        description="Data Relay AI Connector Builder (M29.7) — draft Source Pack generation",
    )
    parser.add_argument("--input", required=True, help="Builder input JSON/YAML path")
    parser.add_argument(
        "--provider",
        default="fixture",
        help="Translation provider (fixture|manual). Production network providers deferred.",
    )
    parser.add_argument("--output", required=True, help="Draft output directory")
    args = parser.parse_args(argv)

    data = _load_mapping(Path(args.input))
    request = _request_from_dict(data, output_dir=Path(args.output), provider=args.provider)
    result = build_connector_draft(request)
    print(json.dumps(result.to_dict(), indent=2, default=str))
    if result.status.value in {"BLOCKED"} and not result.package_generated:
        return 2
    if result.validation_status == "FAIL":
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
