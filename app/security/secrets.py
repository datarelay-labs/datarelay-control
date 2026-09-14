"""Secret masking helpers for API responses, exports, and persisted snapshots."""

from __future__ import annotations

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
    }
)

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


def is_sensitive_field_name(name: str) -> bool:
    """Return True when ``name`` is a known secret-bearing field or param key."""

    return normalize_secret_field_name(name) in SENSITIVE_FIELD_NAMES


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


def mask_secrets(value: Any) -> Any:
    """Recursively mask known secret fields in dict/list payloads."""

    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            key_str = normalize_secret_field_name(str(key))
            if key_str in SENSITIVE_FIELD_NAMES:
                out[key] = _MASK if item not in (None, "") else item
                continue
            out[key] = mask_secrets(item)
        return out
    if isinstance(value, list):
        return [mask_secrets(item) for item in value]
    return value


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
            if key_str in SENSITIVE_FIELD_NAMES and item == _MASK and prior not in (None, ""):
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
