"""Fail-closed trusted-proxy sources; no running listener or host change."""
from __future__ import annotations

import pytest

from app.auth.trusted_proxy import trusted_proxy_peer_networks


@pytest.mark.parametrize("raw", [
    None, "", "  ", "*", "0.0.0.0/0", "::/0", "::ffff:0:0/96",
    "127.0.0.1,*", "127.0.0.1,", ",::1", "localhost",
    "127.0.0.1,127.0.0.1/32", "2001:db8::/0", "not-an-ip",
])
def test_trusted_proxy_peers_reject_wildcard_missing_or_ambiguous_network(raw) -> None:
    with pytest.raises(ValueError):
        trusted_proxy_peer_networks(raw)


def test_explicit_trusted_proxy_ip_and_cidr_are_canonical() -> None:
    assert trusted_proxy_peer_networks(
        "127.0.0.1, ::1, 192.0.2.7, 2001:db8:abcd::/64",
    ) == [
        "127.0.0.1/32", "::1/128", "192.0.2.7/32", "2001:db8:abcd::/64",
    ]


def test_mapped_ipv4_proxy_peer_normalizes_without_wildcard() -> None:
    assert trusted_proxy_peer_networks("::ffff:192.0.2.7") == ["192.0.2.7/32"]


def test_bounded_trusted_peers_rejects_list_explosion() -> None:
    raw = ",".join(f"198.51.100.{i}" for i in range(33))
    with pytest.raises(ValueError, match="oversized"):
        trusted_proxy_peer_networks(raw)


def test_actual_uvicorn_middleware_respects_canonical_proxy_peers() -> None:
    import asyncio

    from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

    async def capture_peer(peer: str, xff: str) -> str:
        seen: dict[str, str] = {}

        async def final_app(scope, receive, send) -> None:
            seen["client"] = scope["client"][0]
            await send({"type": "http.response.start", "status": 204, "headers": []})
            await send({"type": "http.response.body", "body": b""})

        proxy = ProxyHeadersMiddleware(
            final_app,
            trusted_hosts=trusted_proxy_peer_networks("127.0.0.1, ::1"),
        )

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message) -> None:
            pass

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "method": "GET",
            "scheme": "http",
            "path": "/health",
            "headers": [(b"x-forwarded-for", xff.encode("ascii"))],
            "client": (peer, 50001),
            "server": ("testserver", 80),
        }
        await proxy(scope, receive, send)
        return seen["client"]

    assert asyncio.run(capture_peer("203.0.113.9", "198.51.100.7")) == "203.0.113.9"
    assert asyncio.run(capture_peer("127.0.0.1", "198.51.100.7")) == "198.51.100.7"
