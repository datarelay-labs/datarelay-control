#!/usr/bin/env python3
"""Validate e2e/capabilities/data-relay-capabilities.yaml against the repo.

Checks:
1. YAML syntax
2. Unique capability IDs
3. Allowed status enum values
4. evidence.file paths exist (files or directories)
5. existing_tests paths exist
6. SUPPORTED entries have UI/API/Runtime evidence when those flags are true
7. Connector SourceType / DestinationTypeLiteral / AuthType / enrichment rule types
   from code are represented in the manifest
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    print("FAIL: PyYAML is required (pip install pyyaml)", file=sys.stderr)
    sys.exit(2)

REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = Path(__file__).resolve().parent / "data-relay-capabilities.yaml"

ALLOWED_STATUS = frozenset(
    {
        "SUPPORTED",
        "PARTIAL",
        "UI_ONLY",
        "API_ONLY",
        "RUNTIME_ONLY",
        "NOT_IMPLEMENTED",
        "UNKNOWN",
        "OUT_OF_SCOPE",
    }
)

PHASE_E_CAPABILITY_IDS = (
    "auth.ai_provider.api_key_or_bearer",
    "source.ai_proxy_receiver",
    "destination.ai_provider_post",
)

CONTROL_SOURCE_CAPABILITIES = {
    "HTTP_API_POLLING": "source.http_api_polling",
    "DATABASE_QUERY": "source.database_query_postgresql",
    "WEBHOOK_RECEIVER": "source.webhook_receiver",
    "S3_OBJECT_POLLING": "source.s3_object_polling",
    "REMOTE_FILE_POLLING": "source.remote_file_polling",
}

ROUTE_ON_REQUIRED_SUPPORTED = (
    "wizard.step.route_processing",
    "routes.per_route_transform",
    "routes.per_route_protection_classification_policy",
    "flag.gdc_route_processing_enabled",
)

STALE_TRUTH_PHRASES = (
    "defaults False",
    "defaults **False**",
    "Default False",
    "default False",
    "default is `False`",
    "Route Processing UI not implemented",
    "wizard does not persist",
    "does not save route_mappings",
)

PHASE_E_SOURCE_DEST_LABELS = (
    "AI_PROXY_RECEIVER",
    "AI_PROVIDER_POST",
)

CAPABILITY_SECTIONS = (
    "authentication",
    "sources",
    "destinations",
    "wizard",
    "processing",
    "routes",
    "governance",
    "runtime",
    "feature_flags",
    "test_infrastructure",
)


def _extract_literal_strings(py_text: str, assign_name: str) -> list[str]:
    """Best-effort extract of string values from ``Name = Literal[...]`` or frozenset({...})."""
    tree = ast.parse(py_text)
    out: list[str] = []
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if not any(isinstance(t, ast.Name) and t.id == assign_name for t in node.targets):
            continue
        value = node.value
        # Name = Literal["a", "b"]
        if isinstance(value, ast.Subscript):
            slice_node = value.slice
            elts = slice_node.elts if isinstance(slice_node, ast.Tuple) else [slice_node]
            for elt in elts:
                if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                    out.append(elt.value)
        # Name = frozenset({...})  or Name = frozenset( {..} )
        if isinstance(value, ast.Call):
            for arg in value.args:
                if isinstance(arg, (ast.Set, ast.Tuple, ast.List)):
                    for elt in arg.elts:
                        if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                            out.append(elt.value)
    return out


def _extract_dict_string_keys_from_assignment(py_text: str, class_name: str, attr: str) -> list[str]:
    """Extract string keys from ``class X: attr = { "K": ... }`` class body assignment."""
    tree = ast.parse(py_text)
    keys: list[str] = []
    for node in tree.body:
        if not isinstance(node, ast.ClassDef) or node.name != class_name:
            continue
        for stmt in node.body:
            if not isinstance(stmt, ast.Assign):
                continue
            if not any(isinstance(t, ast.Name) and t.id == attr for t in stmt.targets):
                continue
            if isinstance(stmt.value, ast.Dict):
                for k in stmt.value.keys:
                    if isinstance(k, ast.Constant) and isinstance(k.value, str) and k.value:
                        keys.append(k.value)
    return keys


def _path_exists(rel: str) -> bool:
    p = REPO_ROOT / rel
    return p.exists()


def _iter_capabilities(doc: dict) -> list[dict]:
    caps: list[dict] = []
    for section in CAPABILITY_SECTIONS:
        items = doc.get(section) or []
        if not isinstance(items, list):
            raise ValueError(f"section {section!r} must be a list")
        for item in items:
            if not isinstance(item, dict):
                raise ValueError(f"capability in {section} must be a mapping")
            caps.append(item)
    return caps


def _assignment_default_true(py_text: str, name: str) -> bool:
    tree = ast.parse(py_text)
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        for stmt in node.body:
            if not isinstance(stmt, ast.AnnAssign):
                continue
            if not isinstance(stmt.target, ast.Name) or stmt.target.id != name:
                continue
            return isinstance(stmt.value, ast.Constant) and stmt.value.value is True
    return False


def _has_evidence_for_layer(cap: dict, layer: str) -> bool:
    """Heuristic: evidence notes/files mention layer, or applicable evidence exists when flag true."""
    evidence = cap.get("evidence") or []
    if not evidence:
        return False
    # Any real evidence file is enough for SUPPORTED when the corresponding *_supported flag is true;
    # stricter layer matching would be brittle. Require at least one existing evidence entry.
    return any(isinstance(e, dict) and e.get("file") for e in evidence)


def main() -> int:
    errors: list[str] = []
    warnings: list[str] = []

    if not MANIFEST_PATH.exists():
        print(f"FAIL: missing manifest {MANIFEST_PATH}", file=sys.stderr)
        return 1

    try:
        doc = yaml.safe_load(MANIFEST_PATH.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        print(f"FAIL: YAML syntax error: {exc}", file=sys.stderr)
        return 1

    if not isinstance(doc, dict):
        print("FAIL: manifest root must be a mapping", file=sys.stderr)
        return 1

    for key in ("metadata", *CAPABILITY_SECTIONS):
        if key not in doc:
            errors.append(f"missing top-level key: {key}")

    caps = _iter_capabilities(doc) if not errors else []
    ids: list[str] = []
    for cap in caps:
        cid = cap.get("id")
        if not cid or not isinstance(cid, str):
            errors.append(f"capability missing string id: {cap!r}")
            continue
        ids.append(cid)
        status = cap.get("status")
        if status not in ALLOWED_STATUS:
            errors.append(f"{cid}: invalid status {status!r}")

        for e in cap.get("evidence") or []:
            if not isinstance(e, dict):
                errors.append(f"{cid}: evidence entry must be mapping")
                continue
            f = e.get("file")
            if not f:
                errors.append(f"{cid}: evidence missing file")
                continue
            if not _path_exists(str(f)):
                errors.append(f"{cid}: evidence.file missing: {f}")

        for t in cap.get("existing_tests") or []:
            if not isinstance(t, str):
                errors.append(f"{cid}: existing_tests entry must be string")
                continue
            if not _path_exists(t):
                errors.append(f"{cid}: existing_tests path missing: {t}")

        product_scope = cap.get("product_scope")
        if status == "SUPPORTED" and product_scope == "phase_e_out_of_scope":
            errors.append(f"{cid}: Phase E capability cannot be SUPPORTED in Control scope")
        if product_scope == "phase_e_out_of_scope" and status != "OUT_OF_SCOPE":
            errors.append(f"{cid}: phase_e_out_of_scope requires status OUT_OF_SCOPE")
        if status == "OUT_OF_SCOPE" and product_scope != "phase_e_out_of_scope":
            errors.append(f"{cid}: OUT_OF_SCOPE requires product_scope phase_e_out_of_scope")

        if status == "SUPPORTED":
            evidence = cap.get("evidence") or []
            product_evidence = [
                e
                for e in evidence
                if isinstance(e, dict)
                and str(e.get("file") or "")
                and not str(e.get("file")).startswith("docs/")
            ]
            if not product_evidence:
                errors.append(
                    f"{cid}: SUPPORTED requires evidence outside docs/; generated text alone cannot promote it"
                )
            if cap.get("ui_supported") and not _has_evidence_for_layer(cap, "ui"):
                errors.append(f"{cid}: SUPPORTED with ui_supported=true but no evidence")
            if cap.get("api_supported") and not _has_evidence_for_layer(cap, "api"):
                errors.append(f"{cid}: SUPPORTED with api_supported=true but no evidence")
            if cap.get("runtime_supported") and not _has_evidence_for_layer(cap, "runtime"):
                errors.append(f"{cid}: SUPPORTED with runtime_supported=true but no evidence")

    dupes = sorted({i for i in ids if ids.count(i) > 1})
    if dupes:
        errors.append(f"duplicate capability ids: {dupes}")

    # --- Code vs manifest coverage ---
    connectors_schemas = (REPO_ROOT / "app/connectors/schemas.py").read_text(encoding="utf-8")
    dest_schemas = (REPO_ROOT / "app/destinations/schemas.py").read_text(encoding="utf-8")
    auth_registry = (REPO_ROOT / "app/connectors/auth/registry.py").read_text(encoding="utf-8")
    source_registry = (REPO_ROOT / "app/sources/adapters/registry.py").read_text(encoding="utf-8")
    rule_executor = (REPO_ROOT / "app/enrichers/rule_executor.py").read_text(encoding="utf-8")
    gov_constants = (REPO_ROOT / "app/stream_governance/constants.py").read_text(encoding="utf-8")

    auth_types = set(_extract_literal_strings(connectors_schemas, "AuthType"))
    source_types = set(_extract_literal_strings(connectors_schemas, "SourceType"))
    connector_types = set(_extract_literal_strings(connectors_schemas, "ConnectorType"))
    dest_types = set(_extract_literal_strings(dest_schemas, "DestinationTypeLiteral"))
    registry_auth = set(_extract_dict_string_keys_from_assignment(auth_registry, "AuthStrategyRegistry", "_by_type"))
    registry_auth.discard("")  # empty-string alias for NO_AUTH
    source_adapter_keys = set(
        re.findall(r'"([A-Z0-9_]+)"\s*:', source_registry)
    )
    # Prefer AST from SourceAdapterRegistry.__init__ dict if possible
    rule_types = set()
    m = re.search(r"_RULE_TYPES\s*=\s*frozenset\(\s*\{([^}]+)\}", rule_executor, re.S)
    if m:
        rule_types = set(re.findall(r'"([a-z_]+)"', m.group(1)))
    protection_actions = set(_extract_literal_strings(gov_constants, "ALLOWED_PROTECTION_ACTIONS"))
    if not protection_actions:
        protection_actions = set(re.findall(r'"(audit|mask_partial|mask_full|tokenize|hash|drop_field)"', gov_constants))
    delivery_behaviors = set(_extract_literal_strings(gov_constants, "ALLOWED_DELIVERY_BEHAVIORS"))
    if not delivery_behaviors:
        delivery_behaviors = set(re.findall(r'"(continue|quarantine|block)"', gov_constants))

    manifest_text = MANIFEST_PATH.read_text(encoding="utf-8")

    # AuthType values must appear in manifest (as auth.http.* ids or notes)
    auth_id_map = {
        "no_auth": "auth.http.no_auth",
        "basic": "auth.http.basic",
        "bearer": "auth.http.bearer",
        "api_key": "auth.http.api_key",
        "oauth2_client_credentials": "auth.http.oauth2_client_credentials",
        "session_login": "auth.http.session_login",
        "jwt_refresh_token": "auth.http.jwt_refresh_token",
        "vendor_jwt_exchange": "auth.http.vendor_jwt_exchange",
    }
    id_set = set(ids)
    for at in sorted(auth_types):
        expected = auth_id_map.get(at)
        if expected and expected not in id_set:
            errors.append(f"AuthType {at!r} missing capability id {expected}")

    for rt in sorted(registry_auth):
        # Registry uses UPPERCASE
        lower = rt.lower()
        expected = auth_id_map.get(lower)
        if expected and expected not in id_set:
            errors.append(f"AuthStrategyRegistry key {rt!r} missing capability {expected}")

    # Canonical product source types (aliases counted under primary)
    source_id_map = {
        **CONTROL_SOURCE_CAPABILITIES,
        "AI_PROXY_RECEIVER": "source.ai_proxy_receiver",
    }
    by_id = {c.get("id"): c for c in caps}
    for st, cid in CONTROL_SOURCE_CAPABILITIES.items():
        if st not in source_adapter_keys and st not in source_types:
            errors.append(f"control source {st!r} missing from source registry/schema")
            continue
        cap = by_id.get(cid)
        if not cap or cap.get("status") != "SUPPORTED":
            errors.append(f"control source {st!r} must be SUPPORTED capability {cid}")
    if "AI_PROXY_RECEIVER" in source_adapter_keys:
        ai_source = by_id.get("source.ai_proxy_receiver")
        if not ai_source or ai_source.get("status") != "OUT_OF_SCOPE":
            errors.append("AI_PROXY_RECEIVER must stay OUT_OF_SCOPE and must not be a supported Control source")

    # Aliases should be mentioned in manifest text at least
    for alias in ("S3", "REMOTE_FILE", "WEBHOOK", "WEBHOOK_PUSH"):
        if alias in source_types or alias in source_adapter_keys:
            if alias not in manifest_text:
                warnings.append(f"source alias {alias!r} not mentioned in manifest text")

    dest_id_map = {
        "SYSLOG_UDP": "destination.syslog_udp",
        "SYSLOG_TCP": "destination.syslog_tcp",
        "SYSLOG_TLS": "destination.syslog_tls",
        "WEBHOOK_POST": "destination.webhook_post",
        "AI_PROVIDER_POST": "destination.ai_provider_post",
    }
    for dt, cid in dest_id_map.items():
        if dt not in dest_types:
            continue
        if dt == "AI_PROVIDER_POST":
            cap = by_id.get(cid)
            if not cap or cap.get("status") != "OUT_OF_SCOPE":
                errors.append("AI_PROVIDER_POST must stay OUT_OF_SCOPE and must not be a supported Control destination")
            continue
        if cid not in id_set:
            errors.append(f"destination type {dt!r} missing capability {cid}")
        elif by_id.get(cid, {}).get("status") != "SUPPORTED":
            errors.append(f"destination type {dt!r} must be SUPPORTED capability {cid}")

    for ct in sorted(connector_types):
        if ct not in manifest_text:
            warnings.append(f"ConnectorType {ct!r} not mentioned in manifest text")

    for rt in sorted(rule_types):
        expected = f"processing.enrichment.{rt}"
        if expected not in id_set:
            errors.append(f"enrichment rule type {rt!r} missing capability {expected}")

    for action in sorted(protection_actions):
        # map drop_field / mask_* to capability ids
        if action == "audit" and "governance.protection.audit" not in id_set:
            errors.append("protection action audit missing governance.protection.audit")
        if action in {"mask_partial", "mask_full"} and "governance.protection.mask" not in id_set:
            errors.append("protection mask actions missing governance.protection.mask")
        if action == "tokenize" and "governance.protection.tokenize" not in id_set:
            errors.append("protection action tokenize missing")
        if action == "hash" and "governance.protection.hash" not in id_set:
            errors.append("protection action hash missing")
        if action == "drop_field" and "governance.protection.drop_field" not in id_set:
            errors.append("protection action drop_field missing")

    for beh in sorted(delivery_behaviors):
        expected = f"governance.delivery.{beh}"
        if expected not in id_set:
            errors.append(f"delivery behavior {beh!r} missing capability {expected}")

    config_text = (REPO_ROOT / "app/config.py").read_text(encoding="utf-8")
    if not _assignment_default_true(config_text, "GDC_ROUTE_PROCESSING_ENABLED"):
        errors.append("app/config.py GDC_ROUTE_PROCESSING_ENABLED default must be True")
    if "false is no longer supported" not in config_text:
        errors.append("app/config.py must reject explicit Route Processing false")

    flag = by_id.get("flag.gdc_route_processing_enabled") or {}
    if flag.get("default_value") is not True:
        errors.append("flag.gdc_route_processing_enabled default_value must be true")
    for cid in ROUTE_ON_REQUIRED_SUPPORTED:
        if by_id.get(cid, {}).get("status") != "SUPPORTED":
            errors.append(f"{cid} must be SUPPORTED on the Route-ON product path")

    for phrase in STALE_TRUTH_PHRASES:
        if phrase in manifest_text:
            errors.append(f"capability manifest contains stale current-truth phrase: {phrase}")

    coverage_path = REPO_ROOT / "e2e/COVERAGE.md"
    coverage_text = coverage_path.read_text(encoding="utf-8") if coverage_path.exists() else ""
    for phrase in STALE_TRUTH_PHRASES:
        if phrase in coverage_text:
            errors.append(f"e2e/COVERAGE.md contains stale current-truth phrase: {phrase}")
    for label in PHASE_E_SOURCE_DEST_LABELS:
        if label in coverage_text:
            errors.append(f"e2e/COVERAGE.md must not list {label} as current Control support")

    for cid in PHASE_E_CAPABILITY_IDS:
        cap = by_id.get(cid)
        if not cap or cap.get("status") == "SUPPORTED" or cap.get("product_scope") != "phase_e_out_of_scope":
            errors.append(f"{cid} must be classified phase_e_out_of_scope and must not be SUPPORTED")

    axes_path = REPO_ROOT / "e2e/cross-product/cross-product-axes.yaml"
    axes_doc = yaml.safe_load(axes_path.read_text(encoding="utf-8"))
    route_values = (((axes_doc or {}).get("axes") or {}).get("route_runtime") or {}).get("values")
    if route_values != ["ROUTE_ON"]:
        errors.append(f"cross-product route_runtime values must be ['ROUTE_ON'], got {route_values!r}")

    release_cfg = yaml.safe_load(
        (REPO_ROOT / "e2e/release-gate/release-gate-config.yaml").read_text(encoding="utf-8")
    )
    route_cfg = (release_cfg or {}).get("route_processing") or {}
    if route_cfg.get("require_off") is not False or route_cfg.get("require_on") is not True:
        errors.append("release-gate route_processing must require ON and must not require OFF")

    baseline_path = REPO_ROOT / "e2e/cross-product/baseline/cross-product-baseline.json"
    if baseline_path.exists():
        import json

        baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
        if int(baseline.get("route_off_combinations") or 0) != 0:
            errors.append(
                "cross-product baseline route_off_combinations must be 0 "
                f"(got {baseline.get('route_off_combinations')})"
            )

    matrix_path = REPO_ROOT / "e2e/scenarios/generated/full-matrix.json"
    if matrix_path.exists():
        import json

        matrix = json.loads(matrix_path.read_text(encoding="utf-8"))
        if int((matrix.get("counts") or {}).get("route_off") or 0) != 0:
            errors.append("supported full matrix route_off count must be 0")
        for scenario in matrix.get("scenarios") or []:
            caps_for_scenario = scenario.get("capabilities") or []
            if any(cid in PHASE_E_CAPABILITY_IDS for cid in caps_for_scenario):
                errors.append(f"full matrix scenario includes Phase E capability: {scenario.get('id')}")
                break

    provenance = str((doc.get("metadata") or {}).get("generated_from_commit") or "")
    if not re.fullmatch(r"[0-9a-f]{40}", provenance):
        errors.append("metadata.generated_from_commit must be a 40-character commit")

    print(f"Manifest: {MANIFEST_PATH.relative_to(REPO_ROOT)}")
    print(f"Capabilities: {len(ids)}")
    print(f"AuthType (code): {sorted(auth_types)}")
    print(f"DestinationTypeLiteral (code): {sorted(dest_types)}")
    print(f"Enrichment _RULE_TYPES (code): {sorted(rule_types)}")
    print(f"Source adapter keys (code): {sorted(source_adapter_keys)}")

    if warnings:
        print("WARNINGS:")
        for w in warnings:
            print(f"  - {w}")

    if errors:
        print("FAIL:")
        for e in errors:
            print(f"  - {e}")
        return 1

    print("PASS: capability manifest validation succeeded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
