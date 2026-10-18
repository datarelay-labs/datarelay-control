"""Runtime-only UDP datagram pacing configuration at the destination boundary.

The StreamRunner selects a Route and forwards its effective config without
embedding destination-type branches in the central delivery orchestrator.
"""

from __future__ import annotations

from typing import Any


def udp_paced_destination_config(
    destination_type: str,
    config: dict[str, Any],
    rate_limit: dict[str, Any],
    route_key: int,
) -> dict[str, Any]:
    """Carry a UDP event-rate hint to the existing adapter, without persisting it.

    Legacy max_events/per_seconds continues to use batch admission. UI
    per_second/burst_size instead paces individual SYSLOG_UDP datagrams.
    """
    result = dict(config)
    result.pop("_route_udp_event_rate", None)
    if destination_type == "SYSLOG_UDP" and rate_limit.get("enabled") is not False:
        if "per_second" in rate_limit or "burst_size" in rate_limit:
            result["_route_udp_event_rate"] = {
                "route_id": route_key,
                "per_second": rate_limit.get("per_second"),
                "burst_size": rate_limit.get("burst_size"),
            }
    return result
