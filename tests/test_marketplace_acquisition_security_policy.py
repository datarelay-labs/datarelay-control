"""Tests for M29.5B Marketplace license/provenance + acquisition URL security policy."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import yaml

from app.connectors_registry.acquisition_url_policy import (
    AcquisitionUrlPolicyError,
    NetworkAcquisitionPolicyConfig,
    looks_like_absolute_url,
    validate_redirect_target,
    validate_resolved_target,
    validate_url,
    validate_url_with_dns,
)
from app.connectors_registry.license_policy import (
    LICENSE_DECISION_ALLOW,
    LICENSE_DECISION_DENY,
    LICENSE_DECISION_REFERENCE_ONLY,
    LICENSE_DECISION_REVIEW,
    LicensePolicyConfig,
    evaluate_license_policy,
    evaluate_raw_manifest_license_policy,
)
from app.connectors_registry.lifecycle_errors import LifecycleError
from app.connectors_registry.package_validator import validate_marketplace_package


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _base_manifest(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": "acme",
        "name": "Acme API",
        "vendor": "Acme",
        "version": "1.0.0",
        "source_type": "HTTP_API_POLLING",
        "auth": {"type": "bearer"},
        "streams": [{"id": "events", "name": "Events"}],
        "package_id": "acme",
        "package_kind": "source",
        "pack_version": "1.0.0",
    }
    payload.update(overrides)
    return payload


def _staging_with_manifest(tmp_path: Path, manifest: dict[str, Any]) -> Path:
    root = tmp_path / "pkg"
    root.mkdir(parents=True)
    (root / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False), encoding="utf-8")
    return root


# ---------------------------------------------------------------------------
# License / provenance policy
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("license_value", "expected"),
    [
        ("MIT", LICENSE_DECISION_ALLOW),
        ("Apache-2.0", LICENSE_DECISION_ALLOW),
        ("apache-2.0", LICENSE_DECISION_ALLOW),
    ],
)
def test_license_permissive_allow(license_value: str, expected: str) -> None:
    result = evaluate_license_policy(license_value=license_value)
    assert result.decision == expected
    assert result.allows_direct_content_import is True


@pytest.mark.parametrize(
    "license_value",
    ["MPL-2.0", "GPL-3.0", "LGPL-2.1"],
)
def test_license_reciprocal_review(license_value: str) -> None:
    result = evaluate_license_policy(license_value=license_value)
    assert result.decision == LICENSE_DECISION_REVIEW
    assert result.allows_direct_content_import is False


@pytest.mark.parametrize(
    "license_value",
    ["ELv2", "Elastic-2.0", "BUSL-1.1", "proprietary", "source-available", "SSPL-1.0"],
)
def test_license_source_available_reference_only(license_value: str) -> None:
    result = evaluate_license_policy(license_value=license_value)
    assert result.decision == LICENSE_DECISION_REFERENCE_ONLY


def test_license_unknown_and_missing_are_reference_only() -> None:
    missing = evaluate_license_policy(license_value=None)
    assert missing.decision == LICENSE_DECISION_REFERENCE_ONLY
    assert missing.decision_code == "UNKNOWN_OR_MISSING_LICENSE"

    unknown = evaluate_license_policy(license_value="SomeObscureLicense-9.9")
    assert unknown.decision == LICENSE_DECISION_REFERENCE_ONLY


def test_license_explicit_deny_via_config() -> None:
    cfg = LicensePolicyConfig(denied_licenses=frozenset({"MIT"}))
    result = evaluate_license_policy(license_value="MIT", config=cfg)
    assert result.decision == LICENSE_DECISION_DENY
    assert result.decision_code == "EXPLICIT_POLICY_DENY"


def test_license_policy_config_is_normalized() -> None:
    cfg = LicensePolicyConfig(denied_licenses=frozenset({"mit"}))
    result = evaluate_license_policy(license_value="MIT", config=cfg)
    assert result.decision == LICENSE_DECISION_DENY


def test_manifest_spoofed_license_decision_ignored() -> None:
    raw = _base_manifest(
        license="ELv2",
        license_decision="ALLOW",
        license_decision_code="SPOOF",
        license_decision_reason="trust me",
    )
    result = evaluate_raw_manifest_license_policy(raw)
    assert result.decision == LICENSE_DECISION_REFERENCE_ONLY
    assert "license_decision" in result.spoofed_fields_ignored


def test_provenance_preserved_without_fetch() -> None:
    provenance = {
        "upstream_project": "example-tap",
        "upstream_url": "https://github.com/example/tap",
        "upstream_path": "tap_example",
        "upstream_commit_or_version": "abc123",
        "license_spdx_or_detected_license": "MIT",
        "license_source": "https://github.com/example/tap/LICENSE",
        "notice_required": True,
        "modified_from_upstream": True,
        "import_method": "harvester",
    }
    evidence = [{"type": "openapi", "ref": "https://example.com/openapi.json", "notes": "docs"}]
    result = evaluate_license_policy(
        license_value={"spdx": "MIT", "source": "LICENSE", "notice_required": True},
        upstream_provenance=provenance,
        source_evidence=evidence,
    )
    assert result.decision == LICENSE_DECISION_ALLOW
    d = result.declared
    assert d.upstream_project == "example-tap"
    assert d.upstream_url == "https://github.com/example/tap"
    assert d.upstream_path == "tap_example"
    assert d.upstream_commit_or_version == "abc123"
    assert d.license_identifier == "MIT"
    assert d.license_source == "LICENSE"
    assert d.notice_required is True
    assert d.modified_from_upstream is True
    assert d.import_method == "harvester"
    assert d.source_evidence[0]["ref"] == "https://example.com/openapi.json"


def test_license_allow_does_not_imply_trust_tier() -> None:
    result = evaluate_license_policy(license_value="MIT")
    assert result.decision == LICENSE_DECISION_ALLOW
    assert "not legal" in result.decision_reason.lower() or "Product decision" in result.decision_reason
    assert "Official trust" in result.decision_reason or "Verified" in result.decision_reason


def test_validator_computes_platform_license_and_strips_spoof(tmp_path: Path) -> None:
    staging = _staging_with_manifest(
        tmp_path,
        _base_manifest(
            license="Apache-2.0",
            license_decision="DENY",
            upstream_provenance={
                "upstream_project": "x",
                "upstream_url": "https://example.com/repo",
                "upstream_commit_or_version": "1",
            },
            source_evidence=[{"type": "docs", "ref": "README.md"}],
        ),
    )
    validated = validate_marketplace_package(staging, digest="sha256:" + ("a" * 64))
    assert validated.license_policy is not None
    assert validated.license_policy.decision == LICENSE_DECISION_ALLOW
    assert "license_decision" in validated.license_policy.spoofed_fields_ignored


def test_validator_rejects_unsafe_declared_evidence_url(tmp_path: Path) -> None:
    staging = _staging_with_manifest(
        tmp_path,
        _base_manifest(
            license="MIT",
            source_evidence=[{"type": "openapi", "ref": "http://169.254.169.254/latest/meta-data"}],
        ),
    )
    with pytest.raises(LifecycleError) as exc:
        validate_marketplace_package(staging, digest="sha256:" + ("b" * 64))
    assert exc.value.error_code == "DECLARED_URL_POLICY"


def test_relative_source_evidence_not_treated_as_url(tmp_path: Path) -> None:
    staging = _staging_with_manifest(
        tmp_path,
        _base_manifest(
            license="MIT",
            source_evidence=[{"type": "fixture", "ref": "samples/event.json"}],
        ),
    )
    validated = validate_marketplace_package(staging, digest="sha256:" + ("c" * 64))
    assert validated.license_policy is not None
    assert validated.license_policy.decision == LICENSE_DECISION_ALLOW


def test_validator_rejects_private_runtime_url_default(tmp_path: Path) -> None:
    staging = _staging_with_manifest(
        tmp_path,
        _base_manifest(
            license="MIT",
            auth={"type": "bearer", "schema_ref": "auth_schema.yaml"},
        ),
    )
    (staging / "auth_schema.yaml").write_text(
        yaml.safe_dump(
            {
                "type": "bearer",
                "fields": [
                    {
                        "name": "base_url",
                        "required": True,
                        "default": "https://127.0.0.1/internal",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(LifecycleError) as exc:
        validate_marketplace_package(staging, digest="sha256:" + ("d" * 64))
    assert exc.value.error_code == "DECLARED_URL_POLICY"


def test_validator_accepts_public_runtime_url_defaults(tmp_path: Path) -> None:
    staging = _staging_with_manifest(
        tmp_path,
        _base_manifest(
            license="MIT",
            auth={"type": "oauth2", "schema_ref": "auth_schema.yaml"},
        ),
    )
    (staging / "auth_schema.yaml").write_text(
        yaml.safe_dump(
            {
                "type": "oauth2",
                "fields": [
                    {
                        "name": "base_url",
                        "required": True,
                        "default": "https://graph.microsoft.com",
                    },
                    {
                        "name": "oauth2_token_url",
                        "required": True,
                        "default": "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    validated = validate_marketplace_package(staging, digest="sha256:" + ("e" * 64))
    assert validated.license_policy is not None
    assert validated.license_policy.decision == LICENSE_DECISION_ALLOW


# ---------------------------------------------------------------------------
# Network acquisition URL policy
# ---------------------------------------------------------------------------


def test_valid_public_https() -> None:
    result = validate_url("https://registry.example.com/packages/acme.tar.gz")
    assert result.scheme == "https"
    assert result.hostname == "registry.example.com"
    assert result.port == 443


def test_valid_public_ipv4() -> None:
    result = validate_url("https://8.8.8.8/path")
    assert result.is_ip_literal is True
    assert result.hostname == "8.8.8.8"


def test_valid_public_ipv6() -> None:
    result = validate_url("https://[2001:4860:4860::8888]/pkg")
    assert result.is_ip_literal is True
    assert result.hostname == "2001:4860:4860::8888"


@pytest.mark.parametrize(
    "url",
    [
        "https://localhost/x",
        "https://127.0.0.1/x",
        "https://[::1]/x",
    ],
)
def test_localhost_and_loopback_blocked(url: str) -> None:
    with pytest.raises(AcquisitionUrlPolicyError) as exc:
        validate_url(url)
    assert exc.value.code in {"LOCALHOST_BLOCKED", "LOOPBACK_BLOCKED"}


@pytest.mark.parametrize(
    "url",
    [
        "https://10.0.0.5/x",
        "https://192.168.1.10/x",
        "https://172.16.5.5/x",
        "https://[fd12:3456:789a::1]/x",
    ],
)
def test_private_and_ula_blocked(url: str) -> None:
    with pytest.raises(AcquisitionUrlPolicyError) as exc:
        validate_url(url)
    assert exc.value.code == "PRIVATE_IP_BLOCKED"


@pytest.mark.parametrize(
    "url",
    [
        "https://169.254.1.1/x",
        "https://[fe80::1]/x",
    ],
)
def test_link_local_blocked(url: str) -> None:
    with pytest.raises(AcquisitionUrlPolicyError) as exc:
        validate_url(url)
    assert exc.value.code == "LINK_LOCAL_BLOCKED"


def test_metadata_ip_blocked() -> None:
    with pytest.raises(AcquisitionUrlPolicyError) as exc:
        validate_url("https://169.254.169.254/latest/meta-data")
    assert exc.value.code in {"METADATA_IP_BLOCKED", "LINK_LOCAL_BLOCKED"}


def test_userinfo_blocked() -> None:
    with pytest.raises(AcquisitionUrlPolicyError) as exc:
        validate_url("https://user:secret@example.com/pkg")
    assert exc.value.code == "USERINFO_BLOCKED"


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com\\@127.0.0.1/path",
        "https://example.com/path\nnext",
    ],
)
def test_ambiguous_or_control_character_url_blocked(url: str) -> None:
    with pytest.raises(AcquisitionUrlPolicyError) as exc:
        validate_url(url)
    assert exc.value.code == "MALFORMED_URL"


@pytest.mark.parametrize(
    ("url", "code"),
    [
        ("http://example.com/pkg", "HTTP_BLOCKED"),
        ("file:///etc/passwd", "UNSUPPORTED_SCHEME"),
        ("ftp://example.com/pkg", "UNSUPPORTED_SCHEME"),
    ],
)
def test_scheme_blocks(url: str, code: str) -> None:
    with pytest.raises(AcquisitionUrlPolicyError) as exc:
        validate_url(url)
    assert exc.value.code == code


def test_http_allowed_when_explicitly_configured() -> None:
    cfg = NetworkAcquisitionPolicyConfig(allow_http=True, allowed_schemes=frozenset({"https", "http"}))
    result = validate_url("http://example.com/pkg", config=cfg)
    assert result.scheme == "http"


def test_malformed_port_blocked() -> None:
    with pytest.raises(AcquisitionUrlPolicyError) as exc:
        validate_url("https://example.com:notaport/pkg")
    assert exc.value.code == "MALFORMED_PORT"


def test_disallowed_port_when_allowlist_set() -> None:
    cfg = NetworkAcquisitionPolicyConfig(allowed_ports=frozenset({443}))
    with pytest.raises(AcquisitionUrlPolicyError) as exc:
        validate_url("https://example.com:8443/pkg", config=cfg)
    assert exc.value.code == "PORT_NOT_ALLOWED"


def test_dns_resolving_to_private_blocked() -> None:
    with pytest.raises(AcquisitionUrlPolicyError) as exc:
        validate_resolved_target("evil.example.com", ["10.1.2.3"])
    assert exc.value.code == "PRIVATE_IP_BLOCKED"


def test_mixed_public_private_dns_blocked() -> None:
    with pytest.raises(AcquisitionUrlPolicyError) as exc:
        validate_resolved_target("mixed.example.com", ["8.8.8.8", "10.0.0.1"])
    assert exc.value.code == "MIXED_DNS_PRIVATE_BLOCKED"


def test_mixed_dns_public_only_passes() -> None:
    approved = validate_resolved_target("ok.example.com", ["8.8.8.8", "1.1.1.1"])
    assert approved == ["8.8.8.8", "1.1.1.1"]


def test_redirect_public_to_private_blocked() -> None:
    validate_url("https://example.com/start")
    with pytest.raises(AcquisitionUrlPolicyError) as exc:
        validate_redirect_target("https://10.0.0.8/next")
    assert exc.value.code == "PRIVATE_IP_BLOCKED"


def test_redirect_revalidates_from_scratch_with_dns() -> None:
    with pytest.raises(AcquisitionUrlPolicyError) as exc:
        validate_redirect_target(
            "https://follow.example.com/next",
            resolved_addresses=["192.168.0.50"],
        )
    assert exc.value.code == "PRIVATE_IP_BLOCKED"


def test_domain_allowlist_hook() -> None:
    cfg = NetworkAcquisitionPolicyConfig(allowed_hosts=frozenset({"registry.example.com"}))
    validate_url("https://registry.example.com/pkg", config=cfg)
    with pytest.raises(AcquisitionUrlPolicyError) as exc:
        validate_url("https://other.example.com/pkg", config=cfg)
    assert exc.value.code == "HOST_NOT_ALLOWED"


def test_validate_url_with_injected_dns_resolver() -> None:
    def resolver(host: str) -> list[str]:
        assert host == "cdn.example.com"
        return ["8.8.4.4"]

    result, approved = validate_url_with_dns(
        "https://cdn.example.com/pkg",
        resolver=resolver,
    )
    assert result.hostname == "cdn.example.com"
    assert approved == ["8.8.4.4"]


def test_looks_like_absolute_url() -> None:
    assert looks_like_absolute_url("https://example.com/a") is True
    assert looks_like_absolute_url("samples/a.json") is False
    assert looks_like_absolute_url("not a url") is False


def test_dns_rebinding_boundary_documented() -> None:
    """Policy documents that URL preflight alone does not stop DNS rebinding."""

    import app.connectors_registry.acquisition_url_policy as mod

    doc = mod.__doc__ or ""
    assert "DNS rebinding" in doc
    assert "connect only to an approved address" in doc or "pin" in doc.lower()


def test_no_network_fetch_imports_in_policy_modules() -> None:
    """Guard: policy modules must not pull HTTP clients for acquisition."""

    import app.connectors_registry.acquisition_url_policy as net
    import app.connectors_registry.license_policy as lic

    for mod in (net, lic):
        source = Path(mod.__file__).read_text(encoding="utf-8")
        assert "requests.get" not in source
        assert "httpx.get" not in source
        assert "urllib.request" not in source
        assert "subprocess" not in source
        assert "clone(" not in source
