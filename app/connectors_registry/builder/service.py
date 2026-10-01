"""AI Connector Translator / Builder service (M29.7).

Pipeline:

  User / Harvester Evidence
    → Normalized Builder Input
    → AI Translation Provider (fixture/manual; production network OPTIONAL)
    → Strict Structured Translation Result
    → Evidence / Confidence Reconciliation
    → Draft Source Pack
    → Marketplace Validator (+ secret scan)
    → Local Draft / Imported Draft

AI must NOT install, enable streams, create credentials, publish, or assign
Verified/Official. AI output is always untrusted draft content.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from app.connectors_registry.builder.evidence import (
    build_bounded_provider_request,
    collect_known_endpoints,
    documentation_text,
    extract_openapi_summary,
    inspect_script_text,
    reconcile_field,
    sample_path_resolves,
)
from app.connectors_registry.builder.models import (
    UNKNOWN,
    BuilderIssue,
    BuilderRequest,
    BuilderResult,
    BuilderStatus,
    BuilderTrustCandidate,
    Confidence,
    EvidenceSourceKind,
    EvidencedValue,
    OpenQuestion,
    StructuredTranslationResult,
    SUPPORTED_SOURCE_TYPES,
)
from app.connectors_registry.builder.package_builder import write_source_pack
from app.connectors_registry.builder.prompt_contract import render_provider_prompt
from app.connectors_registry.builder.providers.fixture import ManualTranslationProvider
from app.connectors_registry.builder.providers.registry import (
    ProviderRegistry,
    UnknownProviderError,
    build_default_provider_registry,
)
from app.connectors_registry.builder.result_validator import (
    StructuredResultValidationError,
    parse_structured_translation,
)
from app.connectors_registry.harvester.models import ContentReuseClass
from app.connectors_registry.lifecycle_errors import LifecycleError
from app.connectors_registry.license_policy import (
    LICENSE_DECISION_DENY,
    LICENSE_DECISION_REFERENCE_ONLY,
    LICENSE_DECISION_REVIEW,
    LicensePolicyConfig,
    LicensePolicyResult,
    evaluate_license_policy,
)
from app.connectors_registry.package_digest import compute_canonical_package_digest
from app.connectors_registry.package_secret_scan import assert_package_secrets_clean
from app.connectors_registry.package_validator import validate_marketplace_package

# Capability flags for result reports / operators.
PRODUCTION_AI_PROVIDER_IMPLEMENTED = False
SCRIPT_EXECUTION = False
SUBPROCESS_EXECUTION = False
DEPENDENCY_INSTALL = False
AUTO_INSTALL = False
AUTO_STREAM_CREATE = False
AUTO_STREAM_ENABLE = False
AUTO_CREDENTIAL_CREATE = False
TRUST_AUTO_PROMOTION = False


class BuilderService:
    """Orchestrates evidence → provider → validate → draft package."""

    def __init__(self, registry: ProviderRegistry | None = None) -> None:
        self._registry = registry or build_default_provider_registry()

    @property
    def registry(self) -> ProviderRegistry:
        return self._registry

    def build(self, request: BuilderRequest) -> BuilderResult:
        issues: list[BuilderIssue] = []
        open_questions: list[OpenQuestion] = []
        conflicts: list = []
        evidence_summary: dict[str, Any] = {
            "has_harvested": request.harvested_knowledge is not None,
            "has_openapi": request.openapi is not None,
            "has_sample": request.sample is not None,
            "has_documentation": request.documentation is not None,
            "has_script": request.script_reference is not None,
            "script_executed": False,
            "subprocess_used": False,
        }

        # --- License / provenance gate when harvested knowledge present ---
        license_result: LicensePolicyResult | None = None
        trust = request.trust_candidate
        if request.harvested_knowledge is not None:
            # Harvested inputs default to Imported Draft unless caller forced Local Draft.
            if trust != BuilderTrustCandidate.LOCAL_DRAFT:
                trust = BuilderTrustCandidate.IMPORTED_DRAFT
            license_result = self._evaluate_license(request)
            if license_result.decision == LICENSE_DECISION_DENY:
                return BuilderResult(
                    status=BuilderStatus.BLOCKED,
                    package_generated=False,
                    package_path=None,
                    validation_status="BLOCKED",
                    validation_issues=[
                        BuilderIssue(
                            code="LICENSE_DENY",
                            message=license_result.decision_reason,
                        )
                    ],
                    license_decision=license_result.decision,
                    license_decision_code=license_result.decision_code,
                    license_decision_reason=license_result.decision_reason,
                    trust_candidate=trust,
                    evidence_summary=evidence_summary,
                    provider_name=request.provider_name,
                )
            if license_result.decision == LICENSE_DECISION_REFERENCE_ONLY:
                # REFERENCE_ONLY may inform factual interpretation but must not
                # become distributable package content from harvested material alone.
                request.harvested_knowledge.content_reuse = ContentReuseClass.RESTRICTED
                has_independent = any(
                    [
                        request.openapi is not None,
                        request.sample is not None,
                        request.documentation is not None,
                        request.script_reference is not None,
                    ]
                )
                if not has_independent and request.supplied_translation is None:
                    return BuilderResult(
                        status=BuilderStatus.BLOCKED,
                        package_generated=False,
                        package_path=None,
                        validation_status="BLOCKED",
                        validation_issues=[
                            BuilderIssue(
                                code="LICENSE_REFERENCE_ONLY",
                                message=(
                                    "REFERENCE_ONLY harvested knowledge cannot produce "
                                    "a distributable package without independent evidence"
                                ),
                                severity="error",
                            )
                        ],
                        open_questions=[
                            OpenQuestion(
                                code="LICENSE_REFERENCE_ONLY",
                                message=license_result.decision_reason,
                                severity="error",
                            )
                        ],
                        license_decision=license_result.decision,
                        license_decision_code=license_result.decision_code,
                        license_decision_reason=license_result.decision_reason,
                        trust_candidate=trust,
                        evidence_summary=evidence_summary,
                        provider_name=request.provider_name,
                    )
                issues.append(
                    BuilderIssue(
                        code="LICENSE_REFERENCE_ONLY_INDEPENDENT",
                        message=(
                            "Harvested content is REFERENCE_ONLY; package uses "
                            "independent evidence only"
                        ),
                        severity="warning",
                    )
                )
            if license_result.decision == LICENSE_DECISION_REVIEW:
                issues.append(
                    BuilderIssue(
                        code="LICENSE_REVIEW_REQUIRED",
                        message=license_result.decision_reason,
                        severity="warning",
                    )
                )

        # --- Normalize evidence ---
        openapi_summary = None
        if request.openapi is not None:
            openapi_summary = extract_openapi_summary(request.openapi.document)

        script_redacted = None
        script_clues = None
        if request.script_reference is not None:
            script_redacted, script_clues = inspect_script_text(request.script_reference.text)
            evidence_summary["script_secrets_redacted"] = script_clues.secrets_redacted
            evidence_summary["script_redaction_count"] = script_clues.redaction_count

        doc_text = documentation_text(request.documentation)
        known_endpoints = collect_known_endpoints(request, openapi_summary, script_clues)
        evidence_summary["known_endpoints"] = sorted(known_endpoints)

        bounded = build_bounded_provider_request(
            request,
            openapi_summary=openapi_summary,
            script_redacted=script_redacted,
            script_clues=script_clues,
            documentation_text=doc_text,
        )
        # Ensure provider prompt is bounded (side-effect: validates serializable).
        _ = render_provider_prompt(bounded)

        # --- Provider dispatch ---
        provider_name = (request.provider_name or "fixture").strip().lower()
        try:
            if provider_name == "manual" or request.supplied_translation is not None:
                if request.supplied_translation is None and provider_name == "manual":
                    return BuilderResult(
                        status=BuilderStatus.BLOCKED,
                        package_generated=False,
                        package_path=None,
                        validation_status="BLOCKED",
                        validation_issues=[
                            BuilderIssue(
                                code="MANUAL_TRANSLATION_REQUIRED",
                                message="manual provider requires supplied_translation",
                            )
                        ],
                        trust_candidate=trust,
                        evidence_summary=evidence_summary,
                        provider_name="manual",
                    )
                provider = ManualTranslationProvider(request.supplied_translation)
                provider_name = "manual"
            else:
                provider = self._registry.get(provider_name)
        except UnknownProviderError as exc:
            return BuilderResult(
                status=BuilderStatus.BLOCKED,
                package_generated=False,
                package_path=None,
                validation_status="BLOCKED",
                validation_issues=[
                    BuilderIssue(code="UNKNOWN_PROVIDER", message=str(exc))
                ],
                trust_candidate=trust,
                evidence_summary=evidence_summary,
                provider_name=provider_name,
            )

        try:
            raw_translation = dict(provider.translate(bounded))
        except Exception as exc:  # noqa: BLE001
            return BuilderResult(
                status=BuilderStatus.BLOCKED,
                package_generated=False,
                package_path=None,
                validation_status="BLOCKED",
                validation_issues=[
                    BuilderIssue(code="PROVIDER_FAILED", message=str(exc))
                ],
                trust_candidate=trust,
                evidence_summary=evidence_summary,
                provider_name=provider_name,
                license_decision=license_result.decision if license_result else None,
                license_decision_code=license_result.decision_code if license_result else None,
                license_decision_reason=license_result.decision_reason if license_result else None,
            )

        try:
            translation = parse_structured_translation(raw_translation)
        except StructuredResultValidationError as exc:
            return BuilderResult(
                status=BuilderStatus.BLOCKED,
                package_generated=False,
                package_path=None,
                validation_status="BLOCKED",
                validation_issues=[
                    BuilderIssue(code="INVALID_STRUCTURED_RESULT", message=msg)
                    for msg in exc.issues
                ],
                trust_candidate=trust,
                evidence_summary=evidence_summary,
                provider_name=provider_name,
                license_decision=license_result.decision if license_result else None,
                license_decision_code=license_result.decision_code if license_result else None,
                license_decision_reason=license_result.decision_reason if license_result else None,
            )

        # --- Evidence reconciliation / hallucination gate ---
        translation, recon_issues, recon_questions, recon_conflicts = self._reconcile(
            request,
            translation,
            known_endpoints=known_endpoints,
            openapi_summary=openapi_summary,
        )
        issues.extend(recon_issues)
        open_questions.extend(translation.open_questions)
        open_questions.extend(recon_questions)
        conflicts.extend(recon_conflicts)

        # Unsupported source types → open question / reject
        for stream in translation.streams:
            st = stream.source_type
            if st and st != UNKNOWN and st not in SUPPORTED_SOURCE_TYPES:
                open_questions.append(
                    OpenQuestion(
                        code="UNSUPPORTED_SOURCE_TYPE",
                        message=f"Unsupported source type {st!r}",
                        field=f"streams.{stream.name}.source_type",
                        severity="error",
                    )
                )
                stream.source_type = UNKNOWN

        # Sample path validation
        if request.sample is not None:
            for stream in translation.streams:
                ev = stream.event_array_path
                if ev is None or ev.value in (None, UNKNOWN):
                    continue
                if not sample_path_resolves(request.sample.payload, str(ev.value)):
                    issues.append(
                        BuilderIssue(
                            code="SAMPLE_PATH_UNRESOLVED",
                            message=(
                                f"event_array_path {ev.value!r} does not resolve "
                                f"against sample for stream {stream.name}"
                            ),
                        )
                    )
                    open_questions.append(
                        OpenQuestion(
                            code="SAMPLE_PATH_UNRESOLVED",
                            message=f"JSONPath {ev.value!r} failed against sample",
                            field=f"streams.{stream.name}.event_array_path",
                            severity="error",
                        )
                    )
                    # Do not silently replace with another guess.
                    stream.event_array_path = EvidencedValue(
                        value=UNKNOWN,
                        evidence_source=EvidenceSourceKind.SAMPLE,
                        confidence=Confidence.UNKNOWN,
                        inferred=False,
                        notes="cleared: path did not resolve against sample",
                    )

        confidence_summary = self._confidence_summary(translation)
        blocking = [i for i in issues if i.severity == "error"]
        missing_required = self._missing_required(translation)
        for msg in missing_required:
            open_questions.append(
                OpenQuestion(
                    code="UNRESOLVED_REQUIRED_FIELD",
                    message=msg,
                    severity="error",
                )
            )

        # License REVIEW without package auto-generation preference → NEEDS_REVIEW
        if license_result and license_result.decision == LICENSE_DECISION_REVIEW:
            # Still allow draft if independent evidence complete, but mark review.
            pass

        if blocking or any(
            q.severity == "error"
            and q.code in {"HALLUCINATED_ENDPOINT", "UNSUPPORTED_EVIDENCE_CLAIM"}
            for q in open_questions
        ):
            # Hallucinated endpoints are blocking.
            hallu = [
                q
                for q in open_questions
                if q.code in {"HALLUCINATED_ENDPOINT", "UNSUPPORTED_EVIDENCE_CLAIM"}
            ]
            if hallu or blocking:
                status = BuilderStatus.BLOCKED if hallu or any(
                    i.code in {
                        "SAMPLE_PATH_UNRESOLVED",
                        "UNSUPPORTED_AI_INFERENCE",
                        "HALLUCINATED_ENDPOINT",
                        "UNSUPPORTED_EVIDENCE_CLAIM",
                    }
                    for i in issues
                ) else BuilderStatus.INCOMPLETE
                # Continue to attempt status classification below.

        can_package = (
            bool(translation.streams)
            and not missing_required
            and not any(
                i.code in {
                    "SAMPLE_PATH_UNRESOLVED",
                    "HALLUCINATED_ENDPOINT",
                    "UNSUPPORTED_AI_INFERENCE",
                    "UNSUPPORTED_EVIDENCE_CLAIM",
                }
                for i in issues
            )
            and not (
                license_result
                and license_result.decision == LICENSE_DECISION_DENY
            )
        )

        if not can_package:
            status = BuilderStatus.BLOCKED if any(
                i.code in {
                    "HALLUCINATED_ENDPOINT",
                    "UNSUPPORTED_AI_INFERENCE",
                    "SAMPLE_PATH_UNRESOLVED",
                    "UNSUPPORTED_EVIDENCE_CLAIM",
                }
                or i.code.startswith("LICENSE_DENY")
                for i in issues
            ) else BuilderStatus.INCOMPLETE
            if license_result and license_result.decision == LICENSE_DECISION_REVIEW and not missing_required:
                status = BuilderStatus.NEEDS_REVIEW
            return BuilderResult(
                status=status,
                package_generated=False,
                package_path=None,
                validation_status="SKIPPED",
                validation_issues=issues,
                open_questions=open_questions,
                conflicts=conflicts,
                confidence_summary=confidence_summary,
                evidence_summary=evidence_summary,
                license_decision=license_result.decision if license_result else None,
                license_decision_code=license_result.decision_code if license_result else None,
                license_decision_reason=license_result.decision_reason if license_result else None,
                trust_candidate=trust,
                translation=translation,
                provider_name=provider_name,
            )

        if request.output_dir is None:
            return BuilderResult(
                status=BuilderStatus.NEEDS_REVIEW
                if (license_result and license_result.decision == LICENSE_DECISION_REVIEW)
                else BuilderStatus.INCOMPLETE,
                package_generated=False,
                package_path=None,
                validation_status="BLOCKED",
                validation_issues=issues
                + [
                    BuilderIssue(
                        code="OUTPUT_DIR_REQUIRED",
                        message="output_dir is required to generate a draft Source Pack",
                    )
                ],
                open_questions=open_questions,
                conflicts=conflicts,
                confidence_summary=confidence_summary,
                evidence_summary=evidence_summary,
                license_decision=license_result.decision if license_result else None,
                license_decision_code=license_result.decision_code if license_result else None,
                license_decision_reason=license_result.decision_reason if license_result else None,
                trust_candidate=trust,
                translation=translation,
                provider_name=provider_name,
            )

        # REFERENCE_ONLY harvested-only path already handled; for ALLOW/independent:
        if (
            license_result
            and license_result.decision == LICENSE_DECISION_REFERENCE_ONLY
            and request.harvested_knowledge is not None
            and request.openapi is None
            and request.sample is None
            and request.documentation is None
            and request.script_reference is None
            and request.supplied_translation is None
        ):
            return BuilderResult(
                status=BuilderStatus.BLOCKED,
                package_generated=False,
                package_path=None,
                validation_status="BLOCKED",
                validation_issues=issues
                + [
                    BuilderIssue(
                        code="LICENSE_REFERENCE_ONLY",
                        message="cannot package REFERENCE_ONLY harvested content alone",
                    )
                ],
                open_questions=open_questions,
                license_decision=license_result.decision,
                license_decision_code=license_result.decision_code,
                license_decision_reason=license_result.decision_reason,
                trust_candidate=trust,
                translation=translation,
                provider_name=provider_name,
                evidence_summary=evidence_summary,
            )

        output_dir = Path(request.output_dir)
        try:
            package_path = write_source_pack(
                translation,
                output_dir=output_dir,
                trust_candidate=trust,
                license_result=license_result,
                sample_payload=request.sample.payload if request.sample else None,
            )
        except Exception as exc:  # noqa: BLE001
            return BuilderResult(
                status=BuilderStatus.INCOMPLETE,
                package_generated=False,
                package_path=None,
                validation_status="FAIL",
                validation_issues=issues
                + [BuilderIssue(code="PACKAGE_BUILD_FAILED", message=str(exc))],
                open_questions=open_questions,
                conflicts=conflicts,
                confidence_summary=confidence_summary,
                evidence_summary=evidence_summary,
                license_decision=license_result.decision if license_result else None,
                license_decision_code=license_result.decision_code if license_result else None,
                license_decision_reason=license_result.decision_reason if license_result else None,
                trust_candidate=trust,
                translation=translation,
                provider_name=provider_name,
            )

        # Reject executable files if any slipped in (defense in depth).
        exec_issues = self._reject_executables(package_path)
        if exec_issues:
            issues.extend(exec_issues)
            return BuilderResult(
                status=BuilderStatus.BLOCKED,
                package_generated=False,
                package_path=package_path,
                validation_status="FAIL",
                validation_issues=issues,
                open_questions=open_questions,
                conflicts=conflicts,
                confidence_summary=confidence_summary,
                evidence_summary=evidence_summary,
                license_decision=license_result.decision if license_result else None,
                license_decision_code=license_result.decision_code if license_result else None,
                license_decision_reason=license_result.decision_reason if license_result else None,
                trust_candidate=trust,
                translation=translation,
                provider_name=provider_name,
            )

        validation_status, validation_details, val_issues = self._validate_package(package_path)
        issues.extend(val_issues)

        if validation_status != "PASS":
            return BuilderResult(
                status=BuilderStatus.INCOMPLETE,
                package_generated=False,
                package_path=package_path,
                validation_status=validation_status,
                validation_issues=issues,
                open_questions=open_questions,
                conflicts=conflicts,
                confidence_summary=confidence_summary,
                evidence_summary=evidence_summary,
                license_decision=license_result.decision if license_result else None,
                license_decision_code=license_result.decision_code if license_result else None,
                license_decision_reason=license_result.decision_reason if license_result else None,
                trust_candidate=trust,
                translation=translation,
                validation_details=validation_details,
                provider_name=provider_name,
            )

        status = BuilderStatus.READY_DRAFT
        if license_result and license_result.decision == LICENSE_DECISION_REVIEW:
            status = BuilderStatus.NEEDS_REVIEW
        elif any(q.severity == "warning" for q in open_questions):
            # Warnings alone still allow READY_DRAFT when package validated.
            status = BuilderStatus.READY_DRAFT

        return BuilderResult(
            status=status,
            package_generated=True,
            package_path=package_path,
            validation_status="PASS",
            validation_issues=issues,
            open_questions=open_questions,
            conflicts=conflicts,
            confidence_summary=confidence_summary,
            evidence_summary=evidence_summary,
            license_decision=license_result.decision if license_result else None,
            license_decision_code=license_result.decision_code if license_result else None,
            license_decision_reason=license_result.decision_reason if license_result else None,
            trust_candidate=trust,
            translation=translation,
            validation_details=validation_details,
            provider_name=provider_name,
        )

    def _reconcile(
        self,
        request: BuilderRequest,
        translation: StructuredTranslationResult,
        *,
        known_endpoints: set[str],
        openapi_summary: Any,
    ) -> tuple[
        StructuredTranslationResult,
        list[BuilderIssue],
        list[OpenQuestion],
        list,
    ]:
        issues: list[BuilderIssue] = []
        questions: list[OpenQuestion] = []
        conflicts: list = []

        # Overlay sample-priority for event_array_path when sample evidence present.
        if request.sample is not None:
            sample = request.sample.payload
            if isinstance(sample, dict):
                for key in ("items", "data", "results", "events", "records"):
                    if isinstance(sample.get(key), list):
                        sample_path = f"$.{key}"
                        for stream in translation.streams:
                            candidates = []
                            if stream.event_array_path is not None:
                                candidates.append(stream.event_array_path)
                            candidates.append(
                                EvidencedValue(
                                    value=sample_path,
                                    evidence_source=EvidenceSourceKind.SAMPLE,
                                    confidence=Confidence.HIGH,
                                    inferred=False,
                                    source_ref="sample_evidence",
                                )
                            )
                            winner = reconcile_field(
                                f"streams.{stream.name}.event_array_path",
                                candidates,
                                conflicts,
                                questions,
                            )
                            stream.event_array_path = winner
                        break

        # Preserve deterministic OpenAPI paths — AI must not invent others.
        require_evidence = request.constraints.require_evidence_for_endpoints
        for stream in translation.streams:
            path_ev = stream.path
            if path_ev is None:
                continue
            path_val = path_ev.value
            if path_val in (None, "", UNKNOWN):
                continue
            path_s = str(path_val)
            matched = any(
                path_s == k or path_s.rstrip("/") == k.rstrip("/") or k.endswith(path_s)
                for k in known_endpoints
            )
            if require_evidence and not matched:
                is_ai_claim = (
                    path_ev.inferred
                    or path_ev.evidence_source == EvidenceSourceKind.AI_INFERENCE
                )
                issue_code = (
                    "HALLUCINATED_ENDPOINT"
                    if is_ai_claim
                    else "UNSUPPORTED_EVIDENCE_CLAIM"
                )
                issues.append(
                    BuilderIssue(
                        code=issue_code,
                        message=(
                            f"Endpoint {path_s!r} is not backed by supplied non-AI evidence"
                        ),
                    )
                )
                questions.append(
                    OpenQuestion(
                        code=issue_code,
                        message=f"Endpoint {path_s!r} lacks supplied evidence",
                        field=f"streams.{stream.name}.path",
                        severity="error",
                    )
                )
                stream.path = EvidencedValue(
                    value=UNKNOWN,
                    evidence_source=path_ev.evidence_source,
                    confidence=Confidence.UNKNOWN,
                    inferred=is_ai_claim,
                    notes="blocked: endpoint evidence claim could not be verified",
                )
                if is_ai_claim:
                    issues.append(
                        BuilderIssue(
                            code="UNSUPPORTED_AI_INFERENCE",
                            message="AI inference alone cannot establish endpoint",
                            severity="error",
                        )
                    )
                continue

            # AI inference alone never silently HIGH
            if path_ev.inferred and path_ev.confidence == Confidence.HIGH:
                path_ev = EvidencedValue(
                    value=path_ev.value,
                    evidence_source=path_ev.evidence_source,
                    confidence=Confidence.LOW,
                    inferred=True,
                    source_ref=path_ev.source_ref,
                    notes="downgraded: inference cannot be HIGH",
                )
                stream.path = path_ev

        # OpenAPI deterministic auth preference.
        if openapi_summary and openapi_summary.auth_hints and translation.auth_type:
            if translation.auth_type.evidence_source == EvidenceSourceKind.AI_INFERENCE:
                # Prefer openapi hint when AI guessed.
                hint = openapi_summary.auth_hints[0]
                mapped = "bearer"
                if "api" in hint and "key" in hint:
                    mapped = "api_key"
                elif "oauth" in hint:
                    mapped = "oauth2_client_credentials"
                elif "basic" in hint:
                    mapped = "basic"
                translation.auth_type = reconcile_field(
                    "auth.auth_type",
                    [
                        translation.auth_type,
                        EvidencedValue(
                            value=mapped,
                            evidence_source=EvidenceSourceKind.OPENAPI,
                            confidence=Confidence.HIGH,
                            inferred=False,
                            source_ref="openapi.securitySchemes",
                        ),
                    ],
                    conflicts,
                    questions,
                )

        return translation, issues, questions, conflicts

    def _missing_required(self, translation: StructuredTranslationResult) -> list[str]:
        missing: list[str] = []
        if not translation.streams:
            missing.append("no streams proposed")
            return missing
        for stream in translation.streams:
            path = stream.path.value if stream.path else None
            method = stream.method.value if stream.method else None
            if path in (None, "", UNKNOWN):
                missing.append(f"stream {stream.name}: endpoint unresolved")
            if method in (None, "", UNKNOWN):
                missing.append(f"stream {stream.name}: method unresolved")
            st = stream.source_type
            if st in (None, UNKNOWN) or (
                st is not None and st not in SUPPORTED_SOURCE_TYPES
            ):
                # Default HTTP_API_POLLING only when path/method present and no explicit unsupported.
                if st and st not in SUPPORTED_SOURCE_TYPES and st != UNKNOWN:
                    missing.append(f"stream {stream.name}: unsupported source type")
        return missing

    def _confidence_summary(self, translation: StructuredTranslationResult) -> dict[str, Any]:
        counts = {c.value: 0 for c in Confidence}
        for ev in (
            translation.vendor,
            translation.product,
            translation.api_family_version,
            translation.auth_type,
        ):
            if ev is not None:
                counts[ev.confidence.value] += 1
        for stream in translation.streams:
            for ev in (stream.path, stream.method, stream.event_array_path, stream.checkpoint):
                if ev is not None:
                    counts[ev.confidence.value] += 1
        return counts

    def _evaluate_license(self, request: BuilderRequest) -> LicensePolicyResult:
        knowledge = request.harvested_knowledge
        assert knowledge is not None
        config = LicensePolicyConfig(
            denied_licenses=request.denied_licenses,
            force_review_licenses=request.force_review_licenses,
            force_reference_only_licenses=request.force_reference_only_licenses,
        )
        license_value: dict[str, Any] | str | None
        if knowledge.license.identifier:
            license_value = {
                "spdx": knowledge.license.identifier,
                "source": knowledge.license.source,
                "notice_required": knowledge.license.notice_required,
            }
        else:
            license_value = None
        upstream = {
            "upstream_project": knowledge.provenance.upstream_project,
            "upstream_url": knowledge.provenance.upstream_url,
            "upstream_path": knowledge.provenance.upstream_path,
            "upstream_commit_or_version": (
                knowledge.provenance.upstream_commit or knowledge.provenance.upstream_version
            ),
            "license_spdx_or_detected_license": knowledge.license.identifier,
            "license_source": knowledge.license.source,
            "notice_required": knowledge.license.notice_required,
            "modified_from_upstream": True,
            "import_method": knowledge.provenance.import_method or "ai_builder",
        }
        source_evidence = [
            {
                "type": "harvester",
                "ref": e.source_path or e.documentation_ref or "harvest",
                "notes": e.notes,
            }
            for e in knowledge.provenance.evidence
            if e.source_path or e.documentation_ref
        ]
        return evaluate_license_policy(
            license_value=license_value,
            upstream_provenance=upstream,
            source_evidence=source_evidence,
            config=config,
        )

    def _validate_package(
        self,
        package_path: Path,
    ) -> tuple[str, dict[str, Any], list[BuilderIssue]]:
        issues: list[BuilderIssue] = []
        details: dict[str, Any] = {}
        try:
            assert_package_secrets_clean(package_path)
        except LifecycleError as exc:
            issues.append(
                BuilderIssue(
                    code=exc.error_code or "PACKAGE_SECRET_DETECTED",
                    message=str(exc),
                )
            )
            details["secret_scan"] = "FAIL"
            return "FAIL", details, issues
        details["secret_scan"] = "PASS"
        digest = compute_canonical_package_digest(package_path)
        details["digest"] = f"sha256:{digest}"
        try:
            validated = validate_marketplace_package(
                package_path,
                digest=f"sha256:{digest}",
            )
        except LifecycleError as exc:
            issues.append(
                BuilderIssue(
                    code=exc.error_code or "VALIDATION_FAILED",
                    message=str(exc),
                )
            )
            details["marketplace_validator"] = "FAIL"
            return "FAIL", details, issues
        details["marketplace_validator"] = "PASS"
        details["package_id"] = validated.package_id
        details["pack_version"] = validated.pack_version
        if validated.license_policy is not None:
            details["validator_license_decision"] = validated.license_policy.decision
        return "PASS", details, issues

    @staticmethod
    def _reject_executables(package_root: Path) -> list[BuilderIssue]:
        banned_suffixes = {".py", ".sh", ".bash", ".js", ".mjs", ".cjs", ".exe", ".bin"}
        issues: list[BuilderIssue] = []
        for path in package_root.rglob("*"):
            if path.is_file() and path.suffix.lower() in banned_suffixes:
                issues.append(
                    BuilderIssue(
                        code="EXECUTABLE_PACKAGE_FILE",
                        message=f"executable/package code file not allowed: {path.name}",
                    )
                )
        return issues


def build_connector_draft(
    request: BuilderRequest,
    *,
    registry: ProviderRegistry | None = None,
) -> BuilderResult:
    """Module-level service entrypoint."""

    return BuilderService(registry=registry).build(request)
