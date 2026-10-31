"""Single place for HTTP outbound request shape: previews, poller, connector probes."""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

import httpx

from app.parsers.jsonpath_parser import find_values
from app.pollers.http_query_params import (
    drop_placeholder_pagination_params,
    httpx_body_kwargs,
    outbound_body_for_debug,
    unwrap_json_string_body,
)
from app.security.secrets import mask_http_headers, mask_secrets

_CHECKPOINT_VAR_PATTERN = re.compile(r"\{\{\s*checkpoint\.([a-zA-Z0-9_]+)\s*\}\}")


def _is_scalar_json(value: Any) -> bool:
    return value is None or isinstance(value, bool | int | float | str)


def _first_scalar(value: Any) -> Any | None:
    if _is_scalar_json(value):
        return value
    if isinstance(value, list):
        for item in value:
            picked = _first_scalar(item)
            if picked is not None:
                return picked
    return None


def _normalize_path(path: Any) -> str:
    p = str(path or "").strip()
    if not p:
        return ""
    if p.startswith("$"):
        return p
    if p.startswith("."):
        return f"${p}"
    return f"$.{p}"


def _checkpoint_path_candidates(path: str, event_array_path: str) -> list[str]:
    """Generate JSONPath candidates relative to an extracted event object."""

    out: list[str] = []
    seen: set[str] = set()

    def _push(candidate: str) -> None:
        c = _normalize_path(candidate)
        if c and c not in seen:
            seen.add(c)
            out.append(c)

    raw = _normalize_path(path)
    if not raw:
        return out
    _push(raw)
    _push(raw.replace(".*[*].", ".*."))

    arr = _normalize_path(event_array_path)
    if not arr:
        return out
    arr_prefixes = [arr, f"{arr}[*]", f"{arr}[0]"]
    raw_variants = [raw, raw.replace(".*[*].", ".*.")]
    for variant in raw_variants:
        for prefix in arr_prefixes:
            if variant.startswith(f"{prefix}."):
                _push(f"$.{variant[len(prefix) + 1:]}")
        if arr.endswith(".*"):
            map_prefix = arr[:-2]
            if variant.startswith(f"{map_prefix}."):
                tail = variant[len(map_prefix) + 1 :]
                next_dot = tail.find(".")
                if next_dot >= 0:
                    _push(f"$.{tail[next_dot + 1 :]}")
    return out


def _resolve_checkpoint_value_from_event(*, last_event: dict[str, Any], stream_config: dict[str, Any]) -> Any | None:
    checkpoint_cfg = stream_config.get("checkpoint")
    if not isinstance(checkpoint_cfg, dict):
        return None

    event_array_path = str(stream_config.get("event_array_path") or "$")
    raw_paths: list[str] = []
    cursor_paths = checkpoint_cfg.get("cursor_paths")
    if isinstance(cursor_paths, list):
        raw_paths.extend([str(p) for p in cursor_paths if str(p or "").strip()])
    for single_path_key in ("cursor_path", "path", "field_path"):
        path = checkpoint_cfg.get(single_path_key)
        if str(path or "").strip():
            raw_paths.append(str(path))

    for raw_path in raw_paths:
        for candidate in _checkpoint_path_candidates(raw_path, event_array_path):
            try:
                matches = find_values(last_event, candidate)
            except Exception:
                continue
            for match in matches:
                picked = _first_scalar(match)
                if picked is not None:
                    return picked
    return None


# Epoch values at or above this are milliseconds; at or above _EPOCH_SECONDS_MIN they are seconds.
# Same thresholds as the API Test (parseTimestampMs in wizard-incremental-request.ts).
_CHECKPOINT_EPOCH_MS_MIN = 1_000_000_000_000
_CHECKPOINT_EPOCH_SECONDS_MIN = 1_000_000_000
_NUMERIC_TEXT = re.compile(r"^-?\d+(\.\d+)?$")


def checkpoint_timestamp_ms(value: Any) -> int | None:
    """Epoch milliseconds for a timestamp-like checkpoint value, or None when it is not a timestamp.

    Mirrors the API Test checkpoint: numbers (or numeric strings) >= 1e12 are epoch ms, >= 1e9 epoch seconds,
    smaller numbers are plain numeric cursors; other strings are parsed as ISO-8601 (naive = UTC). Sub-millisecond
    precision is floored so the derived window never starts after the stored checkpoint.
    """

    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        number = float(value)
    else:
        text = str(value).strip()
        if not text:
            return None
        if _NUMERIC_TEXT.match(text):
            number = float(text)
        else:
            try:
                parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            except ValueError:
                return None
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            delta = parsed - datetime(1970, 1, 1, tzinfo=timezone.utc)
            return delta // timedelta(milliseconds=1)
    if number != number or number in (float("inf"), float("-inf")):
        return None
    if number >= _CHECKPOINT_EPOCH_MS_MIN:
        return int(number // 1)
    if number >= _CHECKPOINT_EPOCH_SECONDS_MIN:
        return int((number * 1000) // 1)
    return None


def normalize_checkpoint_timestamp_ms(value: Any) -> Any:
    """``last_timestamp_ms`` representation: epoch ms (int) for timestamp-like values, otherwise unchanged.

    Used on write (new checkpoints store numeric epoch ms) and on read (checkpoints written before this fix stored
    the ISO raw sample in ``last_timestamp_ms``; they are converted in memory, never migrated).
    """

    ms = checkpoint_timestamp_ms(value)
    return ms if ms is not None else value


def build_runtime_checkpoint_template_context(
    checkpoint: dict[str, Any] | None,
    stream_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Flatten runtime checkpoint aliases consumed by ``{{checkpoint.*}}`` templates.

    ``last_timestamp`` keeps the canonical raw sample value (e.g. ISO); ``last_timestamp_ms`` is numeric epoch
    milliseconds when the value is timestamp-like, matching the API Test checkpoint payload.
    """

    context = dict(checkpoint or {})
    last_event = context.get("last_success_event")
    cfg = stream_config if isinstance(stream_config, dict) else {}

    cursor_value = None
    if isinstance(last_event, dict):
        cursor_value = _resolve_checkpoint_value_from_event(last_event=last_event, stream_config=cfg)

    if cursor_value is not None:
        context.setdefault("cursor", cursor_value)
        context.setdefault("value", cursor_value)
        context.setdefault("last_seen", cursor_value)
        context.setdefault("next_cursor", cursor_value)
        context.setdefault("last_timestamp", cursor_value)
        context.setdefault("last_timestamp_ms", cursor_value)

    if "last_timestamp_ms" in context:
        context["last_timestamp_ms"] = normalize_checkpoint_timestamp_ms(context["last_timestamp_ms"])

    return context


def render_runtime_checkpoint_templates(value: Any, checkpoint: dict[str, Any] | None) -> Any:
    """Replace ``{{checkpoint.field}}`` recursively (runtime poller / run-once)."""

    checkpoint_map = checkpoint or {}
    numeric_defaults = {
        "cursor",
        "value",
        "last_seen",
        "next_cursor",
        "last_timestamp",
        "last_timestamp_ms",
    }

    if isinstance(value, str):

        def _replace(match: re.Match[str]) -> str:
            key = match.group(1)
            replacement = checkpoint_map.get(key)
            if replacement is None:
                return "0" if key in numeric_defaults else ""
            return str(replacement)

        return _CHECKPOINT_VAR_PATTERN.sub(_replace, value)

    if isinstance(value, dict):
        return {k: render_runtime_checkpoint_templates(v, checkpoint_map) for k, v in value.items()}
    if isinstance(value, list):
        return [render_runtime_checkpoint_templates(v, checkpoint_map) for v in value]
    return value


def _utc_now_seconds() -> float:
    return time.time()


_DEFAULT_TIME_WINDOW_MS = 86400000
# Epoch values above this are milliseconds (1973-03-03 in ms); below it they are seconds.
_EPOCH_MS_THRESHOLD = 100_000_000_000


def _iso_z_from_seconds(seconds: float) -> str:
    return datetime.fromtimestamp(int(seconds), timezone.utc).isoformat().replace("+00:00", "Z")


def _canonical_start_ts(raw: Any) -> str | None:
    """Return the checkpoint timestamp as an ISO UTC string, or None when it is not a usable timestamp.

    ISO strings are returned exactly as stored (the same value ``{{checkpoint.last_timestamp}}`` renders,
    keeping any sub-second precision). Epoch seconds/milliseconds are converted to ``YYYY-MM-DDTHH:MM:SSZ``,
    floored to the second so the window never starts after the checkpoint.
    """

    if raw is None or isinstance(raw, bool):
        return None
    if isinstance(raw, int | float):
        number = float(raw)
    else:
        text = str(raw).strip()
        if not text:
            return None
        try:
            number = float(text)
        except ValueError:
            try:
                datetime.fromisoformat(text.replace("Z", "+00:00"))
            except ValueError:
                return None
            return text
    if number <= 0:
        return None
    seconds = number / 1000 if number >= _EPOCH_MS_THRESHOLD else number
    try:
        return _iso_z_from_seconds(seconds)
    except (OverflowError, OSError, ValueError):
        return None


def time_template_replacements(checkpoint: dict[str, Any] | None = None) -> dict[str, str]:
    """Time placeholders shared by runtime requests and the onboarding API test.

    ``checkpoint`` is the resolved checkpoint template context (see
    :func:`build_runtime_checkpoint_template_context` / ``prepare_fetch_checkpoint_context``); both the runtime and
    the API test pass the same context so the incremental window renders identically.

    * ``{{end_ts}}`` is the run time, identical to ``{{now}}`` (same clock, ISO UTC ``...Z``).
    * ``{{start_ts}}`` is the incremental window start: the checkpoint ``last_timestamp`` (or
      ``last_timestamp_ms``) in ISO UTC form. When there is no usable checkpoint timestamp yet (first run, cursor-only
      checkpoint, unparseable value) it falls back to ``end_ts`` minus 24 hours, the same default window as
      ``{{start_ms}}``, so the request never carries the literal placeholder or an open-ended lower bound.
    """

    now = _utc_now_seconds()
    now_ms = int(now * 1000)
    window_ms = _DEFAULT_TIME_WINDOW_MS
    now_iso = datetime.fromtimestamp(now, timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    ctx = checkpoint if isinstance(checkpoint, dict) else {}
    start_ts = _canonical_start_ts(ctx.get("last_timestamp")) or _canonical_start_ts(ctx.get("last_timestamp_ms"))
    if start_ts is None:
        start_ts = _iso_z_from_seconds((now_ms - window_ms) / 1000)
    return {
        "{{now}}": now_iso,
        "{{runtime.now_ms}}": str(now_ms),
        "{{runtime.now_iso}}": now_iso,
        "{{start_ms}}": str(now_ms - window_ms),
        "{{end_ms}}": str(now_ms),
        "{{end_ts}}": now_iso,
        # Last: replacements apply in order, so a checkpoint-derived value is never re-rendered.
        "{{start_ts}}": start_ts,
    }


def render_runtime_request_templates(
    value: Any,
    checkpoint: dict[str, Any] | None,
    time_replacements: dict[str, str],
) -> Any:
    """Render time placeholders, then ``{{checkpoint.*}}``, in the same order as the API test."""

    return render_runtime_checkpoint_templates(apply_api_test_templates(value, time_replacements), checkpoint)


def api_test_checkpoint_replacements(checkpoint: dict[str, Any] | None) -> dict[str, str]:
    """Placeholders for onboarding API test / JSON preview incremental request tests."""

    replacements = time_template_replacements(checkpoint)

    if checkpoint:
        ck = checkpoint

        def _pick(*keys: str) -> Any:
            for key in keys:
                if key in ck and ck[key] is not None:
                    return ck[key]
            return None

        ck_val = _pick("cursor", "value", "last_seen")
        if ck_val is None:
            ck_val = "0"

        last_timestamp = _pick("last_timestamp", "last_timestamp_ms")
        if last_timestamp is None:
            last_timestamp = ck_val

        last_timestamp_ms = _pick("last_timestamp_ms", "last_timestamp")
        if last_timestamp_ms is None:
            last_timestamp_ms = last_timestamp

        last_event_id = _pick("last_event_id", "last_id", "event_id")
        if last_event_id is None:
            last_event_id = ""

        next_cursor = _pick("next_cursor", "cursor")
        if next_cursor is None:
            next_cursor = ck_val

        replacements.update(
            {
                "{{checkpoint}}": str(ck_val),
                "{{checkpoint.last_timestamp}}": str(last_timestamp),
                "{{checkpoint.last_timestamp_ms}}": str(last_timestamp_ms),
                "{{checkpoint.last_event_id}}": str(last_event_id),
                "{{checkpoint.next_cursor}}": str(next_cursor),
            }
        )

    return replacements


def apply_api_test_templates(value: Any, repl: dict[str, str]) -> Any:
    if isinstance(value, str):
        out = value
        for k, v in repl.items():
            out = out.replace(k, v)
        return out
    if isinstance(value, dict):
        return {str(k): apply_api_test_templates(v, repl) for k, v in value.items()}
    if isinstance(value, list):
        return [apply_api_test_templates(v, repl) for v in value]
    return value


def _lookup(cfg: dict[str, Any], keys: list[str], default: Any = None) -> Any:
    for key in keys:
        if key in cfg and cfg[key] is not None:
            return cfg[key]
    return default


def join_base_url_endpoint(base_url: str, endpoint: str) -> str:
    base = base_url.rstrip("/")
    ep = endpoint if endpoint.startswith("/") else f"/{endpoint}"
    return f"{base}{ep}"


def normalize_http_method(raw: Any, *, default: str = "GET") -> str:
    m = str(raw or default).strip().upper()
    return m if m else default.upper()


def merge_shared_header_layers(*parts: dict[str, Any] | None) -> dict[str, str]:
    """Later layers override earlier keys (connector → stream)."""

    out: dict[str, str] = {}
    for part in parts:
        if not part:
            continue
        for k, v in part.items():
            out[str(k)] = str(v)
    return out


@dataclass(frozen=True)
class SharedHttpRequestPlan:
    """Normalized outbound HTTP resource identity before connector auth is applied."""

    method: str
    endpoint: str
    url: str
    params: dict[str, Any]
    connector_headers: dict[str, str]
    stream_headers: dict[str, str]
    normalized_json_body: Any | None


def build_shared_http_request(
    *,
    source_config: dict[str, Any],
    stream_config: dict[str, Any],
    mode: Literal["runtime", "api_test"],
    checkpoint_value: dict[str, Any] | None = None,
    api_test_checkpoint: dict[str, Any] | None = None,
    invalid_json_body_exc_factory: Any | None = None,
) -> SharedHttpRequestPlan:
    """Build URL, params, header layers, and JSON body used by poller and HTTP API test."""

    base_url = str(_lookup(source_config, ["base_url", "host"], "")).strip()
    endpoint_raw = str(_lookup(stream_config, ["endpoint"], "") or _lookup(stream_config, ["endpoint_path"], "")).strip()
    ep = endpoint_raw if endpoint_raw.startswith("/") else f"/{endpoint_raw}"

    method = normalize_http_method(_lookup(stream_config, ["method"], _lookup(stream_config, ["http_method"], "GET")))

    api_test_ctx: dict[str, Any] | None = None
    repl: dict[str, str] | None = None
    if mode == "runtime":
        runtime_checkpoint_ctx = build_runtime_checkpoint_template_context(
            checkpoint_value,
            stream_config,
        )
        runtime_time_repl = time_template_replacements(runtime_checkpoint_ctx)
        ep_rendered = render_runtime_request_templates(ep, runtime_checkpoint_ctx, runtime_time_repl)
    else:
        runtime_checkpoint_ctx = None
        runtime_time_repl = {}
        # Resolve checkpoint aliases (e.g. from ``last_success_event``) exactly like the runtime so the
        # API test substitutes the same ``{{checkpoint.*}}`` representation the poller will send.
        api_test_ctx = (
            build_runtime_checkpoint_template_context(api_test_checkpoint, stream_config)
            if api_test_checkpoint
            else api_test_checkpoint
        )
        repl = api_test_checkpoint_replacements(api_test_ctx)
        # Same renderer as the runtime path (time placeholders, then ``{{checkpoint.*}}``); ``repl`` carries the
        # time_template_replacements values, so the path matches the params/body rendered below.
        ep_rendered = render_runtime_request_templates(ep, api_test_ctx, repl)

    request_url = join_base_url_endpoint(base_url, ep_rendered)

    common_src = dict(_lookup(source_config, ["headers", "common_headers"], {}) or {})
    stream_hdr = dict(_lookup(stream_config, ["headers"], {}) or {})
    params_raw = dict(_lookup(stream_config, ["params", "query_params"], {}) or {})
    params_raw = drop_placeholder_pagination_params(stream_config, dict(params_raw))

    if mode == "runtime":
        connector_headers = (
            render_runtime_request_templates(dict(common_src), runtime_checkpoint_ctx, runtime_time_repl)
            if common_src
            else {}
        )
        params = dict(
            render_runtime_request_templates(dict(params_raw), runtime_checkpoint_ctx, runtime_time_repl)
            if params_raw
            else {}
        )
    else:
        connector_headers = {str(k): str(v) for k, v in apply_api_test_templates(dict(common_src), repl).items()} if common_src else {}
        params = dict(apply_api_test_templates(dict(params_raw), repl)) if params_raw else {}

    raw_body = _lookup(stream_config, ["body", "request_body"], None)

    def _raise_bad_json(exc: json.JSONDecodeError) -> None:
        if invalid_json_body_exc_factory is not None:
            invalid_json_body_exc_factory(exc)

    normalized_body: Any | None
    if raw_body is None:
        normalized_body = None
    elif mode == "runtime":
        normalized_body = render_runtime_request_templates(raw_body, runtime_checkpoint_ctx, runtime_time_repl)
    else:
        body = raw_body
        repl_eff = repl or {}
        if isinstance(body, str) and body.strip():
            templated = apply_api_test_templates(body.strip(), repl_eff)
            try:
                body = json.loads(templated)
            except json.JSONDecodeError as exc:
                _raise_bad_json(exc)
                raise exc
        elif isinstance(body, dict):
            body = apply_api_test_templates(body, repl_eff)
        elif body is not None:
            body = apply_api_test_templates(body, repl_eff)
        else:
            body = None
        if isinstance(body, str):
            body = unwrap_json_string_body(body)
        normalized_body = body

    stream_headers_rendered: dict[str, str]
    if mode == "runtime":
        stream_headers_rendered = (
            {
                str(k): str(v)
                for k, v in render_runtime_request_templates(
                    dict(stream_hdr), runtime_checkpoint_ctx, runtime_time_repl
                ).items()
            }
            if stream_hdr
            else {}
        )
    else:
        stream_headers_rendered = (
            {str(k): str(v) for k, v in apply_api_test_templates(dict(stream_hdr), repl or {}).items()} if stream_hdr else {}
        )

    return SharedHttpRequestPlan(
        method=method,
        endpoint=endpoint_raw or ep.lstrip("/"),
        url=request_url,
        params=params,
        connector_headers=connector_headers,
        stream_headers=stream_headers_rendered,
        normalized_json_body=normalized_body,
    )


def body_preview_for_snapshot(body_kwargs: dict[str, Any]) -> str:
    """Short masked preview string aligned with runtime error detail."""

    preview_val = outbound_body_for_debug(body_kwargs) if body_kwargs else None
    if preview_val is None:
        return ""
    try:
        return json.dumps(mask_secrets(preview_val), ensure_ascii=False)[:8000]
    except Exception:
        return str(preview_val)[:8000]


def build_outbound_debug_detail(
    *,
    response: httpx.Response,
    body_kwargs: dict[str, Any],
) -> dict[str, Any]:
    """Stable outbound debug dict for SOURCE_HTTP_ERROR (masks secrets)."""

    req = response.request
    u = httpx.URL(str(req.url))
    try:
        qraw = {str(k): str(v) for k, v in u.params.multi_items()}
    except Exception:
        qraw = {str(k): str(v) for k, v in dict(u.params).items()}
    qdict = mask_secrets(qraw)
    body_preview = body_preview_for_snapshot(body_kwargs)
    full = str(u)
    hdrs = {str(k): str(v) for k, v in req.headers.multi_items()}
    outbound_headers_masked = mask_http_headers(hdrs)

    def _preview_response_body(resp: httpx.Response) -> str:
        try:
            return json.dumps(mask_secrets(resp.json()), ensure_ascii=False)[:8000]
        except Exception:
            raw = resp.text or ""
            return raw[:8000]

    return {
        "error_code": "SOURCE_HTTP_ERROR",
        "outbound_method": req.method,
        "outbound_url": full.split("?")[0],
        "outbound_final_url": full,
        "outbound_query_params": qdict,
        "outbound_headers_masked": outbound_headers_masked,
        "has_json_body": bool(body_kwargs),
        "body_preview": body_preview,
        "response_status": int(response.status_code),
        "response_body": _preview_response_body(response),
    }


__all__ = [
    "SharedHttpRequestPlan",
    "api_test_checkpoint_replacements",
    "apply_api_test_templates",
    "body_preview_for_snapshot",
    "build_outbound_debug_detail",
    "build_shared_http_request",
    "build_runtime_checkpoint_template_context",
    "checkpoint_timestamp_ms",
    "join_base_url_endpoint",
    "merge_shared_header_layers",
    "normalize_checkpoint_timestamp_ms",
    "normalize_http_method",
    "render_runtime_checkpoint_templates",
    "render_runtime_request_templates",
    "time_template_replacements",
]
