"""Bounded synthetic test delivery for one saved Destination.

This deliberately bypasses Stream/Route scheduling, checkpoints and activation.
Only known synthetic events generated here are eligible for delivery.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

from app.delivery.webhook_payload_mode import resolve_webhook_payload_mode
from app.destinations.adapters.registry import DestinationAdapterRegistry
from app.destinations.models import Destination
from app.formatters.config_resolver import resolve_formatter_config

_MIN_TEST_EVENTS = 1
_MAX_TEST_EVENTS = 100
_SUPPORTED_TYPES = frozenset({"SYSLOG_UDP", "SYSLOG_TCP", "SYSLOG_TLS", "WEBHOOK_POST"})


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_webhook_target(raw_url: Any) -> str:
    value = str(raw_url or "").strip()
    if not value:
        return "Webhook target not configured"
    try:
        parts = urlsplit(value)
    except ValueError:
        return "Webhook target configured"
    host = parts.hostname or ""
    if not parts.scheme or not host:
        return "Webhook target configured"
    port = f":{parts.port}" if parts.port is not None else ""
    path = parts.path or "/"
    return f"{parts.scheme}://{host}{port}{path}"


def _target_summary(destination_type: str, config: dict[str, Any]) -> str:
    if destination_type == "WEBHOOK_POST":
        return _safe_webhook_target(config.get("url"))
    host = str(config.get("host") or "").strip() or "host not configured"
    port = config.get("port")
    port_text = str(port) if port is not None else "514"
    return f"{host}:{port_text}"


def _transport_format(destination_type: str, config: dict[str, Any]) -> str:
    if destination_type == "WEBHOOK_POST":
        return f"WEBHOOK_POST / {resolve_webhook_payload_mode(config)}"
    formatter = resolve_formatter_config(config, None)
    message_format = str(formatter.get("message_format") or "json")
    return f"{destination_type} / {message_format}"


def _synthetic_events(*, count: int, test_delivery_id: str, tested_at: str) -> list[dict[str, Any]]:
    return [
        {
            "event_id": f"datarelay-test-{test_delivery_id}-{index:03d}",
            "timestamp": tested_at,
            "message": "DataRelay bounded test delivery",
            "severity": "INFO",
            "datarelay_test_delivery": True,
            "test_delivery_id": test_delivery_id,
            "sequence": index,
            "total": count,
        }
        for index in range(1, count + 1)
    ]


def run_bounded_destination_test_delivery(
    destination: Destination,
    *,
    count: int,
    registry: DestinationAdapterRegistry | None = None,
) -> dict[str, Any]:
    """Send exactly count logical synthetic events through the existing adapter."""

    if count < _MIN_TEST_EVENTS or count > _MAX_TEST_EVENTS:
        raise ValueError(f"count must be between {_MIN_TEST_EVENTS} and {_MAX_TEST_EVENTS}")
    if not bool(destination.enabled):
        raise ValueError("Destination is disabled")
    destination_type = str(destination.destination_type or "").strip().upper()
    if destination_type not in _SUPPORTED_TYPES:
        raise ValueError(f"Unsupported destination type for bounded test delivery: {destination_type}")

    config = dict(destination.config_json or {})
    tested_at = _iso_now()
    test_delivery_id = uuid4().hex
    events = _synthetic_events(count=count, test_delivery_id=test_delivery_id, tested_at=tested_at)
    adapter = (registry or DestinationAdapterRegistry()).get(destination_type)
    adapter.send(
        events,
        config,
        idempotency_key=f"datarelay-test-{test_delivery_id}",
    )

    return {
        "success": True,
        "destination_id": int(destination.id),
        "destination_name": str(destination.name or f"Destination #{destination.id}"),
        "destination_type": destination_type,
        "target": _target_summary(destination_type, config),
        "transport_format": _transport_format(destination_type, config),
        "logical_event_count": count,
        "test_delivery_id": test_delivery_id,
        "tested_at": tested_at,
        "message": (
            f"Sent {count} synthetic logical test event{'s' if count != 1 else ''}. "
            "Transport retries are not counted as additional logical events."
        ),
    }


__all__ = ["run_bounded_destination_test_delivery"]
