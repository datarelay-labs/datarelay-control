"""Connectors catalog read cache."""

import os
import subprocess
import sys
import time
from pathlib import Path
from unittest.mock import MagicMock

from app.connectors.read_cache import (
    clear_connectors_read_cache,
    get_connectors_list_cached,
    get_connectors_operations_summary_cached,
    invalidate_connectors_list_fresh_cache,
    invalidate_connectors_read_cache_after_auth_check,
    peek_connectors_list_cache,
    peek_connectors_list_stale_cache,
    publish_connectors_catalog_epoch,
    resolve_connectors_list_catalog,
)
from app.connectors.operations_schemas import ConnectorOperationsSummaryResponse
from app.connectors.schemas import ConnectorRead


def _sample_connector(name: str = "Alpha") -> ConnectorRead:
    return ConnectorRead(
        id=1,
        name=name,
        description=None,
        status="STOPPED",
        connector_type="generic_http",
        source_type="HTTP_API_POLLING",
        source_id=1,
        stream_count=0,
        auth_type="no_auth",
        auth={"auth_type": "no_auth"},
        verify_ssl=True,
        common_headers={},
    )


def test_connectors_list_cache_reuses_loader_once(db_session) -> None:
    clear_connectors_read_cache()
    calls = {"n": 0}

    def loader(_db) -> list[ConnectorRead]:
        calls["n"] += 1
        return [_sample_connector()]

    first = get_connectors_list_cached(db_session, loader)
    second = get_connectors_list_cached(db_session, loader)
    assert first[0].name == "Alpha"
    assert second[0].name == "Alpha"
    assert calls["n"] == 1
    assert peek_connectors_list_cache() is not None
    assert peek_connectors_list_stale_cache() is not None
    clear_connectors_read_cache()
    assert peek_connectors_list_cache() is None
    assert peek_connectors_list_stale_cache() is None


def test_resolve_connectors_list_catalog_returns_stale_on_db_failure(monkeypatch) -> None:
    clear_connectors_read_cache()
    monkeypatch.setattr("app.connectors.read_cache._LIST_FRESH_TTL_SEC", 0.0)
    get_connectors_list_cached(MagicMock(), lambda _db: [_sample_connector("Cached")])
    assert peek_connectors_list_cache() is None
    assert peek_connectors_list_stale_cache() is not None

    def failing_loader() -> tuple[list[ConnectorRead], float, float]:
        raise TimeoutError("pool exhausted")

    rows, metrics = resolve_connectors_list_catalog(failing_loader)
    assert len(rows) == 1
    assert rows[0].name == "Cached"
    assert metrics.stale_fallback is True
    clear_connectors_read_cache()


def test_resolve_connectors_list_catalog_fresh_hit_skips_db_loader() -> None:
    clear_connectors_read_cache()
    get_connectors_list_cached(MagicMock(), lambda _db: [_sample_connector("Fresh")])

    def should_not_run() -> tuple[list[ConnectorRead], float, float]:
        raise AssertionError("db loader should not run on fresh cache hit")

    rows, metrics = resolve_connectors_list_catalog(should_not_run)
    assert rows[0].name == "Fresh"
    assert metrics.cache_hit is True
    clear_connectors_read_cache()


def test_connectors_operations_cache_is_window_scoped(db_session) -> None:
    clear_connectors_read_cache()
    calls = {"n": 0}

    def loader(_db) -> ConnectorOperationsSummaryResponse:
        calls["n"] += 1
        return ConnectorOperationsSummaryResponse(window="1h", generated_at=None, connectors=[])

    get_connectors_operations_summary_cached(db_session, window="1h", loader=loader)
    get_connectors_operations_summary_cached(db_session, window="1h", loader=loader)
    get_connectors_operations_summary_cached(db_session, window="15m", loader=loader)
    assert calls["n"] == 2


def test_invalidate_connectors_list_fresh_cache_preserves_stale() -> None:
    clear_connectors_read_cache()
    get_connectors_list_cached(MagicMock(), lambda _db: [_sample_connector("StaleKeep")])

    invalidate_connectors_list_fresh_cache()
    assert peek_connectors_list_cache() is None
    stale = peek_connectors_list_stale_cache()
    assert stale is not None
    assert stale[0].name == "StaleKeep"
    clear_connectors_read_cache()


def test_auth_check_invalidation_patches_stale_without_clearing_ops() -> None:
    from datetime import UTC, datetime

    clear_connectors_read_cache()
    get_connectors_list_cached(MagicMock(), lambda _db: [_sample_connector()])
    finished = datetime(2026, 6, 21, 12, 0, 0, tzinfo=UTC)
    invalidate_connectors_read_cache_after_auth_check(
        1,
        last_auth_check_at=finished,
        last_auth_check_status="success",
        last_auth_error=None,
    )
    stale = peek_connectors_list_stale_cache()
    assert stale is not None
    assert stale[0].last_auth_check_status == "success"
    clear_connectors_read_cache()


def _isolate_epoch(monkeypatch, tmp_path: Path) -> Path:
    epoch = tmp_path / "connectors-catalog-epoch"
    monkeypatch.setenv("GDC_CONNECTORS_CACHE_EPOCH_PATH", str(epoch))
    return epoch


def test_clear_publishes_distinct_shared_epochs(monkeypatch, tmp_path: Path) -> None:
    epoch = _isolate_epoch(monkeypatch, tmp_path)
    clear_connectors_read_cache()
    first = epoch.read_text(encoding="utf-8").strip()
    clear_connectors_read_cache()
    second = epoch.read_text(encoding="utf-8").strip()
    assert first
    assert second
    assert first != second


def test_shared_epoch_publish_drops_fresh_list_and_reloads(monkeypatch, tmp_path: Path) -> None:
    _isolate_epoch(monkeypatch, tmp_path)
    clear_connectors_read_cache()
    calls = {"n": 0}

    def loader(_db) -> list[ConnectorRead]:
        calls["n"] += 1
        return [_sample_connector(f"gen-{calls['n']}")]

    first = get_connectors_list_cached(MagicMock(), loader)
    assert first[0].name == "gen-1"
    assert calls["n"] == 1

    publish_connectors_catalog_epoch()
    assert peek_connectors_list_cache() is None
    stale = peek_connectors_list_stale_cache()
    assert stale is not None
    assert stale[0].name == "gen-1"

    second = get_connectors_list_cached(MagicMock(), loader)
    assert second[0].name == "gen-2"
    assert calls["n"] == 2
    assert peek_connectors_list_cache() is not None
    clear_connectors_read_cache()


def test_shared_epoch_publish_keeps_stale_fallback_when_reload_fails(monkeypatch, tmp_path: Path) -> None:
    _isolate_epoch(monkeypatch, tmp_path)
    clear_connectors_read_cache()
    get_connectors_list_cached(MagicMock(), lambda _db: [_sample_connector("BeforeDelete")])
    publish_connectors_catalog_epoch()

    def failing_loader() -> tuple[list[ConnectorRead], float, float]:
        raise TimeoutError("pool exhausted")

    rows, metrics = resolve_connectors_list_catalog(failing_loader)
    assert metrics.stale_fallback is True
    assert rows[0].name == "BeforeDelete"
    assert peek_connectors_list_cache() is None
    clear_connectors_read_cache()


def test_catalog_snapshot_is_not_cached_when_epoch_changes_during_load(monkeypatch, tmp_path: Path) -> None:
    _isolate_epoch(monkeypatch, tmp_path)
    clear_connectors_read_cache()

    def loader(_db) -> list[ConnectorRead]:
        publish_connectors_catalog_epoch()
        return [_sample_connector("Torn")]

    rows = get_connectors_list_cached(MagicMock(), loader)
    assert rows[0].name == "Torn"
    assert peek_connectors_list_cache() is None
    assert peek_connectors_list_stale_cache() is None
    clear_connectors_read_cache()


def test_operations_cache_reloads_after_shared_epoch_publish(monkeypatch, tmp_path: Path, db_session) -> None:
    _isolate_epoch(monkeypatch, tmp_path)
    clear_connectors_read_cache()
    calls = {"n": 0}

    def loader(_db) -> ConnectorOperationsSummaryResponse:
        calls["n"] += 1
        return ConnectorOperationsSummaryResponse(window="1h", generated_at=None, connectors=[])

    get_connectors_operations_summary_cached(db_session, window="1h", loader=loader)
    get_connectors_operations_summary_cached(db_session, window="1h", loader=loader)
    assert calls["n"] == 1
    publish_connectors_catalog_epoch()
    get_connectors_operations_summary_cached(db_session, window="1h", loader=loader)
    assert calls["n"] == 2
    clear_connectors_read_cache()


def test_other_process_epoch_publish_invalidates_cached_catalog(tmp_path: Path) -> None:
    """A sibling worker must miss after another process publishes the catalog epoch."""

    epoch = tmp_path / "connectors-catalog-epoch"
    status = tmp_path / "status"
    release = tmp_path / "release"
    result = tmp_path / "result"
    script = tmp_path / "worker_cache.py"
    script.write_text(
        f"""
import os
import time

os.environ["GDC_CONNECTORS_CACHE_EPOCH_PATH"] = {str(epoch)!r}
from app.connectors.read_cache import get_connectors_list_cached, peek_connectors_list_cache
from app.connectors.schemas import ConnectorRead

def loader(_db):
    return [ConnectorRead(id=1, name="Cached", status="STOPPED", auth={{"auth_type": "no_auth"}})]

get_connectors_list_cached(object(), loader)
open({str(status)!r}, "w", encoding="utf-8").write("filled\\n")
deadline = time.time() + 15
while not os.path.exists({str(release)!r}):
    if time.time() > deadline:
        raise SystemExit(2)
    time.sleep(0.05)
peek = peek_connectors_list_cache()
open({str(result)!r}, "w", encoding="utf-8").write("hit\\n" if peek else "miss\\n")
""",
        encoding="utf-8",
    )
    env = os.environ.copy()
    env["GDC_CONNECTORS_CACHE_EPOCH_PATH"] = str(epoch)
    env["PYTHONPATH"] = os.pathsep.join(
        [os.getcwd(), env.get("PYTHONPATH", "")]
    ).rstrip(os.pathsep)
    proc = subprocess.Popen(
        [sys.executable, str(script)],
        cwd=os.getcwd(),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        deadline = time.time() + 15
        while not status.exists():
            if proc.poll() is not None or time.time() > deadline:
                out, err = proc.communicate(timeout=5)
                raise AssertionError(f"worker exited early code={proc.returncode} stdout={out} stderr={err}")
            time.sleep(0.05)
        epoch.write_text(f"{time.time_ns()}\n", encoding="utf-8")
        release.write_text("go\n", encoding="utf-8")
        out, err = proc.communicate(timeout=15)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.communicate(timeout=5)
    assert proc.returncode == 0, f"stdout={out} stderr={err}"
    assert result.read_text(encoding="utf-8").strip() == "miss"
