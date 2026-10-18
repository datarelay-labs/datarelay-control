"""Route-level message prefix applied immediately before destination delivery."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any, TypedDict

DEFAULT_MESSAGE_PREFIX_TEMPLATE = "<134> gdc generic-connector event:"

_MESSAGE_PREFIX_KEYS = frozenset({"message_prefix_enabled", "message_prefix_template"})

_PLACEHOLDER_RE = re.compile(r"\{\{\s*([^}]+?)\s*\}\}")


class MessagePrefixResolveContext(TypedDict, total=False):
    """Metadata for template resolution at wire send time (not mutated onto events)."""

    stream_name: str
    stream_id: int
    destination_name: str
    destination_type: str
    route_id: int
    """When set, used as {{timestamp}} instead of generating a new UTC timestamp."""

    timestamp_iso: str


def compact_event_json(event: dict[str, Any]) -> str:
    return json.dumps(event, separators=(",", ":"))


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _safe_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value)


def _event_field(event: dict[str, Any], field: str) -> str:
    raw = event.get(field)
    if raw is None:
        return ""
    return _safe_str(raw)


def resolve_message_prefix_template(
    template: str,
    *,
    event: dict[str, Any],
    context: MessagePrefixResolveContext | None = None,
) -> str:
    """Replace supported ``{{...}}`` placeholders. Missing / unknown → empty string."""

    ctx = context or {}
    ts = str(ctx.get("timestamp_iso") or "").strip() or _utc_now_iso()

    def lookup(key: str) -> str:
        k = key.strip()
        if k == "timestamp":
            return ts
        if k == "stream.name":
            return _safe_str(ctx.get("stream_name", ""))
        if k == "stream.id":
            sid = ctx.get("stream_id")
            return _safe_str(sid) if sid is not None else ""
        if k == "destination.name":
            return _safe_str(ctx.get("destination_name", ""))
        if k == "destination.type":
            return _safe_str(ctx.get("destination_type", ""))
        if k == "route.id":
            rid = ctx.get("route_id")
            return _safe_str(rid) if rid is not None else ""
        if k.startswith("event."):
            field = k[len("event.") :].strip()
            if not field:
                return ""
            return _event_field(event, field)
        return ""

    def repl(match: re.Match[str]) -> str:
        return lookup(match.group(1))

    return _PLACEHOLDER_RE.sub(repl, template)


def build_message_prefix_context(
    *,
    stream_name: str = "",
    stream_id: int | None = None,
    destination_name: str = "",
    destination_type: str = "",
    route_id: int | None = None,
    timestamp_iso: str | None = None,
) -> MessagePrefixResolveContext:
    out: MessagePrefixResolveContext = {
        "stream_name": stream_name,
        "destination_name": destination_name,
        "destination_type": destination_type,
    }
    if stream_id is not None:
        out["stream_id"] = int(stream_id)
    if route_id is not None:
        out["route_id"] = int(route_id)
    if timestamp_iso:
        out["timestamp_iso"] = timestamp_iso
    return out


def route_formatter_without_prefix_keys(route_formatter: dict[str, Any] | None) -> dict[str, Any] | None:
    """Strip prefix keys so ``resolve_formatter_config`` can merge syslog/formatter settings."""

    if route_formatter is None:
        return None
    out = {k: v for k, v in route_formatter.items() if k not in _MESSAGE_PREFIX_KEYS}
    return out if out else None


def effective_message_prefix_enabled(route_formatter: dict[str, Any], destination_type: str) -> bool:
    """Default: enabled for SYSLOG*, disabled for WEBHOOK and unknown types."""

    if "message_prefix_enabled" in route_formatter:
        return bool(route_formatter["message_prefix_enabled"])
    dt = str(destination_type or "").strip().upper()
    if dt.startswith("SYSLOG"):
        return True
    return False


def effective_message_prefix_template(route_formatter: dict[str, Any]) -> str:
    raw = route_formatter.get("message_prefix_template")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    return DEFAULT_MESSAGE_PREFIX_TEMPLATE


def _escape_syslog_prefix_controls(prefix: str) -> str:
    """Keep source-derived prefix data from creating extra Syslog records.

    This is only applied to the *computed prefix*, not the underlying JSON
    event. Escape CR, LF, NUL, C0, DEL and Unicode line separators as visible
    literal code-point sequences before framing.
    """
    return "".join(
        f"\\u{ord(char):04x}"
        if ord(char) < 32 or ord(char) in {127, 0x85, 0x2028, 0x2029}
        else char
        for char in prefix
    )


def format_single_delivery_line(
    event: dict[str, Any],
    route_formatter: dict[str, Any] | None,
    destination_type: str,
    *,
    prefix_context: MessagePrefixResolveContext | None = None,
) -> str:
    """One wire line: compact JSON, or resolved prefix + space + compact JSON."""

    rf = dict(route_formatter or {})
    payload = compact_event_json(event)
    if not effective_message_prefix_enabled(rf, destination_type):
        return payload
    template = effective_message_prefix_template(rf)
    resolved = resolve_message_prefix_template(template, event=event, context=prefix_context)
    if str(destination_type or "").upper().startswith("SYSLOG"):
        resolved = _escape_syslog_prefix_controls(resolved)
    return f"{resolved.rstrip()} {payload}"


def format_delivery_lines_syslog(
    events: list[dict[str, Any]],
    route_formatter: dict[str, Any] | None,
    destination_type: str,
    *,
    prefix_context: MessagePrefixResolveContext | None = None,
) -> list[str]:
    rf = dict(route_formatter or {})
    lines: list[str] = []
    for event in events:
        lines.append(
            format_single_delivery_line(
                event,
                rf,
                destination_type,
                prefix_context=prefix_context,
            )
        )
    return lines
