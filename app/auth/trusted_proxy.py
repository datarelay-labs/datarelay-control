"""Parse explicitly trusted proxy socket peers for Uvicorn.

Forwarded/X-Forwarded-For is authoritative only when its immediate socket peer
matches this configured set. A blank setting or '*' must never widen that set.
"""
from __future__ import annotations

from datarelay_onprem_security import canonical_network


def trusted_proxy_peer_networks(raw: str | None) -> list[str]:
    """Return canonical, non-wildcard IP/CIDRs or raise before starting API."""
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("trusted proxy peers must be explicit IP/CIDR values")
    parts = [s.strip() for s in raw.split(",")]
    if len(parts) > 32 or any(not p for p in parts):
        raise ValueError("trusted proxy peers contain an empty or oversized list")
    try:
        peers = [canonical_network(value) for value in parts]
    except ValueError as exc:
        raise ValueError("trusted proxy peer is not a safe IP/CIDR") from exc
    if len(set(peers)) != len(peers):
        raise ValueError("duplicate trusted proxy peer CIDR")
    return peers
