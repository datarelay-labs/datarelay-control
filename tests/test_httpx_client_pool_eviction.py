"""HttpxClientPool must not close clients that callers may still be using."""

from __future__ import annotations

import httpx

from app.delivery.connection_pool import HttpxClientPool


def test_lru_eviction_does_not_close_previously_returned_client() -> None:
    pool = HttpxClientPool(max_clients=2)
    timeout = httpx.Timeout(5.0)

    first = pool.get("a", timeout=timeout)
    second = pool.get("b", timeout=timeout)
    assert pool.size() == 2

    # Force eviction of "a" (LRU) when inserting "c".
    third = pool.get("c", timeout=timeout)
    assert pool.size() == 2
    assert third is not first

    # Previously handed-out client must remain usable (not closed by eviction).
    assert getattr(first, "is_closed", False) is False
    assert getattr(second, "is_closed", False) is False

    first.close()
    second.close()
    third.close()


def test_invalidate_still_closes_pooled_client() -> None:
    pool = HttpxClientPool(max_clients=4)
    timeout = httpx.Timeout(5.0)
    client = pool.get("x", timeout=timeout)
    pool.invalidate("x")
    assert getattr(client, "is_closed", False) is True
    assert pool.size() == 0
