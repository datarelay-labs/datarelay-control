"""Static validation for enrichment configuration (no runtime execution)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal

from app.enrichers.lookup_tables import TABLES, normalize_table_name

_RULE_TYPES = frozenset({"static", "calculated", "lookup", "conditional", "normalize"})
_RESERVED_TOP_LEVEL = frozenset({"__rules", "__computed", "__preview", "__enrichment_meta"})
_FIELD_PATH_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$")
_NORMALIZE_FORMATS = frozenset({"iso8601", "iso_8601", "lowercase", "uppercase", "trim"})
_ALLOWED_FUNCTIONS = ("concat", "upper", "lower", "coalesce", "now_utc")
_FIELD_REF_RE = re.compile(r"\{\{\s*([^}]+?)\s*\}\}")


@dataclass
class EnrichmentValidationIssue:
    code: str
    severity: Literal["error", "warning"]
    message: str
    rule_type: str | None = None
    target_field: str | None = None
    field: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "severity": self.severity,
            "message": self.message,
            "rule_type": self.rule_type,
            "target_field": self.target_field,
            "field": self.field,
        }


@dataclass
class EnrichmentValidationResult:
    ok: bool
    issues: list[EnrichmentValidationIssue] = field(default_factory=list)

    def errors(self) -> list[EnrichmentValidationIssue]:
        return [i for i in self.issues if i.severity == "error"]

    def warnings(self) -> list[EnrichmentValidationIssue]:
        return [i for i in self.issues if i.severity == "warning"]


def is_valid_field_path(path: str) -> bool:
    key = path.strip()
    if not key or key.startswith("__"):
        return False
    if ".." in key or key.endswith("."):
        return False
    return bool(_FIELD_PATH_RE.match(key))


def validate_calculated_expression(expression: str) -> list[EnrichmentValidationIssue]:
    issues: list[EnrichmentValidationIssue] = []
    expr = expression.strip()
    if not expr:
        issues.append(
            EnrichmentValidationIssue(
                code="calculated_expression_empty",
                severity="error",
                message="Calculated expression is required",
                rule_type="calculated",
                field="expression",
            )
        )
        return issues
    if expr.count("(") != expr.count(")"):
        issues.append(
            EnrichmentValidationIssue(
                code="calculated_expression_malformed",
                severity="error",
                message="Unbalanced parentheses in expression",
                rule_type="calculated",
                field="expression",
            )
        )
    for ref in _FIELD_REF_RE.findall(expr):
        if not is_valid_field_path(ref):
            issues.append(
                EnrichmentValidationIssue(
                    code="invalid_field_path",
                    severity="error",
                    message=f"Invalid field reference {ref!r}",
                    rule_type="calculated",
                    field="expression",
                )
            )
    lower = expr.lower()
    if "{{" not in expr and not any(fn in lower for fn in _ALLOWED_FUNCTIONS):
        if "?" in expr and (".includes" in expr or "===" in expr or "==" in expr):
            return issues
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_.]*$", expr):
            issues.append(
                EnrichmentValidationIssue(
                    code="calculated_expression_unsupported",
                    severity="warning",
                    message="Expression uses legacy syntax; verify with preview before save",
                    rule_type="calculated",
                    field="expression",
                )
            )
    return issues


def _lookup_table_exists(name: str) -> bool:
    raw = name.strip()
    if not raw:
        return False
    return raw in TABLES or normalize_table_name(raw) in TABLES


def _validate_rule_dict(rule: dict[str, Any], *, default_target: str | None = None) -> list[EnrichmentValidationIssue]:
    issues: list[EnrichmentValidationIssue] = []
    rule_type = str(rule.get("type") or "").strip().lower()
    if rule_type not in _RULE_TYPES:
        issues.append(
            EnrichmentValidationIssue(
                code="invalid_rule_type",
                severity="error",
                message=f"Unsupported rule type {rule_type!r}",
                rule_type=rule_type or None,
            )
        )
        return issues

    target = str(
        rule.get("target_field")
        or rule.get("fieldName")
        or rule.get("field_name")
        or default_target
        or ""
    ).strip()
    if not target:
        issues.append(
            EnrichmentValidationIssue(
                code="missing_target_field",
                severity="error",
                message="Target field is required",
                rule_type=rule_type,
                field="target_field",
            )
        )
    elif not is_valid_field_path(target):
        issues.append(
            EnrichmentValidationIssue(
                code="invalid_field_path",
                severity="error",
                message=f"Invalid target field path {target!r}",
                rule_type=rule_type,
                target_field=target,
                field="target_field",
            )
        )

    if rule.get("enabled") is False:
        return issues

    if rule_type == "calculated":
        issues.extend(validate_calculated_expression(str(rule.get("expression") or "")))
        for issue in issues:
            if issue.target_field is None:
                issue.target_field = target or None
    elif rule_type == "lookup":
        table = str(rule.get("lookup_table") or rule.get("lookupTable") or "").strip()
        # Match rule_executor: key_field → lookup_key_field → lookupKeyField
        key_field = str(
            rule.get("key_field") or rule.get("lookup_key_field") or rule.get("lookupKeyField") or ""
        ).strip()
        if not table:
            issues.append(
                EnrichmentValidationIssue(
                    code="missing_lookup_table",
                    severity="error",
                    message="Lookup table is required",
                    rule_type="lookup",
                    target_field=target or None,
                    field="lookup_table",
                )
            )
        elif not _lookup_table_exists(table):
            issues.append(
                EnrichmentValidationIssue(
                    code="invalid_lookup_table",
                    severity="error",
                    message=f"Unknown lookup table {table!r}",
                    rule_type="lookup",
                    target_field=target or None,
                    field="lookup_table",
                )
            )
        if not key_field:
            issues.append(
                EnrichmentValidationIssue(
                    code="missing_lookup_key_field",
                    severity="error",
                    message="Lookup key field is required",
                    rule_type="lookup",
                    target_field=target or None,
                    field="lookup_key_field",
                )
            )
        elif not is_valid_field_path(key_field):
            issues.append(
                EnrichmentValidationIssue(
                    code="invalid_field_path",
                    severity="error",
                    message=f"Invalid lookup key field {key_field!r}",
                    rule_type="lookup",
                    target_field=target or None,
                    field="lookup_key_field",
                )
            )
    elif rule_type == "conditional":
        conditions = rule.get("conditions")
        if not isinstance(conditions, list) or len(conditions) == 0:
            issues.append(
                EnrichmentValidationIssue(
                    code="conditional_invalid",
                    severity="error",
                    message="At least one condition is required",
                    rule_type="conditional",
                    target_field=target or None,
                    field="conditions",
                )
            )
        else:
            has_valid_when = False
            for idx, item in enumerate(conditions):
                if not isinstance(item, dict):
                    continue
                when = str(item.get("when") or "").strip()
                if when:
                    has_valid_when = True
                elif str(item.get("then") or "").strip():
                    issues.append(
                        EnrichmentValidationIssue(
                            code="conditional_invalid",
                            severity="warning",
                            message=f"Condition {idx + 1} has 'then' without 'when'",
                            rule_type="conditional",
                            target_field=target or None,
                            field="conditions",
                        )
                    )
            if not has_valid_when and not str(rule.get("default") or rule.get("conditionalDefault") or "").strip():
                issues.append(
                    EnrichmentValidationIssue(
                        code="conditional_invalid",
                        severity="warning",
                        message="No when clauses or default value; rule may produce empty output",
                        rule_type="conditional",
                        target_field=target or None,
                        field="conditions",
                    )
                )
    elif rule_type == "normalize":
        source = str(
            rule.get("source_field") or rule.get("normalizeSourceField") or rule.get("sourceField") or ""
        ).strip()
        fmt = str(rule.get("format") or rule.get("normalizeFormat") or "iso8601").strip().lower()
        if not source:
            issues.append(
                EnrichmentValidationIssue(
                    code="missing_source_field",
                    severity="error",
                    message="Normalize source field is required",
                    rule_type="normalize",
                    target_field=target or None,
                    field="source_field",
                )
            )
        elif not is_valid_field_path(source):
            issues.append(
                EnrichmentValidationIssue(
                    code="invalid_field_path",
                    severity="error",
                    message=f"Invalid normalize source field {source!r}",
                    rule_type="normalize",
                    target_field=target or None,
                    field="source_field",
                )
            )
        if fmt not in _NORMALIZE_FORMATS:
            issues.append(
                EnrichmentValidationIssue(
                    code="invalid_normalize_format",
                    severity="error",
                    message=f"Unsupported normalize format {fmt!r}",
                    rule_type="normalize",
                    target_field=target or None,
                    field="format",
                )
            )

    return issues


def _iter_rules_from_enrichment(enrichment: dict[str, Any]) -> list[tuple[dict[str, Any], str | None]]:
    rules: list[tuple[dict[str, Any], str | None]] = []
    for key, value in enrichment.items():
        if key in _RESERVED_TOP_LEVEL:
            continue
        if isinstance(value, dict) and "type" in value:
            rules.append((value, str(key)))
    raw_rules = enrichment.get("__rules")
    if isinstance(raw_rules, dict):
        for key, value in raw_rules.items():
            key_type = str(key).strip().lower()
            if isinstance(value, dict) and "type" in value:
                rules.append((value, str(key)))
            elif isinstance(value, list):
                for item in value:
                    if isinstance(item, dict):
                        merged = dict(item)
                        if key_type in _RULE_TYPES and "type" not in merged:
                            merged["type"] = key_type
                        rules.append((merged, None))
    return rules


def validate_enrichment_json(enrichment: dict[str, Any] | None) -> EnrichmentValidationResult:
    """Validate enrichment configuration without executing rules."""

    if not enrichment:
        return EnrichmentValidationResult(ok=True)

    issues: list[EnrichmentValidationIssue] = []
    targets_seen: dict[str, str] = {}

    for key, value in enrichment.items():
        if key in _RESERVED_TOP_LEVEL:
            continue
        if isinstance(value, dict) and "type" in value:
            continue
        if not isinstance(key, str) or not key.strip():
            issues.append(
                EnrichmentValidationIssue(
                    code="invalid_static_field",
                    severity="error",
                    message="Static enrichment field name is required",
                    rule_type="static",
                    field="fieldName",
                )
            )
        elif not is_valid_field_path(key):
            issues.append(
                EnrichmentValidationIssue(
                    code="invalid_field_path",
                    severity="error",
                    message=f"Invalid static field path {key!r}",
                    rule_type="static",
                    target_field=key,
                    field="fieldName",
                )
            )
        else:
            kl = key.strip().lower()
            if kl in targets_seen:
                issues.append(
                    EnrichmentValidationIssue(
                        code="duplicate_target_field",
                        severity="warning",
                        message=f"Duplicate target field {key!r} (also used by {targets_seen[kl]})",
                        rule_type="static",
                        target_field=key,
                        field="fieldName",
                    )
                )
            else:
                targets_seen[kl] = key

    for rule, default_target in _iter_rules_from_enrichment(enrichment):
        for issue in _validate_rule_dict(rule, default_target=default_target):
            issues.append(issue)
        target = str(
            rule.get("target_field")
            or rule.get("fieldName")
            or default_target
            or ""
        ).strip()
        if target and rule.get("enabled") is not False:
            kl = target.lower()
            if kl in targets_seen:
                issues.append(
                    EnrichmentValidationIssue(
                        code="duplicate_target_field",
                        severity="warning",
                        message=f"Duplicate target field {target!r} (also used by {targets_seen[kl]})",
                        rule_type=str(rule.get("type") or ""),
                        target_field=target,
                        field="target_field",
                    )
                )
            else:
                targets_seen[kl] = target

    ok = not any(i.severity == "error" for i in issues)
    return EnrichmentValidationResult(ok=ok, issues=issues)
