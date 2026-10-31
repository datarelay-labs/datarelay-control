"""Secret masking helpers for API responses, exports, and persisted snapshots."""

from __future__ import annotations

import re
from typing import Any, Mapping
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

# Exported for export/import integrity checks (backup bundles, audit views).
SENSITIVE_FIELD_NAMES: frozenset[str] = frozenset(
    {
        "secret_key",
        "access_key",
        "password",
        "basic_password",
        "token",
        "bearer_token",
        "api_key_value",
        "client_secret",
        "oauth_client_secret",
        "oauth2_client_secret",
        "login_password",
        "refresh_token",
        "access_token",
        "id_token",
        "api_key",
        "secret",
        "private_key",
        "tls_key_pem",
        "certificate_pem",
        # Declared connector/source secret fields (see ``SOURCE_SECRET_FIELDS``).
        "shared_secret",
        "webhook_shared_secret",
        "webhook_bearer_token",
        "private_key_passphrase",
        "remote_private_key_passphrase",
        "remote_private_key",
        "remote_password",
        "db_password",
        "passphrase",
    }
)

# Secret-bearing fields declared per Source type and per storage container. This is the explicit
# half of the masking policy (the other half is the generic key-name heuristic below). Every
# serializer must go through :func:`mask_source_config_json` / :func:`mask_source_auth_json` (or the
# generic :func:`mask_secrets`) so that adding a connector type means declaring its fields here.
SOURCE_SECRET_FIELDS: dict[str, dict[str, frozenset[str]]] = {
    "HTTP_API_POLLING": {
        "config_json": frozenset(),
        "auth_json": frozenset(
            {
                "basic_password",
                "bearer_token",
                "api_key_value",
                "api_key",
                "oauth2_client_secret",
                "login_password",
                "refresh_token",
                "access_token",
            }
        ),
    },
    "S3_OBJECT_POLLING": {
        "config_json": frozenset({"secret_key", "access_key"}),
        "auth_json": frozenset(),
    },
    "DATABASE_QUERY": {
        "config_json": frozenset({"password"}),
        "auth_json": frozenset(),
    },
    "REMOTE_FILE_POLLING": {
        "config_json": frozenset({"password", "private_key", "private_key_passphrase"}),
        "auth_json": frozenset(),
    },
    "WEBHOOK_RECEIVER": {
        "config_json": frozenset(),
        "auth_json": frozenset({"shared_secret", "bearer_token"}),
    },
}

_SENSITIVE_HEADER_NAMES = frozenset(
    {
        "authorization",
        "cookie",
        "set-cookie",
        "x-api-key",
    }
)

_MASK = "********"


def normalize_secret_field_name(name: str) -> str:
    """Normalize header/query/body key names for sensitive-field matching."""

    return str(name).lower().replace("-", "_")


# --- Generic key-name heuristic (backstop for fields that are not declared above) ---------------
# A key is treated as secret-bearing when one of its ``_``-separated tokens is a secret word, when it
# contains a secret compound (``api_key``, ``private_key`` ...), or when it contains ``token`` that is
# not a pagination cursor. A trailing descriptor token (``url``, ``name``, ``path``, ``mode`` ...)
# means the field *describes* a credential rather than holding it and is never treated as secret.
_SECRET_WORD_TOKENS = frozenset(
    {
        "secret",
        "secrets",
        "password",
        "passwd",
        "passphrase",
        "pwd",
        "pass",
        "credential",
        "credentials",
        "authorization",
        "tokens",
        "cookie",
        "cookies",
        "apikey",
        "privatekey",
        "accesskey",
        "secretkey",
    }
)
_KEY_QUALIFIER_TOKENS = frozenset(
    {
        "api",
        "private",
        "access",
        "secret",
        "signing",
        "encryption",
        "auth",
        "shared",
        "master",
        "session",
        "license",
        "bearer",
        "hmac",
        "client",
        "sas",
    }
)
_CURSOR_TOKEN_QUALIFIERS = frozenset(
    {"page", "next", "prev", "previous", "continuation", "cursor", "pagination", "sync", "delta", "resume", "start", "nextpage"}
)
_DESCRIPTOR_LAST_TOKENS = frozenset(
    {
        "url",
        "uri",
        "path",
        "name",
        "names",
        "header",
        "headers",
        "prefix",
        "suffix",
        "location",
        "method",
        "mode",
        "type",
        "ttl",
        "seconds",
        "endpoint",
        "field",
        "fields",
        "param",
        "params",
        "configured",
        "set",
        "present",
        "enabled",
        "required",
        "policy",
        "format",
        "injection",
        "scheme",
        "id",
        "ids",
        "version",
        "expires",
        "expiry",
        "at",
        "length",
        "count",
        "pattern",
        "template",
        "label",
        "hint",
        "kind",
        "body",
        "extract",
        "extractions",
        "claim",
        "algorithm",
        "alg",
    }
)


def _name_tokens(name: str) -> list[str]:
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(name))
    return [t for t in re.split(r"[^a-z0-9]+", spaced.lower()) if t]


def _heuristic_secret_name(name: str) -> bool:
    tokens = _name_tokens(name)
    if not tokens:
        return False
    if tokens[-1] in _DESCRIPTOR_LAST_TOKENS:
        return False
    if any(t in _SECRET_WORD_TOKENS for t in tokens):
        return True
    for idx, tok in enumerate(tokens):
        if tok == "token" and not (idx > 0 and tokens[idx - 1] in _CURSOR_TOKEN_QUALIFIERS):
            return True
        if tok == "key" and idx > 0 and tokens[idx - 1] in _KEY_QUALIFIER_TOKENS:
            return True
    return False


def is_sensitive_field_name(name: str, *, declared: frozenset[str] | None = None) -> bool:
    """Return True when ``name`` is a declared secret field or looks like a secret-bearing key.

    ``declared`` adds per-scope names (see :data:`SOURCE_SECRET_FIELDS`) on top of the global
    registry; the generic heuristic is always applied as a backstop.
    """

    normalized = normalize_secret_field_name(name)
    if normalized in SENSITIVE_FIELD_NAMES:
        return True
    if declared and normalized in declared:
        return True
    return _heuristic_secret_name(str(name))


def mask_http_headers(headers: dict[str, str]) -> dict[str, str]:
    """Mask Authorization, Cookie, API keys, and similar headers for API responses."""

    out: dict[str, str] = {}
    for key, item in headers.items():
        lk = str(key).lower()
        if lk in _SENSITIVE_HEADER_NAMES:
            out[str(key)] = _MASK if item not in (None, "") else str(item)
            continue
        low_key = lk.replace("_", "-")
        if "secret" in lk:
            out[str(key)] = _MASK if item not in (None, "") else str(item)
            continue
        if low_key.endswith("-token") or "token" in lk or "password" in lk:
            out[str(key)] = _MASK if item not in (None, "") else str(item)
            continue
        if "api-key" in low_key or low_key.endswith("apikey") or "api_key" in lk:
            out[str(key)] = _MASK if item not in (None, "") else str(item)
            continue
        out[str(key)] = str(item)
    return out


def mask_headers_map(
    headers: Mapping[str, Any] | None,
    *,
    mask_all_values: bool = False,
) -> dict[str, str]:
    """Mask a headers mapping.

    When ``mask_all_values`` is True (destination/webhook delivery headers), every
    non-empty value is replaced with the sentinel. Otherwise only sensitive header
    names are masked.
    """

    raw = {str(k): "" if v is None else str(v) for k, v in dict(headers or {}).items()}
    if mask_all_values:
        return {k: (_MASK if str(v).strip() else v) for k, v in raw.items()}
    return mask_http_headers(raw)


def mask_param_map(params: Mapping[str, Any] | None) -> dict[str, Any]:
    """Mask sensitive query/form parameter values by key name."""

    out: dict[str, Any] = {}
    for key, item in dict(params or {}).items():
        if is_sensitive_field_name(str(key)) and item not in (None, ""):
            out[key] = _MASK
        else:
            out[key] = item
    return out


def mask_url_query_secrets(url: str) -> str:
    """Return ``url`` with sensitive query-parameter values replaced by the sentinel."""

    text = str(url or "")
    if not text or "?" not in text:
        return text
    parsed = urlparse(text)
    if not parsed.query:
        return text
    pairs = []
    changed = False
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        if is_sensitive_field_name(key) and value not in (None, ""):
            pairs.append((key, _MASK))
            changed = True
        else:
            pairs.append((key, value))
    if not changed:
        return text
    return urlunparse(parsed._replace(query=urlencode(pairs, doseq=True)))


def _mask_all_leaves(value: Any) -> Any:
    """Mask every non-empty scalar below a secret-named container (keys are kept)."""

    if isinstance(value, dict):
        return {k: _mask_all_leaves(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_mask_all_leaves(v) for v in value]
    if value is None or value == "" or isinstance(value, bool):
        return value
    return _MASK


def mask_secrets(value: Any, *, declared: frozenset[str] | None = None) -> Any:
    """Recursively mask secret fields in dict/list payloads.

    This is the single choke point every list/detail/export/bundle serializer goes through.
    A key is masked when it is declared (global registry or ``declared``) or matches the generic
    secret-name heuristic. Empty values and booleans are left as-is so the UI can tell "set" (masked
    sentinel) from "not set" (empty) without ever seeing the value.
    """

    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            if is_sensitive_field_name(str(key), declared=declared):
                out[key] = _mask_all_leaves(item)
                continue
            out[key] = mask_secrets(item, declared=declared)
        return out
    if isinstance(value, list):
        return [mask_secrets(item, declared=declared) for item in value]
    return value


def mask_source_config_json(source_type: str | None, config: Mapping[str, Any] | None) -> dict[str, Any]:
    """Mask ``Source.config_json`` using the per-type declaration plus the generic heuristic."""

    scope = SOURCE_SECRET_FIELDS.get(str(source_type or "").strip().upper(), {})
    return mask_secrets(dict(config or {}), declared=scope.get("config_json"))


def mask_source_auth_json(source_type: str | None, auth: Mapping[str, Any] | None) -> dict[str, Any]:
    """Mask ``Source.auth_json`` using the per-type declaration plus the generic heuristic."""

    scope = SOURCE_SECRET_FIELDS.get(str(source_type or "").strip().upper(), {})
    return mask_secrets(dict(auth or {}), declared=scope.get("auth_json"))


def collect_secret_literals(value: Any, *, declared: frozenset[str] | None = None) -> list[str]:
    """Return the string literals stored under secret-named keys (used to verify exports)."""

    out: list[str] = []

    def _leaves(node: Any) -> None:
        if isinstance(node, dict):
            for v in node.values():
                _leaves(v)
        elif isinstance(node, list):
            for v in node:
                _leaves(v)
        elif isinstance(node, str) and node.strip() and node != _MASK:
            out.append(node)

    def _walk(node: Any) -> None:
        if isinstance(node, dict):
            for key, item in node.items():
                if is_sensitive_field_name(str(key), declared=declared):
                    _leaves(item)
                else:
                    _walk(item)
        elif isinstance(node, list):
            for item in node:
                _walk(item)

    _walk(value)
    return out


def redact_pem_literals(value: Any) -> Any:
    """Replace string values that contain PEM blocks (certs/keys) with the standard mask."""

    if isinstance(value, str):
        if "-----BEGIN" in value and "-----END" in value:
            return _MASK
        return value
    if isinstance(value, dict):
        return {k: redact_pem_literals(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redact_pem_literals(item) for item in value]
    return value


def _mask_nested_headers(value: Any, *, mask_all_header_values: bool) -> Any:
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            if str(key).lower() == "headers" and isinstance(item, dict):
                out[key] = mask_headers_map(item, mask_all_values=mask_all_header_values)
            else:
                out[key] = _mask_nested_headers(item, mask_all_header_values=mask_all_header_values)
        return out
    if isinstance(value, list):
        return [_mask_nested_headers(item, mask_all_header_values=mask_all_header_values) for item in value]
    return value


def mask_config_payload(value: Any, *, mask_all_header_values: bool = False) -> Any:
    """Unified config masking: sensitive fields, nested headers maps, then PEM literals.

    Use ``mask_all_header_values=True`` for destination/webhook ``config_json`` so
    outbound Authorization / API-key header values never leave the API or journal.
    """

    return redact_pem_literals(
        _mask_nested_headers(mask_secrets(value), mask_all_header_values=mask_all_header_values)
    )


def mask_secrets_and_pem(value: Any) -> Any:
    """Apply :func:`mask_secrets` then strip PEM material from any remaining strings."""

    return redact_pem_literals(mask_secrets(value))


MASKED_SECRET_SENTINEL = _MASK


def preserve_masked_secrets(incoming: Any, existing: Any) -> Any:
    """Merge update payloads so masked sentinels keep previously stored secrets.

    When a client round-trips a masked GET response into a PUT, secret fields
    arrive as ``********``. Those must not overwrite real stored values.
    """

    if isinstance(incoming, dict):
        existing_dict = existing if isinstance(existing, dict) else {}
        out: dict[str, Any] = {}
        for key, item in incoming.items():
            key_str = normalize_secret_field_name(str(key))
            prior = existing_dict.get(key)
            if is_sensitive_field_name(str(key)) and item == _MASK and prior not in (None, ""):
                out[key] = prior
                continue
            if item == _MASK and isinstance(prior, str) and prior not in (None, ""):
                # Nested opaque secret strings (e.g. PEM blobs) also use the sentinel.
                out[key] = prior
                continue
            out[key] = preserve_masked_secrets(item, prior)
        return out
    if isinstance(incoming, list):
        existing_list = existing if isinstance(existing, list) else []
        return [
            preserve_masked_secrets(item, existing_list[idx] if idx < len(existing_list) else None)
            for idx, item in enumerate(incoming)
        ]
    return incoming


def find_masked_secret_paths(value: Any, prefix: str = "") -> list[str]:
    """Return dotted paths of every value that is still the masked sentinel."""

    out: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            if item == _MASK:
                out.append(path)
            else:
                out.extend(find_masked_secret_paths(item, path))
    elif isinstance(value, list):
        for idx, item in enumerate(value):
            path = f"{prefix}[{idx}]"
            if item == _MASK:
                out.append(path)
            else:
                out.extend(find_masked_secret_paths(item, path))
    return out


def restore_stripped_secrets(stripped: Any, original: Any) -> Any:
    """Re-add secret fields that an import dropped (masked placeholders) from the stored original.

    Used for same-environment clones, where the original row still holds the real values.
    """

    if isinstance(stripped, dict) and isinstance(original, dict):
        out = dict(stripped)
        for key, orig_item in original.items():
            if key not in out or out[key] in (None, ""):
                if is_sensitive_field_name(str(key)):
                    out[key] = orig_item
                continue
            out[key] = restore_stripped_secrets(out[key], orig_item)
        return out
    return stripped
