"""DATABASE_QUERY backfill/replay window must filter an event-time column (E-062).

Regression: the replay window (ISO timestamps) used to be compared against the
``checkpoint_column`` even when that column is an integer id/watermark, producing
``operator does not exist: bigint >= timestamp with time zone`` on PostgreSQL.

The builder and resolver tests are pure unit tests. The ``pg_`` tests run the real adapter
against a throwaway PostgreSQL database named by ``SOURCE_E2E_PG_FIXTURE_URL`` (each test
creates and drops its own uniquely named table) and are skipped when it is not set or not
reachable.
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from typing import Any, Iterator
from urllib.parse import urlparse

import pytest

from app.runtime.errors import SourceFetchError
from app.sources.database_query import execute as execute_mod
from app.sources.database_query.execute import (
    _describe_result_columns,
    fetch_database_rows,
    resolve_replay_column,
)
from app.sources.database_query.sql_builder import build_wrapped_select

LOW = datetime(2026, 11, 1, tzinfo=timezone.utc)
HIGH = datetime(2026, 11, 3, tzinfo=timezone.utc)


# --------------------------------------------------------------------------- builder unit tests


def test_builder_filters_replay_window_on_replay_column_not_checkpoint_column() -> None:
    sql, bind = build_wrapped_select(
        inner_sql="SELECT id, created_at FROM t",
        db_kind="POSTGRESQL",
        query_params=None,
        checkpoint_mode="SINGLE_COLUMN",
        checkpoint_column="id",
        checkpoint_order_column=None,
        max_rows=10,
        checkpoint_value=None,
        replay_low=LOW,
        replay_high=HIGH,
        replay_column="created_at",
    )
    assert '"_gdc_inner"."created_at" >= %s' in sql
    assert '"_gdc_inner"."created_at" <= %s' in sql
    assert '"_gdc_inner"."id" >=' not in sql
    assert 'ORDER BY "_gdc_inner"."id" ASC' in sql
    assert bind == (LOW, HIGH)


def test_builder_replay_window_works_without_checkpoint_mode_when_replay_column_given() -> None:
    sql, bind = build_wrapped_select(
        inner_sql="SELECT id, created_at FROM t",
        db_kind="POSTGRESQL",
        query_params={"tenant": "a"},
        checkpoint_mode="NONE",
        checkpoint_column=None,
        checkpoint_order_column=None,
        max_rows=10,
        checkpoint_value=None,
        replay_low=LOW,
        replay_high=HIGH,
        replay_column="created_at",
    )
    assert '"_gdc_inner"."created_at" >= %(gdc_rl_low)s' in sql
    assert bind == {"tenant": "a", "gdc_rl_low": LOW, "gdc_rl_high": HIGH}


def test_builder_replay_column_is_identifier_validated() -> None:
    with pytest.raises(SourceFetchError):
        build_wrapped_select(
            inner_sql="SELECT 1 AS a",
            db_kind="POSTGRESQL",
            query_params=None,
            checkpoint_mode="NONE",
            checkpoint_column=None,
            checkpoint_order_column=None,
            max_rows=10,
            checkpoint_value=None,
            replay_low=LOW,
            replay_high=HIGH,
            replay_column='created_at"; DROP TABLE t; --',
        )


def test_builder_without_replay_column_keeps_checkpoint_column_behaviour() -> None:
    sql, _bind = build_wrapped_select(
        inner_sql="SELECT id, event_time FROM t",
        db_kind="POSTGRESQL",
        query_params=None,
        checkpoint_mode="SINGLE_COLUMN",
        checkpoint_column="event_time",
        checkpoint_order_column=None,
        max_rows=10,
        checkpoint_value=None,
        replay_low=LOW,
        replay_high=HIGH,
    )
    assert '"_gdc_inner"."event_time" >= %s' in sql


# --------------------------------------------------------------------------- column resolution unit tests

_INT8, _TEXT, _TIMESTAMPTZ, _TIMESTAMP, _DATE = 20, 25, 1184, 1114, 1082


def test_resolver_explicit_column_wins() -> None:
    cols = {"id": _INT8, "created_at": _TIMESTAMPTZ, "updated_at": _TIMESTAMPTZ}
    assert resolve_replay_column(explicit="updated_at", checkpoint_column="id", column_types=cols) == "updated_at"


def test_resolver_prefers_temporal_checkpoint_column() -> None:
    cols = {"event_time": _TIMESTAMP, "created_at": _TIMESTAMPTZ}
    assert resolve_replay_column(explicit=None, checkpoint_column="event_time", column_types=cols) == "event_time"


def test_resolver_picks_the_only_temporal_column_when_checkpoint_is_integer() -> None:
    cols = {"id": _INT8, "label": _TEXT, "day": _DATE}
    assert resolve_replay_column(explicit=None, checkpoint_column="id", column_types=cols) == "day"


def test_resolver_rejects_ambiguous_temporal_columns() -> None:
    cols = {"id": _INT8, "created_at": _TIMESTAMPTZ, "updated_at": _TIMESTAMPTZ}
    with pytest.raises(SourceFetchError, match="replay_time_column") as exc:
        resolve_replay_column(explicit=None, checkpoint_column="id", column_types=cols)
    assert "created_at" in str(exc.value) and "updated_at" in str(exc.value)


def test_resolver_rejects_missing_temporal_column() -> None:
    with pytest.raises(SourceFetchError, match="replay_time_column"):
        resolve_replay_column(explicit=None, checkpoint_column="id", column_types={"id": _INT8, "label": _TEXT})


def test_resolver_rejects_non_temporal_or_unknown_explicit_column() -> None:
    cols = {"id": _INT8, "created_at": _TIMESTAMPTZ}
    with pytest.raises(SourceFetchError, match="not a date/time column"):
        resolve_replay_column(explicit="id", checkpoint_column="id", column_types=cols)
    with pytest.raises(SourceFetchError, match="not in the query result"):
        resolve_replay_column(explicit="nope", checkpoint_column="id", column_types=cols)


# --------------------------------------------------------------------------- probe timeout / skip tests

_SRC = {"db_type": "POSTGRESQL", "host": "h", "port": 5432, "database": "d", "username": "u", "password": "p"}


def _replay_cfg(**extra: Any) -> dict[str, Any]:
    cfg: dict[str, Any] = {
        "query": "SELECT id, created_at FROM t",
        "checkpoint_mode": "SINGLE_COLUMN",
        "checkpoint_column": "id",
        "gdc_replay_start_iso": "2026-11-01T00:00:00Z",
        "gdc_replay_end_iso": "2026-11-03T00:00:00Z",
    }
    cfg.update(extra)
    return cfg


def _spy_fetch(monkeypatch: pytest.MonkeyPatch) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    described: list[dict[str, Any]] = []
    fetched: list[dict[str, Any]] = []

    def _describe(**kw: Any) -> dict[str, int]:
        described.append(kw)
        return {"id": _INT8, "created_at": _TIMESTAMPTZ}

    def _fetch(**kw: Any) -> list[dict[str, Any]]:
        fetched.append(kw)
        return []

    monkeypatch.setattr(execute_mod, "_describe_result_columns", _describe)
    monkeypatch.setattr(execute_mod, "_fetch_postgres", _fetch)
    return described, fetched


def test_column_probe_honours_configured_query_timeout_above_30s(monkeypatch: pytest.MonkeyPatch) -> None:
    described, fetched = _spy_fetch(monkeypatch)
    fetch_database_rows(source_config=_SRC, stream_config=_replay_cfg(query_timeout_seconds=120), checkpoint=None)
    assert [d["statement_ms"] for d in described] == [120_000]
    assert fetched[0]["statement_ms"] == 120_000
    assert '"created_at" >= %s' in fetched[0]["sql_text"]


def test_column_probe_default_timeout_is_unchanged(monkeypatch: pytest.MonkeyPatch) -> None:
    described, fetched = _spy_fetch(monkeypatch)
    fetch_database_rows(source_config=_SRC, stream_config=_replay_cfg(), checkpoint=None)
    assert [d["statement_ms"] for d in described] == [30_000]
    assert fetched[0]["statement_ms"] == 30_000


def test_column_probe_is_skipped_when_replay_time_column_is_set(monkeypatch: pytest.MonkeyPatch) -> None:
    described, fetched = _spy_fetch(monkeypatch)
    fetch_database_rows(
        source_config=_SRC, stream_config=_replay_cfg(replay_time_column="created_at"), checkpoint=None
    )
    assert described == []
    assert '"created_at" >= %s' in fetched[0]["sql_text"]


def test_column_probe_is_not_run_without_a_replay_window(monkeypatch: pytest.MonkeyPatch) -> None:
    described, _fetched = _spy_fetch(monkeypatch)
    cfg = _replay_cfg()
    cfg.pop("gdc_replay_start_iso")
    cfg.pop("gdc_replay_end_iso")
    fetch_database_rows(source_config=_SRC, stream_config=cfg, checkpoint=None)
    assert described == []


def test_describe_probe_sets_statement_timeout_and_runs_limit_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}

    class _Cur:
        description = [("id", _INT8, None, None, None, None, None)]

        def __enter__(self) -> "_Cur":
            return self

        def __exit__(self, *a: Any) -> None:
            return None

        def execute(self, sql: str, bind: Any) -> None:
            seen["sql"] = sql

    class _Conn:
        def cursor(self) -> _Cur:
            return _Cur()

        def close(self) -> None:
            seen["closed"] = True

    def _connect(**kw: Any) -> _Conn:
        seen["options"] = kw["options"]
        return _Conn()

    monkeypatch.setattr(execute_mod.psycopg2, "connect", _connect)
    out = _describe_result_columns(
        source_config=_SRC, inner_sql="SELECT id FROM t", params=None, statement_ms=90_000
    )
    assert out == {"id": _INT8}
    assert seen["options"] == "-c statement_timeout=90000"
    assert seen["sql"].endswith("LIMIT 0")
    assert seen["closed"] is True


# --------------------------------------------------------------------------- real PostgreSQL tests


def _pg_source_config() -> dict[str, Any] | None:
    url = os.getenv("SOURCE_E2E_PG_FIXTURE_URL", "").strip()
    if not url:
        return None
    u = urlparse(url)
    if not u.hostname or not u.path.strip("/"):
        return None
    return {
        "db_type": "POSTGRESQL",
        "host": u.hostname,
        "port": u.port or 5432,
        "database": u.path.strip("/"),
        "username": u.username or "",
        "password": u.password or "",
        "ssl_mode": "DISABLE",
        "connection_timeout_seconds": 5,
    }


@pytest.fixture()
def pg_events() -> Iterator[tuple[dict[str, Any], str]]:
    import psycopg2

    source = _pg_source_config()
    if source is None:
        pytest.skip("SOURCE_E2E_PG_FIXTURE_URL is not set")
    table = f"wpb_replay_{uuid.uuid4().hex[:10]}"
    try:
        conn = psycopg2.connect(
            host=source["host"],
            port=source["port"],
            dbname=source["database"],
            user=source["username"],
            password=source["password"],
            connect_timeout=5,
        )
    except psycopg2.OperationalError as exc:  # pragma: no cover - environment dependent
        pytest.skip(f"PostgreSQL not reachable: {exc}")
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"CREATE TABLE {table} ("
                "id bigint PRIMARY KEY, "
                "label text, "
                "created_at timestamptz NOT NULL, "
                "updated_at timestamptz NOT NULL)"
            )
            cur.execute(
                f"INSERT INTO {table} (id, label, created_at, updated_at) VALUES "
                "(1, 'before', '2026-10-30T12:00:00Z', '2026-11-02T12:00:00Z'), "
                "(2, 'in-a', '2026-11-01T12:00:00Z', '2026-11-05T12:00:00Z'), "
                "(3, 'in-b', '2026-11-02T12:00:00Z', '2026-11-05T12:00:00Z'), "
                "(4, 'after', '2026-11-04T12:00:00Z', '2026-11-02T00:00:00Z')"
            )
        yield source, table
    finally:
        with conn.cursor() as cur:
            cur.execute(f"DROP TABLE IF EXISTS {table}")
        conn.close()


def _stream_cfg(table: str, *, columns: str = "id, label, created_at", **extra: Any) -> dict[str, Any]:
    cfg: dict[str, Any] = {
        "query": f"SELECT {columns} FROM {table}",
        "checkpoint_mode": "SINGLE_COLUMN",
        "checkpoint_column": "id",
        "max_rows_per_run": 100,
        "gdc_replay_start_iso": "2026-11-01T00:00:00Z",
        "gdc_replay_end_iso": "2026-11-03T00:00:00Z",
    }
    cfg.update(extra)
    return cfg


def test_pg_replay_window_uses_event_time_column_when_checkpoint_column_is_integer_id(
    pg_events: tuple[dict[str, Any], str],
) -> None:
    source, table = pg_events
    rows = fetch_database_rows(source_config=source, stream_config=_stream_cfg(table), checkpoint=None)
    assert [r["id"] for r in rows] == [2, 3]


def test_pg_replay_window_honours_explicit_replay_time_column(
    pg_events: tuple[dict[str, Any], str],
) -> None:
    source, table = pg_events
    cfg = _stream_cfg(
        table,
        columns="id, label, created_at, updated_at",
        replay_time_column="updated_at",
        gdc_replay_start_iso="2026-11-02T00:00:00Z",
        gdc_replay_end_iso="2026-11-03T00:00:00Z",
    )
    rows = fetch_database_rows(source_config=source, stream_config=cfg, checkpoint=None)
    assert [r["id"] for r in rows] == [1, 4]


def test_pg_replay_window_with_temporal_checkpoint_column_still_filters_it(
    pg_events: tuple[dict[str, Any], str],
) -> None:
    source, table = pg_events
    cfg = _stream_cfg(table, checkpoint_column="created_at")
    rows = fetch_database_rows(source_config=source, stream_config=cfg, checkpoint=None)
    assert [r["id"] for r in rows] == [2, 3]


def test_pg_replay_window_ambiguous_time_columns_fails_with_actionable_message(
    pg_events: tuple[dict[str, Any], str],
) -> None:
    source, table = pg_events
    cfg = _stream_cfg(table, columns="id, label, created_at, updated_at")
    with pytest.raises(SourceFetchError, match="replay_time_column") as exc:
        fetch_database_rows(source_config=source, stream_config=cfg, checkpoint=None)
    assert "operator does not exist" not in str(exc.value)


def test_pg_replay_window_without_any_time_column_fails_with_actionable_message(
    pg_events: tuple[dict[str, Any], str],
) -> None:
    source, table = pg_events
    cfg = _stream_cfg(table, columns="id, label")
    with pytest.raises(SourceFetchError, match="replay_time_column") as exc:
        fetch_database_rows(source_config=source, stream_config=cfg, checkpoint=None)
    assert "operator does not exist" not in str(exc.value)


def test_pg_explicit_non_temporal_replay_time_column_is_rejected_by_postgres(
    pg_events: tuple[dict[str, Any], str],
) -> None:
    # An explicit column skips discovery, so a non date/time choice surfaces as the source error.
    source, table = pg_events
    cfg = _stream_cfg(table, replay_time_column="label")
    with pytest.raises(SourceFetchError, match="PostgreSQL query failed"):
        fetch_database_rows(source_config=source, stream_config=cfg, checkpoint=None)


def test_pg_column_discovery_does_not_execute_the_user_query(
    pg_events: tuple[dict[str, Any], str],
) -> None:
    # pg_sleep per row would blow the 1s statement timeout if the probe produced rows.
    source, table = pg_events
    types = _describe_result_columns(
        source_config=source,
        inner_sql=f"SELECT id, created_at, pg_sleep(5) AS s FROM {table}",
        params=None,
        statement_ms=1000,
    )
    assert set(types) == {"id", "created_at", "s"}


def test_pg_incremental_poll_without_replay_window_is_unchanged(
    pg_events: tuple[dict[str, Any], str],
) -> None:
    source, table = pg_events
    cfg = _stream_cfg(table)
    cfg.pop("gdc_replay_start_iso")
    cfg.pop("gdc_replay_end_iso")
    rows = fetch_database_rows(
        source_config=source,
        stream_config=cfg,
        checkpoint={"last_success_event": {"id": 2}},
    )
    assert [r["id"] for r in rows] == [3, 4]
