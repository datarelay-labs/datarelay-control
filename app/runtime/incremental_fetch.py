"""Connector-common incremental fetch framework.

Separates **fetch checkpoint** (how far we have successfully queried) from
**delivery checkpoint** (how far we have successfully delivered).

Generic storage keys (no connector-specific names):
- ``incremental_fetch_watermark`` — timestamp / ordering watermark for fetch
- ``connector_cursor`` — opaque cursor token for cursor-based APIs
- ``delivery_checkpoint`` — nested delivery state (includes ``last_success_event``)

When ``config_json.incremental_fetch`` is absent, the runtime auto-maps the
legacy Record Selection UI checkpoint (``config_json.checkpoint.cursor_path`` /
mode) into an effective framework config. Streams with no checkpoint field keep
legacy behaviour: a single checkpoint updated only after successful delivery.
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from app.parsers.jsonpath_parser import find_values

IncrementalStrategy = Literal[
    "cursor",
    "timestamp_watermark",
    "closed_window_watermark",
    "custom",
]

DEFAULT_STABILITY_LAG_SECONDS = 120
DEFAULT_INITIAL_LOOKBACK_SECONDS = 86_400

_FETCH_WATERMARK_KEY = "incremental_fetch_watermark"
_CONNECTOR_CURSOR_KEY = "connector_cursor"
_DELIVERY_CHECKPOINT_KEY = "delivery_checkpoint"
_LAST_FETCH_AT_KEY = "last_fetch_at"
_LAST_DELIVERY_AT_KEY = "last_delivery_at"
_FETCH_WINDOW_KEY = "fetch_window"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _parse_iso(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc)
    text = str(value).strip()
    if not text:
        return None
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        return datetime.fromisoformat(text).astimezone(timezone.utc)
    except ValueError:
        return None


def _first_scalar(value: Any) -> Any | None:
    if value is None or isinstance(value, bool | int | float | str):
        return value
    if isinstance(value, list):
        for item in value:
            picked = _first_scalar(item)
            if picked is not None:
                return picked
    return None


def _normalize_jsonpath(path: Any) -> str:
    p = str(path or "").strip()
    if not p:
        return ""
    if p.startswith("$"):
        return p
    if p.startswith("."):
        return f"${p}"
    return f"$.{p}"


_UPDATE_FIELD_NAMES = frozenset(
    {
        "updated_at",
        "update_time",
        "updatedat",
        "updatetime",
        "modified_at",
        "modifiedat",
        "last_modified",
        "lastmodified",
        "lastmodifiedtime",
        "last_modified_time",
        "write_time",
        "writetime",
        "created_at",
        "creationtime",
        "createdtime",
        "createdat",
        "create_time",
        "createtime",
        "timestamp",
        "event_time",
        "eventtime",
        "event_timestamp",
        "eventtimestamp",
        "time",
        "datetime",
        "date_time",
    }
)

_CURSOR_FIELD_NAMES = frozenset(
    {
        "cursor",
        "next_cursor",
        "nextcursor",
        "page_token",
        "pagetoken",
        "next_page_token",
        "nextpagetoken",
        "continuation_token",
        "continuationtoken",
        "nexttoken",
        "next_token",
        "id",
        "event_id",
        "eventid",
        "record_id",
        "recordid",
        "offset",
    }
)


def _leaf_field_name(path: str) -> str:
    trimmed = str(path or "").strip()
    if not trimmed:
        return ""
    no_prefix = trimmed[1:] if trimmed.startswith("$") else trimmed
    no_prefix = no_prefix.lstrip(".")
    parts = [p for p in no_prefix.split(".") if p]
    last = parts[-1] if parts else no_prefix
    return re.sub(r"\[\d+\]|\[\*\]", "", last).strip().lower()


def is_timestamp_checkpoint_field(name_or_path: str) -> bool:
    """Heuristic matching Record Selection timestamp-style checkpoint fields."""

    leaf = _leaf_field_name(name_or_path)
    if not leaf:
        return False
    if leaf in _UPDATE_FIELD_NAMES:
        return True
    return (
        leaf.endswith("_at")
        or leaf.endswith("_time")
        or "timestamp" in leaf
        or "modified" in leaf
        or leaf.endswith("time")
    )


def is_cursor_checkpoint_field(name_or_path: str) -> bool:
    """Heuristic matching cursor / id / next-token style checkpoint fields."""

    leaf = _leaf_field_name(name_or_path)
    if not leaf:
        return False
    if leaf in _CURSOR_FIELD_NAMES:
        return True
    return (
        "cursor" in leaf
        or "pagetoken" in leaf
        or "page_token" in leaf
        or leaf.endswith("_id")
        or leaf == "id"
        or leaf.endswith("_token")
        or leaf.endswith("token")
    )


def _to_event_relative_field_path(path: Any, event_array_path: Any = None) -> str:
    """Convert persisted ``checkpoint.cursor_path`` (may include ``[*]``) to event-relative JSONPath."""

    raw = _normalize_jsonpath(path)
    if not raw:
        return ""

    arr = _normalize_jsonpath(event_array_path) if event_array_path is not None else ""
    prefixes: list[str] = []
    if arr and arr != "$":
        prefixes.extend([f"{arr}[*]", f"{arr}[0]", arr])
    prefixes.extend(["$[*]", "$[0]"])

    for prefix in prefixes:
        if raw == prefix:
            return "$"
        if raw.startswith(f"{prefix}."):
            rest = raw[len(prefix) + 1 :]
            return rest if rest.startswith("$") else f"$.{rest}"

    # Generic: strip any ``...[*].`` or ``...[0].`` segment once.
    stripped = re.sub(r"^\$[^.]*(?:\[\d+\]|\[\*])\.", "$.", raw)
    if stripped != raw:
        return stripped
    return raw


def _read_legacy_checkpoint_field_path(cfg: dict[str, Any]) -> str:
    checkpoint_cfg = cfg.get("checkpoint")
    if not isinstance(checkpoint_cfg, dict):
        return ""
    event_array_path = cfg.get("event_array_path")
    for key in ("cursor_path", "path", "field_path"):
        path = checkpoint_cfg.get(key)
        if str(path or "").strip():
            return _to_event_relative_field_path(path, event_array_path)
    cursor_paths = checkpoint_cfg.get("cursor_paths")
    if isinstance(cursor_paths, list):
        for path in cursor_paths:
            if str(path or "").strip():
                return _to_event_relative_field_path(path, event_array_path)
    return ""


def _read_legacy_tie_breaker_field(cfg: dict[str, Any]) -> str | None:
    checkpoint_cfg = cfg.get("checkpoint")
    if not isinstance(checkpoint_cfg, dict):
        return None
    event_array_path = cfg.get("event_array_path")
    secondary = checkpoint_cfg.get("secondary_cursor_path")
    if str(secondary or "").strip():
        return _to_event_relative_field_path(secondary, event_array_path) or None
    cursor_paths = checkpoint_cfg.get("cursor_paths")
    if isinstance(cursor_paths, list) and len(cursor_paths) > 1 and str(cursor_paths[1] or "").strip():
        return _to_event_relative_field_path(cursor_paths[1], event_array_path) or None
    return None


def infer_strategy_from_legacy_ui_checkpoint(
    checkpoint_cfg: dict[str, Any] | None,
    field_path: str,
) -> IncrementalStrategy | None:
    """Map Record Selection checkpoint mode/field → incremental_fetch strategy.

    Rules (Product):
    - timestamp-style field → ``closed_window_watermark`` (stability lag default 120)
    - cursor / id / next-style field → ``cursor``
    - else fall back to ``checkpoint.mode`` labels from the legacy UI
    """

    path = str(field_path or "").strip()
    if not path:
        return None

    if is_cursor_checkpoint_field(path):
        return "cursor"
    if is_timestamp_checkpoint_field(path):
        return "closed_window_watermark"

    mode = ""
    if isinstance(checkpoint_cfg, dict):
        mode = str(checkpoint_cfg.get("mode") or "").strip().lower()
    if not mode or mode in ("none", "n/a", "off", "disabled"):
        return None
    if "timestamp" in mode or mode in ("time", "datetime"):
        return "closed_window_watermark"
    if "cursor" in mode or "event id" in mode or "event_id" in mode or mode == "offset":
        return "cursor"
    return None


def _resolve_field(event: dict[str, Any], path: str) -> Any | None:
    normalized = _normalize_jsonpath(path)
    if not normalized:
        return None
    candidates = [normalized]
    relative = _to_event_relative_field_path(normalized)
    if relative and relative not in candidates:
        candidates.append(relative)
    for candidate in candidates:
        try:
            matches = find_values(event, candidate)
        except Exception:
            continue
        for match in matches:
            picked = _first_scalar(match)
            if picked is not None:
                return picked
    return None


def _max_scalar(a: Any, b: Any) -> Any:
    if a is None:
        return b
    if b is None:
        return a
    try:
        return a if a >= b else b
    except TypeError:
        return str(a) if str(a) >= str(b) else str(b)


@dataclass(frozen=True)
class IncrementalFetchConfig:
    strategy: IncrementalStrategy | None
    watermark_field: str | None
    cursor_field: str | None
    tie_breaker_field: str | None
    stability_lag_seconds: int
    initial_lookback_seconds: int
    framework_enabled: bool


@dataclass(frozen=True)
class FetchWindow:
    lower_bound: str
    upper_bound: str
    lower_bound_ms: int | None = None
    upper_bound_ms: int | None = None


@dataclass(frozen=True)
class IncrementalDisplayState:
    strategy: str
    watermark_field: str | None
    cursor_field: str | None
    tie_breaker_field: str | None
    stability_lag_seconds: int | None
    fetch_watermark: Any
    connector_cursor: Any
    delivery_checkpoint: dict[str, Any] | None
    last_fetch_at: str | None
    last_delivery_at: str | None
    fetch_window: FetchWindow | None



def parse_incremental_fetch_config(stream_config: dict[str, Any] | None) -> IncrementalFetchConfig:
    """Parse effective incremental fetch config.

    Priority:
    1. Explicit ``config_json.incremental_fetch.strategy``
    2. ``config_json.connector_incremental.strategy``
    3. Auto-map from legacy Record Selection UI ``config_json.checkpoint``
       (cursor_path / mode / field-name heuristics)
    """

    cfg = stream_config if isinstance(stream_config, dict) else {}
    raw = cfg.get("incremental_fetch")
    blob: dict[str, Any] = raw if isinstance(raw, dict) else {}
    explicit_incremental = isinstance(raw, dict) and bool(
        str(blob.get("strategy") or "").strip()
        or str(blob.get("watermark_field") or "").strip()
        or str(blob.get("cursor_field") or "").strip()
    )

    strategy_raw = blob.get("strategy")
    strategy: IncrementalStrategy | None = None
    if isinstance(strategy_raw, str) and strategy_raw.strip():
        candidate = strategy_raw.strip().lower()
        if candidate in ("cursor", "timestamp_watermark", "closed_window_watermark", "custom"):
            strategy = candidate  # type: ignore[assignment]

    if strategy is None:
        connector_inc = cfg.get("connector_incremental")
        if isinstance(connector_inc, dict):
            declared = connector_inc.get("strategy")
            if isinstance(declared, str) and declared.strip():
                candidate = declared.strip().lower()
                if candidate in ("cursor", "timestamp_watermark", "closed_window_watermark", "custom"):
                    strategy = candidate  # type: ignore[assignment]

    watermark_field = _normalize_jsonpath(blob.get("watermark_field")) or None
    cursor_field = _normalize_jsonpath(blob.get("cursor_field")) or None
    tie_breaker_field = _normalize_jsonpath(blob.get("tie_breaker_field")) or None
    if watermark_field:
        watermark_field = _to_event_relative_field_path(watermark_field, cfg.get("event_array_path")) or watermark_field
    if cursor_field:
        cursor_field = _to_event_relative_field_path(cursor_field, cfg.get("event_array_path")) or cursor_field
    if tie_breaker_field:
        tie_breaker_field = (
            _to_event_relative_field_path(tie_breaker_field, cfg.get("event_array_path")) or tie_breaker_field
        )

    legacy_field = _read_legacy_checkpoint_field_path(cfg)
    checkpoint_cfg = cfg.get("checkpoint") if isinstance(cfg.get("checkpoint"), dict) else None

    if strategy is None and not explicit_incremental:
        strategy = infer_strategy_from_legacy_ui_checkpoint(checkpoint_cfg, legacy_field)

    if not watermark_field and not cursor_field and legacy_field:
        if strategy == "cursor":
            cursor_field = legacy_field
        else:
            watermark_field = legacy_field

    if not tie_breaker_field:
        tie_breaker_field = _read_legacy_tie_breaker_field(cfg)

    if not cursor_field:
        cursor_field = watermark_field
    if strategy == "cursor" and not cursor_field and watermark_field:
        cursor_field = watermark_field
    if strategy in ("timestamp_watermark", "closed_window_watermark") and not watermark_field and cursor_field:
        watermark_field = cursor_field

    stability = blob.get("stability_lag_seconds", blob.get("stability_lag"))
    if stability is None:
        connector_inc = cfg.get("connector_incremental")
        if isinstance(connector_inc, dict):
            stability = connector_inc.get("stability_lag_seconds")
    try:
        stability_lag = int(stability) if stability is not None else DEFAULT_STABILITY_LAG_SECONDS
    except (TypeError, ValueError):
        stability_lag = DEFAULT_STABILITY_LAG_SECONDS
    stability_lag = max(0, stability_lag)

    lookback = blob.get("initial_lookback_seconds", blob.get("initial_lookback"))
    try:
        initial_lookback = int(lookback) if lookback is not None else DEFAULT_INITIAL_LOOKBACK_SECONDS
    except (TypeError, ValueError):
        initial_lookback = DEFAULT_INITIAL_LOOKBACK_SECONDS
    initial_lookback = max(0, initial_lookback)

    framework_enabled = strategy is not None and strategy != "custom"
    return IncrementalFetchConfig(
        strategy=strategy,
        watermark_field=watermark_field or None,
        cursor_field=cursor_field or None,
        tie_breaker_field=tie_breaker_field or None,
        stability_lag_seconds=stability_lag,
        initial_lookback_seconds=initial_lookback,
        framework_enabled=framework_enabled,
    )


def _delivery_checkpoint_blob(checkpoint: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(checkpoint, dict):
        return {}
    nested = checkpoint.get(_DELIVERY_CHECKPOINT_KEY)
    if isinstance(nested, dict):
        return dict(nested)
    legacy: dict[str, Any] = {}
    last_event = checkpoint.get("last_success_event")
    if isinstance(last_event, dict):
        legacy["last_success_event"] = copy.deepcopy(last_event)
    for key in ("cursor", "value", "last_seen", "next_cursor", "last_timestamp", "last_timestamp_ms"):
        if key in checkpoint:
            legacy[key] = checkpoint[key]
    return legacy


def build_fetch_window(
    *,
    config: IncrementalFetchConfig,
    checkpoint: dict[str, Any] | None,
    now: datetime | None = None,
) -> FetchWindow | None:
    if config.strategy != "closed_window_watermark":
        return None
    current = now or _utcnow()
    upper = current - timedelta(seconds=config.stability_lag_seconds)
    lower_raw = None
    if isinstance(checkpoint, dict):
        lower_raw = checkpoint.get(_FETCH_WATERMARK_KEY)
        if lower_raw is None:
            lower_raw = checkpoint.get("last_timestamp") or checkpoint.get("last_timestamp_ms")
    lower_dt = _parse_iso(lower_raw)
    if lower_dt is None and lower_raw is not None:
        # last_timestamp_ms is numeric epoch ms; never drop the stored window by treating it as unparseable.
        from app.http.shared_request_builder import checkpoint_timestamp_ms

        lower_ms_raw = checkpoint_timestamp_ms(lower_raw)
        if lower_ms_raw is not None:
            lower_dt = datetime.fromtimestamp(lower_ms_raw / 1000, timezone.utc)
    if lower_dt is None:
        lower_dt = current - timedelta(seconds=config.initial_lookback_seconds)
    if lower_dt > upper:
        lower_dt = upper
    lower_ms = int(lower_dt.timestamp() * 1000)
    upper_ms = int(upper.timestamp() * 1000)
    return FetchWindow(
        lower_bound=_iso_z(lower_dt),
        upper_bound=_iso_z(upper),
        lower_bound_ms=lower_ms,
        upper_bound_ms=upper_ms,
    )


def prepare_fetch_checkpoint_context(
    checkpoint: dict[str, Any] | None,
    stream_config: dict[str, Any] | None,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Build checkpoint dict used for HTTP template substitution at fetch time."""

    config = parse_incremental_fetch_config(stream_config)
    base = copy.deepcopy(checkpoint) if isinstance(checkpoint, dict) else {}

    if not config.framework_enabled:
        from app.http.shared_request_builder import build_runtime_checkpoint_template_context

        return build_runtime_checkpoint_template_context(base, stream_config)

    delivery = _delivery_checkpoint_blob(base)
    fetch_ctx: dict[str, Any] = dict(base)
    fetch_ctx[_DELIVERY_CHECKPOINT_KEY] = delivery

    fetch_watermark = base.get(_FETCH_WATERMARK_KEY)
    connector_cursor = base.get(_CONNECTOR_CURSOR_KEY)
    if fetch_watermark is None and config.strategy in ("timestamp_watermark", "closed_window_watermark"):
        fetch_watermark = base.get("last_timestamp") or base.get("last_timestamp_ms")
    if connector_cursor is None and config.strategy == "cursor":
        connector_cursor = base.get("cursor") or base.get("next_cursor") or base.get("value")

    if fetch_watermark is None and config.strategy in ("timestamp_watermark", "closed_window_watermark"):
        current = now or _utcnow()
        fetch_watermark = _iso_z(current - timedelta(seconds=config.initial_lookback_seconds))

    window = build_fetch_window(config=config, checkpoint=base, now=now)
    if window is not None:
        fetch_ctx[_FETCH_WINDOW_KEY] = {
            "lower_bound": window.lower_bound,
            "upper_bound": window.upper_bound,
            "fetch_window_lower": window.lower_bound,
            "fetch_window_upper": window.upper_bound,
            "fetch_lower_bound": window.lower_bound,
            "fetch_upper_bound": window.upper_bound,
        }
        fetch_ctx["fetch_window_lower"] = window.lower_bound
        fetch_ctx["fetch_window_upper"] = window.upper_bound
        fetch_ctx["fetch_lower_bound"] = window.lower_bound
        fetch_ctx["fetch_upper_bound"] = window.upper_bound
        fetch_ctx["fetch_window_lower_ms"] = window.lower_bound_ms
        fetch_ctx["fetch_window_upper_ms"] = window.upper_bound_ms
        fetch_ctx["stability_lag_seconds"] = int(config.stability_lag_seconds)
        fetch_ctx["stability_lag"] = int(config.stability_lag_seconds)
        if fetch_watermark is None:
            fetch_watermark = window.lower_bound

    if fetch_watermark is not None:
        fetch_ctx[_FETCH_WATERMARK_KEY] = fetch_watermark
        fetch_ctx.setdefault("last_timestamp", fetch_watermark)
        fetch_ctx.setdefault("last_timestamp_ms", fetch_watermark)
    if "last_timestamp_ms" in fetch_ctx:
        # Numeric epoch ms like the API Test; also converts ISO values stored before that rule (read-time only).
        from app.http.shared_request_builder import normalize_checkpoint_timestamp_ms

        fetch_ctx["last_timestamp_ms"] = normalize_checkpoint_timestamp_ms(fetch_ctx["last_timestamp_ms"])
    if connector_cursor is not None:
        fetch_ctx[_CONNECTOR_CURSOR_KEY] = connector_cursor
        fetch_ctx.setdefault("cursor", connector_cursor)
        fetch_ctx.setdefault("next_cursor", connector_cursor)
        fetch_ctx.setdefault("value", connector_cursor)
        fetch_ctx.setdefault("last_seen", connector_cursor)

    return fetch_ctx


def build_incremental_runtime_summary(
    *,
    stream_config: dict[str, Any] | None,
    fetched: int = 0,
    delivered: int = 0,
    duplicates: int = 0,
    replayed: bool = False,
    fetch_window: FetchWindow | None = None,
    checkpoint: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Operator-facing incremental runtime summary (safe defaults; no KeyError)."""

    config = parse_incremental_fetch_config(stream_config)
    ck = checkpoint if isinstance(checkpoint, dict) else {}
    window = fetch_window
    if window is None:
        window_raw = ck.get(_FETCH_WINDOW_KEY)
        if isinstance(window_raw, dict):
            lb = window_raw.get("lower_bound") or window_raw.get("fetch_window_lower") or window_raw.get("fetch_lower_bound")
            ub = window_raw.get("upper_bound") or window_raw.get("fetch_window_upper") or window_raw.get("fetch_upper_bound")
            if lb and ub:
                window = FetchWindow(lower_bound=str(lb), upper_bound=str(ub))
        elif ck.get("fetch_window_lower") and ck.get("fetch_window_upper"):
            window = FetchWindow(
                lower_bound=str(ck["fetch_window_lower"]),
                upper_bound=str(ck["fetch_window_upper"]),
            )

    summary: dict[str, Any] = {
        "strategy": config.strategy,
        "framework_enabled": bool(config.framework_enabled),
        "fetched": int(fetched),
        "delivered": int(delivered),
        "duplicates": int(duplicates),
        "stability_lag_seconds": (
            int(config.stability_lag_seconds) if config.strategy == "closed_window_watermark" else None
        ),
        "stability_lag": (
            int(config.stability_lag_seconds) if config.strategy == "closed_window_watermark" else None
        ),
        "fetch_window_lower": window.lower_bound if window else ck.get("fetch_window_lower"),
        "fetch_window_upper": window.upper_bound if window else ck.get("fetch_window_upper"),
        "fetch_lower_bound": window.lower_bound if window else ck.get("fetch_lower_bound") or ck.get("fetch_window_lower"),
        "fetch_upper_bound": window.upper_bound if window else ck.get("fetch_upper_bound") or ck.get("fetch_window_upper"),
        "replayed": bool(replayed),
    }
    return summary


def _pick_event_order_key(event: dict[str, Any], config: IncrementalFetchConfig) -> tuple[Any, Any]:
    primary_path = config.watermark_field if config.strategy != "cursor" else config.cursor_field
    primary = _resolve_field(event, primary_path or "") if primary_path else None
    tie = _resolve_field(event, config.tie_breaker_field or "") if config.tie_breaker_field else None
    return primary, tie


def _select_latest_event(events: list[dict[str, Any]], config: IncrementalFetchConfig) -> dict[str, Any] | None:
    if not events:
        return None
    best = events[-1]
    best_key = _pick_event_order_key(best, config)
    for event in events:
        if not isinstance(event, dict):
            continue
        key = _pick_event_order_key(event, config)
        if key[0] is None:
            continue
        if best_key[0] is None:
            best, best_key = event, key
            continue
        if key[0] > best_key[0]:
            best, best_key = event, key
        elif key[0] == best_key[0] and config.tie_breaker_field:
            if key[1] is not None and (best_key[1] is None or key[1] > best_key[1]):
                best, best_key = event, key
    return best if isinstance(best, dict) else None


def _comparable_checkpoint_value(value: Any) -> tuple[str, float] | None:
    """Normalize a checkpoint/event value for ordering: ("time", epoch seconds) or ("number", value)."""

    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        number = float(value)
    else:
        text = str(value).strip()
        if not text:
            return None
        try:
            number = float(text)
        except ValueError:
            dt = _parse_iso(text)
            return ("time", dt.timestamp()) if dt is not None else None
    if number != number:  # NaN
        return None
    if number >= 100_000_000_000:  # epoch milliseconds
        return ("time", number / 1000)
    if number >= 1_000_000_000:  # epoch seconds
        return ("time", number)
    return ("number", number)


def count_records_newer_than_checkpoint(
    events: list[dict[str, Any]],
    *,
    checkpoint: dict[str, Any] | None,
    stream_config: dict[str, Any] | None,
) -> int | None:
    """Count returned records whose checkpoint field is strictly newer than ``checkpoint``.

    ``checkpoint`` is the context the request was built from (``prepare_fetch_checkpoint_context`` for the
    incremental framework, the raw checkpoint otherwise). Returns ``None`` when the comparison is unknown: no
    checkpoint value, no record exposes a comparable value, or the values are opaque cursors.
    """

    from app.http.shared_request_builder import build_runtime_checkpoint_template_context

    cfg = stream_config if isinstance(stream_config, dict) else {}
    config = parse_incremental_fetch_config(cfg)
    if config.framework_enabled:
        ctx = checkpoint if isinstance(checkpoint, dict) else {}
        if config.strategy == "cursor":
            field_path = config.cursor_field
            ck_raw = ctx.get(_CONNECTOR_CURSOR_KEY) or ctx.get("cursor")
        else:
            field_path = config.watermark_field
            ck_raw = ctx.get(_FETCH_WATERMARK_KEY) or ctx.get("last_timestamp") or ctx.get("last_timestamp_ms")

        def _event_value(event: dict[str, Any]) -> Any:
            return _resolve_field(event, field_path) if field_path else None

    else:
        ctx = build_runtime_checkpoint_template_context(checkpoint, cfg)
        ck_raw = ctx.get("last_timestamp") or ctx.get("last_timestamp_ms")

        def _event_value(event: dict[str, Any]) -> Any:
            return build_runtime_checkpoint_template_context({"last_success_event": event}, cfg).get("last_timestamp")

    ck = _comparable_checkpoint_value(ck_raw)
    if ck is None:
        return None
    compared = 0
    newer = 0
    for event in events:
        if not isinstance(event, dict):
            continue
        value = _comparable_checkpoint_value(_event_value(event))
        if value is None or value[0] != ck[0]:
            continue
        compared += 1
        if value[1] > ck[1]:
            newer += 1
    return newer if compared else None


def build_fetch_checkpoint_update(
    *,
    events: list[dict[str, Any]],
    stream_config: dict[str, Any] | None,
    existing_checkpoint: dict[str, Any] | None,
    fetch_succeeded: bool,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """Return updated checkpoint dict after a successful fetch, or None if unchanged."""

    config = parse_incremental_fetch_config(stream_config)
    if not config.framework_enabled or not fetch_succeeded:
        return None

    base = copy.deepcopy(existing_checkpoint) if isinstance(existing_checkpoint, dict) else {}
    updated = dict(base)
    current = now or _utcnow()
    updated[_LAST_FETCH_AT_KEY] = _iso_z(current)

    window = build_fetch_window(config=config, checkpoint=base, now=current)
    if window is not None:
        updated[_FETCH_WINDOW_KEY] = {
            "lower_bound": window.lower_bound,
            "upper_bound": window.upper_bound,
            "fetch_window_lower": window.lower_bound,
            "fetch_window_upper": window.upper_bound,
            "fetch_lower_bound": window.lower_bound,
            "fetch_upper_bound": window.upper_bound,
        }
        updated["fetch_window_lower"] = window.lower_bound
        updated["fetch_window_upper"] = window.upper_bound
        updated["fetch_lower_bound"] = window.lower_bound
        updated["fetch_upper_bound"] = window.upper_bound
        updated["stability_lag_seconds"] = int(config.stability_lag_seconds)
        updated["stability_lag"] = int(config.stability_lag_seconds)

    if config.strategy == "closed_window_watermark" and window is not None:
        updated[_FETCH_WATERMARK_KEY] = window.upper_bound
        return updated

    latest = _select_latest_event([e for e in events if isinstance(e, dict)], config)
    if latest is None:
        return updated if updated != base else None

    if config.strategy == "cursor":
        cursor_val = _resolve_field(latest, config.cursor_field or "")
        if cursor_val is not None:
            existing = base.get(_CONNECTOR_CURSOR_KEY)
            updated[_CONNECTOR_CURSOR_KEY] = _max_scalar(existing, cursor_val)
    elif config.strategy == "timestamp_watermark":
        wm_val = _resolve_field(latest, config.watermark_field or "")
        if wm_val is not None:
            existing = base.get(_FETCH_WATERMARK_KEY)
            updated[_FETCH_WATERMARK_KEY] = _max_scalar(existing, wm_val)

    return updated


def build_delivery_checkpoint_update(
    *,
    successful_events: list[dict[str, Any]],
    stream_config: dict[str, Any] | None,
    existing_checkpoint: dict[str, Any] | None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Merge delivery checkpoint into full checkpoint value, preserving fetch fields."""

    from app.http.shared_request_builder import build_runtime_checkpoint_template_context

    base = copy.deepcopy(existing_checkpoint) if isinstance(existing_checkpoint, dict) else {}
    config = parse_incremental_fetch_config(stream_config)

    last_ev = copy.deepcopy(successful_events[-1])
    delivery_blob: dict[str, Any] = {"last_success_event": last_ev}
    delivery_blob = build_runtime_checkpoint_template_context(delivery_blob, stream_config)

    merged = dict(base)
    merged[_DELIVERY_CHECKPOINT_KEY] = delivery_blob
    merged["last_success_event"] = last_ev
    merged[_LAST_DELIVERY_AT_KEY] = _iso_z(now or _utcnow())

    if isinstance(last_ev, dict):
        for src, dst in (
            ("s3_key", "last_processed_key"),
            ("s3_last_modified", "last_processed_last_modified"),
            ("s3_etag", "last_processed_etag"),
            ("gdc_db_watermark", "last_processed_db_watermark"),
            ("gdc_db_order_value", "last_processed_db_order"),
        ):
            val = last_ev.get(src)
            if val is not None:
                merged[dst] = val
        rp = last_ev.get("remote_path") or last_ev.get("gdc_remote_path")
        rmt = last_ev.get("remote_mtime") or last_ev.get("gdc_remote_mtime")
        if rp is not None:
            merged["last_processed_key"] = rp
            merged["last_processed_file"] = rp
        if rmt is not None:
            merged["last_processed_last_modified"] = rmt
            merged["last_processed_mtime"] = rmt

    if not config.framework_enabled:
        merged = build_runtime_checkpoint_template_context(merged, stream_config)
    else:
        for key, val in delivery_blob.items():
            if key != "last_success_event":
                merged.setdefault(key, val)
        if "last_timestamp_ms" in merged:
            # A preserved pre-fix ISO value must not be re-written as ISO.
            from app.http.shared_request_builder import normalize_checkpoint_timestamp_ms

            merged["last_timestamp_ms"] = normalize_checkpoint_timestamp_ms(merged["last_timestamp_ms"])

    return merged




def normalize_incremental_fetch_config(payload: dict[str, Any] | None) -> dict[str, Any]:
    """Normalize a partial incremental_fetch save payload for ``config_json`` merge.

    Runtime auto-mapping from legacy Record Selection UI values is handled by
    :func:`parse_incremental_fetch_config` (no DB migration / save required).
    """

    raw = payload if isinstance(payload, dict) else {}
    out: dict[str, Any] = {}
    if "strategy" in raw:
        strategy = raw.get("strategy")
        if strategy is None or str(strategy).strip() == "":
            out["strategy"] = None
        else:
            candidate = str(strategy).strip().lower()
            if candidate in ("cursor", "timestamp_watermark", "closed_window_watermark", "custom"):
                out["strategy"] = candidate
            else:
                out["strategy"] = None
    for key in ("watermark_field", "cursor_field", "tie_breaker_field"):
        if key in raw:
            value = raw.get(key)
            out[key] = _normalize_jsonpath(value) or None
    if "stability_lag_seconds" in raw:
        try:
            out["stability_lag_seconds"] = max(0, int(raw.get("stability_lag_seconds")))
        except (TypeError, ValueError):
            out["stability_lag_seconds"] = DEFAULT_STABILITY_LAG_SECONDS
    if "initial_lookback_seconds" in raw:
        try:
            out["initial_lookback_seconds"] = max(0, int(raw.get("initial_lookback_seconds")))
        except (TypeError, ValueError):
            out["initial_lookback_seconds"] = DEFAULT_INITIAL_LOOKBACK_SECONDS
    return out


def split_checkpoint_for_display(
    checkpoint: dict[str, Any] | None,
    stream_config: dict[str, Any] | None,
) -> dict[str, Any]:
    """Split checkpoint blob into fetch vs delivery views for operator UI."""

    config = parse_incremental_fetch_config(stream_config)
    ck = copy.deepcopy(checkpoint) if isinstance(checkpoint, dict) else {}
    if not config.framework_enabled:
        return {
            "framework_enabled": False,
            "checkpoint_mode": "legacy",
            "legacy_checkpoint": ck or None,
            "fetch_checkpoint": None,
            "delivery_checkpoint": None,
        }

    delivery = _delivery_checkpoint_blob(ck)
    fetch_keys = (
        _FETCH_WATERMARK_KEY,
        _CONNECTOR_CURSOR_KEY,
        _LAST_FETCH_AT_KEY,
        _FETCH_WINDOW_KEY,
        "fetch_window_lower",
        "fetch_window_upper",
        "fetch_lower_bound",
        "fetch_upper_bound",
        "fetch_window_lower_ms",
        "fetch_window_upper_ms",
        "stability_lag_seconds",
        "stability_lag",
        "last_timestamp",
        "last_timestamp_ms",
        "cursor",
        "next_cursor",
        "value",
    )
    fetch_checkpoint = {key: ck[key] for key in fetch_keys if key in ck}
    return {
        "framework_enabled": True,
        "checkpoint_mode": "framework",
        "legacy_checkpoint": None,
        "fetch_checkpoint": fetch_checkpoint or None,
        "delivery_checkpoint": delivery or None,
    }


def get_incremental_display_state(
    checkpoint: dict[str, Any] | None,
    stream_config: dict[str, Any] | None,
) -> IncrementalDisplayState:
    config = parse_incremental_fetch_config(stream_config)
    ck = checkpoint if isinstance(checkpoint, dict) else {}
    delivery = _delivery_checkpoint_blob(ck)
    window_raw = ck.get(_FETCH_WINDOW_KEY)
    window: FetchWindow | None = None
    if isinstance(window_raw, dict):
        lb = window_raw.get("lower_bound")
        ub = window_raw.get("upper_bound")
        if lb and ub:
            window = FetchWindow(lower_bound=str(lb), upper_bound=str(ub))

    strategy_label = config.strategy or "legacy (delivery checkpoint)"
    return IncrementalDisplayState(
        strategy=strategy_label,
        watermark_field=config.watermark_field,
        cursor_field=config.cursor_field,
        tie_breaker_field=config.tie_breaker_field,
        stability_lag_seconds=config.stability_lag_seconds if config.strategy == "closed_window_watermark" else None,
        fetch_watermark=ck.get(_FETCH_WATERMARK_KEY),
        connector_cursor=ck.get(_CONNECTOR_CURSOR_KEY),
        delivery_checkpoint=delivery or None,
        last_fetch_at=str(ck.get(_LAST_FETCH_AT_KEY)) if ck.get(_LAST_FETCH_AT_KEY) else None,
        last_delivery_at=str(ck.get(_LAST_DELIVERY_AT_KEY)) if ck.get(_LAST_DELIVERY_AT_KEY) else None,
        fetch_window=window,
    )


def connector_incremental_strategy_from_template(stream_template: dict[str, Any]) -> dict[str, Any] | None:
    """Map connector YAML ``incremental`` block to ``config_json`` fragments."""

    incremental = stream_template.get("incremental")
    if not isinstance(incremental, dict):
        return None

    mode = str(incremental.get("mode") or "").strip().lower()
    strategy: IncrementalStrategy | None = None
    declared = incremental.get("strategy")
    if isinstance(declared, str) and declared.strip():
        candidate = declared.strip().lower()
        if candidate in ("cursor", "timestamp_watermark", "closed_window_watermark", "custom"):
            strategy = candidate  # type: ignore[assignment]
    if strategy is None:
        if mode in ("cursor", "search_after", "offset"):
            strategy = "cursor"
        elif mode in ("query_param", "timestamp", "time_range", "filter"):
            strategy = "timestamp_watermark"
        elif mode == "closed_window":
            strategy = "closed_window_watermark"

    if strategy is None and not incremental.get("supported"):
        return None

    defaults = stream_template.get("checkpoint_defaults") or {}
    cursor_path = defaults.get("cursor_field_path") if isinstance(defaults, dict) else None

    out: dict[str, Any] = {
        "connector_incremental": {
            "strategy": strategy or "custom",
            "supported": bool(incremental.get("supported", True)),
        }
    }
    if strategy and strategy != "custom":
        inc_fetch: dict[str, Any] = {"strategy": strategy}
        if cursor_path:
            path = _normalize_jsonpath(cursor_path)
            if strategy == "cursor":
                inc_fetch["cursor_field"] = path
            else:
                inc_fetch["watermark_field"] = path
        lag = incremental.get("stability_lag_seconds")
        if lag is not None:
            inc_fetch["stability_lag_seconds"] = lag
        out["incremental_fetch"] = inc_fetch
    return out
