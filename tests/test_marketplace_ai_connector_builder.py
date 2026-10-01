"""Tests for M29.7 AI Connector Translator / Builder."""

from __future__ import annotations

import ast
import json
from pathlib import Path

import pytest
import yaml

from app.connectors_registry.builder import (
    AUTO_CREDENTIAL_CREATE,
    AUTO_INSTALL,
    AUTO_STREAM_CREATE,
    AUTO_STREAM_ENABLE,
    DEPENDENCY_INSTALL,
    PRODUCTION_AI_PROVIDER_IMPLEMENTED,
    SCRIPT_EXECUTION,
    SUBPROCESS_EXECUTION,
    TRUST_AUTO_PROMOTION,
    BuilderRequest,
    BuilderStatus,
    BuilderTrustCandidate,
    DocumentationEvidence,
    OpenApiEvidence,
    SampleEvidence,
    ScriptReferenceEvidence,
    UnknownProviderError,
    UserIntent,
    build_connector_draft,
    build_default_provider_registry,
)
from app.connectors_registry.builder.evidence import (
    extract_openapi_summary,
    inspect_script_text,
    redact_secrets_in_text,
    redact_secrets_in_value,
    sample_path_resolves,
)
from app.connectors_registry.builder.models import (
    EVIDENCE_PRIORITY_RANK,
    EvidenceSourceKind,
)
from app.connectors_registry.builder.result_validator import (
    StructuredResultValidationError,
    parse_structured_translation,
)
from app.connectors_registry.harvester.normalizer import normalize_harvested_dict
from app.connectors_registry.license_policy import (
    LICENSE_DECISION_ALLOW,
    LICENSE_DECISION_DENY,
    LICENSE_DECISION_REFERENCE_ONLY,
    LICENSE_DECISION_REVIEW,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "builder"


def _ev(value, source="openapi", confidence="HIGH", inferred=False):
    return {
        "value": value,
        "evidence_source": source,
        "confidence": confidence,
        "inferred": inferred,
    }


def _load_yaml(name: str) -> dict:
    return yaml.safe_load((FIXTURES / name).read_text(encoding="utf-8"))


def _load_json(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _harvested(name: str):
    return normalize_harvested_dict(_load_yaml(name), default_ecosystem="singer")


def test_provider_registry_lists_fixture_and_manual() -> None:
    registry = build_default_provider_registry()
    assert "fixture" in registry.known()
    assert "manual" in registry.known()


def test_unknown_provider_rejected(tmp_path: Path) -> None:
    result = build_connector_draft(
        BuilderRequest(
            intent=UserIntent(vendor="Acme", product="X"),
            openapi=OpenApiEvidence(document=_load_yaml("openapi_events.yaml")),
            provider_name="does-not-exist",
            output_dir=tmp_path,
        )
    )
    assert result.status == BuilderStatus.BLOCKED
    assert any(i.code == "UNKNOWN_PROVIDER" for i in result.validation_issues)
    with pytest.raises(UnknownProviderError):
        build_default_provider_registry().get("nope")


def test_structured_result_validation_rejects_freeform() -> None:
    with pytest.raises(StructuredResultValidationError):
        parse_structured_translation({"manifest": {"id": "x"}, "streams": []})
    with pytest.raises(StructuredResultValidationError):
        parse_structured_translation(
            {
                "identity": {"vendor": "Acme"},
                "auth": {},
                "streams": [],
            }
        )


def test_structured_result_validation_accepts_schema() -> None:
    parsed = parse_structured_translation(
        {
            "identity": {
                "vendor": _ev("Acme"),
                "product": _ev("Events"),
                "api_family_version": _ev("1.0.0"),
            },
            "auth": {"auth_type": _ev("api_key"), "required_fields": ["api_key"], "scopes": []},
            "streams": [
                {
                    "name": "events",
                    "source_type": "HTTP_API_POLLING",
                    "method": _ev("GET"),
                    "path": _ev("/v1/events"),
                    "event_array_path": _ev("$.items", "sample"),
                    "checkpoint": _ev("UNKNOWN", "ai_inference", "UNKNOWN", True),
                }
            ],
            "open_questions": [],
        }
    )
    assert parsed.vendor is not None
    assert parsed.vendor.value == "Acme"
    assert parsed.streams[0].path is not None
    assert parsed.streams[0].path.value == "/v1/events"


def test_ai_inference_cannot_be_high_confidence() -> None:
    with pytest.raises(StructuredResultValidationError):
        parse_structured_translation(
            {
                "identity": {"vendor": _ev("Acme")},
                "auth": {"auth_type": _ev("bearer")},
                "streams": [
                    {
                        "name": "x",
                        "method": _ev("GET"),
                        "path": _ev("/x", "ai_inference", "HIGH", True),
                    }
                ],
            }
        )


def test_capability_flags() -> None:
    assert PRODUCTION_AI_PROVIDER_IMPLEMENTED is False
    assert SCRIPT_EXECUTION is False
    assert SUBPROCESS_EXECUTION is False
    assert DEPENDENCY_INSTALL is False
    assert AUTO_INSTALL is False
    assert AUTO_STREAM_CREATE is False
    assert AUTO_STREAM_ENABLE is False
    assert AUTO_CREDENTIAL_CREATE is False
    assert TRUST_AUTO_PROMOTION is False


def test_sample_outranks_documentation(tmp_path: Path) -> None:
    result = build_connector_draft(
        BuilderRequest(
            intent=UserIntent(vendor="Acme", product="Events"),
            openapi=OpenApiEvidence(document=_load_yaml("openapi_events.yaml")),
            sample=SampleEvidence(payload=_load_json("sample_events.json")),
            documentation=DocumentationEvidence(
                text="Events are under results array",
                structured={"endpoints": ["/v1/events"]},
            ),
            supplied_translation={
                "identity": {
                    "vendor": _ev("Acme", "documentation"),
                    "product": _ev("Events", "documentation"),
                    "api_family_version": _ev("1.0.0", "openapi"),
                },
                "auth": {"auth_type": _ev("api_key", "openapi"), "required_fields": []},
                "streams": [
                    {
                        "name": "events",
                        "source_type": "HTTP_API_POLLING",
                        "method": _ev("GET", "openapi"),
                        "path": _ev("/v1/events", "openapi"),
                        "event_array_path": _ev("$.results", "documentation", "MEDIUM"),
                        "checkpoint": _ev("UNKNOWN", "ai_inference", "UNKNOWN", True),
                    }
                ],
            },
            provider_name="manual",
            output_dir=tmp_path,
        )
    )
    assert result.translation is not None
    assert result.translation.streams[0].event_array_path is not None
    assert result.translation.streams[0].event_array_path.value == "$.items"
    assert (
        result.translation.streams[0].event_array_path.evidence_source
        == EvidenceSourceKind.SAMPLE
    )


def test_openapi_deterministic_facts_preserved() -> None:
    summary = extract_openapi_summary(_load_yaml("openapi_events.yaml"))
    assert summary.base_url == "https://api.example.com"
    paths = {p["path"] for p in summary.paths}
    assert "/v1/events" in paths
    assert "/v1/users" in paths
    assert any(p["method"] == "GET" for p in summary.paths)
    assert summary.auth_hints


def test_conflicts_surfaced(tmp_path: Path) -> None:
    result = build_connector_draft(
        BuilderRequest(
            intent=UserIntent(vendor="Acme", product="Events"),
            openapi=OpenApiEvidence(document=_load_yaml("openapi_events.yaml")),
            sample=SampleEvidence(payload=_load_json("sample_conflict.json")),
            supplied_translation={
                "identity": {
                    "vendor": _ev("Acme"),
                    "product": _ev("Events"),
                    "api_family_version": _ev("1.0.0"),
                },
                "auth": {"auth_type": _ev("api_key")},
                "streams": [
                    {
                        "name": "events",
                        "source_type": "HTTP_API_POLLING",
                        "method": _ev("GET"),
                        "path": _ev("/v1/events"),
                        "event_array_path": _ev("$.items", "openapi", "MEDIUM"),
                        "checkpoint": _ev("UNKNOWN", "ai_inference", "UNKNOWN", True),
                    }
                ],
            },
            provider_name="manual",
            output_dir=tmp_path,
        )
    )
    assert result.translation is not None
    assert result.translation.streams[0].event_array_path.value == "$.data"
    assert any(c.field.endswith("event_array_path") for c in result.conflicts)


def test_evidence_refs_retained(tmp_path: Path) -> None:
    result = build_connector_draft(
        BuilderRequest(
            intent=UserIntent(),
            harvested_knowledge=_harvested("harvested_allow.yaml"),
            provider_name="fixture",
            trust_candidate=BuilderTrustCandidate.IMPORTED_DRAFT,
            output_dir=tmp_path,
        )
    )
    assert result.package_generated is True
    assert result.package_path is not None
    manifest = yaml.safe_load((result.package_path / "manifest.yaml").read_text())
    assert manifest.get("source_evidence")
    sidecar = yaml.safe_load((result.package_path / "builder_evidence.yaml").read_text())
    assert sidecar["streams"][0]["path"]["evidence_source"] == "harvested"


def test_unsupported_ai_inference_blocked(tmp_path: Path) -> None:
    result = build_connector_draft(
        BuilderRequest(
            intent=UserIntent(vendor="Acme", product="Events"),
            documentation=DocumentationEvidence(
                text=(FIXTURES / "incomplete_docs.txt").read_text()
            ),
            supplied_translation={
                "identity": {
                    "vendor": _ev("Acme", "documentation"),
                    "product": _ev("Events", "documentation"),
                    "api_family_version": _ev("UNKNOWN", "ai_inference", "UNKNOWN", True),
                },
                "auth": {
                    "auth_type": _ev("bearer", "ai_inference", "LOW", True),
                    "required_fields": [],
                },
                "streams": [
                    {
                        "name": "events",
                        "source_type": "HTTP_API_POLLING",
                        "method": _ev("GET", "ai_inference", "LOW", True),
                        "path": _ev("/v9/invented", "ai_inference", "LOW", True),
                        "event_array_path": _ev("UNKNOWN", "ai_inference", "UNKNOWN", True),
                        "checkpoint": _ev("UNKNOWN", "ai_inference", "UNKNOWN", True),
                    }
                ],
            },
            provider_name="manual",
            output_dir=tmp_path,
        )
    )
    assert result.package_generated is False
    assert result.status in {BuilderStatus.BLOCKED, BuilderStatus.INCOMPLETE}
    assert any(
        i.code in {"HALLUCINATED_ENDPOINT", "UNSUPPORTED_AI_INFERENCE"}
        for i in result.validation_issues
    )


def test_manual_translation_cannot_spoof_openapi_endpoint_evidence(
    tmp_path: Path,
) -> None:
    result = build_connector_draft(
        BuilderRequest(
            intent=UserIntent(vendor="Acme", product="Events"),
            openapi=OpenApiEvidence(document=_load_yaml("openapi_events.yaml")),
            supplied_translation={
                "identity": {
                    "vendor": _ev("Acme", "openapi"),
                    "product": _ev("Events", "openapi"),
                },
                "auth": {"auth_type": _ev("api_key", "openapi")},
                "streams": [
                    {
                        "name": "events",
                        "source_type": "HTTP_API_POLLING",
                        "method": _ev("GET", "openapi"),
                        "path": _ev("/v9/invented", "openapi"),
                    }
                ],
            },
            provider_name="manual",
            output_dir=tmp_path,
        )
    )
    assert result.package_generated is False
    assert result.status == BuilderStatus.BLOCKED
    assert any(
        i.code == "UNSUPPORTED_EVIDENCE_CLAIM"
        for i in result.validation_issues
    )


def test_evidence_priority_ordering() -> None:
    assert EVIDENCE_PRIORITY_RANK[EvidenceSourceKind.SAMPLE] < EVIDENCE_PRIORITY_RANK[
        EvidenceSourceKind.OPENAPI
    ]
    assert EVIDENCE_PRIORITY_RANK[EvidenceSourceKind.OPENAPI] < EVIDENCE_PRIORITY_RANK[
        EvidenceSourceKind.HARVESTED
    ]
    assert EVIDENCE_PRIORITY_RANK[EvidenceSourceKind.AI_INFERENCE] == max(
        EVIDENCE_PRIORITY_RANK.values()
    )


def test_script_not_executed_and_clues_usable(tmp_path: Path) -> None:
    text = (FIXTURES / "script_clues.py").read_text(encoding="utf-8")
    ast.parse(text)
    _redacted, clues = inspect_script_text(text)
    assert "/v1/events" in clues.endpoints
    assert "GET" in clues.methods
    assert "cursor" in clues.pagination_hints or "limit" in clues.pagination_hints
    assert "updated_at" in clues.checkpoint_hints
    assert "items" in clues.response_path_hints

    result = build_connector_draft(
        BuilderRequest(
            intent=UserIntent(vendor="Acme", product="Events", desired_streams=["events"]),
            script_reference=ScriptReferenceEvidence(text=text, language_hint="python"),
            provider_name="fixture",
            output_dir=tmp_path,
        )
    )
    assert result.evidence_summary.get("script_executed") is False
    assert result.package_generated is True
    assert result.translation is not None
    assert result.translation.streams[0].path is not None
    assert result.translation.streams[0].path.value == "/v1/events"


def test_script_secret_redacted(tmp_path: Path) -> None:
    text = (FIXTURES / "script_with_secret.py").read_text(encoding="utf-8")
    redacted, count = redact_secrets_in_text(text)
    assert count >= 1
    assert "supersecretvalue1234567890" not in redacted
    assert "***REDACTED***" in redacted

    result = build_connector_draft(
        BuilderRequest(
            intent=UserIntent(vendor="Acme", product="Alerts"),
            script_reference=ScriptReferenceEvidence(text=text),
            provider_name="fixture",
            output_dir=tmp_path,
        )
    )
    assert result.evidence_summary.get("script_secrets_redacted") is True
    if result.package_path:
        for path in result.package_path.rglob("*"):
            if path.is_file():
                content = path.read_text(encoding="utf-8", errors="replace")
                assert "supersecretvalue1234567890" not in content


def test_sample_secret_values_redacted_for_provider_input() -> None:
    sample = {
        "items": [{"id": "evt-1", "message": "ok"}],
        "api_key": "literal-sample-key",
        "nested": {
            "authorization": "Bearer verylongliteraltoken1234567890",
            "secret": True,
        },
    }
    redacted, count = redact_secrets_in_value(sample)
    assert count >= 2
    assert redacted["api_key"] == "***REDACTED***"
    assert "verylongliteraltoken1234567890" not in redacted["nested"]["authorization"]
    assert redacted["nested"]["secret"] is True
    assert sample["api_key"] == "literal-sample-key"


def test_no_subprocess_eval_import_in_builder_modules() -> None:
    root = Path(__file__).resolve().parents[1] / "app" / "connectors_registry" / "builder"
    for path in root.rglob("*.py"):
        src = path.read_text(encoding="utf-8")
        assert "import subprocess" not in src
        assert "from subprocess" not in src
        assert "os.system(" not in src


def test_complete_openapi_sample_produces_draft(tmp_path: Path) -> None:
    result = build_connector_draft(
        BuilderRequest(
            intent=UserIntent(vendor="Acme", product="Events API", desired_streams=["listEvents"]),
            openapi=OpenApiEvidence(document=_load_yaml("openapi_events.yaml")),
            sample=SampleEvidence(payload=_load_json("sample_events.json")),
            provider_name="fixture",
            trust_candidate=BuilderTrustCandidate.LOCAL_DRAFT,
            output_dir=tmp_path,
        )
    )
    assert result.status == BuilderStatus.READY_DRAFT
    assert result.package_generated is True
    assert result.validation_status == "PASS"
    assert result.trust_candidate == BuilderTrustCandidate.LOCAL_DRAFT
    assert result.package_path is not None
    assert (result.package_path / "manifest.yaml").is_file()
    assert (result.package_path / "streams").is_dir()
    assert (result.package_path / "README.md").is_file()
    assert (result.package_path / "samples" / "response.json").is_file()
    for path in result.package_path.rglob("*"):
        if path.is_file():
            assert path.suffix.lower() not in {".py", ".sh", ".js"}


def test_existing_builder_output_is_not_overwritten(tmp_path: Path) -> None:
    request = BuilderRequest(
        intent=UserIntent(vendor="Acme", product="Events API", desired_streams=["listEvents"]),
        openapi=OpenApiEvidence(document=_load_yaml("openapi_events.yaml")),
        sample=SampleEvidence(payload=_load_json("sample_events.json")),
        provider_name="fixture",
        output_dir=tmp_path,
    )
    first = build_connector_draft(request)
    assert first.package_generated is True
    assert first.package_path is not None
    sentinel = first.package_path / "operator-note.txt"
    sentinel.write_text("preserve", encoding="utf-8")

    second = build_connector_draft(request)
    assert second.package_generated is False
    assert second.validation_status == "FAIL"
    assert any(i.code == "PACKAGE_BUILD_FAILED" for i in second.validation_issues)
    assert sentinel.read_text(encoding="utf-8") == "preserve"


def test_builder_symlink_parent_output_is_rejected(tmp_path: Path) -> None:
    real_parent = tmp_path / "real-parent"
    real_parent.mkdir()
    linked_parent = tmp_path / "linked-parent"
    linked_parent.symlink_to(real_parent, target_is_directory=True)

    result = build_connector_draft(
        BuilderRequest(
            intent=UserIntent(vendor="Acme", product="Events API", desired_streams=["listEvents"]),
            openapi=OpenApiEvidence(document=_load_yaml("openapi_events.yaml")),
            sample=SampleEvidence(payload=_load_json("sample_events.json")),
            provider_name="fixture",
            output_dir=linked_parent / "nested",
        )
    )
    assert result.package_generated is False
    assert result.validation_status == "FAIL"
    assert any(
        i.code == "PACKAGE_BUILD_FAILED" and "symlink" in i.message.lower()
        for i in result.validation_issues
    )
    assert not (real_parent / "nested").exists()


def test_incomplete_docs_prevent_ready_draft(tmp_path: Path) -> None:
    result = build_connector_draft(
        BuilderRequest(
            intent=UserIntent(vendor="Acme", product="Events"),
            documentation=DocumentationEvidence(
                text=(FIXTURES / "incomplete_docs.txt").read_text()
            ),
            provider_name="fixture",
            output_dir=tmp_path,
        )
    )
    assert result.package_generated is False
    assert result.status in {BuilderStatus.INCOMPLETE, BuilderStatus.BLOCKED}


def test_unresolved_required_field_prevents_ready_draft(tmp_path: Path) -> None:
    result = build_connector_draft(
        BuilderRequest(
            intent=UserIntent(vendor="Acme", product="Events"),
            documentation=DocumentationEvidence(text="vendor docs without endpoints"),
            supplied_translation={
                "identity": {
                    "vendor": _ev("Acme", "documentation"),
                    "product": _ev("Events", "documentation"),
                },
                "auth": {"auth_type": _ev("UNKNOWN", "ai_inference", "UNKNOWN", True)},
                "streams": [
                    {
                        "name": "events",
                        "source_type": "HTTP_API_POLLING",
                        "method": _ev("UNKNOWN", "ai_inference", "UNKNOWN", True),
                        "path": _ev("UNKNOWN", "ai_inference", "UNKNOWN", True),
                    }
                ],
                "open_questions": [
                    {
                        "code": "MISSING_ENDPOINT",
                        "message": "no endpoint",
                        "severity": "error",
                    }
                ],
            },
            provider_name="manual",
            output_dir=tmp_path,
        )
    )
    assert result.status != BuilderStatus.READY_DRAFT
    assert result.package_generated is False


def test_missing_checkpoint_is_open_question_not_fabricated(tmp_path: Path) -> None:
    result = build_connector_draft(
        BuilderRequest(
            intent=UserIntent(vendor="Acme", product="Events"),
            openapi=OpenApiEvidence(document=_load_yaml("openapi_events.yaml")),
            sample=SampleEvidence(payload=_load_json("sample_events.json")),
            provider_name="fixture",
            output_dir=tmp_path,
        )
    )
    assert result.translation is not None
    cps = [s.checkpoint for s in result.translation.streams if s.checkpoint]
    for cp in cps:
        if cp.inferred or cp.evidence_source == EvidenceSourceKind.AI_INFERENCE:
            assert cp.confidence.value in {"UNKNOWN", "LOW", "MEDIUM"}
            assert cp.value in {"UNKNOWN", None} or cp.confidence.value != "HIGH"


def test_sample_path_validation_blocks(tmp_path: Path) -> None:
    assert sample_path_resolves({"items": []}, "$.items")
    assert not sample_path_resolves({"items": []}, "$.missing")

    # Sample without standard array keys so reconciliation cannot auto-repair.
    odd_sample = {"payload": {"rows": [{"id": 1}]}}
    result = build_connector_draft(
        BuilderRequest(
            intent=UserIntent(vendor="Acme", product="Events"),
            openapi=OpenApiEvidence(document=_load_yaml("openapi_events.yaml")),
            sample=SampleEvidence(payload=odd_sample),
            supplied_translation={
                "identity": {
                    "vendor": _ev("Acme"),
                    "product": _ev("Events"),
                    "api_family_version": _ev("1.0.0"),
                },
                "auth": {"auth_type": _ev("api_key")},
                "streams": [
                    {
                        "name": "events",
                        "source_type": "HTTP_API_POLLING",
                        "method": _ev("GET"),
                        "path": _ev("/v1/events"),
                        "event_array_path": _ev(
                            "$.does_not_exist", "documentation", "MEDIUM", False
                        ),
                    }
                ],
            },
            provider_name="manual",
            output_dir=tmp_path,
        )
    )
    assert any(i.code == "SAMPLE_PATH_UNRESOLVED" for i in result.validation_issues)
    assert result.package_generated is False


def test_unsupported_source_type(tmp_path: Path) -> None:
    result = build_connector_draft(
        BuilderRequest(
            intent=UserIntent(vendor="Acme", product="Kafkaish"),
            openapi=OpenApiEvidence(document=_load_yaml("openapi_events.yaml")),
            supplied_translation={
                "identity": {"vendor": _ev("Acme"), "product": _ev("Kafkaish")},
                "auth": {"auth_type": _ev("no_auth")},
                "streams": [
                    {
                        "name": "topic",
                        "source_type": "KAFKA_CONSUMER",
                        "method": _ev("GET", "openapi"),
                        "path": _ev("/v1/events", "openapi"),
                    }
                ],
            },
            provider_name="manual",
            output_dir=tmp_path,
        )
    )
    assert result.package_generated is False
    assert result.status in {BuilderStatus.BLOCKED, BuilderStatus.INCOMPLETE}


def test_harvested_allow_imported_draft(tmp_path: Path) -> None:
    result = build_connector_draft(
        BuilderRequest(
            intent=UserIntent(),
            harvested_knowledge=_harvested("harvested_allow.yaml"),
            provider_name="fixture",
            trust_candidate=BuilderTrustCandidate.IMPORTED_DRAFT,
            output_dir=tmp_path,
        )
    )
    assert result.license_decision == LICENSE_DECISION_ALLOW
    assert result.package_generated is True
    assert result.trust_candidate == BuilderTrustCandidate.IMPORTED_DRAFT
    assert result.status == BuilderStatus.READY_DRAFT


def test_harvested_review_path(tmp_path: Path) -> None:
    result = build_connector_draft(
        BuilderRequest(
            intent=UserIntent(),
            harvested_knowledge=_harvested("harvested_review.yaml"),
            provider_name="fixture",
            trust_candidate=BuilderTrustCandidate.IMPORTED_DRAFT,
            output_dir=tmp_path,
        )
    )
    assert result.license_decision == LICENSE_DECISION_REVIEW
    assert any(i.code == "LICENSE_REVIEW_REQUIRED" for i in result.validation_issues)
    if result.package_generated:
        assert result.status == BuilderStatus.NEEDS_REVIEW


def test_reference_only_blocked_without_independent_evidence(tmp_path: Path) -> None:
    result = build_connector_draft(
        BuilderRequest(
            intent=UserIntent(),
            harvested_knowledge=_harvested("harvested_reference.yaml"),
            provider_name="fixture",
            output_dir=tmp_path,
        )
    )
    assert result.license_decision == LICENSE_DECISION_REFERENCE_ONLY
    assert result.package_generated is False
    assert result.status == BuilderStatus.BLOCKED


def test_deny_remains_blocked(tmp_path: Path) -> None:
    result = build_connector_draft(
        BuilderRequest(
            intent=UserIntent(),
            harvested_knowledge=_harvested("harvested_deny.yaml"),
            denied_licenses=frozenset({"DENY-TEST-LICENSE"}),
            provider_name="fixture",
            output_dir=tmp_path,
        )
    )
    assert result.license_decision == LICENSE_DECISION_DENY
    assert result.package_generated is False
    assert result.status == BuilderStatus.BLOCKED


def test_local_draft_no_trust_promotion(tmp_path: Path) -> None:
    result = build_connector_draft(
        BuilderRequest(
            intent=UserIntent(vendor="Acme", product="Events API"),
            openapi=OpenApiEvidence(document=_load_yaml("openapi_events.yaml")),
            sample=SampleEvidence(payload=_load_json("sample_events.json")),
            provider_name="fixture",
            trust_candidate=BuilderTrustCandidate.LOCAL_DRAFT,
            output_dir=tmp_path,
        )
    )
    assert result.trust_candidate == BuilderTrustCandidate.LOCAL_DRAFT
    assert result.trust_candidate.value not in {"Verified", "Official", "Community"}
    assert TRUST_AUTO_PROMOTION is False


def test_external_agent_authoring_contract_exists() -> None:
    schema = (
        Path(__file__).resolve().parents[1]
        / "app"
        / "connectors_registry"
        / "builder"
        / "schemas"
        / "structured_translation_result.v1.json"
    )
    assert schema.is_file()
    data = json.loads(schema.read_text(encoding="utf-8"))
    assert data["title"] == "StructuredTranslationResult"
    assert "streams" in data["properties"]


def test_cli_module_entrypoint(tmp_path: Path) -> None:
    from app.connectors_registry.builder.__main__ import main

    input_path = tmp_path / "input.json"
    input_path.write_text(
        json.dumps(
            {
                "intent": {"vendor": "Acme", "product": "Events"},
                "openapi": _load_yaml("openapi_events.yaml"),
                "sample": _load_json("sample_events.json"),
            }
        ),
        encoding="utf-8",
    )
    out = tmp_path / "out"
    rc = main(["--input", str(input_path), "--provider", "fixture", "--output", str(out)])
    assert rc == 0


def test_cli_rejects_symlink_input(tmp_path: Path) -> None:
    from app.connectors_registry.builder.__main__ import main

    real_input = tmp_path / "real-input.json"
    real_input.write_text(
        json.dumps(
            {
                "intent": {"vendor": "Acme", "product": "Events"},
                "openapi": _load_yaml("openapi_events.yaml"),
                "sample": _load_json("sample_events.json"),
            }
        ),
        encoding="utf-8",
    )
    linked_input = tmp_path / "linked-input.json"
    linked_input.symlink_to(real_input)

    with pytest.raises(SystemExit) as exc:
        main(
            [
                "--input",
                str(linked_input),
                "--provider",
                "fixture",
                "--output",
                str(tmp_path / "out"),
            ]
        )
    assert "symlink" in str(exc.value).lower()
