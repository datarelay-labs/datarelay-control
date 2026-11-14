"""Secret masking helpers for API responses, exports, and persisted snapshots."""

from __future__ import annotations

import re
from typing import Any, Mapping
from urllib.parse import parse_qsl, quote, unquote_plus, urlencode, urlparse, urlunparse

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


# --- Query-string / echoed-text masking (connector Test Authentication, API test) -----------------
# A secret that travels in the query string ends up in every URL the product echoes back (message,
# request/probe/final/token request URLs, response bodies that echo the URL, transport errors). The
# masking below is keyed on the parameter *name*, never on matching the saved value, so a wrong value
# typed into the form is masked as well. ``extra_names`` adds the connector's own configured names
# (``api_key_name``, ``access_token_query_name``).
QUERY_SECRET_PARAM_NAMES: frozenset[str] = frozenset(
    {
        "api_key",
        "apikey",
        "x_api_key",
        "access_token",
        "id_token",
        "refresh_token",
        "token",
        "auth_token",
        "key",
        "secret",
        "client_secret",
        "password",
        "passwd",
        "pwd",
        "sig",
        "signature",
        "auth",
        "authorization",
        "x_amz_signature",
        "x_amz_security_token",
        "x_amz_credential",
    }
)

# The product's own diagnostics print ``cookies=<cookie names>`` (names only, never values).
_QUERY_DIAGNOSTIC_NAMES: frozenset[str] = frozenset({"cookies"})

# ``name=value`` where ``name`` is not the tail of a longer word; the value ends at the first URL /
# JSON / whitespace delimiter. Matches inside URLs (``?a=b&c=d``), JSON strings and free text.
_QUERY_PAIR_RE = re.compile(r"(?<![A-Za-z0-9_.\-%])(?P<name>[A-Za-z0-9_.\-%\[\]]+)=(?P<value>[^&#\s\"'<>\\]*)")

# Never replace very short literals: it would garble ordinary text ("HTTP 200"); name-based masking is
# the primary control and literal redaction is defence in depth.
_MIN_LITERAL_REDACTION_LEN = 6


def normalize_query_param_names(names: Any) -> frozenset[str]:
    """Normalize configured query-parameter names for :func:`is_secret_query_param_name`."""

    out: set[str] = set()
    for raw in names or ():
        text = str(raw or "").strip()
        if text:
            out.add(normalize_secret_field_name(unquote_plus(text)))
    return frozenset(out)


def is_secret_query_param_name(name: str, extra_names: frozenset[str] | None = None) -> bool:
    """True when the query parameter ``name`` carries a credential (common names, heuristic, or configured)."""

    decoded = unquote_plus(str(name or "")).strip()
    if not decoded:
        return False
    normalized = normalize_secret_field_name(decoded)
    if normalized in QUERY_SECRET_PARAM_NAMES:
        return True
    if extra_names and normalized in normalize_query_param_names(extra_names):
        return True
    if normalized in _QUERY_DIAGNOSTIC_NAMES:
        return False
    return is_sensitive_field_name(decoded)


def mask_secret_query_params_in_text(text: str, *, extra_names: frozenset[str] | None = None) -> str:
    """Replace the value of every secret-named ``name=value`` pair in ``text`` with the mask sentinel."""

    raw = str(text or "")
    if "=" not in raw:
        return raw
    extra = normalize_query_param_names(extra_names)

    def _sub(match: re.Match[str]) -> str:
        value = match.group("value")
        if not value or value == _MASK or not is_secret_query_param_name(match.group("name"), extra):
            return match.group(0)
        return f"{match.group('name')}={_MASK}"

    return _QUERY_PAIR_RE.sub(_sub, raw)


def redact_secret_literals(text: str, literals: Any) -> str:
    """Replace known secret literals (and their URL-encoded forms) in ``text`` with the mask sentinel."""

    out = str(text or "")
    candidates: set[str] = set()
    for lit in literals or ():
        value = str(lit or "")
        if len(value) < _MIN_LITERAL_REDACTION_LEN or value == _MASK:
            continue
        candidates.update({value, quote(value, safe=""), quote(value), value.replace(" ", "+")})
    for value in sorted(candidates, key=len, reverse=True):
        if value and value in out:
            out = out.replace(value, _MASK)
    return out


def sanitize_secret_echo(
    value: Any,
    *,
    param_names: frozenset[str] | None = None,
    literals: Any = (),
) -> Any:
    """Recursively mask query-carried secrets in every string of a response structure.

    Dict keys are preserved; booleans, numbers and ``None`` are returned unchanged.
    """

    if isinstance(value, str):
        return redact_secret_literals(mask_secret_query_params_in_text(value, extra_names=param_names), literals)
    if isinstance(value, dict):
        return {k: sanitize_secret_echo(v, param_names=param_names, literals=literals) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitize_secret_echo(v, param_names=param_names, literals=literals) for v in value]
    if isinstance(value, tuple):
        return tuple(sanitize_secret_echo(v, param_names=param_names, literals=literals) for v in value)
    return value


# A value that is only a template placeholder ("{{login_password}}", "${TOKEN}") references a secret, it is not one.
_PLACEHOLDER_RE = re.compile(r"\s*(\{\{[^{}]+\}\}|\$\{[^{}]+\})\s*")


def is_template_placeholder(value: Any) -> bool:
    return isinstance(value, str) and _PLACEHOLDER_RE.fullmatch(value) is not None


def _mask_all_leaves(value: Any) -> Any:
    """Mask every non-empty scalar below a secret-named container (keys are kept)."""

    if isinstance(value, dict):
        return {k: _mask_all_leaves(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_mask_all_leaves(v) for v in value]
    if value is None or value == "" or isinstance(value, bool) or is_template_placeholder(value):
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
        elif isinstance(node, str) and node.strip() and node != _MASK and not is_template_placeholder(node):
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
