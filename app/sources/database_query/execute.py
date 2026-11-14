"""Execute wrapped DATABASE_QUERY SELECT and return list[dict]."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor

from app.runtime.errors import SourceFetchError
from app.sources.database_query.query_validator import coerce_query_params, validate_select_query
from app.sources.database_query.row_codec import json_safe_row
from app.sources.database_query.sql_builder import build_wrapped_select

logger = logging.getLogger(__name__)


def _get(cfg: dict[str, Any], key: str, default: Any = None) -> Any:
    if isinstance(cfg, dict):
        return cfg.get(key, default)
    return getattr(cfg, key, default)


def _ssl_mode_pg(mode: str) -> str:
    m = str(mode or "PREFER").strip().upper()
    allowed = {"DISABLE", "PREFER", "REQUIRE", "VERIFY_CA", "VERIFY_FULL"}
    if m not in allowed:
        raise SourceFetchError(f"unsupported ssl_mode for PostgreSQL: {mode}")
    return m.lower().replace("_", "-")


def _parse_replay_bound(raw: Any) -> Any:
    """Parse ISO-8601 replay bound from stream_config (string)."""

    if raw is None:
        raise SourceFetchError("replay bound is required")
    s = str(raw).strip()
    if not s:
        raise SourceFetchError("replay bound is required")
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(s)
    except ValueError as exc:
        raise SourceFetchError(f"invalid replay ISO timestamp: {raw!r}") from exc


def _pg_connection_settings(source_config: dict[str, Any]) -> tuple[str, int, str, str, str, int]:
    host = str(_get(source_config, "host") or "").strip()
    port = int(_get(source_config, "port") or 0)
    database = str(_get(source_config, "database") or "").strip()
    user = str(_get(source_config, "username") or "").strip()
    password = str(_get(source_config, "password") or "")
    conn_timeout = int(_get(source_config, "connection_timeout_seconds", 15) or 15)
    if conn_timeout < 1:
        conn_timeout = 1

    if not host or not database or not user:
        raise SourceFetchError("host, database, and username are required in source_config")
    if port <= 0:
        raise SourceFetchError("port must be a positive integer")
    return host, port, database, user, password, conn_timeout


def _describe_result_columns(
    *,
    source_config: dict[str, Any],
    inner_sql: str,
    params: tuple | dict[str, Any] | None,
    statement_ms: int,
) -> dict[str, int]:
    """Return ``{column name: PostgreSQL type OID}`` of the user SELECT's result.

    Runs the wrapped query with ``LIMIT 0`` so no rows are produced (the user query is planned, not
    executed) and applies the stream's configured statement timeout like the real fetch does.
    """

    host, port, database, user, password, conn_timeout = _pg_connection_settings(source_config)
    sql_text, bind = build_wrapped_select(
        inner_sql=inner_sql,
        db_kind="POSTGRESQL",
        query_params=params,
        checkpoint_mode="NONE",
        checkpoint_column=None,
        checkpoint_order_column=None,
        max_rows=1,
        checkpoint_value=None,
        describe_only=True,
    )
    conn = None
    try:
        conn = psycopg2.connect(
            host=host,
            port=port,
            dbname=database,
            user=user,
            password=password,
            connect_timeout=conn_timeout,
            sslmode=_ssl_mode_pg(str(_get(source_config, "ssl_mode") or "PREFER")),
            options=f"-c statement_timeout={int(statement_ms)}",
        )
        with conn.cursor() as cur:
            cur.execute(sql_text, bind)
            return {str(d[0]): int(d[1]) for d in (cur.description or [])}
    except Exception as exc:
        if conn is None:
            raise SourceFetchError(f"PostgreSQL connection failed: {exc}") from exc
        raise SourceFetchError(f"PostgreSQL query failed: {exc}") from exc
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:  # pragma: no cover
                pass


# psycopg2 / PostgreSQL type OIDs of the date/time types a replay window can filter.
_PG_TEMPORAL_TYPE_OIDS = frozenset({1082, 1114, 1184})  # date, timestamp, timestamptz


def resolve_replay_column(
    *,
    explicit: str | None,
    checkpoint_column: str | None,
    column_types: dict[str, int],
) -> str:
    """Pick the date/time column a backfill window filters.

    Order: explicit ``replay_time_column`` > the checkpoint column when it is a date/time >
    the single date/time column of the query result. Anything else fails with an actionable
    message instead of a ``bigint >= timestamptz`` SQL error from comparing an integer watermark.
    """

    temporal = [name for name, oid in column_types.items() if oid in _PG_TEMPORAL_TYPE_OIDS]
    wanted = (explicit or "").strip()
    if wanted:
        if wanted not in column_types:
            raise SourceFetchError(f"replay_time_column {wanted!r} is not in the query result columns")
        if wanted not in temporal:
            raise SourceFetchError(f"replay_time_column {wanted!r} is not a date/time column")
        return wanted
    ck = (checkpoint_column or "").strip()
    if ck and ck in temporal:
        return ck
    if len(temporal) == 1:
        return temporal[0]
    if not temporal:
        raise SourceFetchError(
            "backfill time window needs a date/time column: the query result has none "
            "(the checkpoint column is not a date/time). Select an event-time column or set "
            "stream_config.replay_time_column."
        )
    raise SourceFetchError(
        "backfill time window is ambiguous: the query result has several date/time columns "
        f"({', '.join(sorted(temporal))}). Set stream_config.replay_time_column to the event-time column."
    )


def fetch_database_rows(
    *,
    source_config: dict[str, Any],
    stream_config: dict[str, Any],
    checkpoint: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    db_type = str(_get(source_config, "db_type") or "").strip().upper()
    if db_type != "POSTGRESQL":
        raise SourceFetchError("source_config.db_type must be POSTGRESQL")

    inner = validate_select_query(str(_get(stream_config, "query") or ""))
    max_rows = int(_get(stream_config, "max_rows_per_run", 100) or 100)
    if max_rows < 1:
        max_rows = 1

    q_timeout = int(_get(stream_config, "query_timeout_seconds", 30) or 30)
    if q_timeout < 1:
        q_timeout = 1
    if q_timeout > 3600:
        q_timeout = 3600

    params = coerce_query_params(_get(stream_config, "query_params"))

    ck_mode = str(_get(stream_config, "checkpoint_mode") or "NONE").strip().upper()
    ck_col = _get(stream_config, "checkpoint_column")
    ck_ord = _get(stream_config, "checkpoint_order_column")

    rlow_raw = _get(stream_config, "gdc_replay_start_iso")
    rhigh_raw = _get(stream_config, "gdc_replay_end_iso")
    replay_low: Any | None = None
    replay_high: Any | None = None
    if rlow_raw is not None and str(rlow_raw).strip() and rhigh_raw is not None and str(rhigh_raw).strip():
        replay_low = _parse_replay_bound(rlow_raw)
        replay_high = _parse_replay_bound(rhigh_raw)

    replay_column: str | None = None
    if replay_low is not None and replay_high is not None:
        explicit_replay_column = str(_get(stream_config, "replay_time_column") or "").strip()
        if explicit_replay_column:
            # Operator-chosen column: no column discovery needed.
            replay_column = explicit_replay_column
        else:
            replay_column = resolve_replay_column(
                explicit=None,
                checkpoint_column=str(ck_col).strip() if ck_col is not None else None,
                column_types=_describe_result_columns(
                    source_config=source_config,
                    inner_sql=inner,
                    params=params,
                    statement_ms=min(q_timeout * 1000, 3_600_000),
                ),
            )

    sql_text, bind = build_wrapped_select(
        inner_sql=inner,
        db_kind=db_type,
        query_params=params,
        checkpoint_mode=ck_mode,
        checkpoint_column=str(ck_col).strip() if ck_col is not None else None,
        checkpoint_order_column=str(ck_ord).strip() if ck_ord is not None else None,
        max_rows=max_rows,
        checkpoint_value=checkpoint if isinstance(checkpoint, dict) else None,
        replay_low=replay_low,
        replay_high=replay_high,
        replay_column=replay_column,
    )

    host, port, database, user, password, conn_timeout = _pg_connection_settings(source_config)

    stmt_ms = min(q_timeout * 1000, 3_600_000)

    logger.info(
        "%s",
        {
            "stage": "database_query_execute",
            "db_type": db_type,
            "host": host,
            "port": port,
            "database": database,
            "ssl_mode": str(_get(source_config, "ssl_mode") or ""),
        },
    )

    return _fetch_postgres(
        host=host,
        port=port,
        database=database,
        user=user,
        password=password,
        ssl_mode=str(_get(source_config, "ssl_mode") or "PREFER"),
        connect_timeout=conn_timeout,
        statement_ms=stmt_ms,
        sql_text=sql_text,
        bind=bind,
    )


def _fetch_postgres(
    *,
    host: str,
    port: int,
    database: str,
    user: str,
    password: str,
    ssl_mode: str,
    connect_timeout: int,
    statement_ms: int,
    sql_text: str,
    bind: tuple | dict[str, Any] | None,
) -> list[dict[str, Any]]:
    sslmode = _ssl_mode_pg(ssl_mode)
    conn = None
    rows: list[Any] = []
    try:
        conn = psycopg2.connect(
            host=host,
            port=port,
            dbname=database,
            user=user,
            password=password,
            connect_timeout=connect_timeout,
            sslmode=sslmode,
            options=f"-c statement_timeout={int(statement_ms)}",
        )
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql_text, bind)
            rows = cur.fetchall()
    except Exception as exc:
        if conn is None:
            raise SourceFetchError(f"PostgreSQL connection failed: {exc}") from exc
        raise SourceFetchError(f"PostgreSQL query failed: {exc}") from exc
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:  # pragma: no cover
                pass

    out: list[dict[str, Any]] = []
    for r in rows:
        if isinstance(r, dict):
            out.append(json_safe_row(dict(r)))
    return out


def probe_database_connection(source_config: dict[str, Any]) -> dict[str, Any]:
    """Non-destructive connectivity probe (SELECT 1). Returns structured fields for API."""

    cfg = dict(source_config or {})
    db_type = str(cfg.get("db_type") or "").strip().upper()
    if db_type != "POSTGRESQL":
        return {"ok": False, "error_type": "invalid_db_type", "message": "db_type must be POSTGRESQL"}

    try:
        rows = _fetch_postgres(
            host=str(cfg.get("host") or "").strip(),
            port=int(cfg.get("port") or 5432),
            database=str(cfg.get("database") or "").strip(),
            user=str(cfg.get("username") or "").strip(),
            password=str(cfg.get("password") or ""),
            ssl_mode=str(cfg.get("ssl_mode") or "PREFER"),
            connect_timeout=int(cfg.get("connection_timeout_seconds", 15) or 15),
            statement_ms=5_000,
            sql_text="SELECT 1 AS gdc_ok",
            bind=None,
        )
    except SourceFetchError as exc:
        msg = str(exc)
        et = "auth_failed" if "Access denied" in msg or "password authentication failed" in msg.lower() else "connection_failed"
        return {"ok": False, "error_type": et, "message": msg}

    ok = bool(rows) and rows[0].get("gdc_ok") == 1
    return {"ok": ok, "message": "SELECT 1 succeeded" if ok else "unexpected probe result", "db_auth_ok": ok, "db_reachable": True}


def preview_limited_rows(
    *,
    source_config: dict[str, Any],
    stream_config: dict[str, Any],
    limit: int = 5,
) -> list[dict[str, Any]]:
    """Run user SELECT with optional params; ``max_rows_per_run`` caps preview rows (no checkpoint)."""

    validate_select_query(str(_get(stream_config, "query") or ""))
    lim = max(1, min(int(limit or 5), 50))
    merged = {**dict(stream_config or {}), "max_rows_per_run": lim, "checkpoint_mode": "NONE"}
    return fetch_database_rows(source_config=source_config, stream_config=merged, checkpoint=None)
