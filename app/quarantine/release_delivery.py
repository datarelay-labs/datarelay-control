"""Deliver stored protected payloads to stream routes (no transform re-run)."""

from __future__ import annotations

import logging
import time
from typing import Any

from sqlalchemy.orm import Session

from app.delivery.syslog_sender import SyslogSender
from app.delivery.webhook_sender import WebhookSender
from app.destinations.adapters.registry import DestinationAdapterRegistry
from app.formatters.message_prefix import build_message_prefix_context
from app.runners.stream_loader import load_stream_context

logger = logging.getLogger(__name__)


def _get(obj: Any, key: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def deliver_protected_events_to_routes(
    db: Session,
    *,
    stream_id: int,
    events: list[dict[str, Any]],
    destination_registry: DestinationAdapterRegistry | None = None,
    route_id: int | None = None,
) -> tuple[bool, str | None]:
    """Fan-out protected events to enabled routes.

    LOG_AND_CONTINUE absorbs *partial* route failures, but if every actionable
    destination send fails the release is unsuccessful (must not become RELEASED).
    """

    ctx = load_stream_context(db, stream_id)
    if ctx is None:
        return False, "stream not found"

    routes = list(_get(ctx, "routes", []) or [])
    if not routes:
        return False, "no routes configured"
    if not events:
        return False, "empty protected payload"

    registry = destination_registry or DestinationAdapterRegistry(
        syslog_sender=SyslogSender(),
        webhook_sender=WebhookSender(),
    )
    stream_name = str(_get(ctx, "name", "") or "")
    saw_actionable = False
    any_send_ok = False
    all_required_ok = True
    last_error: str | None = None

    for route in routes:
        current_route_id = int(_get(route, "id", 0))
        if route_id is not None and current_route_id != int(route_id):
            continue
        if not bool(_get(route, "enabled", True)):
            continue
        destination = _get(route, "destination", {}) or {}
        if not bool(_get(destination, "enabled", True)):
            continue

        saw_actionable = True
        destination_id = int(_get(destination, "id", 0))
        destination_type = str(_get(destination, "destination_type", "")).upper()
        destination_config = dict(_get(destination, "config", {}) or {})
        route_fc = _get(route, "formatter_config_json")
        formatter_override: dict[str, Any] | None = None
        if isinstance(route_fc, dict) and route_fc:
            formatter_override = dict(route_fc)

        prefix_context = build_message_prefix_context(
            stream_name=stream_name,
            stream_id=int(stream_id),
            destination_name=str(_get(destination, "name", "") or ""),
            destination_type=destination_type,
            route_id=current_route_id,
        )
        failure_policy = str(_get(route, "failure_policy", "LOG_AND_CONTINUE")).upper()
        send_started = time.monotonic()
        try:
            registry.get(destination_type).send(
                events,
                destination_config,
                formatter_override=formatter_override,
                prefix_context=prefix_context,
            )
            _ = max(0, int((time.monotonic() - send_started) * 1000))
            any_send_ok = True
        except Exception as exc:
            _ = max(0, int((time.monotonic() - send_started) * 1000))
            last_error = str(exc) or type(exc).__name__
            logger.warning(
                "quarantine_release_route_failed stream_id=%s route_id=%s destination_id=%s error=%s",
                stream_id,
                current_route_id,
                destination_id,
                exc,
            )
            if failure_policy != "LOG_AND_CONTINUE":
                all_required_ok = False

    if not saw_actionable:
        return False, "no actionable routes"
    # LOG_AND_CONTINUE may absorb partial route failures, but total send failure must not
    # report success (would falsely mark quarantine RELEASED).
    if not any_send_ok:
        return False, last_error or "all destination sends failed"
    return all_required_ok, None
