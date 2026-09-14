"""Connector HTTP routes."""

import secrets
from typing import Any
from urllib.parse import urlparse

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from app.config_concurrency import as_utc, pop_expected_updated_at, require_fresh_updated_at
from app.connectors.models import Connector
from app.connectors.product_group import infer_product_group_from_connector_name
from app.connectors.schemas import (
    ConnectorCreate,
    ConnectorRead,
    ConnectorUpdate,
)
from app.connectors.operations_schemas import (
    ConnectorAuthCheckPersistedResponse,
    ConnectorOperationsSummaryResponse,
)
from app.connectors.operations_service import (
    get_connectors_operations_summary,
    merge_operational_config,
    read_operational_config,
    run_connector_auth_check_and_persist,
)
from app.connectors.catalog_read import load_connectors_catalog_list
from app.connectors.read_cache import (
    clear_connectors_read_cache,
    get_connectors_operations_summary_cached,
    invalidate_connectors_read_cache_after_auth_check,
)
from app.database import SessionLocal, get_db, get_db_read_bounded, utcnow
from app.sources.models import Source
from app.platform_admin import journal
from app.streams.models import Stream

router = APIRouter()

_MASK = "********"
_SECRET_KEYS = {
    "basic_password",
    "bearer_token",
    "api_key_value",
    "api_key",
    "oauth2_client_secret",
    "login_password",
    "refresh_token",
    "secret_key",
    "db_password",
    "remote_password",
    "remote_private_key",
    "remote_private_key_passphrase",
    "webhook_shared_secret",
    "webhook_bearer_token",
}


def _apply_operational_from_payload(
    config: dict[str, Any] | None,
    payload: ConnectorCreate | ConnectorUpdate,
    *,
    partial: bool,
) -> dict[str, Any]:
    incoming = payload.model_dump(exclude_unset=partial)
    patch: dict[str, Any] = {}
    if "auth_health_check_interval" in incoming:
        patch["auth_health_check_interval"] = incoming.get("auth_health_check_interval")
    if not patch:
        return dict(config or {})
    return merge_operational_config(config if isinstance(config, dict) else {}, patch)


def _operational_read_fields(config: dict[str, Any] | None) -> dict[str, Any]:
    op = read_operational_config(config)
    return {
        "auth_health_check_interval": op.get("auth_health_check_interval") or "disabled",
        "last_auth_check_at": op.get("last_auth_check_at"),
        "last_auth_check_status": op.get("last_auth_check_status"),
        "last_auth_error": op.get("last_auth_error"),
    }


def _not_found(connector_id: int) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"error_code": "CONNECTOR_NOT_FOUND", "message": f"connector not found: {connector_id}"},
    )


def _bad_request(message: str, error_code: str = "CONNECTOR_VALIDATION_FAILED") -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"error_code": error_code, "message": message})


def _normalize_source_type(source_type: str | None) -> str:
    value = str(source_type or "HTTP_API_POLLING").strip().upper()
    aliases = {
        "S3": "S3_OBJECT_POLLING",
        "REMOTE_FILE": "REMOTE_FILE_POLLING",
        "WEBHOOK": "WEBHOOK_RECEIVER",
        "WEBHOOK_PUSH": "WEBHOOK_RECEIVER",
    }
    return aliases.get(value, value)


def _normalize_auth_type(auth_type: str | None) -> str:
    value = (auth_type or "").strip().lower()
    alias = {
        "noauth": "no_auth",
        "none": "no_auth",
        "basicauth": "basic",
        "bearer_token": "bearer",
        "apikey": "api_key",
        "oauth2": "oauth2_client_credentials",
        "client_credentials": "oauth2_client_credentials",
        "session": "session_login",
        "jwt_refresh": "jwt_refresh_token",
        "vendor_jwt": "vendor_jwt_exchange",
        "stellar_jwt": "vendor_jwt_exchange",
    }
    return alias.get(value, value)


def _effective_host(payload: ConnectorCreate | ConnectorUpdate) -> str:
    host = (payload.host or payload.base_url or "").strip()
    if not host:
        raise _bad_request("host/base_url is required")
    return host


def _extract_common_headers(value: dict[str, Any] | None) -> dict[str, str]:
    if not value:
        return {}
    out: dict[str, str] = {}
    for key, item in value.items():
        key_str = str(key).strip()
        if not key_str:
            continue
        out[key_str] = str(item)
    return out


DEFAULT_GENERIC_HTTP_COMMON_HEADERS: dict[str, str] = {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
}


def _effective_common_headers(payload_headers: dict[str, Any] | None, *, on_create_empty_defaults: bool) -> dict[str, str]:
    extracted = _extract_common_headers(payload_headers)
    if on_create_empty_defaults and not extracted:
        return dict(DEFAULT_GENERIC_HTTP_COMMON_HEADERS)
    return extracted


def _merge_secret(
    key: str,
    incoming: dict[str, Any],
    existing: dict[str, Any] | None,
) -> str | None:
    if key in incoming:
        candidate = incoming.get(key)
        if candidate in (None, ""):
            if existing:
                kept = existing.get(key)
                if kept in (None, ""):
                    return None
                return str(kept)
            return None
        if str(candidate) == _MASK and existing:
            return str(existing.get(key) or "") or None
        return str(candidate)
    if existing:
        kept = existing.get(key)
        if kept in (None, ""):
            return None
        return str(kept)
    return None


def _mask_auth_for_response(auth: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(auth, dict):
        return {"auth_type": "no_auth"}
    out: dict[str, Any] = {}
    for key, value in auth.items():
        if key in _SECRET_KEYS:
            out[f"{key}_configured"] = value not in (None, "")
            out[key] = _MASK if value not in (None, "") else ""
            continue
        out[key] = value
    return out


def _build_auth_json(
    payload: ConnectorCreate | ConnectorUpdate,
    existing_auth: dict[str, Any] | None = None,
    *,
    partial: bool,
) -> dict[str, Any]:
    if partial and payload.auth_type is None and existing_auth:
        effective_auth_type = _normalize_auth_type(str(existing_auth.get("auth_type") or ""))
    else:
        effective_auth_type = _normalize_auth_type(payload.auth_type)
    if not effective_auth_type:
        raise _bad_request("auth_type is required")
    if effective_auth_type not in {
        "no_auth",
        "basic",
        "bearer",
        "api_key",
        "oauth2_client_credentials",
        "session_login",
        "jwt_refresh_token",
        "vendor_jwt_exchange",
    }:
        raise _bad_request(f"unsupported auth_type: {effective_auth_type}")

    incoming = payload.model_dump(exclude_unset=True)
    auth: dict[str, Any] = {"auth_type": effective_auth_type}

    if effective_auth_type == "basic":
        username = incoming.get("basic_username", payload.basic_username)
        password = _merge_secret("basic_password", incoming, existing_auth)
        if not (username and str(username).strip()):
            raise _bad_request("basic_username is required when auth_type=basic")
        if not password:
            raise _bad_request("basic_password is required when auth_type=basic")
        auth["basic_username"] = str(username).strip()
        auth["basic_password"] = password
        return auth

    if effective_auth_type == "bearer":
        token = _merge_secret("bearer_token", incoming, existing_auth)
        if not token:
            raise _bad_request("bearer_token is required when auth_type=bearer")
        auth["bearer_token"] = token
        return auth

    if effective_auth_type == "api_key":
        key_name = incoming.get("api_key_name", payload.api_key_name)
        key_value = _merge_secret("api_key_value", incoming, existing_auth)
        location = incoming.get("api_key_location", payload.api_key_location)
        location_norm = str(location or "").strip().lower()
        if not (key_name and str(key_name).strip()):
            raise _bad_request("api_key_name is required when auth_type=api_key")
        if not key_value:
            raise _bad_request("api_key_value is required when auth_type=api_key")
        if location_norm not in {"headers", "query_params"}:
            raise _bad_request("api_key_location must be one of: headers, query_params")
        auth["api_key_name"] = str(key_name).strip()
        auth["api_key_value"] = key_value
        auth["api_key_location"] = location_norm
        return auth

    if effective_auth_type == "oauth2_client_credentials":
        client_id = incoming.get("oauth2_client_id", payload.oauth2_client_id)
        token_url = incoming.get("oauth2_token_url", payload.oauth2_token_url)
        client_secret = _merge_secret("oauth2_client_secret", incoming, existing_auth)
        scope = incoming.get("oauth2_scope", payload.oauth2_scope)
        if not (client_id and str(client_id).strip()):
            raise _bad_request("oauth2_client_id is required when auth_type=oauth2_client_credentials")
        if not client_secret:
            raise _bad_request("oauth2_client_secret is required when auth_type=oauth2_client_credentials")
        if not (token_url and str(token_url).strip()):
            raise _bad_request("oauth2_token_url is required when auth_type=oauth2_client_credentials")
        auth["oauth2_client_id"] = str(client_id).strip()
        auth["oauth2_client_secret"] = client_secret
        auth["oauth2_token_url"] = str(token_url).strip()
        auth["oauth2_scope"] = str(scope).strip() if scope is not None else ""
        return auth

    if effective_auth_type == "session_login":
        ex = existing_auth if partial and isinstance(existing_auth, dict) else {}

        login_url = incoming.get("login_url") if "login_url" in incoming else (ex.get("login_url") if partial else payload.login_url)
        login_path = incoming.get("login_path") if "login_path" in incoming else (ex.get("login_path") if partial else payload.login_path)
        if login_url is None and partial:
            login_url = ex.get("login_url")
        if login_path is None and partial:
            login_path = ex.get("login_path")

        raw_login_method = (
            incoming.get("login_method")
            if "login_method" in incoming
            else (ex.get("login_method") if partial else payload.login_method)
        )
        login_method = str(raw_login_method or "POST").strip().upper()

        if "login_headers" in incoming:
            login_headers = incoming.get("login_headers") or {}
        elif partial and isinstance(ex.get("login_headers"), dict):
            login_headers = ex.get("login_headers") or {}
        else:
            login_headers = payload.login_headers or {}

        if "login_body_template" in incoming:
            login_body_template = incoming.get("login_body_template") or {}
        elif partial and isinstance(ex.get("login_body_template"), dict):
            login_body_template = ex.get("login_body_template") or {}
        else:
            login_body_template = payload.login_body_template or {}

        login_username = incoming.get("login_username") if "login_username" in incoming else (ex.get("login_username") if partial else payload.login_username)
        if login_username is None and partial:
            login_username = ex.get("login_username")
        login_password = _merge_secret("login_password", incoming, existing_auth)
        if not (login_url or login_path):
            raise _bad_request("login_url or login_path is required when auth_type=session_login")
        lu_chk = str(login_url).strip() if login_url else ""
        lp_chk = str(login_path).strip() if login_path else ""
        if lu_chk and lp_chk:
            p = urlparse(lu_chk)
            if p.scheme in ("http", "https") and p.netloc and (p.path or "").rstrip("/"):
                raise _bad_request(
                    "When login_path is set, login_url must be a scheme+host-only base URL with no path "
                    "(e.g. https://example.com). Alternatively omit login_path and put the full URL in login_url."
                )
        if not (login_username and str(login_username).strip()):
            raise _bad_request("login_username is required when auth_type=session_login")
        if not login_password:
            raise _bad_request("login_password is required when auth_type=session_login")
        auth["login_url"] = str(login_url).strip() if login_url else None
        auth["login_path"] = str(login_path).strip() if login_path else None
        auth["login_method"] = login_method
        auth["login_headers"] = _extract_common_headers(login_headers if isinstance(login_headers, dict) else {})
        auth["login_body_template"] = dict(login_body_template) if isinstance(login_body_template, dict) else {}
        auth["login_username"] = str(login_username).strip()
        auth["login_password"] = login_password

        if "login_body_mode" in incoming:
            body_mode = incoming.get("login_body_mode")
        elif partial and ex.get("login_body_mode") is not None:
            body_mode = ex.get("login_body_mode")
        else:
            body_mode = payload.login_body_mode
        if body_mode is not None and str(body_mode).strip():
            bm = str(body_mode).strip().lower()
            if bm not in {"json", "form_urlencoded", "raw"}:
                raise _bad_request("login_body_mode must be one of: json, form_urlencoded, raw")
            auth["login_body_mode"] = bm
        elif not partial:
            auth["login_body_mode"] = "json"
        elif partial and ex.get("login_body_mode"):
            auth["login_body_mode"] = str(ex.get("login_body_mode")).strip().lower()

        if "login_body_raw" in incoming:
            lbr = incoming.get("login_body_raw")
            auth["login_body_raw"] = str(lbr) if lbr is not None else ""
        elif partial and ex.get("login_body_raw") is not None:
            auth["login_body_raw"] = str(ex.get("login_body_raw"))

        if "login_allow_redirects" in incoming:
            lar = incoming.get("login_allow_redirects")
            if lar is not None:
                auth["login_allow_redirects"] = bool(lar)
        elif partial and "login_allow_redirects" in ex:
            auth["login_allow_redirects"] = bool(ex.get("login_allow_redirects"))

        if "session_cookie_name" in incoming:
            scn = incoming.get("session_cookie_name")
            if scn is not None and str(scn).strip():
                auth["session_cookie_name"] = str(scn).strip()
        elif partial and ex.get("session_cookie_name"):
            auth["session_cookie_name"] = str(ex.get("session_cookie_name")).strip()

        if "preflight_enabled" in incoming:
            auth["preflight_enabled"] = bool(incoming.get("preflight_enabled"))
        elif partial and ex.get("preflight_enabled") is not None:
            auth["preflight_enabled"] = bool(ex.get("preflight_enabled"))
        elif payload.preflight_enabled is not None and not partial:
            auth["preflight_enabled"] = bool(payload.preflight_enabled)

        if "preflight_method" in incoming:
            auth["preflight_method"] = str(incoming.get("preflight_method") or "GET").strip().upper()
        elif partial and ex.get("preflight_method"):
            auth["preflight_method"] = str(ex.get("preflight_method")).strip().upper()
        elif payload.preflight_method and not partial:
            auth["preflight_method"] = str(payload.preflight_method).strip().upper()

        if "preflight_path" in incoming:
            auth["preflight_path"] = str(incoming.get("preflight_path") or "").strip() or None
        elif partial and ex.get("preflight_path") is not None:
            auth["preflight_path"] = str(ex.get("preflight_path") or "").strip() or None
        elif payload.preflight_path is not None and not partial:
            auth["preflight_path"] = str(payload.preflight_path or "").strip() or None

        if "preflight_url" in incoming:
            auth["preflight_url"] = str(incoming.get("preflight_url") or "").strip() or None
        elif partial and ex.get("preflight_url") is not None:
            auth["preflight_url"] = str(ex.get("preflight_url") or "").strip() or None
        elif payload.preflight_url is not None and not partial:
            auth["preflight_url"] = str(payload.preflight_url or "").strip() or None

        if "preflight_headers" in incoming:
            ph = incoming.get("preflight_headers") or {}
            auth["preflight_headers"] = _extract_common_headers(ph if isinstance(ph, dict) else {})
        elif partial and isinstance(ex.get("preflight_headers"), dict):
            auth["preflight_headers"] = _extract_common_headers(ex.get("preflight_headers") or {})
        elif payload.preflight_headers is not None and not partial:
            auth["preflight_headers"] = _extract_common_headers(payload.preflight_headers or {})

        if "preflight_body_raw" in incoming:
            pbr = incoming.get("preflight_body_raw")
            auth["preflight_body_raw"] = str(pbr) if pbr is not None else ""
        elif partial and ex.get("preflight_body_raw") is not None:
            auth["preflight_body_raw"] = str(ex.get("preflight_body_raw"))
        elif payload.preflight_body_raw is not None and not partial:
            auth["preflight_body_raw"] = str(payload.preflight_body_raw)

        if "preflight_follow_redirects" in incoming:
            pfr = incoming.get("preflight_follow_redirects")
            if pfr is not None:
                auth["preflight_follow_redirects"] = bool(pfr)
        elif partial and "preflight_follow_redirects" in ex:
            auth["preflight_follow_redirects"] = bool(ex.get("preflight_follow_redirects"))
        elif payload.preflight_follow_redirects is not None and not partial:
            auth["preflight_follow_redirects"] = bool(payload.preflight_follow_redirects)

        if "login_query_params" in incoming:
            lqp = incoming.get("login_query_params") or {}
            auth["login_query_params"] = dict(lqp) if isinstance(lqp, dict) else {}
        elif "login_query" in incoming:
            lq = incoming.get("login_query") or {}
            auth["login_query_params"] = dict(lq) if isinstance(lq, dict) else {}
        elif partial and isinstance(ex.get("login_query_params"), dict):
            auth["login_query_params"] = dict(ex.get("login_query_params") or {})
        elif partial and isinstance(ex.get("login_query"), dict):
            auth["login_query_params"] = dict(ex.get("login_query") or {})
        elif payload.login_query_params is not None and not partial:
            auth["login_query_params"] = dict(payload.login_query_params or {})

        if "session_login_extractions" in incoming:
            sle = incoming.get("session_login_extractions")
            auth["session_login_extractions"] = list(sle) if isinstance(sle, list) else []
        elif partial and isinstance(ex.get("session_login_extractions"), list):
            auth["session_login_extractions"] = list(ex.get("session_login_extractions") or [])
        elif payload.session_login_extractions is not None and not partial:
            auth["session_login_extractions"] = list(payload.session_login_extractions or [])

        if "csrf_extract" in incoming:
            ce = incoming.get("csrf_extract")
            auth["csrf_extract"] = dict(ce) if isinstance(ce, dict) else None
        elif partial and isinstance(ex.get("csrf_extract"), dict):
            auth["csrf_extract"] = dict(ex.get("csrf_extract") or {})
        elif payload.csrf_extract is not None and not partial:
            auth["csrf_extract"] = dict(payload.csrf_extract) if isinstance(payload.csrf_extract, dict) else None

        return auth

    if effective_auth_type == "jwt_refresh_token":
        refresh_token = _merge_secret("refresh_token", incoming, existing_auth)
        token_url = incoming.get("token_url", payload.token_url)
        token_path = incoming.get("token_path", payload.token_path)
        if not (token_url or token_path):
            raise _bad_request("token_url or token_path is required when auth_type=jwt_refresh_token")
        if not refresh_token:
            raise _bad_request("refresh_token is required when auth_type=jwt_refresh_token")
        auth["refresh_token"] = refresh_token
        auth["token_url"] = str(token_url).strip() if token_url else None
        auth["token_path"] = str(token_path).strip() if token_path else None
        auth["token_http_method"] = str(incoming.get("token_http_method", payload.token_http_method) or "POST").strip().upper()
        auth["refresh_token_header_name"] = str(
            incoming.get("refresh_token_header_name", payload.refresh_token_header_name) or "Authorization"
        ).strip()
        auth["refresh_token_header_prefix"] = str(
            incoming.get("refresh_token_header_prefix", payload.refresh_token_header_prefix) or "Bearer"
        ).strip()
        auth["access_token_json_path"] = str(
            incoming.get("access_token_json_path", payload.access_token_json_path) or "$.access_token"
        ).strip()
        auth["access_token_header_name"] = str(
            incoming.get("access_token_header_name", payload.access_token_header_name) or "Authorization"
        ).strip()
        auth["access_token_header_prefix"] = str(
            incoming.get("access_token_header_prefix", payload.access_token_header_prefix) or "Bearer"
        ).strip()
        auth["token_ttl_seconds"] = int(incoming.get("token_ttl_seconds", payload.token_ttl_seconds) or 600)
        return auth

    if effective_auth_type == "vendor_jwt_exchange":
        allowed_modes = {
            "basic_user_api_key",
            "basic_user_id_api_key",
            "basic_user_password",
            "basic_client_secret",
            "bearer",
            "api_key_header",
            "api_key_query",
            "custom_headers",
            "none",
        }
        uid = incoming.get("user_id", payload.user_id)
        api_key = _merge_secret("api_key", incoming, existing_auth)
        token_url = incoming.get("token_url", payload.token_url)
        token_method = str(incoming.get("token_method", payload.token_method) or "POST").strip().upper()
        token_auth_mode = str(incoming.get("token_auth_mode", payload.token_auth_mode) or "basic_user_api_key").strip().lower()
        token_path = str(incoming.get("token_path", payload.token_path) or "$.access_token").strip()
        token_content_type = incoming.get("token_content_type", payload.token_content_type)
        token_body_mode = incoming.get("token_body_mode", payload.token_body_mode)
        token_body = incoming.get("token_body", payload.token_body)
        access_token_injection = str(incoming.get("access_token_injection", payload.access_token_injection) or "bearer_authorization").strip().lower()
        access_token_query_name = incoming.get("access_token_query_name", payload.access_token_query_name)
        token_custom_headers = incoming.get("token_custom_headers", payload.token_custom_headers)
        if not (uid and str(uid).strip()):
            raise _bad_request("user_id is required when auth_type=vendor_jwt_exchange")
        if not api_key:
            raise _bad_request("api_key is required when auth_type=vendor_jwt_exchange")
        if not (token_url and str(token_url).strip()):
            raise _bad_request("token_url is required when auth_type=vendor_jwt_exchange")
        if token_auth_mode not in allowed_modes:
            raise _bad_request(f"token_auth_mode must be one of {sorted(allowed_modes)} for vendor_jwt_exchange")
        auth["user_id"] = str(uid).strip()
        auth["api_key"] = api_key
        auth["token_url"] = str(token_url).strip()
        auth["token_method"] = token_method
        auth["token_auth_mode"] = token_auth_mode
        auth["token_path"] = token_path
        if token_content_type is not None:
            auth["token_content_type"] = str(token_content_type).strip()
        if token_body_mode is not None:
            auth["token_body_mode"] = str(token_body_mode).strip().lower()
        if token_body is not None:
            auth["token_body"] = str(token_body)
        auth["access_token_injection"] = access_token_injection
        if access_token_query_name is not None:
            auth["access_token_query_name"] = str(access_token_query_name).strip()
        if isinstance(token_custom_headers, dict):
            auth["token_custom_headers"] = token_custom_headers
        return auth

    return auth


def _build_config_json(payload: ConnectorCreate | ConnectorUpdate, existing: dict[str, Any] | None = None, *, partial: bool) -> dict[str, Any]:
    incoming = payload.model_dump(exclude_unset=True)
    base_url = _effective_host(payload) if (not partial or ("host" in incoming or "base_url" in incoming)) else str((existing or {}).get("base_url") or "")
    if not base_url:
        raise _bad_request("host/base_url is required")
    verify_ssl = payload.verify_ssl
    if partial and "verify_ssl" not in incoming and existing is not None:
        verify_ssl = bool(existing.get("verify_ssl", True))
    http_proxy = payload.http_proxy
    if partial and "http_proxy" not in incoming and existing is not None:
        http_proxy = existing.get("http_proxy")
    common_headers = payload.common_headers
    if partial and "common_headers" not in incoming and existing is not None:
        common_headers = existing.get("common_headers")

    raw_ch = common_headers if isinstance(common_headers, dict) else {}
    apply_defaults = (not partial) and len(raw_ch) == 0
    ch_final = _effective_common_headers(raw_ch, on_create_empty_defaults=apply_defaults)

    return {
        "connector_type": "generic_http",
        "base_url": base_url,
        "verify_ssl": bool(verify_ssl),
        "http_proxy": (str(http_proxy).strip() if http_proxy else None),
        "common_headers": ch_final,
    }


def _build_s3_config_json(
    payload: ConnectorCreate | ConnectorUpdate,
    existing: dict[str, Any] | None = None,
    *,
    partial: bool,
) -> dict[str, Any]:
    """Build Source.config_json for S3_OBJECT_POLLING."""

    prev = dict(existing or {})
    incoming = payload.model_dump(exclude_unset=partial)

    def gv(key: str, default: Any = None) -> Any:
        if key in incoming:
            return incoming[key]
        if partial:
            return prev.get(key, default)
        return incoming.get(key, default)

    endpoint_url = str(gv("endpoint_url") or "").strip()
    if not endpoint_url:
        raise _bad_request("endpoint_url is required for S3_OBJECT_POLLING")
    bucket = str(gv("bucket") or "").strip()
    if not bucket:
        raise _bad_request("bucket is required for S3_OBJECT_POLLING")
    region = str(gv("region") or "us-east-1").strip() or "us-east-1"
    access_key = str(gv("access_key") or "").strip()
    if not access_key:
        raise _bad_request("access_key is required for S3_OBJECT_POLLING")

    secret_key = _merge_secret("secret_key", incoming, prev if partial else None)
    if not secret_key:
        raise _bad_request("secret_key is required for S3_OBJECT_POLLING")

    prefix = str(gv("prefix") or "")
    object_key_pattern = str(gv("object_key_pattern") or "").strip()
    ps = gv("path_style_access", True)
    path_style = True if ps is None else bool(ps)
    use_ssl = bool(gv("use_ssl", False))

    cfg = {
        "connector_type": "s3_compatible",
        "endpoint_url": endpoint_url,
        "bucket": bucket,
        "region": region,
        "access_key": access_key,
        "secret_key": secret_key,
        "prefix": prefix,
        "path_style_access": path_style,
        "use_ssl": use_ssl,
    }
    if object_key_pattern:
        cfg["object_key_pattern"] = object_key_pattern
    return cfg


def _build_database_query_config_json(
    payload: ConnectorCreate | ConnectorUpdate,
    existing: dict[str, Any] | None = None,
    *,
    partial: bool,
) -> dict[str, Any]:
    """Build Source.config_json for DATABASE_QUERY."""

    prev = dict(existing or {})
    incoming = payload.model_dump(exclude_unset=partial)
    # Stored config uses "username"/"password"; API uses "db_username"/"db_password".
    prev_api = {**prev}
    if prev_api.get("username") is not None:
        prev_api.setdefault("db_username", prev_api.get("username"))
    if prev_api.get("password") is not None:
        prev_api.setdefault("db_password", prev_api.get("password"))

    def gv(key: str, default: Any = None) -> Any:
        if key in incoming:
            return incoming[key]
        if partial:
            return prev_api.get(key, default)
        return incoming.get(key, default)

    host = str(gv("host") or gv("base_url") or "").strip()
    if not host:
        raise _bad_request("host is required for DATABASE_QUERY")

    db_type = str(gv("db_type") or "").strip().upper()
    if db_type != "POSTGRESQL":
        raise _bad_request("db_type must be POSTGRESQL")

    database = str(gv("database") or "").strip()
    if not database:
        raise _bad_request("database is required for DATABASE_QUERY")

    username = str(gv("db_username") or "").strip()
    if not username:
        raise _bad_request("db_username is required for DATABASE_QUERY")

    password = _merge_secret("db_password", incoming, prev_api if partial else None)
    if not password:
        raise _bad_request("db_password is required for DATABASE_QUERY")

    raw_port = gv("port")
    if raw_port is not None:
        port = int(raw_port)
    else:
        port = 5432 if db_type == "POSTGRESQL" else 3306

    ssl_mode = str(gv("ssl_mode") or "PREFER").strip().upper()
    cto = int(gv("connection_timeout_seconds") or 15)

    return {
        "connector_type": "relational_database",
        "db_type": db_type,
        "host": host,
        "port": port,
        "database": database,
        "username": username,
        "password": password,
        "ssl_mode": ssl_mode,
        "connection_timeout_seconds": max(1, min(cto, 600)),
    }


def _build_remote_file_config_json(
    payload: ConnectorCreate | ConnectorUpdate,
    existing: dict[str, Any] | None = None,
    *,
    partial: bool,
) -> dict[str, Any]:
    """Build Source.config_json for REMOTE_FILE_POLLING (SFTP/SCP)."""

    prev = dict(existing or {})
    incoming = payload.model_dump(exclude_unset=partial)

    def gv(key: str, default: Any = None) -> Any:
        if key in incoming:
            return incoming[key]
        if partial:
            return prev.get(key, default)
        return incoming.get(key, default)

    host = str(gv("host") or "").strip()
    if not host:
        raise _bad_request("host is required for REMOTE_FILE_POLLING")

    username = str(gv("remote_username") or gv("username") or "").strip()
    if not username:
        raise _bad_request("remote_username is required for REMOTE_FILE_POLLING")

    password = _merge_secret("remote_password", incoming, prev if partial else None)
    private_key = _merge_secret("remote_private_key", incoming, prev if partial else None)
    private_key_passphrase = _merge_secret("remote_private_key_passphrase", incoming, prev if partial else None)

    if not password and not (private_key or "").strip():
        raise _bad_request("remote_password or remote_private_key is required for REMOTE_FILE_POLLING")

    raw_port = gv("port")
    port = int(raw_port) if raw_port is not None else 22
    if port < 1 or port > 65535:
        raise _bad_request("port must be between 1 and 65535 for REMOTE_FILE_POLLING")

    policy = str(gv("known_hosts_policy") or "strict").strip()
    cto = int(gv("connection_timeout_seconds") or 20)
    proto = gv("remote_file_protocol")
    if proto is None and partial:
        proto = prev.get("protocol")
    protocol = str(proto or "sftp").strip().lower()
    if protocol == "scp":
        protocol = "sftp_compatible_scp"
    if protocol not in {"sftp", "sftp_compatible_scp"}:
        raise _bad_request("remote_file_protocol must be 'sftp' or 'sftp_compatible_scp' (legacy 'scp' is normalized)")

    known_hosts_text = gv("known_hosts_text")
    kht = str(known_hosts_text).strip() if known_hosts_text is not None else ""

    cfg: dict[str, Any] = {
        "connector_type": "remote_file",
        "protocol": protocol,
        "host": host,
        "port": port,
        "username": username,
        "known_hosts_policy": policy,
        "connection_timeout_seconds": max(1, min(cto, 600)),
    }
    if password:
        cfg["password"] = password
    if private_key:
        cfg["private_key"] = private_key
    if private_key_passphrase:
        cfg["private_key_passphrase"] = private_key_passphrase
    if kht:
        cfg["known_hosts_text"] = kht
    return cfg


def _normalize_webhook_auth_mode(value: str | None) -> str:
    mode = str(value or "no_auth").strip().lower().replace("-", "_")
    aliases = {
        "none": "no_auth",
        "off": "no_auth",
        "shared_secret": "shared_secret_header",
        "secret": "shared_secret_header",
        "header": "shared_secret_header",
        "bearer": "bearer_token",
        "token": "bearer_token",
    }
    return aliases.get(mode, mode)


def _build_webhook_receiver_config_json(
    payload: ConnectorCreate | ConnectorUpdate,
    existing: dict[str, Any] | None = None,
    *,
    partial: bool,
) -> dict[str, Any]:
    """Build Source.config_json for WEBHOOK_RECEIVER."""

    prev = dict(existing or {})
    incoming = payload.model_dump(exclude_unset=partial)

    def gv(key: str, default: Any = None) -> Any:
        if key in incoming:
            return incoming[key]
        if partial:
            return prev.get(key, default)
        return incoming.get(key, default)

    receiver_key = str(gv("receiver_key") or "").strip() or secrets.token_urlsafe(24)
    max_bytes = int(gv("max_request_bytes") or prev.get("max_request_bytes") or 1_048_576)
    auth_header_name = str(
        gv("webhook_auth_header_name") or prev.get("auth_header_name") or "X-GDC-Webhook-Secret"
    ).strip()
    cfg: dict[str, Any] = {
        "connector_type": "webhook_receiver",
        "receiver_key": receiver_key,
        "max_request_bytes": max(1024, min(max_bytes, 10 * 1024 * 1024)),
        "auth_header_name": auth_header_name or "X-GDC-Webhook-Secret",
    }
    payload_preview = gv("payload_preview")
    if payload_preview is not None:
        cfg["payload_preview"] = str(payload_preview)
    return cfg


def _build_webhook_receiver_auth_json(
    payload: ConnectorCreate | ConnectorUpdate,
    existing: dict[str, Any] | None = None,
    *,
    partial: bool,
) -> dict[str, Any]:
    prev = dict(existing or {})
    incoming = payload.model_dump(exclude_unset=partial)
    raw_mode = incoming.get("webhook_auth_mode")
    if raw_mode is None and partial:
        raw_mode = prev.get("auth_mode")
    mode = _normalize_webhook_auth_mode(str(raw_mode or "no_auth"))
    if mode not in {"no_auth", "shared_secret_header", "bearer_token"}:
        raise _bad_request("webhook_auth_mode must be one of: no_auth, shared_secret_header, bearer_token")
    auth: dict[str, Any] = {"auth_mode": mode}
    if mode == "shared_secret_header":
        secret_value = _merge_secret("webhook_shared_secret", incoming, prev if partial else None)
        if not secret_value:
            raise _bad_request("webhook_shared_secret is required when webhook_auth_mode=shared_secret_header")
        auth["shared_secret"] = secret_value
        header_name = incoming.get("webhook_auth_header_name") or prev.get("header_name") or "X-GDC-Webhook-Secret"
        auth["header_name"] = str(header_name).strip() or "X-GDC-Webhook-Secret"
    elif mode == "bearer_token":
        token_value = _merge_secret("webhook_bearer_token", incoming, prev if partial else None)
        if not token_value:
            raise _bad_request("webhook_bearer_token is required when webhook_auth_mode=bearer_token")
        auth["bearer_token"] = token_value
    return auth


def _serialize(connector: Connector, source: Source | None, stream_count: int) -> ConnectorRead:
    config = source.config_json if source else {}
    auth = source.auth_json if source else {"auth_type": "no_auth"}
    masked_auth = _mask_auth_for_response(auth if isinstance(auth, dict) else {"auth_type": "no_auth"})
    st = str(source.source_type if source else "HTTP_API_POLLING").strip().upper()
    ctype = str(
        (config or {}).get("connector_type")
        or (
            "s3_compatible"
            if st == "S3_OBJECT_POLLING"
            else (
                "relational_database"
                if st == "DATABASE_QUERY"
                else (
                    "webhook_receiver"
                    if st == "WEBHOOK_RECEIVER"
                    else ("remote_file" if st == "REMOTE_FILE_POLLING" else "generic_http")
                )
            )
        )
    )

    if st == "S3_OBJECT_POLLING":
        host_disp = (config or {}).get("endpoint_url")
        base_disp = (config or {}).get("endpoint_url")
    elif st == "DATABASE_QUERY":
        host_disp = (config or {}).get("host")
        base_disp = (config or {}).get("host")
    elif st == "REMOTE_FILE_POLLING":
        host_disp = (config or {}).get("host")
        base_disp = (config or {}).get("host")
    elif st == "WEBHOOK_RECEIVER":
        host_disp = None
        base_disp = None
    else:
        host_disp = (config or {}).get("base_url")
        base_disp = (config or {}).get("base_url")

    read_kw: dict[str, Any] = dict(
        id=connector.id,
        name=connector.name,
        product_group=connector.product_group,
        description=connector.description,
        status=connector.status,
        connector_type=ctype,  # type: ignore[arg-type]
        source_type=st,  # type: ignore[arg-type]
        source_id=source.id if source else None,
        stream_count=stream_count,
        host=host_disp,
        base_url=base_disp,
        verify_ssl=bool((config or {}).get("verify_ssl", True))
        if st not in {"S3_OBJECT_POLLING", "DATABASE_QUERY", "REMOTE_FILE_POLLING", "WEBHOOK_RECEIVER"}
        else True,
        http_proxy=(config or {}).get("http_proxy"),
        common_headers=dict((config or {}).get("common_headers") or {}),
        auth_type=_normalize_auth_type(str((auth or {}).get("auth_type") or "no_auth")),
        auth=masked_auth if isinstance(masked_auth, dict) else {"auth_type": "no_auth"},
        created_at=connector.created_at,
        updated_at=connector.updated_at,
        source_updated_at=source.updated_at if source is not None else None,
        **_operational_read_fields(config if isinstance(config, dict) else {}),
    )
    if st == "S3_OBJECT_POLLING" and isinstance(config, dict):
        sk = config.get("secret_key")
        read_kw.update(
            endpoint_url=str(config.get("endpoint_url") or "").strip() or None,
            bucket=str(config.get("bucket") or "").strip() or None,
            region=str(config.get("region") or "us-east-1").strip() or None,
            prefix=str(config.get("prefix") or "") or None,
            object_key_pattern=str(config.get("object_key_pattern") or "") or None,
            path_style_access=bool(config.get("path_style_access", True)),
            use_ssl=bool(config.get("use_ssl", False)),
            access_key=str(config.get("access_key") or "").strip() or None,
            secret_key_configured=bool(sk not in (None, "")),
        )
        read_kw.update(
            db_type=None,
            database=None,
            port=None,
            db_username=None,
            db_password_configured=None,
            ssl_mode=None,
            connection_timeout_seconds=None,
            remote_username=None,
            remote_password_configured=None,
            known_hosts_policy=None,
            remote_file_protocol=None,
            remote_private_key_configured=None,
            remote_private_key_passphrase_configured=None,
            known_hosts_configured=None,
        )
    elif st == "DATABASE_QUERY" and isinstance(config, dict):
        pw = config.get("password")
        read_kw.update(
            endpoint_url=None,
            bucket=None,
            region=None,
            prefix=None,
            object_key_pattern=None,
            path_style_access=None,
            use_ssl=None,
            access_key=None,
            secret_key_configured=None,
            db_type=str(config.get("db_type") or "") or None,
            database=str(config.get("database") or "") or None,
            port=int(config.get("port") or 0) or None,
            db_username=str(config.get("username") or "") or None,
            db_password_configured=bool(pw not in (None, "")),
            ssl_mode=str(config.get("ssl_mode") or "") or None,
            connection_timeout_seconds=int(config.get("connection_timeout_seconds") or 0) or None,
            remote_username=None,
            remote_password_configured=None,
            known_hosts_policy=None,
            remote_file_protocol=None,
            remote_private_key_configured=None,
            remote_private_key_passphrase_configured=None,
            known_hosts_configured=None,
        )
    elif st == "REMOTE_FILE_POLLING" and isinstance(config, dict):
        rp = config.get("password")
        pk = config.get("private_key")
        pph = config.get("private_key_passphrase")
        kht = str(config.get("known_hosts_text") or "").strip()
        proto_disp = str(config.get("protocol") or "sftp") or None
        if proto_disp == "scp":
            proto_disp = "sftp_compatible_scp"
        read_kw.update(
            endpoint_url=None,
            bucket=None,
            region=None,
            prefix=None,
            object_key_pattern=None,
            path_style_access=None,
            use_ssl=None,
            access_key=None,
            secret_key_configured=None,
            db_type=None,
            database=None,
            port=int(config.get("port") or 0) or None,
            db_username=None,
            db_password_configured=None,
            ssl_mode=None,
            connection_timeout_seconds=int(config.get("connection_timeout_seconds") or 0) or None,
            remote_username=str(config.get("username") or "") or None,
            remote_password_configured=bool(rp not in (None, "")),
            known_hosts_policy=str(config.get("known_hosts_policy") or "") or None,
            remote_file_protocol=proto_disp,
            remote_private_key_configured=bool(pk not in (None, "")),
            remote_private_key_passphrase_configured=bool(pph not in (None, "")),
            known_hosts_configured=bool(kht),
        )
    elif st == "WEBHOOK_RECEIVER" and isinstance(config, dict):
        auth_dict = auth if isinstance(auth, dict) else {}
        receiver_key = str(config.get("receiver_key") or "").strip()
        read_kw.update(
            endpoint_url=None,
            bucket=None,
            region=None,
            prefix=None,
            object_key_pattern=None,
            path_style_access=None,
            use_ssl=None,
            access_key=None,
            secret_key_configured=None,
            db_type=None,
            database=None,
            port=None,
            db_username=None,
            db_password_configured=None,
            ssl_mode=None,
            connection_timeout_seconds=None,
            remote_username=None,
            remote_password_configured=None,
            known_hosts_policy=None,
            remote_file_protocol=None,
            remote_private_key_configured=None,
            remote_private_key_passphrase_configured=None,
            known_hosts_configured=None,
            receiver_key=receiver_key or None,
            receiver_path=f"/api/v1/ingest/webhook/{receiver_key}" if receiver_key else None,
            webhook_auth_mode=str(auth_dict.get("auth_mode") or "no_auth"),
            webhook_auth_header_name=str(
                auth_dict.get("header_name") or config.get("auth_header_name") or "X-GDC-Webhook-Secret"
            ),
            webhook_shared_secret_configured=bool(auth_dict.get("shared_secret") not in (None, "")),
            webhook_bearer_token_configured=bool(auth_dict.get("bearer_token") not in (None, "")),
            max_request_bytes=int(config.get("max_request_bytes") or 0) or None,
            payload_preview=str(config.get("payload_preview") or ""),
        )
    else:
        read_kw.update(
            endpoint_url=None,
            bucket=None,
            region=None,
            prefix=None,
            object_key_pattern=None,
            path_style_access=None,
            use_ssl=None,
            access_key=None,
            secret_key_configured=None,
            db_type=None,
            database=None,
            port=None,
            db_username=None,
            db_password_configured=None,
            ssl_mode=None,
            connection_timeout_seconds=None,
            remote_username=None,
            remote_password_configured=None,
            known_hosts_policy=None,
            remote_file_protocol=None,
            remote_private_key_configured=None,
            remote_private_key_passphrase_configured=None,
            known_hosts_configured=None,
        )

    return ConnectorRead.model_validate(read_kw)


def _load_source(db: Session, connector_id: int, *, for_update: bool = False) -> Source | None:
    q_http = db.query(Source).filter(Source.connector_id == connector_id, Source.source_type == "HTTP_API_POLLING")
    q_any = db.query(Source).filter(Source.connector_id == connector_id)
    if for_update:
        q_http = q_http.with_for_update()
        q_any = q_any.with_for_update()
    http = q_http.order_by(Source.id.asc()).first()
    if http is not None:
        return http
    return q_any.order_by(Source.id.asc()).first()


def _bulk_load_sources(db: Session, connector_ids: list[int]) -> dict[int, Source]:
    if not connector_ids:
        return {}
    source_rows = (
        db.query(Source)
        .filter(Source.connector_id.in_(connector_ids))
        .order_by(Source.connector_id.asc(), Source.id.asc())
        .all()
    )
    by_connector: dict[int, Source] = {}
    for source in source_rows:
        cid = int(source.connector_id)
        existing = by_connector.get(cid)
        if existing is None:
            by_connector[cid] = source
        elif str(source.source_type) == "HTTP_API_POLLING":
            by_connector[cid] = source
    return by_connector


def _list_connectors_rows(db: Session) -> list[ConnectorRead]:
    rows = db.query(Connector).order_by(Connector.id.asc()).all()
    if not rows:
        return []

    connector_ids = [int(row.id) for row in rows]
    stream_count_rows = (
        db.query(Stream.connector_id, func.count(Stream.id))
        .filter(Stream.connector_id.in_(connector_ids))
        .group_by(Stream.connector_id)
        .all()
    )
    stream_counts = {int(connector_id): int(count) for connector_id, count in stream_count_rows}
    sources_by_connector = _bulk_load_sources(db, connector_ids)

    out: list[ConnectorRead] = []
    for row in rows:
        source = sources_by_connector.get(int(row.id))
        stream_count = stream_counts.get(int(row.id), 0)
        out.append(_serialize(row, source, stream_count))
    return out


@router.get("/", response_model=list[ConnectorRead])
def list_connectors() -> list[ConnectorRead]:
    return load_connectors_catalog_list(_list_connectors_rows)


@router.get("/operations-summary", response_model=ConnectorOperationsSummaryResponse)
def list_connectors_operations_summary(
    window: str = "1h",
    db: Session = Depends(get_db_read_bounded),
) -> ConnectorOperationsSummaryResponse:
    """Per-connector runtime aggregation for the Connectors operations dashboard."""

    return get_connectors_operations_summary_cached(
        db,
        window=window,
        loader=lambda session: get_connectors_operations_summary(session, window=window),
    )


@router.post("/{connector_id}/auth-check", response_model=ConnectorAuthCheckPersistedResponse)
async def post_connector_auth_check(
    connector_id: int,
) -> ConnectorAuthCheckPersistedResponse:
    """Run an immediate auth probe and persist last-check metadata."""

    db = SessionLocal()
    try:
        row = db.query(Connector).filter(Connector.id == connector_id).first()
        if row is None:
            raise _not_found(connector_id)
    finally:
        db.close()

    try:
        result = await asyncio.to_thread(run_connector_auth_check_and_persist, connector_id)
    except ValueError as exc:
        raise _bad_request(str(exc)) from exc

    invalidate_connectors_read_cache_after_auth_check(
        connector_id,
        last_auth_check_at=result.last_auth_check_at,
        last_auth_check_status=result.last_auth_check_status,
        last_auth_error=result.last_auth_error,
    )
    return result


@router.post("/", response_model=ConnectorRead, status_code=status.HTTP_201_CREATED)
async def create_connector(payload: ConnectorCreate, request: Request, db: Session = Depends(get_db)) -> ConnectorRead:
    product_group = (payload.product_group or "").strip() if payload.product_group is not None else None
    if not product_group:
        product_group = infer_product_group_from_connector_name(payload.name.strip())
    connector = Connector(
        name=payload.name.strip(),
        product_group=product_group or None,
        description=payload.description,
        status=payload.status or "STOPPED",
    )
    db.add(connector)
    db.flush()

    st = _normalize_source_type(payload.source_type)
    if st == "S3_OBJECT_POLLING":
        if _normalize_auth_type(payload.auth_type) != "no_auth":
            raise _bad_request("S3_OBJECT_POLLING requires auth_type=no_auth")
        source = Source(
            connector_id=connector.id,
            source_type=st,
            config_json=_build_s3_config_json(payload, partial=False),
            auth_json={"auth_type": "no_auth"},
            enabled=True,
        )
    elif st == "DATABASE_QUERY":
        if _normalize_auth_type(payload.auth_type) != "no_auth":
            raise _bad_request("DATABASE_QUERY requires auth_type=no_auth")
        source = Source(
            connector_id=connector.id,
            source_type=st,
            config_json=_build_database_query_config_json(payload, partial=False),
            auth_json={"auth_type": "no_auth"},
            enabled=True,
        )
    elif st == "REMOTE_FILE_POLLING":
        if _normalize_auth_type(payload.auth_type) != "no_auth":
            raise _bad_request("REMOTE_FILE_POLLING requires auth_type=no_auth")
        source = Source(
            connector_id=connector.id,
            source_type=st,
            config_json=_build_remote_file_config_json(payload, partial=False),
            auth_json={"auth_type": "no_auth"},
            enabled=True,
        )
    elif st == "WEBHOOK_RECEIVER":
        if _normalize_auth_type(payload.auth_type) != "no_auth":
            raise _bad_request("WEBHOOK_RECEIVER requires auth_type=no_auth")
        source = Source(
            connector_id=connector.id,
            source_type=st,
            config_json=_build_webhook_receiver_config_json(payload, partial=False),
            auth_json=_build_webhook_receiver_auth_json(payload, partial=False),
            enabled=True,
        )
    else:
        source = Source(
            connector_id=connector.id,
            source_type="HTTP_API_POLLING",
            config_json=_build_config_json(payload, partial=False),
            auth_json=_build_auth_json(payload, partial=False),
            enabled=True,
        )
    source.config_json = _apply_operational_from_payload(source.config_json, payload, partial=False)
    db.add(source)
    db.flush()
    journal.record_audit_event(
        db,
        action="CONNECTOR_CREATED",
        entity_type="CONNECTOR",
        entity_id=int(connector.id),
        entity_name=str(connector.name),
        details={"source_type": str(source.source_type)},
        request=request,
    )
    db.commit()
    db.refresh(connector)
    db.refresh(source)
    clear_connectors_read_cache()
    return _serialize(connector, source, 0)


@router.get("/{connector_id}", response_model=ConnectorRead)
async def get_connector(connector_id: int, db: Session = Depends(get_db)) -> ConnectorRead:
    row = db.query(Connector).filter(Connector.id == connector_id).first()
    if row is None:
        raise _not_found(connector_id)
    source = _load_source(db, row.id)
    stream_count = db.query(func.count(Stream.id)).filter(Stream.connector_id == row.id).scalar() or 0
    return _serialize(row, source, int(stream_count))


@router.put("/{connector_id}", response_model=ConnectorRead)
async def update_connector(
    connector_id: int,
    payload: ConnectorUpdate,
    request: Request,
    db: Session = Depends(get_db),
) -> ConnectorRead:
    # Lock connector + primary source so compound mutations cannot silently overwrite.
    row = db.query(Connector).filter(Connector.id == connector_id).with_for_update().first()
    if row is None:
        raise _not_found(connector_id)
    source = _load_source(db, row.id, for_update=True)

    update = payload.model_dump(exclude_unset=True)
    expected_updated_at = pop_expected_updated_at(update)
    require_fresh_updated_at(
        entity_label="Connector",
        error_code="CONNECTOR_STALE_WRITE",
        current_updated_at=getattr(row, "updated_at", None),
        expected_updated_at=expected_updated_at,
    )
    expected_source_updated_at = update.pop("expected_source_updated_at", None)
    if source is not None:
        if expected_source_updated_at is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={
                    "error_code": "EXPECTED_SOURCE_UPDATED_AT_REQUIRED",
                    "message": "expected_source_updated_at is required when the connector owns a Source row",
                },
            )
        source_updated_at = getattr(source, "updated_at", None)
        if source_updated_at is None or as_utc(source_updated_at) != as_utc(expected_source_updated_at):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "error_code": "CONNECTOR_SOURCE_STALE_WRITE",
                    "message": (
                        "Connector source configuration changed since you started editing. "
                        "Refresh the latest connector before saving again; unsaved local edits are not applied."
                    ),
                    "expected_source_updated_at": expected_source_updated_at.isoformat(),
                    "current_source_updated_at": (
                        source_updated_at.isoformat() if source_updated_at is not None else None
                    ),
                },
            )

    if source is None:
        st_new = _normalize_source_type(payload.source_type)
        st_init = (
            st_new
            if st_new in {"S3_OBJECT_POLLING", "DATABASE_QUERY", "REMOTE_FILE_POLLING", "WEBHOOK_RECEIVER"}
            else "HTTP_API_POLLING"
        )
        source = Source(
            connector_id=row.id,
            source_type=st_init,
            config_json={},
            auth_json={"auth_type": "no_auth"},
            enabled=True,
        )
        db.add(source)
        db.flush()

    st_source = str(source.source_type or "HTTP_API_POLLING").upper()
    if payload.source_type is not None and _normalize_source_type(str(payload.source_type)) != st_source:
        raise _bad_request("Changing source_type is not supported on connector update")

    if "name" in update and payload.name is not None:
        row.name = payload.name.strip()
    if "product_group" in update:
        pg = (payload.product_group or "").strip() if payload.product_group is not None else None
        row.product_group = pg or None
    if "description" in update:
        row.description = payload.description
    if "status" in update and payload.status is not None:
        row.status = payload.status

    if st_source == "S3_OBJECT_POLLING":
        if payload.auth_type is not None and _normalize_auth_type(payload.auth_type) != "no_auth":
            raise _bad_request("S3_OBJECT_POLLING requires auth_type=no_auth")
        source.config_json = _build_s3_config_json(payload, existing=source.config_json, partial=True)
        source.auth_json = {"auth_type": "no_auth"}
    elif st_source == "DATABASE_QUERY":
        if payload.auth_type is not None and _normalize_auth_type(payload.auth_type) != "no_auth":
            raise _bad_request("DATABASE_QUERY requires auth_type=no_auth")
        source.config_json = _build_database_query_config_json(payload, existing=source.config_json, partial=True)
        source.auth_json = {"auth_type": "no_auth"}
    elif st_source == "REMOTE_FILE_POLLING":
        if payload.auth_type is not None and _normalize_auth_type(payload.auth_type) != "no_auth":
            raise _bad_request("REMOTE_FILE_POLLING requires auth_type=no_auth")
        source.config_json = _build_remote_file_config_json(payload, existing=source.config_json, partial=True)
        source.auth_json = {"auth_type": "no_auth"}
    elif st_source == "WEBHOOK_RECEIVER":
        if payload.auth_type is not None and _normalize_auth_type(payload.auth_type) != "no_auth":
            raise _bad_request("WEBHOOK_RECEIVER requires auth_type=no_auth")
        source.config_json = _build_webhook_receiver_config_json(payload, existing=source.config_json, partial=True)
        source.auth_json = _build_webhook_receiver_auth_json(payload, existing=source.auth_json, partial=True)
    else:
        source.config_json = _build_config_json(payload, existing=source.config_json, partial=True)
        source.auth_json = _build_auth_json(payload, existing_auth=source.auth_json, partial=True)

    source.config_json = _apply_operational_from_payload(source.config_json, payload, partial=True)
    now = utcnow()
    row.updated_at = now
    source.updated_at = now

    journal.record_audit_event(
        db,
        action="CONNECTOR_UPDATED",
        entity_type="CONNECTOR",
        entity_id=int(row.id),
        entity_name=str(row.name),
        details={"updated_fields": sorted(k for k in update.keys() if not k.startswith("expected_"))},
        request=request,
    )
    db.commit()
    db.refresh(row)
    db.refresh(source)
    clear_connectors_read_cache()
    stream_count = db.query(func.count(Stream.id)).filter(Stream.connector_id == row.id).scalar() or 0
    return _serialize(row, source, int(stream_count))


@router.delete("/{connector_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_connector(connector_id: int, request: Request, db: Session = Depends(get_db)) -> None:
    row = db.query(Connector).filter(Connector.id == connector_id).first()
    if row is None:
        raise _not_found(connector_id)
    stream_exists = db.query(Stream.id).filter(Stream.connector_id == row.id).first() is not None
    if stream_exists:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error_code": "CONNECTOR_HAS_STREAMS",
                "message": "connector has streams; delete or reassign streams first",
            },
        )
    name = str(row.name)
    db.query(Source).filter(Source.connector_id == row.id).delete(synchronize_session=False)
    db.delete(row)
    journal.record_audit_event(
        db,
        action="CONNECTOR_DELETED",
        entity_type="CONNECTOR",
        entity_id=int(connector_id),
        entity_name=name,
        request=request,
    )
    db.commit()
    clear_connectors_read_cache()
