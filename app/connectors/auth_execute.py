"""Shared authenticated HTTP execution for Stream API Test and related previews."""

from __future__ import annotations

import base64
import json
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterator
from urllib.parse import urlencode, urlparse

import httpx

from app.pollers.http_query_params import httpx_body_kwargs
from app.connectors.schemas import (
    ConnectorAuthLabEffectiveRequest,
    ConnectorAuthLabResponse,
    ConnectorAuthLabStep,
)
from app.security.secrets import mask_http_headers, mask_secret_query_params_in_text, mask_secrets
from app.connectors.session_login_http import (
    SessionLoginHttpDebug,
    cookie_jar_names,
    resolve_session_login_url,
    session_login_single_request,
)


class _StarletteAuthLabClient:
    """In-process HTTP when API host is FastAPI TestClient (`testserver`)."""

    def __init__(self, asgi_app: Any, origin: str) -> None:
        from starlette.testclient import TestClient

        self._origin = origin.rstrip("/")
        self._tc = TestClient(asgi_app, base_url=self._origin)

    def _path(self, url: str) -> str:
        u = (url or "").strip()
        if u.startswith(self._origin + "/"):
            return u[len(self._origin) :]
        if u == self._origin:
            return "/"
        return u if u.startswith("/") else f"/{u}"

    def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        path = self._path(url)
        return self._tc.request(method, path, **kwargs)

    def post(self, url: str, **kwargs: Any) -> httpx.Response:
        return self.request("POST", url, **kwargs)

    @property
    def cookies(self) -> Any:
        return self._tc.cookies

    def close(self) -> None:
        return None


def _cookie_present(jar: Any, name: str) -> bool:
    getter = getattr(jar, "get", None)
    if callable(getter):
        try:
            return getter(name) is not None
        except Exception:
            return False
    try:
        return name in jar
    except Exception:
        return False


def normalize_auth_type(auth_type: str | None) -> str:
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
    }
    return alias.get(value, value)


def merge_str_headers(*parts: dict[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in parts:
        if not part:
            continue
        for k, v in part.items():
            out[str(k)] = str(v)
    return out


@contextmanager
def lab_client(
    api_origin: str,
    *,
    verify_ssl: bool,
    proxy: str | None = None,
    timeout: float = 45.0,
    allow_in_process_testclient: bool = True,
) -> Iterator[httpx.Client | _StarletteAuthLabClient]:
    """HTTP client for auth flows; optional in-process ASGI for FastAPI TestClient (`testserver`)."""

    origin = api_origin.rstrip("/")
    host = urlparse(origin).hostname or ""
    if allow_in_process_testclient and host == "testserver":
        from app.main import app

        client = _StarletteAuthLabClient(app, origin)
        yield client
        client.close()
        return
    with httpx.Client(verify=verify_ssl, proxy=proxy, timeout=timeout, trust_env=True) as client:
        yield client


def resource_json_kw(method: str, body: Any, headers: dict[str, Any] | None = None) -> dict[str, Any]:
    m = method.upper()
    if m not in {"GET", "POST", "PUT", "PATCH", "DELETE"} or body is None:
        return {}
    return httpx_body_kwargs(body, headers)


def resolve_jwt_token_url(auth_cfg: dict[str, Any], path_origin: str) -> str:
    tok_url = str(auth_cfg.get("token_url") or "").strip()
    if tok_url:
        return tok_url
    tok_path = str(auth_cfg.get("token_path") or "").strip()
    if not tok_path:
        return ""
    path = tok_path if tok_path.startswith("/") else f"/{tok_path}"
    return f"{path_origin.rstrip('/')}{path}"


def extract_json_path_value(payload: Any, json_path: str) -> Any:
    path = (json_path or "").strip()
    if not path.startswith("$."):
        return None
    current = payload
    for part in path[2:].split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current


def response_sample(resp: httpx.Response) -> Any:
    try:
        data = resp.json()
    except Exception:
        return {"_truncated_text": (resp.text or "")[:4000]}
    return mask_secrets(data)


def effective_request(method: str, url: str, headers: dict[str, str]) -> ConnectorAuthLabEffectiveRequest:
    return ConnectorAuthLabEffectiveRequest(
        method=method.upper(),
        # Display-only: a credential carried in the query string (api_key / access_token ...) is masked.
        url=mask_secret_query_params_in_text(url),
        headers=mask_http_headers(headers),
    )


def target_suggests_login_redirect(resp: httpx.Response) -> bool:
    if resp.status_code not in (301, 302, 303, 307, 308):
        return False
    loc = (resp.headers.get("location") or "").lower()
    if not loc:
        return False
    needles = ("login", "signin", "sign-in", "auth", "/session", "logout")
    return any(n in loc for n in needles)


def jwt_access_token_from_response(tjson: dict[str, Any], auth_cfg: dict[str, Any]) -> Any:
    path = str(auth_cfg.get("access_token_json_path") or "$.access_token").strip()
    if path.startswith("$."):
        return extract_json_path_value(tjson, path)
    if path and path != "$.access_token":
        return tjson.get(path.lstrip("$").lstrip("."))
    return tjson.get("access_token")


def vendor_access_token_from_response(tjson: Any, auth_cfg: dict[str, Any]) -> Any:
    """Extract access token using vendor token_path (default $.access_token)."""

    path = str(auth_cfg.get("token_path") or "$.access_token").strip()
    if not isinstance(tjson, dict):
        return None
    if path.startswith("$."):
        return extract_json_path_value(tjson, path)
    if path:
        return tjson.get(path.lstrip("$").lstrip("."))
    return tjson.get("access_token")


VENDOR_TOKEN_AUTH_MODES = frozenset(
    {
        "basic_user_api_key",
        "basic_user_password",
        "basic_client_secret",
        "bearer",
        "api_key_header",
        "api_key_query",
        "custom_headers",
        "none",
    }
)


def normalize_vendor_token_auth_mode(raw: str | None) -> str:
    m = (raw or "basic_user_api_key").strip().lower()
    if m == "basic_user_id_api_key":
        return "basic_user_api_key"
    return m


def resolve_vendor_token_exchange_url(token_url: str, path_origin: str) -> str:
    tu = (token_url or "").strip()
    if not tu:
        return ""
    if tu.startswith("http://") or tu.startswith("https://"):
        return tu
    base = path_origin.rstrip("/")
    path = tu if tu.startswith("/") else f"/{tu}"
    return f"{base}{path}"


def _parse_token_custom_headers(val: Any) -> dict[str, str]:
    if isinstance(val, dict):
        return {str(k): str(v) for k, v in val.items()}
    if isinstance(val, str) and val.strip():
        try:
            obj = json.loads(val)
            if isinstance(obj, dict):
                return {str(k): str(v) for k, v in obj.items()}
        except Exception:
            return {}
    return {}


def _vendor_jwt_validate_credentials(auth_cfg: dict[str, Any], mode: str) -> str | None:
    if mode == "basic_user_api_key":
        if not str(auth_cfg.get("user_id") or "").strip() or not str(auth_cfg.get("api_key") or ""):
            return "user_id and api_key are required for basic_user_api_key"
    elif mode == "basic_user_password":
        uid = str(auth_cfg.get("user_id") or "").strip()
        pw = str(auth_cfg.get("basic_password") or auth_cfg.get("password") or "").strip()
        if not uid or not pw:
            return "user_id and basic_password are required for basic_user_password"
    elif mode == "basic_client_secret":
        cid = str(auth_cfg.get("oauth2_client_id") or auth_cfg.get("client_id") or "").strip()
        sec = str(auth_cfg.get("oauth2_client_secret") or auth_cfg.get("client_secret") or "").strip()
        if not cid or not sec:
            return "oauth2_client_id and oauth2_client_secret are required for basic_client_secret"
    elif mode == "bearer":
        tok = str(auth_cfg.get("bearer_token") or auth_cfg.get("refresh_token") or "").strip()
        if not tok:
            return "bearer_token or refresh_token is required for bearer token exchange"
    elif mode == "api_key_header":
        if not str(auth_cfg.get("api_key_name") or "").strip() or str(auth_cfg.get("api_key_value") or "") == "":
            return "api_key_name and api_key_value are required for api_key_header"
    elif mode == "api_key_query":
        if not str(auth_cfg.get("api_key_name") or "").strip() or str(auth_cfg.get("api_key_value") or "") == "":
            return "api_key_name and api_key_value are required for api_key_query"
    elif mode == "custom_headers":
        ch = _parse_token_custom_headers(auth_cfg.get("token_custom_headers"))
        if not ch:
            return "token_custom_headers must be a non-empty JSON object for custom_headers"
    return None


def build_vendor_token_exchange_auth_headers(auth_cfg: dict[str, Any]) -> tuple[dict[str, str], dict[str, Any]]:
    """Build Authorization / vendor headers for the token exchange request only (not common connector headers)."""

    mode = normalize_vendor_token_auth_mode(auth_cfg.get("token_auth_mode"))
    headers: dict[str, str] = {}
    token_query: dict[str, Any] = {}

    if mode == "basic_user_api_key":
        uid = str(auth_cfg.get("user_id") or "").strip()
        key = str(auth_cfg.get("api_key") or "")
        if uid and key:
            raw = base64.b64encode(f"{uid}:{key}".encode("utf-8")).decode("ascii")
            headers["Authorization"] = f"Basic {raw}"
    elif mode == "basic_user_password":
        uid = str(auth_cfg.get("user_id") or "").strip()
        pw = str(auth_cfg.get("basic_password") or auth_cfg.get("password") or "").strip()
        if uid and pw:
            raw = base64.b64encode(f"{uid}:{pw}".encode("utf-8")).decode("ascii")
            headers["Authorization"] = f"Basic {raw}"
    elif mode == "basic_client_secret":
        cid = str(auth_cfg.get("oauth2_client_id") or auth_cfg.get("client_id") or "").strip()
        sec = str(auth_cfg.get("oauth2_client_secret") or auth_cfg.get("client_secret") or "").strip()
        if cid and sec:
            raw = base64.b64encode(f"{cid}:{sec}".encode("utf-8")).decode("ascii")
            headers["Authorization"] = f"Basic {raw}"
    elif mode == "bearer":
        tok = str(auth_cfg.get("bearer_token") or auth_cfg.get("refresh_token") or "").strip()
        if tok:
            headers["Authorization"] = f"Bearer {tok}"
    elif mode == "api_key_header":
        name = str(auth_cfg.get("api_key_name") or "").strip()
        val = auth_cfg.get("api_key_value")
        if name and val is not None:
            headers[name] = str(val)
    elif mode == "api_key_query":
        name = str(auth_cfg.get("api_key_name") or "").strip()
        val = auth_cfg.get("api_key_value")
        if name:
            token_query[name] = val
    elif mode == "custom_headers":
        headers.update(_parse_token_custom_headers(auth_cfg.get("token_custom_headers")))
    elif mode == "none":
        pass

    if mode != "custom_headers":
        tc_raw = auth_cfg.get("token_content_type")
        if tc_raw is not None and str(tc_raw).strip() != "":
            tc_val = str(tc_raw).strip()
            if tc_val.lower() != "none":
                headers["Content-Type"] = tc_val

    lower_keys = {k.lower() for k in headers}
    if "accept" not in lower_keys:
        headers["Accept"] = "application/json"

    return headers, token_query


def vendor_token_request_body_mode_label(auth_cfg: dict[str, Any], token_method_u: str) -> str:
    if token_method_u == "GET":
        return "none"
    bm = str(auth_cfg.get("token_body_mode") or "empty").strip().lower()
    return bm if bm else "empty"


def build_vendor_token_exchange_body_kwargs(auth_cfg: dict[str, Any], token_method_u: str) -> dict[str, Any]:
    if token_method_u == "GET":
        return {}
    bm = str(auth_cfg.get("token_body_mode") or "empty").strip().lower()
    tb = str(auth_cfg.get("token_body") or "").strip()
    if bm in {"", "empty"}:
        # Match Python `requests.post(..., data=None)` / empty body — explicit zero-length content.
        return {"content": b""}
    if bm == "json":
        if not tb:
            return {"json": {}}
        return {"json": json.loads(tb)}
    if bm == "form":
        if tb.startswith("{"):
            data_obj = json.loads(tb)
            if isinstance(data_obj, dict):
                flat = {str(k): str(v) for k, v in data_obj.items()}
                return {"data": flat}
            raise ValueError("token_body JSON for form mode must be an object")
        return {"data": tb}
    if bm == "raw":
        return {"content": tb.encode("utf-8")}
    return {}


def merge_vendor_access_into_target(
    auth_cfg: dict[str, Any],
    access_token: str,
    target_headers: dict[str, Any],
    target_params: dict[str, Any],
) -> tuple[dict[str, str], dict[str, Any]]:
    """Apply access_token_injection for the resource (final API) request."""

    inj = str(auth_cfg.get("access_token_injection") or "bearer_authorization").strip().lower()
    headers = merge_str_headers(target_headers)
    params = dict(target_params or {})

    if inj in {"", "bearer", "bearer_authorization"}:
        headers["Authorization"] = f"Bearer {access_token}"
        return headers, params
    if inj == "custom_header":
        name = str(auth_cfg.get("access_token_header_name") or "Authorization").strip()
        if name.lower() == "authorization":
            pref = str(auth_cfg.get("access_token_header_prefix") or "Bearer").strip()
            headers[name] = f"{pref} {access_token}".strip() if pref else access_token
        else:
            headers[name] = access_token
        return headers, params
    if inj in {"query_param", "query"}:
        qn = str(auth_cfg.get("access_token_query_name") or "access_token").strip() or "access_token"
        params = {**params}
        params.setdefault(qn, access_token)
        return headers, params

    headers["Authorization"] = f"Bearer {access_token}"
    return headers, params


def vendor_jwt_run_token_exchange(
    client: httpx.Client | _StarletteAuthLabClient,
    ctx: _ExecCtx,
    auth_cfg: dict[str, Any],
    path_origin: str,
    *,
    token_diag_out: dict[str, Any] | None = None,
) -> str | ConnectorAuthLabResponse:
    """Perform vendor JWT token exchange; returns access_token string or a failure ConnectorAuthLabResponse."""

    def _token_diag(
        *,
        tok_headers: dict[str, str],
        token_method_u: str,
        resolved_url: str,
        tr_resp: httpx.Response | None,
        tdict: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body_mode = vendor_token_request_body_mode_label(auth_cfg, token_method_u)
        req_url = str(tr_resp.request.url) if tr_resp is not None else resolved_url
        out: dict[str, Any] = {
            "phase": "token_exchange",
            "token_request_method": token_method_u,
            "token_request_url": req_url,
            "token_request_headers_masked": mask_http_headers(tok_headers),
            "token_request_body_mode": body_mode,
        }
        if tr_resp is not None:
            out["token_response_status_code"] = int(tr_resp.status_code)
            out["token_response_headers_masked"] = mask_http_headers({str(k): str(v) for k, v in tr_resp.headers.items()})
        if tdict is not None:
            out["token_response_body_masked"] = json.dumps(mask_secrets(tdict), ensure_ascii=False)[:8000]
        elif tr_resp is not None:
            try:
                out["token_response_body_masked"] = json.dumps(mask_secrets(tr_resp.json()), ensure_ascii=False)[:8000]
            except Exception:
                out["token_response_body_masked"] = (tr_resp.text or "")[:8000]
        return out

    mode = normalize_vendor_token_auth_mode(auth_cfg.get("token_auth_mode"))
    if mode not in VENDOR_TOKEN_AUTH_MODES:
        return _fail(
            ctx,
            f"unsupported token_auth_mode: {mode}",
            error_code="vendor_jwt_exchange_failed",
            eff=effective_request("POST", "", {}),
            vendor_diag={"phase": "token_exchange"},
        )

    token_url_raw = str(auth_cfg.get("token_url") or "").strip()
    if not token_url_raw:
        return _fail(
            ctx,
            "vendor_jwt_exchange requires token_url",
            error_code="vendor_jwt_exchange_failed",
            eff=effective_request("POST", "", {}),
            vendor_diag={"phase": "token_exchange"},
        )

    err = _vendor_jwt_validate_credentials(auth_cfg, mode)
    if err:
        return _fail(ctx, err, error_code="vendor_jwt_exchange_failed", eff=effective_request("POST", "", {}), vendor_diag={"phase": "token_exchange"})

    token_method_u = str(auth_cfg.get("token_method") or "POST").strip().upper()
    if token_method_u not in {"GET", "POST"}:
        return _fail(
            ctx,
            f"unsupported token_method: {token_method_u}",
            error_code="vendor_jwt_exchange_failed",
            eff=effective_request(token_method_u, "", {}),
            vendor_diag={"phase": "token_exchange"},
        )

    resolved_url = resolve_vendor_token_exchange_url(token_url_raw, path_origin)
    if not resolved_url:
        return _fail(
            ctx,
            "could not resolve token_url",
            error_code="vendor_jwt_exchange_failed",
            eff=effective_request(token_method_u, "", {}),
            vendor_diag={"phase": "token_exchange"},
        )

    try:
        tok_headers, tok_query = build_vendor_token_exchange_auth_headers(auth_cfg)
    except (json.JSONDecodeError, ValueError) as exc:
        return _fail(
            ctx,
            str(exc),
            error_code="vendor_jwt_exchange_failed",
            eff=effective_request(token_method_u, resolved_url, {}),
            vendor_diag={"phase": "token_exchange"},
        )

    try:
        body_kw = build_vendor_token_exchange_body_kwargs(auth_cfg, token_method_u)
    except (json.JSONDecodeError, ValueError) as exc:
        return _fail(
            ctx,
            f"invalid token_body: {exc}",
            error_code="vendor_jwt_exchange_failed",
            eff=effective_request(token_method_u, resolved_url, tok_headers),
            vendor_diag={"phase": "token_exchange"},
        )

    merged_q = {**dict(tok_query or {})}
    try:
        tr_resp = client.request(
            token_method_u,
            resolved_url,
            headers=tok_headers,
            params=merged_q if merged_q else None,
            follow_redirects=False,
            **body_kw,
        )
    except Exception as exc:
        return _fail(
            ctx,
            str(exc),
            error_code="NETWORK_ERROR",
            eff=effective_request(token_method_u, resolved_url, tok_headers),
            vendor_diag={**_token_diag(tok_headers=tok_headers, token_method_u=token_method_u, resolved_url=resolved_url, tr_resp=None), "phase": "token_exchange"},
        )

    ctx.steps.append(
        ConnectorAuthLabStep(
            name="token_request",
            success=tr_resp.is_success,
            status_code=int(tr_resp.status_code),
            message="Vendor token exchange succeeded" if tr_resp.is_success else f"HTTP {tr_resp.status_code}",
        )
    )

    if not tr_resp.is_success:
        vd = _token_diag(tok_headers=tok_headers, token_method_u=token_method_u, resolved_url=resolved_url, tr_resp=tr_resp)
        return _fail(
            ctx,
            f"Token exchange HTTP {tr_resp.status_code} for {token_method_u} {str(tr_resp.request.url)}",
            error_code="TOKEN_HTTP_ERROR",
            eff=effective_request(token_method_u, str(tr_resp.request.url), tok_headers),
            status_code=int(tr_resp.status_code),
            sample=response_sample(tr_resp),
            tok=False,
            vendor_diag=vd,
        )

    try:
        tjson = tr_resp.json()
    except Exception:
        vd = _token_diag(tok_headers=tok_headers, token_method_u=token_method_u, resolved_url=resolved_url, tr_resp=tr_resp)
        return _fail(
            ctx,
            "token response is not JSON",
            error_code="TOKEN_PARSE_ERROR",
            eff=effective_request(token_method_u, str(tr_resp.request.url), tok_headers),
            status_code=int(tr_resp.status_code),
            vendor_diag=vd,
        )

    tdict = tjson if isinstance(tjson, dict) else {}
    access_token = vendor_access_token_from_response(tdict, auth_cfg)
    if not access_token:
        vd = _token_diag(tok_headers=tok_headers, token_method_u=token_method_u, resolved_url=resolved_url, tr_resp=tr_resp, tdict=tdict)
        return _fail(
            ctx,
            "access token not found at token_path",
            error_code="TOKEN_EXTRACTION_FAILED",
            eff=effective_request(token_method_u, str(tr_resp.request.url), tok_headers),
            status_code=int(tr_resp.status_code),
            sample=mask_secrets(tdict),
            tok=False,
            vendor_diag=vd,
        )

    if token_diag_out is not None:
        vd_ok = _token_diag(tok_headers=tok_headers, token_method_u=token_method_u, resolved_url=resolved_url, tr_resp=tr_resp)
        vd_ok.pop("phase", None)
        token_diag_out.update(vd_ok)

    return str(access_token)


@dataclass
class _ExecCtx:
    auth_type: str
    mode: str
    steps: list[ConnectorAuthLabStep]
    path_origin: str


def _fail(
    ctx: _ExecCtx,
    message: str,
    *,
    error_code: str,
    eff: ConnectorAuthLabEffectiveRequest,
    status_code: int | None = None,
    sample: Any | None = None,
    tok: bool | None = None,
    sess: bool | None = None,
    vendor_diag: dict[str, Any] | None = None,
    extra_lab_fields: dict[str, Any] | None = None,
) -> ConnectorAuthLabResponse:
    fields: dict[str, Any] = dict(
        success=False,
        auth_type=ctx.auth_type,
        mode=ctx.mode,
        steps=ctx.steps,
        effective_request=eff,
        status_code=status_code,
        response_sample=sample,
        error_code=error_code,
        message=message,
        token_obtained=tok,
        session_cookie_obtained=sess,
    )
    if vendor_diag:
        for k, v in vendor_diag.items():
            if v is not None:
                fields[k] = v
    if extra_lab_fields:
        for k, v in extra_lab_fields.items():
            if v is not None:
                fields[k] = v
    return ConnectorAuthLabResponse(**fields)


def execute_authenticated_http(
    client: httpx.Client | _StarletteAuthLabClient,
    *,
    auth_type: str,
    auth_cfg: dict[str, Any],
    target_method: str,
    target_url: str,
    target_headers: dict[str, Any],
    target_params: dict[str, Any],
    target_body: Any,
    path_origin: str,
    mode: str,
    session_retry_on_target_auth_failure: bool = False,
) -> ConnectorAuthLabResponse:
    """Run connector auth flows then one target HTTP call (same behavior as Auth Lab resource step)."""

    supported = {
        "no_auth",
        "basic",
        "bearer",
        "api_key",
        "oauth2_client_credentials",
        "session_login",
        "jwt_refresh_token",
        "vendor_jwt_exchange",
    }
    ctx = _ExecCtx(auth_type=auth_type, mode=mode, steps=[], path_origin=path_origin)
    if auth_type not in supported:
        return ConnectorAuthLabResponse(
            success=False,
            auth_type=auth_type,
            mode=mode,
            steps=[],
            effective_request=effective_request("GET", "", {}),
            error_code="UNSUPPORTED_AUTH_TYPE",
            message=f"unsupported auth_type: {auth_type}",
        )

    target_method_u = (target_method or "GET").upper()
    params = dict(target_params or {})

    if auth_type == "no_auth":
        headers = merge_str_headers(target_headers)
        try:
            resp = client.request(
                target_method_u,
                target_url,
                headers=headers,
                params=params or None,
                follow_redirects=False,
                **resource_json_kw(target_method_u, target_body, headers),
            )
        except Exception as exc:
            return _fail(ctx, str(exc), error_code="NETWORK_ERROR", eff=effective_request(target_method_u, target_url, headers))
        return _finalize_resource_fixed(ctx, resp, headers, target_method_u, token_ok=False, session_ok=False)

    if auth_type == "basic":
        user = str(auth_cfg.get("basic_username") or "")
        pw = str(auth_cfg.get("basic_password") or "")
        headers = merge_str_headers(target_headers)
        try:
            resp = client.request(
                target_method_u,
                target_url,
                headers=headers,
                params=params or None,
                auth=(user, pw),
                follow_redirects=False,
                **resource_json_kw(target_method_u, target_body, headers),
            )
        except Exception as exc:
            return _fail(ctx, str(exc), error_code="NETWORK_ERROR", eff=effective_request(target_method_u, target_url, headers))
        return _finalize_resource_fixed(ctx, resp, headers, target_method_u, token_ok=False, session_ok=False)

    if auth_type == "bearer":
        tok = str(auth_cfg.get("bearer_token") or "")
        headers = merge_str_headers(target_headers, {"Authorization": f"Bearer {tok}"})
        try:
            resp = client.request(
                target_method_u,
                target_url,
                headers=headers,
                params=params or None,
                follow_redirects=False,
                **resource_json_kw(target_method_u, target_body, headers),
            )
        except Exception as exc:
            return _fail(ctx, str(exc), error_code="NETWORK_ERROR", eff=effective_request(target_method_u, target_url, headers))
        return _finalize_resource_fixed(ctx, resp, headers, target_method_u, token_ok=False, session_ok=False)

    if auth_type == "api_key":
        name = str(auth_cfg.get("api_key_name") or "X-API-Key")
        value = str(auth_cfg.get("api_key_value") or "")
        location = str(auth_cfg.get("api_key_location") or "headers").lower()
        headers = merge_str_headers(target_headers)
        if location in {"query", "query_params", "query_param"}:
            params = {**params}
            params.setdefault(name, value)
        else:
            headers = {**headers, name: value}
        try:
            resp = client.request(
                target_method_u,
                target_url,
                headers=headers,
                params=params or None,
                follow_redirects=False,
                **resource_json_kw(target_method_u, target_body, headers),
            )
        except Exception as exc:
            return _fail(ctx, str(exc), error_code="NETWORK_ERROR", eff=effective_request(target_method_u, target_url, headers))
        return _finalize_resource_fixed(ctx, resp, headers, target_method_u, token_ok=False, session_ok=False)

    if auth_type == "oauth2_client_credentials":
        token_url = str(auth_cfg.get("oauth2_token_url") or "").strip()
        cid = str(auth_cfg.get("oauth2_client_id") or "")
        csec = str(auth_cfg.get("oauth2_client_secret") or "")
        scope = str(auth_cfg.get("oauth2_scope") or "").strip()
        if not token_url or not cid or not csec:
            return _fail(
                ctx,
                "oauth2_client_credentials requires oauth2_token_url, oauth2_client_id, oauth2_client_secret",
                error_code="CONFIG_INVALID",
                eff=effective_request("POST", token_url, {}),
            )
        token_headers = {"Content-Type": "application/json"}
        token_body: dict[str, Any] = {"grant_type": "client_credentials", "client_id": cid, "client_secret": csec}
        if scope:
            token_body["scope"] = scope
        try:
            tr_resp = client.post(token_url, headers=token_headers, json=token_body)
        except Exception as exc:
            return _fail(ctx, str(exc), error_code="NETWORK_ERROR", eff=effective_request("POST", token_url, token_headers))
        ctx.steps.append(
            ConnectorAuthLabStep(
                name="token_request",
                success=tr_resp.is_success,
                status_code=int(tr_resp.status_code),
                message="Token request succeeded" if tr_resp.is_success else f"Token HTTP {tr_resp.status_code}",
            )
        )
        if not tr_resp.is_success:
            return _fail(
                ctx,
                ctx.steps[-1].message,
                error_code="TOKEN_HTTP_ERROR",
                eff=effective_request("POST", str(tr_resp.request.url), token_headers),
                status_code=int(tr_resp.status_code),
                sample=response_sample(tr_resp),
                tok=False,
            )
        try:
            tjson = tr_resp.json()
        except Exception:
            return _fail(
                ctx,
                "token response is not JSON",
                error_code="TOKEN_PARSE_ERROR",
                eff=effective_request("POST", str(tr_resp.request.url), token_headers),
                status_code=int(tr_resp.status_code),
            )
        access_token = jwt_access_token_from_response(tjson if isinstance(tjson, dict) else {}, auth_cfg)
        if not access_token:
            return _fail(
                ctx,
                "token response missing access_token",
                error_code="TOKEN_MISSING",
                eff=effective_request("POST", str(tr_resp.request.url), token_headers),
                status_code=int(tr_resp.status_code),
                sample=mask_secrets(tjson) if isinstance(tjson, dict) else None,
                tok=False,
            )

        res_headers = merge_str_headers(target_headers, {"Authorization": f"Bearer {access_token}"})
        try:
            resp = client.request(
                target_method_u,
                target_url,
                headers=res_headers,
                params=params or None,
                follow_redirects=False,
                **resource_json_kw(target_method_u, target_body, res_headers),
            )
        except Exception as exc:
            return _fail(
                ctx,
                str(exc),
                error_code="NETWORK_ERROR",
                eff=effective_request(target_method_u, target_url, res_headers),
                tok=True,
            )
        return _finalize_resource_fixed(ctx, resp, res_headers, target_method_u, token_ok=True, session_ok=False)

    if auth_type == "session_login":
        return _session_flow(
            client,
            ctx,
            auth_cfg,
            target_method_u,
            target_url,
            target_headers,
            params,
            target_body,
            session_retry_on_target_auth_failure,
        )

    if auth_type == "jwt_refresh_token":
        refresh = str(auth_cfg.get("refresh_token") or "")
        token_method = str(auth_cfg.get("token_http_method") or "POST").upper()
        rh_name = str(auth_cfg.get("refresh_token_header_name") or "Authorization")
        rh_pref = str(auth_cfg.get("refresh_token_header_prefix") or "Bearer").strip()
        header_val = f"{rh_pref} {refresh}".strip() if rh_pref else refresh
        if not refresh:
            return _fail(ctx, "jwt_refresh_token requires refresh_token", error_code="CONFIG_INVALID", eff=effective_request(token_method, "", {}))
        resolved_token_url = resolve_jwt_token_url(auth_cfg, path_origin)
        if not resolved_token_url:
            return _fail(
                ctx,
                "jwt_refresh_token requires token_url or token_path",
                error_code="CONFIG_INVALID",
                eff=effective_request(token_method, "", {}),
            )

        tok_headers = {rh_name: header_val, "Content-Type": "application/json"}
        try:
            tr_resp = client.request(token_method, resolved_token_url, headers=tok_headers, json={}, follow_redirects=False)
        except Exception as exc:
            return _fail(ctx, str(exc), error_code="NETWORK_ERROR", eff=effective_request(token_method, resolved_token_url, tok_headers))
        ctx.steps.append(
            ConnectorAuthLabStep(
                name="access_token_request",
                success=tr_resp.is_success,
                status_code=int(tr_resp.status_code),
                message="Access token request succeeded" if tr_resp.is_success else f"HTTP {tr_resp.status_code}",
            )
        )
        if not tr_resp.is_success:
            return _fail(
                ctx,
                ctx.steps[-1].message,
                error_code="TOKEN_HTTP_ERROR",
                eff=effective_request(token_method, str(tr_resp.request.url), tok_headers),
                status_code=int(tr_resp.status_code),
                sample=response_sample(tr_resp),
                tok=False,
            )
        try:
            tjson = tr_resp.json()
        except Exception:
            return _fail(
                ctx,
                "access token response is not JSON",
                error_code="TOKEN_PARSE_ERROR",
                eff=effective_request(token_method, str(tr_resp.request.url), tok_headers),
                status_code=int(tr_resp.status_code),
            )
        tdict = tjson if isinstance(tjson, dict) else {}
        access_token = jwt_access_token_from_response(tdict, auth_cfg)
        if not access_token:
            return _fail(
                ctx,
                "access token missing in response",
                error_code="TOKEN_MISSING",
                eff=effective_request(token_method, str(tr_resp.request.url), tok_headers),
                status_code=int(tr_resp.status_code),
                sample=mask_secrets(tdict),
            )

        ah_name = str(auth_cfg.get("access_token_header_name") or "Authorization")
        ah_pref = str(auth_cfg.get("access_token_header_prefix") or "Bearer").strip()
        auth_hdr = f"{ah_pref} {access_token}".strip() if ah_pref else str(access_token)
        res_headers = merge_str_headers(target_headers, {ah_name: auth_hdr})
        try:
            resp = client.request(
                target_method_u,
                target_url,
                headers=res_headers,
                params=params or None,
                follow_redirects=False,
                **resource_json_kw(target_method_u, target_body, res_headers),
            )
        except Exception as exc:
            return _fail(
                ctx,
                str(exc),
                error_code="NETWORK_ERROR",
                eff=effective_request(target_method_u, target_url, res_headers),
                tok=True,
            )
        return _finalize_resource_fixed(ctx, resp, res_headers, target_method_u, token_ok=True, session_ok=False)

    if auth_type == "vendor_jwt_exchange":
        token_diag_out: dict[str, Any] = {}
        out = vendor_jwt_run_token_exchange(client, ctx, auth_cfg, ctx.path_origin, token_diag_out=token_diag_out)
        if isinstance(out, ConnectorAuthLabResponse):
            return out
        access_token = out
        res_headers, params = merge_vendor_access_into_target(auth_cfg, access_token, target_headers, params)
        try:
            resp = client.request(
                target_method_u,
                target_url,
                headers=res_headers,
                params=params or None,
                follow_redirects=False,
                **resource_json_kw(target_method_u, target_body, res_headers),
            )
        except Exception as exc:
            fd = {**token_diag_out, "phase": "final_request"}
            return _fail(
                ctx,
                f"Final request network error: {exc}",
                error_code="NETWORK_ERROR",
                eff=effective_request(target_method_u, target_url, res_headers),
                tok=True,
                vendor_diag=fd,
            )
        return _finalize_resource_fixed(
            ctx, resp, res_headers, target_method_u, token_ok=True, session_ok=False, vendor_jwt_token_diag=token_diag_out
        )

    return ConnectorAuthLabResponse(
        success=False,
        auth_type=auth_type,
        mode=mode,
        steps=ctx.steps,
        effective_request=effective_request("GET", "", {}),
        error_code="INTERNAL",
        message="Auth execution internal error",
    )


def _final_probe_body_masked(resp: httpx.Response) -> str:
    try:
        return json.dumps(mask_secrets(resp.json()), ensure_ascii=False)[:8000]
    except Exception:
        return (resp.text or "")[:8000]


def _finalize_resource_fixed(
    ctx: _ExecCtx,
    resp: httpx.Response,
    headers_for_eff: dict[str, str],
    method_u: str,
    *,
    token_ok: bool,
    session_ok: bool,
    vendor_jwt_token_diag: dict[str, Any] | None = None,
    session_login_extra: dict[str, Any] | None = None,
) -> ConnectorAuthLabResponse:
    ctx.steps.append(
        ConnectorAuthLabStep(
            name="resource_request",
            success=resp.is_success,
            status_code=int(resp.status_code),
            message="Resource request succeeded" if resp.is_success else f"HTTP {resp.status_code}",
        )
    )
    ok = resp.is_success
    raw_preview = (resp.text or "")[:80000]
    parsed: Any | None = None
    try:
        parsed = resp.json()
    except Exception:
        parsed = None
    msg_ok = "Auth test succeeded"
    msg_fail = f"Final resource HTTP {resp.status_code} for {method_u} {str(resp.request.url)}"
    vendor_extra: dict[str, Any] = {}
    if ctx.auth_type == "vendor_jwt_exchange" and vendor_jwt_token_diag is not None:
        vendor_extra.update(vendor_jwt_token_diag)
        vendor_extra["final_request_method"] = method_u
        vendor_extra["final_request_url"] = str(resp.request.url)
        vendor_extra["final_request_headers_masked"] = mask_http_headers(headers_for_eff)
        vendor_extra["final_response_status_code"] = int(resp.status_code)
        vendor_extra["final_response_headers_masked"] = mask_http_headers({str(k): str(v) for k, v in resp.headers.items()})
        vendor_extra["final_response_body"] = _final_probe_body_masked(resp)
        if not ok:
            vendor_extra["phase"] = "final_request"
    base = dict(
        success=ok,
        auth_type=ctx.auth_type,
        mode=ctx.mode,
        steps=ctx.steps,
        effective_request=effective_request(method_u, str(resp.request.url), headers_for_eff),
        status_code=int(resp.status_code),
        response_sample=response_sample(resp),
        error_code=None if ok else "RESOURCE_HTTP_ERROR",
        message=msg_ok if ok else msg_fail,
        token_obtained=token_ok,
        session_cookie_obtained=session_ok,
        raw_body_preview=raw_preview,
        parsed_json_preview=parsed,
        target_response_headers={str(k).lower(): str(v) for k, v in resp.headers.items()},
    )
    base.update(vendor_extra)
    if session_login_extra:
        base.update({k: v for k, v in session_login_extra.items() if v is not None})
    return ConnectorAuthLabResponse(**base)


def _session_login_lab_extra(dbg: SessionLoginHttpDebug) -> dict[str, Any]:
    return {
        "session_login_body_mode": dbg.body_mode,
        "session_login_follow_redirects": dbg.login_allow_redirects,
        "session_login_final_url": dbg.login_final_url,
        "session_login_redirect_chain": dbg.redirect_chain,
        "session_login_cookie_names": dbg.cookie_names,
        "session_login_http_reason": dbg.login_http_reason,
        "computed_login_request_url": dbg.computed_login_request_url,
        "login_url_resolution_warnings": dbg.login_url_resolution_warnings,
        "session_login_body_preview": dbg.session_login_body_preview,
        "session_login_content_type": dbg.session_login_content_type,
        "session_login_request_encoding": dbg.session_login_request_encoding,
        "preflight_http_status": dbg.preflight_http_status,
        "preflight_final_url": dbg.preflight_final_url,
        "preflight_cookies": dbg.preflight_cookies,
        "extracted_variables": dbg.extracted_variables,
        "template_render_preview": dbg.template_render_preview,
    }


def _session_flow(
    client: httpx.Client | _StarletteAuthLabClient,
    ctx: _ExecCtx,
    auth_cfg: dict[str, Any],
    target_method_u: str,
    target_url: str,
    target_headers: dict[str, Any],
    params: dict[str, Any],
    target_body: Any,
    session_retry_on_target_auth_failure: bool,
) -> ConnectorAuthLabResponse:
    login_url = resolve_session_login_url(auth_cfg, ctx.path_origin)
    login_method = str(auth_cfg.get("login_method") or "POST").upper()
    login_headers_raw = auth_cfg.get("login_headers")
    login_headers = merge_str_headers(login_headers_raw if isinstance(login_headers_raw, dict) else {})
    if not login_url:
        return _fail(
            ctx,
            "session_login requires login_url or login_path",
            error_code="CONFIG_INVALID",
            eff=effective_request("POST", "", {}),
        )
    if not str(auth_cfg.get("login_username") or "").strip() or not str(auth_cfg.get("login_password") or "").strip():
        return _fail(
            ctx,
            "session_login requires login_username and login_password",
            error_code="CONFIG_INVALID",
            eff=effective_request(login_method, login_url, login_headers),
        )

    def run_login_phase(step_name: str) -> tuple[httpx.Response | None, SessionLoginHttpDebug | None]:
        try:
            lr, dbg = session_login_single_request(client, auth_cfg, ctx.path_origin)
        except Exception as exc:
            ctx.steps.append(
                ConnectorAuthLabStep(
                    name=step_name,
                    success=False,
                    status_code=None,
                    message=str(exc),
                )
            )
            return None, None
        ctx.steps.append(
            ConnectorAuthLabStep(
                name=step_name,
                success=dbg.login_http_ok,
                status_code=int(lr.status_code),
                message=dbg.login_http_reason,
            )
        )
        return lr, dbg

    lr, dbg = run_login_phase("login_request")
    if lr is None or dbg is None:
        return _fail(
            ctx,
            ctx.steps[-1].message,
            error_code="NETWORK_ERROR",
            eff=effective_request(login_method, login_url, login_headers),
        )
    if not dbg.login_http_ok:
        return _fail(
            ctx,
            dbg.login_http_reason,
            error_code="LOGIN_HTTP_ERROR",
            eff=effective_request(login_method, str(lr.request.url), login_headers),
            status_code=int(lr.status_code),
            sample=response_sample(lr),
            sess=False,
            extra_lab_fields=_session_login_lab_extra(dbg),
        )

    named_cookie = str(auth_cfg.get("session_cookie_name") or "").strip()
    cn = cookie_jar_names(client.cookies)
    if named_cookie and not _cookie_present(client.cookies, named_cookie):
        return _fail(
            ctx,
            f"expected session cookie {named_cookie!r} not present after login",
            error_code="LOGIN_COOKIE_MISSING",
            eff=effective_request(login_method, str(lr.request.url), login_headers),
            status_code=int(lr.status_code),
            sample=response_sample(lr),
            sess=False,
            extra_lab_fields=_session_login_lab_extra(dbg),
        )

    ctx.steps.append(
        ConnectorAuthLabStep(
            name="session_cookie",
            success=True if not named_cookie else _cookie_present(client.cookies, named_cookie),
            status_code=None,
            message=f"Cookies stored: {', '.join(cn) if cn else '(none)'}",
        )
    )

    cookie_ok = bool(cn) if not named_cookie else _cookie_present(client.cookies, named_cookie)

    res_headers = merge_str_headers(target_headers)
    res_headers = {k: v for k, v in res_headers.items() if str(k).lower() != "cookie"}

    def send_target() -> httpx.Response:
        return client.request(
            target_method_u,
            target_url,
            headers=res_headers,
            params=params or None,
            follow_redirects=False,
            **resource_json_kw(target_method_u, target_body, res_headers),
        )

    try:
        resp = send_target()
    except Exception as exc:
        return _fail(
            ctx,
            str(exc),
            error_code="NETWORK_ERROR",
            eff=effective_request(target_method_u, target_url, res_headers),
            sess=cookie_ok,
            extra_lab_fields=_session_login_lab_extra(dbg),
        )

    need_retry = session_retry_on_target_auth_failure and (
        resp.status_code == 401 or (resp.status_code in (301, 302, 303, 307, 308) and target_suggests_login_redirect(resp))
    )
    if need_retry:
        ctx.steps.append(
            ConnectorAuthLabStep(
                name="resource_request",
                success=False,
                status_code=int(resp.status_code),
                message=f"HTTP {resp.status_code}" if resp.status_code != 401 else "HTTP 401 Unauthorized",
            )
        )
        lr2, dbg2 = run_login_phase("retry_login")
        if lr2 is None or dbg2 is None:
            return _fail(
                ctx,
                ctx.steps[-1].message if ctx.steps else "retry login failed",
                error_code="NETWORK_ERROR",
                eff=effective_request(login_method, login_url, login_headers),
                extra_lab_fields=_session_login_lab_extra(dbg),
            )
        if not dbg2.login_http_ok:
            return _fail(
                ctx,
                dbg2.login_http_reason,
                error_code="LOGIN_HTTP_ERROR",
                eff=effective_request(login_method, str(lr2.request.url), login_headers),
                status_code=int(lr2.status_code),
                sample=response_sample(lr2),
                sess=False,
                extra_lab_fields=_session_login_lab_extra(dbg2),
            )
        cn2 = cookie_jar_names(client.cookies)
        named_cookie2 = str(auth_cfg.get("session_cookie_name") or "").strip()
        if named_cookie2 and not _cookie_present(client.cookies, named_cookie2):
            return _fail(
                ctx,
                f"expected session cookie {named_cookie2!r} not present after retry login",
                error_code="LOGIN_COOKIE_MISSING",
                eff=effective_request(login_method, str(lr2.request.url), login_headers),
                status_code=int(lr2.status_code),
                sample=response_sample(lr2),
                sess=False,
                extra_lab_fields=_session_login_lab_extra(dbg2),
            )
        cookie_ok2 = bool(cn2) if not named_cookie2 else _cookie_present(client.cookies, named_cookie2)
        ctx.steps.append(
            ConnectorAuthLabStep(
                name="session_cookie",
                success=True if not named_cookie2 else _cookie_present(client.cookies, named_cookie2),
                status_code=None,
                message=f"Cookies stored after retry: {', '.join(cn2) if cn2 else '(none)'}",
            )
        )
        try:
            resp = send_target()
        except Exception as exc:
            return _fail(
                ctx,
                str(exc),
                error_code="NETWORK_ERROR",
                eff=effective_request(target_method_u, target_url, res_headers),
                sess=cookie_ok2,
                extra_lab_fields=_session_login_lab_extra(dbg2),
            )
        ctx.steps.append(
            ConnectorAuthLabStep(
                name="retry_target_request",
                success=resp.is_success,
                status_code=int(resp.status_code),
                message="Retry target succeeded" if resp.is_success else f"HTTP {resp.status_code}",
            )
        )
        ok = resp.is_success
        raw_preview = (resp.text or "")[:80000]
        parsed: Any | None = None
        try:
            parsed = resp.json()
        except Exception:
            parsed = None
        fields = dict(
            success=ok,
            auth_type=ctx.auth_type,
            mode=ctx.mode,
            steps=ctx.steps,
            effective_request=effective_request(target_method_u, str(resp.request.url), res_headers),
            status_code=int(resp.status_code),
            response_sample=response_sample(resp),
            error_code=None if ok else "RESOURCE_HTTP_ERROR",
            message="Auth test succeeded" if ok else ctx.steps[-1].message,
            token_obtained=False,
            session_cookie_obtained=cookie_ok2,
            raw_body_preview=raw_preview,
            parsed_json_preview=parsed,
            target_response_headers={str(k).lower(): str(v) for k, v in resp.headers.items()},
        )
        fields.update(_session_login_lab_extra(dbg2))
        return ConnectorAuthLabResponse(**fields)

    return _finalize_resource_fixed(
        ctx,
        resp,
        res_headers,
        target_method_u,
        token_ok=False,
        session_ok=cookie_ok,
        session_login_extra=_session_login_lab_extra(dbg),
    )


def run_stream_api_authenticated_request(
    *,
    api_origin: str,
    connector_base_url: str,
    verify_ssl: bool,
    proxy: str | None,
    timeout: float,
    auth_type: str,
    auth_config: dict[str, Any],
    target_method: str,
    target_url: str,
    target_headers: dict[str, Any],
    target_params: dict[str, Any],
    target_body: Any,
) -> ConnectorAuthLabResponse:
    """Stream API Test: authenticated probe request against the connector base URL."""

    path_origin = connector_base_url.rstrip("/")
    with lab_client(
        api_origin,
        verify_ssl=verify_ssl,
        proxy=proxy,
        timeout=timeout,
        allow_in_process_testclient=False,
    ) as client:
        return execute_authenticated_http(
            client,
            auth_type=normalize_auth_type(auth_type),
            auth_cfg=dict(auth_config or {}),
            target_method=target_method,
            target_url=target_url,
            target_headers=target_headers,
            target_params=target_params,
            target_body=target_body,
            path_origin=path_origin,
            mode="stream_api_test",
            session_retry_on_target_auth_failure=True,
        )
