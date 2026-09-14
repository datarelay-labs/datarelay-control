"""Persistent outbound connection pools for delivery and provider HTTP."""

from __future__ import annotations

import threading
from collections import OrderedDict

import httpx

# Bound pool growth when destinations/URLs churn over long-running processes.
_DEFAULT_MAX_CLIENTS = 128


class HttpxClientPool:
    """Thread-safe LRU pool of persistent httpx.Client instances."""

    def __init__(self, *, max_clients: int = _DEFAULT_MAX_CLIENTS) -> None:
        self._lock = threading.Lock()
        self._clients: OrderedDict[str, httpx.Client] = OrderedDict()
        self._max_clients = max(1, int(max_clients))

    def get(self, pool_key: str, *, timeout: httpx.Timeout) -> httpx.Client:
        with self._lock:
            client = self._clients.get(pool_key)
            if (
                client is None
                or getattr(client, "is_closed", False)
                or not isinstance(client, httpx.Client)
            ):
                client = httpx.Client(timeout=timeout)
                self._clients[pool_key] = client
            else:
                self._clients.move_to_end(pool_key)
            while len(self._clients) > self._max_clients:
                _evicted_key, evicted = self._clients.popitem(last=False)
                if evicted is not None and not getattr(evicted, "is_closed", False):
                    evicted.close()
            return client

    def invalidate(self, pool_key: str) -> None:
        with self._lock:
            client = self._clients.pop(pool_key, None)
        if client is not None and not getattr(client, "is_closed", False):
            client.close()

    def size(self) -> int:
        with self._lock:
            return len(self._clients)


_httpx_pool = HttpxClientPool()


def get_httpx_client(*, pool_key: str, timeout: httpx.Timeout) -> httpx.Client:
    return _httpx_pool.get(pool_key, timeout=timeout)


def invalidate_httpx_client(pool_key: str) -> None:
    _httpx_pool.invalidate(pool_key)
