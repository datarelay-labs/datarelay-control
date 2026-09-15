"""Parse ``curl`` command strings into HTTP request components (no secret persistence)."""

from __future__ import annotations

import base64
import json
import re
import shlex
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, urlparse

from app.security.secrets import (
    MASKED_SECRET_SENTINEL,
    mask_config_payload,
    mask_http_headers,
    mask_param_map,
    mask_url_query_secrets,
)

_MASK = MASKED_SECRET_SENTINEL


@dataclass
class ParsedCurlRequest:
    method: str = "GET"
    url: str = ""
    base_url: str = ""
    endpoint: str = "/"
    query_params: dict[str, str] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)
    headers_masked: dict[str, str] = field(default_factory=dict)
    json_body: Any | None = None
    raw_body: str | None = None
    warnings: list[str] = field(default_factory=list)
    parse_errors: list[str] = field(default_factory=list)


def _normalize_curl_text(raw: str) -> str:
    text = (raw or "").strip()
    if not text:
        return ""
    text = re.sub(r"\\\s*\r?\n", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    if text.lower().startswith("curl "):
        text = text[5:].strip()
    elif text.lower() == "curl":
        text = ""
    return text


def _tokenize_curl(text: str) -> list[str]:
    if not text:
        return []
    try:
        return shlex.split(text, posix=True)
    except ValueError as exc:
        raise ValueError(f"Could not tokenize curl command: {exc}") from exc


def _next_value(tokens: list[str], i: int) -> tuple[str | None, int]:
    if i + 1 >= len(tokens):
        return None, i + 1
    return tokens[i + 1], i + 2


def _parse_basic_user_flag(value: str) -> tuple[str, str]:
    if ":" in value:
        user, pw = value.split(":", 1)
        return user, pw
    return value, ""


def _looks_like_url(token: str) -> bool:
    t = token.strip()
    return t.startswith("http://") or t.startswith("https://") or t.startswith("$")


def _split_url(url: str) -> tuple[str, str, dict[str, str]]:
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.netloc:
        return "", url if url.startswith("/") else f"/{url}", {}
    base = f"{parsed.scheme}://{parsed.netloc}"
    path = parsed.path or "/"
    qs = parse_qs(parsed.query, keep_blank_values=True)
    params = {k: (v[0] if v else "") for k, v in qs.items()}
    return base, path, params


def _coerce_json_body(raw: str) -> tuple[Any | None, str | None]:
    stripped = raw.strip()
    if not stripped:
        return None, None
    try:
        return json.loads(stripped), None
    except json.JSONDecodeError:
        return None, stripped


def parse_curl_command(raw: str) -> ParsedCurlRequest:
    """Parse a curl command into method, URL parts, headers, and body."""

    out = ParsedCurlRequest()
    text = _normalize_curl_text(raw)
    if not text:
        out.parse_errors.append("Empty curl command.")
        return out

    try:
        tokens = _tokenize_curl(text)
    except ValueError as exc:
        out.parse_errors.append(str(exc))
        return out

    method = "GET"
    url: str | None = None
    headers: dict[str, str] = {}
    data_parts: list[str] = []
    use_get_with_data = False
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        low = tok.lower()
        if low in ("-x", "--request"):
            val, i = _next_value(tokens, i)
            if val:
                method = val.upper()
            continue
        if low in ("-h", "--header"):
            val, i = _next_value(tokens, i)
            if val and ":" in val:
                name, value = val.split(":", 1)
                headers[name.strip()] = value.strip()
            continue
        if low in ("-d", "--data", "--data-raw", "--data-binary", "--data-urlencode"):
            val, i = _next_value(tokens, i)
            if val is not None:
                data_parts.append(val)
            continue
        if low in ("-g", "--get"):
            use_get_with_data = True
            i += 1
            continue
        if low in ("-u", "--user"):
            val, i = _next_value(tokens, i)
            if val:
                user, pw = _parse_basic_user_flag(val)
                if user:
                    cred = base64.b64encode(f"{user}:{pw}".encode()).decode()
                    headers["Authorization"] = f"Basic {cred}"
            continue
        if low.startswith("-") and low not in ("-k", "-s", "-s", "-l", "-i", "-v", "--compressed", "-L", "--location"):
            _, i = _next_value(tokens, i)
            continue
        if _looks_like_url(tok):
            url = tok.strip().strip("'\"")
            i += 1
            continue
        i += 1

    if url is None:
        for t in tokens:
            if _looks_like_url(t):
                url = t.strip().strip("'\"")
                break

    if not url:
        out.parse_errors.append("No URL found in curl command.")
        return out

    if url.startswith("$"):
        out.warnings.append("URL uses a shell variable; replace it with a literal URL before saving.")
        url = "https://example.invalid/"

    base, endpoint, query_from_url = _split_url(url)
    out.url = url
    out.base_url = base
    out.endpoint = endpoint
    out.query_params = dict(query_from_url)

    if data_parts:
        body_raw = "&".join(data_parts) if use_get_with_data and method == "GET" else data_parts[-1]
        if use_get_with_data and method == "GET":
            extra = parse_qs(body_raw, keep_blank_values=True)
            for k, v in extra.items():
                out.query_params[k] = v[0] if v else ""
            out.warnings.append("curl -G data merged into query_params.")
        else:
            json_body, raw_body = _coerce_json_body(body_raw)
            out.json_body = json_body
            out.raw_body = raw_body
            if method == "GET":
                method = "POST"
                out.warnings.append("Request body present; method promoted to POST.")

    out.method = method
    out.headers = headers
    out.headers_masked = mask_http_headers({str(k): str(v) for k, v in headers.items()})

    if out.json_body is not None and "Content-Type" not in {k.title() for k in out.headers}:
        out.warnings.append("JSON body detected without Content-Type; application/json is typical.")

    return out


def build_curl_import_draft(parsed: ParsedCurlRequest, *, connector_name: str | None = None) -> dict[str, Any]:
    """Build a UI-friendly draft (secrets masked; credentials not populated)."""

    from urllib.parse import urljoin

    name = (connector_name or "").strip() or "Imported HTTP connector"
    auth_type = "no_auth"
    auth_fields: dict[str, Any] = {}
    common_headers: dict[str, str] = {}

    for hk, hv in parsed.headers.items():
        lk = hk.lower()
        if lk == "authorization":
            parts = hv.split(None, 1)
            scheme = parts[0].lower() if parts else ""
            if scheme == "bearer" and len(parts) > 1:
                auth_type = "bearer"
                auth_fields["bearer_token"] = ""
            elif scheme == "basic" and len(parts) > 1:
                auth_type = "basic"
                auth_fields["basic_username"] = ""
                auth_fields["basic_password"] = ""
            continue
        if lk in ("x-api-key",) or "api" in lk and "key" in lk:
            auth_type = "api_key"
            auth_fields["api_key_name"] = hk
            auth_fields["api_key_value"] = ""
            auth_fields["api_key_location"] = "headers"
            continue
        common_headers[hk] = hv

    # Header masking alone is insufficient: query/body may carry api_key, token, password, etc.
    safe_query = mask_param_map(parsed.query_params)
    safe_body: Any | None
    if parsed.json_body is not None:
        safe_body = mask_config_payload(parsed.json_body)
    elif parsed.raw_body:
        safe_body = _MASK if any(
            token in (parsed.raw_body or "").lower()
            for token in ("password=", "api_key=", "access_token=", "client_secret=", "token=")
        ) else parsed.raw_body
    else:
        safe_body = None

    stream_config: dict[str, Any] = {
        "endpoint": parsed.endpoint,
        "method": parsed.method,
    }
    if safe_query:
        stream_config["params"] = dict(safe_query)
    if safe_body is not None:
        stream_config["body"] = safe_body

    suggested_stream_name = "Imported stream"
    if parsed.endpoint and parsed.endpoint != "/":
        slug = parsed.endpoint.strip("/").split("/")[-1] or "stream"
        suggested_stream_name = f"Imported {slug}"

    safe_url = mask_url_query_secrets(parsed.url)
    base_url = parsed.base_url or urljoin(safe_url, "/")

    return {
        "draft_kind": "curl_http",
        "connector": {
            "name": name,
            "description": f"Draft from curl ({parsed.method} {parsed.endpoint})",
            "status": "STOPPED",
            "source_type": "HTTP_API_POLLING",
            "connector_type": "generic_http",
            "base_url": base_url,
            "verify_ssl": True,
            "common_headers": common_headers,
            "auth_type": auth_type,
            **auth_fields,
        },
        "source_config_json": {
            "connector_type": "generic_http",
            "base_url": base_url,
            "verify_ssl": True,
            "common_headers": common_headers,
        },
        "stream": {
            "name": suggested_stream_name,
            "stream_type": "HTTP_API_POLLING",
            "enabled": False,
            "status": "STOPPED",
            "config_json": stream_config,
            "polling_interval": 60,
        },
        "parsed": {
            "method": parsed.method,
            "url": safe_url,
            "base_url": parsed.base_url,
            "endpoint": parsed.endpoint,
            "query_params": safe_query,
            "headers_masked": parsed.headers_masked,
            "has_json_body": parsed.json_body is not None,
            "has_raw_body": parsed.raw_body is not None,
        },
        "warnings": list(parsed.warnings),
        "parse_errors": list(parsed.parse_errors),
        "secrets_included": False,
    }
