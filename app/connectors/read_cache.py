"""Process-local TTL cache for lightweight Connectors catalog read endpoints.

Payloads stay in the worker that loaded them. Create/update/delete publish a shared
catalog epoch so other workers in the same host (multi-worker uvicorn) cannot keep
serving pre-mutation rows for the TTL window. The epoch file is scoped by database
identity; override it with ``GDC_CONNECTORS_CACHE_EPOCH_PATH``.
"""

from __future__ import annotations

import hashlib
import logging
import os
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Generic, TypeVar

from sqlalchemy.orm import Session

from app.config import settings
from app.connectors.operations_schemas import ConnectorOperationsSummaryResponse
from app.connectors.schemas import ConnectorRead

logger = logging.getLogger(__name__)

_LIST_CACHE_KEY = "connectors_list"
_OPS_TTL_SEC = 20.0
_LIST_FRESH_TTL_SEC = max(1.0, float(settings.GDC_CONNECTORS_LIST_CACHE_TTL_SEC))
_EPOCH_UNREADABLE = "\x00unreadable"

T = TypeVar("T")


@dataclass
class _CacheEntry(Generic[T]):
    value: T
    mono_ts: float
    epoch: str


@dataclass
class ConnectorsListCacheMetrics:
    cache_hit: bool = False
    cache_miss: bool = False
    stale_fallback: bool = False
    pool_wait_ms: float | None = None
    db_load_ms: float | None = None


_lock = Lock()
_list_fresh: _CacheEntry[list[ConnectorRead]] | None = None
_list_stale: _CacheEntry[list[ConnectorRead]] | None = None
_ops_cache: dict[str, _CacheEntry[ConnectorOperationsSummaryResponse]] = {}


def _epoch_path() -> Path:
    override = os.environ.get("GDC_CONNECTORS_CACHE_EPOCH_PATH", "").strip()
    if override:
        return Path(override)
    digest = hashlib.sha256(str(settings.DATABASE_URL).encode()).hexdigest()[:16]
    runtime_override = os.environ.get("GDC_RUNTIME_DIR", "").strip()
    if runtime_override:
        runtime = Path(runtime_override).expanduser()
    else:
        runtime = Path(tempfile.gettempdir()) / f"gdc-runtime-{os.getuid()}"
    return runtime / f"connectors-catalog-epoch-{digest}"


def _read_shared_epoch() -> str:
    """Return the catalog epoch visible to every worker of this database."""

    try:
        return _epoch_path().read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""
    except OSError:
        logger.warning("%s", {"stage": "connectors_list_cache", "epoch_read_failed": True})
        return _EPOCH_UNREADABLE


def publish_connectors_catalog_epoch() -> None:
    """Advance the shared catalog epoch so other workers drop pre-mutation cache hits."""

    path = _epoch_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        if not os.environ.get("GDC_CONNECTORS_CACHE_EPOCH_PATH", "").strip():
            try:
                os.chmod(path.parent, 0o700)
            except OSError:
                pass
        token = str(time.time_ns())
        tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        tmp.write_text(token + "\n", encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        logger.warning("%s", {"stage": "connectors_list_cache", "epoch_publish_failed": True})


def _store_connectors_list_success(value: list[ConnectorRead], *, observed_epoch: str) -> None:
    """Cache a catalog snapshot only when no mutation landed while it was loading."""

    if observed_epoch != _read_shared_epoch():
        return
    now = time.monotonic()
    entry = _CacheEntry(value=value, mono_ts=now, epoch=observed_epoch)
    with _lock:
        global _list_fresh, _list_stale
        if observed_epoch != _read_shared_epoch():
            return
        _list_fresh = entry
        _list_stale = entry


def _peek_connectors_list_fresh() -> list[ConnectorRead] | None:
    now = time.monotonic()
    with _lock:
        entry = _list_fresh
        if entry is None or (now - entry.mono_ts) >= _LIST_FRESH_TTL_SEC:
            return None
        epoch = entry.epoch
        value = entry.value
    if epoch != _read_shared_epoch():
        return None
    return value


def _peek_connectors_list_stale() -> list[ConnectorRead] | None:
    with _lock:
        if _list_stale is not None:
            return _list_stale.value
    return None


def resolve_connectors_list_catalog(
    db_loader: Callable[[], tuple[list[ConnectorRead], float, float]],
) -> tuple[list[ConnectorRead], ConnectorsListCacheMetrics]:
    """Cache-first connectors list: fresh hit → catalog DB → stale last-success fallback."""

    fresh = _peek_connectors_list_fresh()
    if fresh is not None:
        logger.debug("%s", {"stage": "connectors_list_cache", "cache_hit": True, "fresh": True})
        return fresh, ConnectorsListCacheMetrics(cache_hit=True)

    metrics = ConnectorsListCacheMetrics(cache_miss=True)
    observed_epoch = _read_shared_epoch()
    try:
        value, pool_wait_ms, db_load_ms = db_loader()
        metrics.pool_wait_ms = pool_wait_ms
        metrics.db_load_ms = db_load_ms
        _store_connectors_list_success(value, observed_epoch=observed_epoch)
        logger.debug(
            "%s",
            {
                "stage": "connectors_list_cache",
                "cache_miss": True,
                "count": len(value),
                "db_load_ms": db_load_ms,
            },
        )
        return value, metrics
    except Exception:
        stale = _peek_connectors_list_stale()
        if stale is not None:
            logger.warning(
                "%s",
                {
                    "stage": "connectors_list_cache",
                    "cache_miss": True,
                    "stale_fallback": True,
                    "count": len(stale),
                },
            )
            return stale, ConnectorsListCacheMetrics(cache_miss=True, stale_fallback=True)
        raise


def get_connectors_list_cached(db: Session | None, loader: Callable[[Session], list[ConnectorRead]]) -> list[ConnectorRead]:
    """Return cached connector rows when fresh; otherwise load once and cache (test/helper path)."""

    fresh = _peek_connectors_list_fresh()
    if fresh is not None:
        return fresh

    if db is None:
        raise RuntimeError("connectors list cache miss requires a database session")

    observed_epoch = _read_shared_epoch()
    value = loader(db)
    _store_connectors_list_success(value, observed_epoch=observed_epoch)
    return value


def peek_connectors_list_cache() -> list[ConnectorRead] | None:
    """Return fresh cached connector rows without touching the database."""

    return _peek_connectors_list_fresh()


def peek_connectors_list_stale_cache() -> list[ConnectorRead] | None:
    """Return last successful connector rows regardless of TTL."""

    return _peek_connectors_list_stale()


def get_connectors_operations_summary_cached(
    db: Session,
    *,
    window: str,
    loader: Callable[[Session], ConnectorOperationsSummaryResponse],
) -> ConnectorOperationsSummaryResponse:
    """Return cached operations summary per window when fresh."""

    key = str(window or "1h").strip().lower() or "1h"
    now = time.monotonic()
    with _lock:
        entry = _ops_cache.get(key)
        fresh = entry is not None and (now - entry.mono_ts) < _OPS_TTL_SEC
        cached_epoch = entry.epoch if fresh and entry is not None else None
        cached_value = entry.value if fresh and entry is not None else None
    if cached_value is not None and cached_epoch == _read_shared_epoch():
        logger.debug("%s", {"stage": "connectors_ops_cache", "cache_hit": True, "window": key})
        return cached_value

    observed_epoch = _read_shared_epoch()
    value = loader(db)
    if observed_epoch == _read_shared_epoch():
        with _lock:
            if observed_epoch == _read_shared_epoch():
                _ops_cache[key] = _CacheEntry(value=value, mono_ts=time.monotonic(), epoch=observed_epoch)
    logger.debug(
        "%s",
        {
            "stage": "connectors_ops_cache",
            "cache_miss": True,
            "window": key,
            "count": len(value.connectors),
        },
    )
    return value


def invalidate_connectors_list_fresh_cache() -> None:
    """Drop only the TTL-gated fresh list cache; preserve last-success stale rows."""

    with _lock:
        global _list_fresh
        _list_fresh = None


def patch_connectors_list_cache_connector(
    connector_id: int,
    *,
    last_auth_check_at: datetime | None = None,
    last_auth_check_status: str | None = None,
    last_auth_error: str | None = None,
) -> None:
    """Merge auth-check metadata into cached connector rows without dropping stale fallback."""

    patch: dict[str, object] = {}
    if last_auth_check_at is not None:
        patch["last_auth_check_at"] = last_auth_check_at
    if last_auth_check_status is not None:
        patch["last_auth_check_status"] = last_auth_check_status
    if last_auth_error is not None or last_auth_check_status == "success":
        patch["last_auth_error"] = last_auth_error

    if not patch:
        return

    def _patch_rows(rows: list[ConnectorRead]) -> list[ConnectorRead]:
        out: list[ConnectorRead] = []
        for row in rows:
            if int(row.id) == int(connector_id):
                out.append(row.model_copy(update=patch))
            else:
                out.append(row)
        return out

    with _lock:
        global _list_fresh, _list_stale
        if _list_fresh is not None:
            _list_fresh = _CacheEntry(
                value=_patch_rows(_list_fresh.value),
                mono_ts=_list_fresh.mono_ts,
                epoch=_list_fresh.epoch,
            )
        if _list_stale is not None:
            _list_stale = _CacheEntry(
                value=_patch_rows(_list_stale.value),
                mono_ts=_list_stale.mono_ts,
                epoch=_list_stale.epoch,
            )


def invalidate_connectors_read_cache_after_auth_check(
    connector_id: int,
    *,
    last_auth_check_at: datetime | None,
    last_auth_check_status: str | None,
    last_auth_error: str | None,
) -> None:
    """Auth-check cache policy: expire fresh list only, patch stale rows, keep ops cache."""

    invalidate_connectors_list_fresh_cache()
    patch_connectors_list_cache_connector(
        connector_id,
        last_auth_check_at=last_auth_check_at,
        last_auth_check_status=last_auth_check_status,
        last_auth_error=last_auth_error,
    )


def clear_connectors_read_cache() -> None:
    """Drop cached connector reads and publish an epoch for other workers."""

    publish_connectors_catalog_epoch()
    with _lock:
        global _list_fresh, _list_stale
        _list_fresh = None
        _list_stale = None
        _ops_cache.clear()
