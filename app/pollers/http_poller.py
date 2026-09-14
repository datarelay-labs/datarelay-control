"""HTTP API polling — fetch raw responses for StreamRunner."""

from __future__ import annotations

import time
from typing import Any

import httpx

from app.http.outbound_httpx_timeout import outbound_httpx_timeout
from app.http.shared_request_builder import build_outbound_debug_detail, build_shared_http_request
from app.http_util.retry_after import parse_retry_after_seconds
from app.pollers.http_query_params import httpx_body_kwargs
from app.connectors.auth import apply_auth_to_http_request, normalize_connector_auth
from app.runtime.errors import PreviewRequestError, SourceFetchError
from app.runtime.preview_service import _target_suggests_login_redirect, perform_http_session_login


def _get(data: Any, key: str, default: Any = None) -> Any:
    """Read key from dict/object."""

    if isinstance(data, dict):
        return data.get(key, default)
    return getattr(data, key, default)


class HttpPoller:
    """HTTP poller with retry/backoff and basic 429 handling."""

    def fetch(
        self,
        source_config: dict[str, Any],
        stream_config: dict[str, Any],
        checkpoint: dict[str, Any] | None,
    ) -> Any:
        """Fetch JSON payload for one stream cycle.

        Supports GET/POST, timeout, retry, backoff, and Retry-After for 429.
        """

        plan = build_shared_http_request(
            source_config=dict(source_config or {}),
            stream_config=dict(stream_config or {}),
            mode="runtime",
            checkpoint_value=checkpoint,
        )
        method = plan.method
        url = plan.url

        if not str(_get(source_config, "base_url", "")).strip():
            raise SourceFetchError("HTTP source_config.base_url is required")
        endpoint_raw = str(_get(stream_config, "endpoint", "") or _get(stream_config, "endpoint_path", "")).strip()
        if not endpoint_raw:
            raise SourceFetchError("HTTP stream_config.endpoint is required")
        if method not in {"GET", "POST"}:
            raise SourceFetchError(f"Unsupported HTTP method: {method}")

        timeout_seconds = float(_get(stream_config, "timeout_seconds", _get(source_config, "timeout_seconds", 30)))
        retries = int(_get(stream_config, "retry_count", _get(source_config, "retry_count", 2)))
        initial_backoff = float(_get(stream_config, "retry_backoff_seconds", 1.0))

        verify_ssl = bool(_get(source_config, "verify_ssl", True))
        proxy_url = _get(source_config, "http_proxy") or None
        base_url_raw = str(_get(source_config, "base_url", "")).strip()

        headers = dict(plan.connector_headers)
        params_dict = dict(plan.params)

        auth = normalize_connector_auth(source_config)
        try:
            headers, params_dict = apply_auth_to_http_request(
                auth,
                headers,
                params_dict,
                verify_ssl,
                proxy_url if isinstance(proxy_url, str) else None,
                timeout_seconds,
                base_url_raw,
            )
        except PreviewRequestError as exc:
            detail = exc.detail if isinstance(exc.detail, dict) else {}
            raise SourceFetchError(str(detail.get("message") or detail)) from exc

        headers.update(plan.stream_headers)
        if auth.get("auth_type") == "SESSION_LOGIN":
            headers = {str(k): str(v) for k, v in headers.items() if str(k).lower() != "cookie"}

        params = params_dict if params_dict else None

        rendered_body = plan.normalized_json_body
        body_kwargs = httpx_body_kwargs(rendered_body, headers)

        attempts = retries + 1
        last_error: Exception | None = None
        session_login = auth.get("auth_type") == "SESSION_LOGIN"

        def send(cli: httpx.Client) -> httpx.Response:
            req_kw: dict[str, Any] = {
                "method": method,
                "url": url,
                "headers": headers,
                "params": params,
                "follow_redirects": False,
            }
            req_kw.update(body_kwargs)
            return cli.request(**req_kw)

        def ensure_session_login(cli: httpx.Client) -> None:
            if not session_login:
                return
            try:
                perform_http_session_login(cli, source_config)
            except PreviewRequestError as exc:
                detail = exc.detail if isinstance(exc.detail, dict) else {}
                raise SourceFetchError(str(detail.get("message") or detail)) from exc

        httpx_timeout = outbound_httpx_timeout(timeout_seconds)
        with httpx.Client(
            verify=verify_ssl,
            proxy=proxy_url if isinstance(proxy_url, str) else None,
            timeout=httpx_timeout,
        ) as client:
            ensure_session_login(client)
            for attempt in range(1, attempts + 1):
                try:
                    response = send(client)
                    if session_login and (
                        response.status_code == 401
                        or (
                            response.status_code in (301, 302, 303, 307, 308)
                            and _target_suggests_login_redirect(response)
                        )
                    ):
                        ensure_session_login(client)
                        response = send(client)

                    if response.status_code == 429:
                        retry_after = response.headers.get("Retry-After")
                        sleep_seconds = parse_retry_after_seconds(
                            retry_after,
                            fallback_seconds=initial_backoff * (2 ** (attempt - 1)),
                        )
                        if attempt < attempts:
                            time.sleep(max(sleep_seconds, 0))
                            continue
                        raise SourceFetchError("HTTP 429 exceeded retries")

                    if response.status_code >= 400:
                        detail = build_outbound_debug_detail(response=response, body_kwargs=body_kwargs)
                        raise SourceFetchError(
                            f"HTTP {response.status_code} for {method} {response.request.url}",
                            detail=detail,
                        )

                    try:
                        return response.json()
                    except ValueError as exc:
                        raise SourceFetchError("HTTP response is not valid JSON") from exc

                except SourceFetchError as exc:
                    if exc.detail.get("response_status") is not None:
                        raise
                    last_error = exc
                    if attempt >= attempts:
                        break
                    time.sleep(max(initial_backoff * (2 ** (attempt - 1)), 0))
                except httpx.HTTPError as exc:
                    last_error = exc
                    if attempt >= attempts:
                        break
                    time.sleep(max(initial_backoff * (2 ** (attempt - 1)), 0))

        raise SourceFetchError(f"HTTP polling failed after retries: {last_error}")


class HTTPPoller(HttpPoller):
    """Backward-compatible class name alias."""


# Historical names (tests may monkeypatch these module attributes).
_apply_auth_to_request = apply_auth_to_http_request
_normalize_auth = normalize_connector_auth
