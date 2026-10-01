"""Marketplace package secret scanner (M29.5A).

Scans staged package text for embedded credentials. Placeholder / reference
values are allowed; literal secret material is a blocking failure.

Findings never include the secret value itself — only file, rule, and severity.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from app.connectors_registry.lifecycle_errors import LifecycleError

SEVERITY_BLOCKING = "blocking"

# Text-like suffixes / names typically present in Source Packs / Stream Extensions.
_SCAN_SUFFIXES = frozenset(
    {
        ".yaml",
        ".yml",
        ".json",
        ".md",
        ".txt",
        ".toml",
        ".ini",
        ".cfg",
        ".conf",
        ".env",
        ".csv",
        ".xml",
        ".properties",
        ".py",
        ".js",
        ".jsx",
        ".ts",
        ".tsx",
        ".sh",
        ".bash",
        ".zsh",
        ".ps1",
        ".rb",
        ".go",
        ".java",
        ".rs",
        ".pem",
        ".key",
        ".crt",
        ".cer",
    }
)

_SCAN_BASENAMES = frozenset(
    {
        "manifest",
        "dockerfile",
        "makefile",
        "readme",
        "license",
        "changelog",
    }
)

# Field names that often hold credentials when paired with literal values.
_SECRET_KEY_PATTERN = re.compile(
    r"(?i)^(password|passwd|pwd|secret|client[_-]?secret|consumer[_-]?secret|"
    r"secret[_-]?access[_-]?key|api[_-]?key|apikey|"
    r"(?:access|refresh|auth|oauth|session|id)[_-]?token|token|"
    r"private[_-]?key|authorization|bearer|credential|credentials)$"
)

# Values that look like intentional placeholders / refs, not live secrets.
_PLACEHOLDER_VALUE = re.compile(
    r"""(?ix)
    ^\s*(
        \$\{[^}]+\}          # ${ENV}
      | \{\{[^}]+\}\}        # {{mustache}}
      | <[^<>]{1,64}>        # <required>
      | \[your[^\]]*\]       # [your-api-key]
      | (null|none|nil|undefined|n/?a)
      | (required|changeme|change_me|placeholder|example|sample|todo|tbd|xxx+|[*•·]+)
      | (your[_-]?[a-z0-9_-]*)
      | (<\s*required\s*>)
    )\s*$
    """
)

_ENV_REF = re.compile(r"^\$\{[A-Za-z_][A-Za-z0-9_]*\}$")
_AUTH_ENV_REF = re.compile(
    r"(?i)^(?:bearer|basic)\s+\$\{[A-Za-z_][A-Za-z0-9_]*\}$"
)
_CREDENTIAL_REF_KEY = re.compile(r"(?i)(credential[_-]?ref|secret[_-]?ref|auth[_-]?ref)$")

_BEARER_LITERAL = re.compile(
    r"(?i)\bauthorization\s*[:=]\s*['\"]?bearer\s+([A-Za-z0-9\-._~+/]+=*)['\"]?"
)
_BEARER_INLINE = re.compile(r"(?i)\bbearer\s+([A-Za-z0-9\-._~+/]{16,}=*)\b")
_PEM_PRIVATE_KEY = re.compile(
    r"-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----"
)

# High-confidence literal API key / token shapes (excluding placeholders).
_LITERAL_TOKENISH = re.compile(
    r"(?x)"
    r"^(?:"
    r"sk-[A-Za-z0-9]{16,}"
    r"|ghp_[A-Za-z0-9]{20,}"
    r"|xox[baprs]-[A-Za-z0-9-]{10,}"
    r"|AKIA[0-9A-Z]{16}"
    r"|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}"  # JWT-ish
    r"|[A-Za-z0-9+/]{32,}={0,2}"  # long base64-ish
    r"|[A-Fa-f0-9]{32,}"  # long hex
    r")$"
)


@dataclass(frozen=True)
class SecretFinding:
    """Redacted secret finding — never carries the secret value."""

    file: str
    rule: str
    severity: str = SEVERITY_BLOCKING


def _is_scan_candidate(path: Path) -> bool:
    if not path.is_file() or path.is_symlink():
        return False
    name = path.name.lower()
    suffix = path.suffix.lower()
    if suffix in _SCAN_SUFFIXES:
        return True
    stem = path.stem.lower()
    if stem in _SCAN_BASENAMES or name in _SCAN_BASENAMES:
        return True
    # Extension-less config / stream definition files under known dirs.
    parts = {p.lower() for p in path.parts}
    if parts & {"streams", "mappings", "enrichments", "fixtures", "docs", "samples", "config"}:
        try:
            sample = path.read_bytes()[:512]
        except OSError:
            return False
        if b"\x00" in sample:
            return False
        return True
    return False


def _is_placeholder(value: str) -> bool:
    text = value.strip()
    if not text:
        return True
    if _ENV_REF.match(text):
        return True
    if _AUTH_ENV_REF.match(text):
        return True
    if _PLACEHOLDER_VALUE.match(text):
        return True
    # Short instructional stubs.
    if len(text) < 8 and text.lower() in {"test", "demo", "fake", "dummy"}:
        return True
    return False


def _looks_like_literal_secret(value: str, *, field_context: bool = False) -> bool:
    text = value.strip().strip("'\"")
    if not text or _is_placeholder(text):
        return False
    if _PEM_PRIVATE_KEY.search(text):
        return True
    if _LITERAL_TOKENISH.match(text):
        return True
    if field_context:
        # Secret-named fields fail closed for any non-placeholder literal, even
        # short passwords/tokens. URL-like values are configuration references,
        # not secret material.
        if text.startswith(("http://", "https://", "mailto:")):
            return False
        return True
    # Free-text: only high-confidence shapes (handled above) or long opaque tokens.
    if len(text) >= 24 and not any(ch.isspace() for ch in text[:64]):
        if text.startswith(("http://", "https://", "mailto:")):
            return False
        return True
    return False


def _finding(rel: str, rule: str) -> SecretFinding:
    return SecretFinding(file=rel, rule=rule, severity=SEVERITY_BLOCKING)


def _scan_mapping(obj: Any, *, rel: str, findings: list[SecretFinding], path: str = "") -> None:
    if isinstance(obj, dict):
        for key, value in obj.items():
            key_s = str(key)
            child = f"{path}.{key_s}" if path else key_s
            if isinstance(value, (dict, list)):
                _scan_mapping(value, rel=rel, findings=findings, path=child)
                continue
            if value is None:
                continue
            if not isinstance(value, (str, int, float, bool)):
                continue
            text = str(value)
            if _CREDENTIAL_REF_KEY.search(key_s):
                continue
            if _SECRET_KEY_PATTERN.match(key_s.strip()):
                if _looks_like_literal_secret(text, field_context=True):
                    findings.append(_finding(rel, f"secret_field:{key_s.strip().lower()}"))
                continue
            # Nested authorization bearer values without matching key name.
            if isinstance(value, str) and _BEARER_LITERAL.search(value):
                token = _BEARER_LITERAL.search(value)
                assert token is not None
                if not _is_placeholder(token.group(1)):
                    findings.append(_finding(rel, "authorization_bearer"))
    elif isinstance(obj, list):
        for idx, item in enumerate(obj):
            _scan_mapping(item, rel=rel, findings=findings, path=f"{path}[{idx}]")


def _scan_text_content(content: str, *, rel: str, findings: list[SecretFinding]) -> None:
    if _PEM_PRIVATE_KEY.search(content):
        findings.append(_finding(rel, "private_key_pem"))

    for match in _BEARER_INLINE.finditer(content):
        token = match.group(1)
        if not _is_placeholder(token) and len(token) >= 16:
            findings.append(_finding(rel, "authorization_bearer"))
            break

    # Key: value / key = value line heuristics for non-JSON/YAML leftovers.
    for line in content.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or stripped.startswith("//"):
            continue
        kv = re.match(
            r"(?i)^(?:['\"]?)([A-Za-z0-9_.-]+)(?:['\"]?)\s*[:=]\s*(.+?)\s*$",
            stripped,
        )
        if not kv:
            continue
        key, raw_val = kv.group(1), kv.group(2)
        if _CREDENTIAL_REF_KEY.search(key):
            continue
        val = raw_val.strip().strip(",").strip("'\"")
        if _SECRET_KEY_PATTERN.match(key) and _looks_like_literal_secret(val, field_context=True):
            findings.append(_finding(rel, f"secret_field:{key.lower()}"))


def _try_parse_structured(content: str) -> Any | None:
    text = content.strip()
    if not text:
        return None
    if text[0] in "[{":
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass
    try:
        import yaml

        loaded = yaml.safe_load(text)
        if isinstance(loaded, (dict, list)):
            return loaded
    except Exception:
        return None
    return None


def iter_scan_files(package_root: Path) -> Iterable[Path]:
    """Yield text-like files under a package root (signature metadata excluded)."""

    from app.connectors_registry.package_digest import is_signature_metadata_path

    if not package_root.is_dir():
        return
    for path in sorted(package_root.rglob("*")):
        if not _is_scan_candidate(path):
            continue
        try:
            rel = path.relative_to(package_root)
        except ValueError:
            continue
        if is_signature_metadata_path(rel):
            continue
        yield path


def scan_package_secrets(package_root: Path) -> list[SecretFinding]:
    """Scan package text files; return redacted findings (may be empty)."""

    findings: list[SecretFinding] = []
    for path in iter_scan_files(package_root):
        rel = path.relative_to(package_root).as_posix()
        try:
            content = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        structured = _try_parse_structured(content)
        if structured is not None:
            _scan_mapping(structured, rel=rel, findings=findings)
        _scan_text_content(content, rel=rel, findings=findings)

    # Deduplicate by (file, rule).
    seen: set[tuple[str, str]] = set()
    unique: list[SecretFinding] = []
    for finding in findings:
        key = (finding.file, finding.rule)
        if key in seen:
            continue
        seen.add(key)
        unique.append(finding)
    return unique


def assert_package_secrets_clean(package_root: Path) -> None:
    """Raise LifecycleError when blocking secrets are present (values redacted)."""

    findings = scan_package_secrets(package_root)
    if not findings:
        return
    details = [
        {"file": f.file, "rule": f.rule, "severity": f.severity}
        for f in findings
    ]
    raise LifecycleError(
        f"package contains embedded secrets ({len(findings)} finding(s))",
        error_code="PACKAGE_SECRET_DETECTED",
        details={"findings": details},
    )
