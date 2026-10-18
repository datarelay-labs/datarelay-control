"""Resolve formatter_config: route override > destination formatter > flat keys."""

from __future__ import annotations

from typing import Any

from app.formatters.message_prefix import route_formatter_without_prefix_keys

_FORMATTER_TOP_KEYS = frozenset(
    {
        "message_format",
        "syslog_wire_mode",
        "syslog",
        "facility",
        "severity",
        "hostname",
        "app_name",
        "tag",
    }
)


def resolve_formatter_config(
    destination_config: dict[str, Any],
    route_formatter_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Pick formatter settings for Preview parity with runtime delivery.

    Priority:
    1. Non-empty ``route_formatter_config`` (after stripping message-prefix keys) → use as full formatter_config dict.
    2. Else ``destination_config["formatter_config"]`` if present.
    3. Else flat formatter-related keys on ``destination_config``.

    Empty route dict ``{}`` does not override — falls through to destination.

    ``message_prefix_enabled`` / ``message_prefix_template`` on the route are delivery-only; they are not part of
    the resolved syslog/JSON formatter profile and are ignored here.
    """

    if route_formatter_config is not None and not isinstance(route_formatter_config, dict):
        raise ValueError("route formatter_config must be an object")

    effective_route = route_formatter_without_prefix_keys(route_formatter_config)
    if effective_route is not None and effective_route:
        return dict(effective_route)

    explicit = destination_config.get("formatter_config")
    if explicit is not None:
        if not isinstance(explicit, dict):
            raise ValueError("destination config formatter_config must be an object")
        return explicit

    return {k: destination_config[k] for k in _FORMATTER_TOP_KEYS if k in destination_config}
