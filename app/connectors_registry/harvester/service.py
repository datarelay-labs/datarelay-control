"""Connector Harvester service — external import pipeline (M29.6).

Pipeline:

  External Source (local/snapshot/fixture)
    → License / Provenance Policy (M29.5B)
    → Harvested Connector Knowledge
    → Normalize / mapping gate
    → Data Relay Source Pack Draft
    → Marketplace Package Validator (+ secret scan)
    → Imported / Local Draft candidate

No automatic Verified/Official promotion.
No automatic install / stream enable.
No AI generation.
No remote acquisition in V1 (see REMOTE_ACQUISITION_IMPLEMENTED=NO).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from app.connectors_registry.harvester.models import (
    ContentReuseClass,
    EvidenceRef,
    HarvestInputMode,
    HarvestRequest,
    HarvestedIntegrationKnowledge,
    ImportIssue,
    ImportResult,
    MappingStatus,
    TrustCandidate,
)
from app.connectors_registry.harvester.package_builder import write_source_pack
from app.connectors_registry.harvester.path_safety import assert_no_symlink_components
from app.connectors_registry.harvester.registry import (
    HarvesterSourceRegistry,
    UnknownHarvesterAdapterError,
    build_default_harvester_registry,
)
from app.connectors_registry.lifecycle_errors import LifecycleError
from app.connectors_registry.license_policy import (
    LICENSE_DECISION_ALLOW,
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

# Documented V1 capability flags for result reports / operators.
REMOTE_ACQUISITION_IMPLEMENTED = False
SHARED_ACQUISITION_POLICY_REUSED = True  # policy module exists; no fetcher wired
INDEPENDENT_NETWORK_POLICY_ADDED = False


def _validate_untrusted_input_path(path: Path) -> None:
    """Reject symlink-bearing local snapshots before any adapter reads them."""

    assert_no_symlink_components(path, label="harvest input path")
    if path.is_file():
        return
    if not path.is_dir():
        raise ValueError(f"harvest input must be a regular file or directory: {path}")
    for entry in path.rglob("*"):
        if entry.is_symlink():
            raise ValueError(f"harvest input contains a symlink: {entry}")


class HarvesterService:
    """Orchestrates deterministic harvest → license gate → draft package."""

    def __init__(self, registry: HarvesterSourceRegistry | None = None) -> None:
        self._registry = registry or build_default_harvester_registry()

    @property
    def registry(self) -> HarvesterSourceRegistry:
        return self._registry

    def harvest_and_import(self, request: HarvestRequest) -> ImportResult:
        """Run the full M29.6 pipeline for one candidate."""

        ecosystem = (request.ecosystem or "").strip().lower()
        issues: list[ImportIssue] = []
        evidence: list[EvidenceRef] = []

        try:
            adapter = self._registry.get(ecosystem)
        except UnknownHarvesterAdapterError as exc:
            return ImportResult(
                source=ecosystem or "unknown",
                candidate=None,
                license_decision=None,
                license_decision_code=None,
                license_decision_reason=None,
                mapping_status=MappingStatus.UNKNOWN,
                package_generated=False,
                package_path=None,
                validation_status="BLOCKED",
                issues=[
                    ImportIssue(
                        code="UNKNOWN_ADAPTER",
                        message=str(exc),
                        severity="error",
                    )
                ],
                trust_candidate=request.trust_candidate,
            )

        if not adapter.supports_input_mode(request.input_mode):
            return ImportResult(
                source=ecosystem,
                candidate=None,
                license_decision=None,
                license_decision_code=None,
                license_decision_reason=None,
                mapping_status=MappingStatus.UNKNOWN,
                package_generated=False,
                package_path=None,
                validation_status="BLOCKED",
                issues=[
                    ImportIssue(
                        code="UNSUPPORTED_INPUT_MODE",
                        message=f"adapter {ecosystem!r} does not support {request.input_mode.value}",
                        severity="error",
                    )
                ],
                trust_candidate=request.trust_candidate,
            )

        path = Path(request.path)
        if not path.exists():
            return ImportResult(
                source=ecosystem,
                candidate=None,
                license_decision=None,
                license_decision_code=None,
                license_decision_reason=None,
                mapping_status=MappingStatus.UNKNOWN,
                package_generated=False,
                package_path=None,
                validation_status="BLOCKED",
                issues=[
                    ImportIssue(
                        code="INPUT_MISSING",
                        message=f"harvest input path does not exist: {path}",
                        severity="error",
                    )
                ],
                trust_candidate=request.trust_candidate,
            )

        try:
            _validate_untrusted_input_path(path)
            knowledge = adapter.harvest(
                path=path,
                input_mode=request.input_mode,
                fixture_overrides=request.fixture_overrides,
            )
        except Exception as exc:  # noqa: BLE001 — surface as structured issue
            return ImportResult(
                source=ecosystem,
                candidate=None,
                license_decision=None,
                license_decision_code=None,
                license_decision_reason=None,
                mapping_status=MappingStatus.UNKNOWN,
                package_generated=False,
                package_path=None,
                validation_status="BLOCKED",
                issues=[
                    ImportIssue(
                        code="HARVEST_FAILED",
                        message=f"harvest failed: {exc}",
                        severity="error",
                    )
                ],
                trust_candidate=request.trust_candidate,
            )

        # Ensure import_method reflects input mode when adapter omitted it.
        if not knowledge.provenance.import_method:
            knowledge.provenance.import_method = request.input_mode.value

        evidence.extend(knowledge.provenance.evidence)
        for stream in knowledge.streams:
            evidence.extend(stream.evidence)

        license_result = self._evaluate_license(knowledge, request)
        mapping_status = knowledge.mapping_status

        # License gate decisions.
        if license_result.decision == LICENSE_DECISION_DENY:
            issues.append(
                ImportIssue(
                    code="LICENSE_DENY",
                    message=license_result.decision_reason,
                    severity="error",
                )
            )
            return ImportResult(
                source=ecosystem,
                candidate=knowledge,
                license_decision=license_result.decision,
                license_decision_code=license_result.decision_code,
                license_decision_reason=license_result.decision_reason,
                mapping_status=mapping_status,
                package_generated=False,
                package_path=None,
                validation_status="BLOCKED",
                issues=issues,
                evidence=evidence,
                confidence=self._confidence(knowledge),
                review_required=False,
                trust_candidate=request.trust_candidate,
            )

        if license_result.decision == LICENSE_DECISION_REFERENCE_ONLY:
            # Retain metadata/reference knowledge only — no distributable package
            # that copies restricted upstream content.
            knowledge.content_reuse = ContentReuseClass.RESTRICTED
            if mapping_status == MappingStatus.MAPPED:
                knowledge.mapping_status = MappingStatus.REFERENCE_ONLY
                knowledge.mapping_reason = (
                    knowledge.mapping_reason
                    or "license REFERENCE_ONLY: knowledge retained, no direct package content copy"
                )
                mapping_status = MappingStatus.REFERENCE_ONLY
            issues.append(
                ImportIssue(
                    code="LICENSE_REFERENCE_ONLY",
                    message=license_result.decision_reason,
                    severity="warning",
                )
            )
            return ImportResult(
                source=ecosystem,
                candidate=knowledge,
                license_decision=license_result.decision,
                license_decision_code=license_result.decision_code,
                license_decision_reason=license_result.decision_reason,
                mapping_status=mapping_status,
                package_generated=False,
                package_path=None,
                validation_status="SKIPPED",
                issues=issues,
                evidence=evidence,
                confidence=self._confidence(knowledge),
                review_required=True,
                trust_candidate=request.trust_candidate,
            )

        review_required = license_result.decision == LICENSE_DECISION_REVIEW
        if review_required:
            issues.append(
                ImportIssue(
                    code="LICENSE_REVIEW_REQUIRED",
                    message=license_result.decision_reason,
                    severity="warning",
                )
            )
            # REVIEW: retain normalized knowledge; do not auto-generate package.
            return ImportResult(
                source=ecosystem,
                candidate=knowledge,
                license_decision=license_result.decision,
                license_decision_code=license_result.decision_code,
                license_decision_reason=license_result.decision_reason,
                mapping_status=mapping_status,
                package_generated=False,
                package_path=None,
                validation_status="SKIPPED",
                issues=issues,
                evidence=evidence,
                confidence=self._confidence(knowledge),
                review_required=True,
                trust_candidate=request.trust_candidate,
            )

        # ALLOW path — mapping gate before package generation.
        assert license_result.decision == LICENSE_DECISION_ALLOW

        if mapping_status != MappingStatus.MAPPED or not knowledge.proposed_source_type:
            issues.append(
                ImportIssue(
                    code="UNSUPPORTED_MAPPING",
                    message=knowledge.mapping_reason
                    or "harvested integration does not map to a supported Data Relay source type",
                    severity="warning",
                )
            )
            return ImportResult(
                source=ecosystem,
                candidate=knowledge,
                license_decision=license_result.decision,
                license_decision_code=license_result.decision_code,
                license_decision_reason=license_result.decision_reason,
                mapping_status=mapping_status
                if mapping_status != MappingStatus.UNKNOWN
                else MappingStatus.UNSUPPORTED,
                package_generated=False,
                package_path=None,
                validation_status="SKIPPED",
                issues=issues,
                evidence=evidence,
                confidence=self._confidence(knowledge),
                review_required=False,
                trust_candidate=request.trust_candidate,
            )

        if request.output_dir is None:
            issues.append(
                ImportIssue(
                    code="OUTPUT_DIR_REQUIRED",
                    message="output_dir is required to generate a draft Source Pack",
                    severity="error",
                )
            )
            return ImportResult(
                source=ecosystem,
                candidate=knowledge,
                license_decision=license_result.decision,
                license_decision_code=license_result.decision_code,
                license_decision_reason=license_result.decision_reason,
                mapping_status=mapping_status,
                package_generated=False,
                package_path=None,
                validation_status="BLOCKED",
                issues=issues,
                evidence=evidence,
                confidence=self._confidence(knowledge),
                trust_candidate=request.trust_candidate,
            )

        output_dir = Path(request.output_dir)

        try:
            package_path = write_source_pack(
                knowledge,
                output_dir=output_dir,
                license_result=license_result,
                trust_candidate=request.trust_candidate,
            )
        except Exception as exc:  # noqa: BLE001
            issues.append(
                ImportIssue(
                    code="PACKAGE_BUILD_FAILED",
                    message=f"Source Pack generation failed: {exc}",
                    severity="error",
                )
            )
            return ImportResult(
                source=ecosystem,
                candidate=knowledge,
                license_decision=license_result.decision,
                license_decision_code=license_result.decision_code,
                license_decision_reason=license_result.decision_reason,
                mapping_status=mapping_status,
                package_generated=False,
                package_path=None,
                validation_status="FAIL",
                issues=issues,
                evidence=evidence,
                confidence=self._confidence(knowledge),
                trust_candidate=request.trust_candidate,
            )

        validation_status, validation_details, val_issues = self._validate_package(package_path)
        issues.extend(val_issues)

        if validation_status != "PASS":
            return ImportResult(
                source=ecosystem,
                candidate=knowledge,
                license_decision=license_result.decision,
                license_decision_code=license_result.decision_code,
                license_decision_reason=license_result.decision_reason,
                mapping_status=mapping_status,
                package_generated=False,
                package_path=package_path,
                validation_status=validation_status,
                issues=issues,
                evidence=evidence,
                confidence=self._confidence(knowledge),
                trust_candidate=request.trust_candidate,
                validation_details=validation_details,
            )

        return ImportResult(
            source=ecosystem,
            candidate=knowledge,
            license_decision=license_result.decision,
            license_decision_code=license_result.decision_code,
            license_decision_reason=license_result.decision_reason,
            mapping_status=mapping_status,
            package_generated=True,
            package_path=package_path,
            validation_status="PASS",
            issues=issues,
            evidence=evidence,
            confidence=self._confidence(knowledge),
            review_required=False,
            trust_candidate=request.trust_candidate,
            validation_details=validation_details,
        )

    def _evaluate_license(
        self,
        knowledge: HarvestedIntegrationKnowledge,
        request: HarvestRequest,
    ) -> LicensePolicyResult:
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
            "import_method": knowledge.provenance.import_method,
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
    ) -> tuple[str, dict[str, Any], list[ImportIssue]]:
        """Run marketplace validator + secret scan. Never bypass security gates."""

        issues: list[ImportIssue] = []
        details: dict[str, Any] = {}
        try:
            assert_package_secrets_clean(package_path)
        except LifecycleError as exc:
            issues.append(
                ImportIssue(
                    code=exc.error_code or "PACKAGE_SECRET_DETECTED",
                    message=str(exc),
                    severity="error",
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
                ImportIssue(
                    code=exc.error_code or "VALIDATION_FAILED",
                    message=str(exc),
                    severity="error",
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
    def _confidence(knowledge: HarvestedIntegrationKnowledge) -> str:
        if knowledge.streams and knowledge.proposed_source_type:
            # Medium when streams + path + method evidenced.
            if any(s.path and s.http_method for s in knowledge.streams):
                return "medium"
            return "low"
        return "low"


def harvest_and_import(
    request: HarvestRequest,
    *,
    registry: HarvesterSourceRegistry | None = None,
) -> ImportResult:
    """Module-level convenience entry point."""

    return HarvesterService(registry=registry).harvest_and_import(request)
