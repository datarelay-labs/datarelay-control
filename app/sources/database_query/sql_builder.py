"""Wrap user SELECT with checkpoint filters, deterministic ORDER BY, and LIMIT."""

from __future__ import annotations

from typing import Any

from app.runtime.errors import SourceFetchError

from app.sources.database_query.query_validator import validate_sql_identifier


def _quote_ident_pg(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def build_wrapped_select(
    *,
    inner_sql: str,
    db_kind: str,
    query_params: tuple | dict[str, Any] | None,
    checkpoint_mode: str,
    checkpoint_column: str | None,
    checkpoint_order_column: str | None,
    max_rows: int,
    checkpoint_value: dict[str, Any] | None,
    replay_low: Any | None = None,
    replay_high: Any | None = None,
    replay_column: str | None = None,
) -> tuple[str, tuple | dict[str, Any] | None]:
    """Return (sql, merged_params). LIMIT is inlined as a validated int; other binds preserved.

    ``replay_column`` is the date/time column the backfill window (``replay_low``..``replay_high``)
    filters. It is independent of the checkpoint (watermark) column, which is often an integer id.
    Without it the window falls back to ``checkpoint_column`` (only valid when that is a date/time).
    """

    mode = str(checkpoint_mode or "NONE").strip().upper()
    lim = max(1, int(max_rows))

    if db_kind != "POSTGRESQL":
        raise SourceFetchError(f"unsupported db_kind for SQL builder: {db_kind}")
    q_ident = _quote_ident_pg
    inner_alias = '"_gdc_inner"'

    where_parts: list[str] = []
    extra_pos: list[Any] = []
    extra_named: dict[str, Any] = {}

    use_replay_range = replay_low is not None and replay_high is not None

    if use_replay_range:
        if replay_column:
            col = validate_sql_identifier(replay_column, field="replay_time_column")
        else:
            if mode not in {"SINGLE_COLUMN", "COMPOSITE_ORDER"}:
                raise SourceFetchError(
                    "DATABASE_QUERY replay requires replay_time_column or checkpoint_mode SINGLE_COLUMN/COMPOSITE_ORDER"
                )
            if not checkpoint_column:
                raise SourceFetchError("checkpoint_column is required for DATABASE_QUERY replay window")
            col = validate_sql_identifier(checkpoint_column, field="checkpoint_column")
        wc = q_ident(col)
        if isinstance(query_params, dict):
            where_parts.append(f"{inner_alias}.{wc} >= %(gdc_rl_low)s")
            where_parts.append(f"{inner_alias}.{wc} <= %(gdc_rl_high)s")
            extra_named["gdc_rl_low"] = replay_low
            extra_named["gdc_rl_high"] = replay_high
        else:
            where_parts.append(f"{inner_alias}.{wc} >= %s")
            where_parts.append(f"{inner_alias}.{wc} <= %s")
            extra_pos.extend([replay_low, replay_high])
    elif mode == "NONE":
        pass
    elif mode == "SINGLE_COLUMN":
        if not checkpoint_column:
            raise SourceFetchError("checkpoint_column is required when checkpoint_mode=SINGLE_COLUMN")
        col = validate_sql_identifier(checkpoint_column, field="checkpoint_column")
        wc = q_ident(col)
        last = _extract_watermark_only(checkpoint_value, col)
        if last is not None:
            if isinstance(query_params, dict):
                where_parts.append(f"{inner_alias}.{wc} > %(gdc_wm)s")
                extra_named["gdc_wm"] = last
            else:
                where_parts.append(f"{inner_alias}.{wc} > %s")
                extra_pos.append(last)
    elif mode == "COMPOSITE_ORDER":
        if not checkpoint_column or not checkpoint_order_column:
            raise SourceFetchError(
                "checkpoint_column and checkpoint_order_column are required when checkpoint_mode=COMPOSITE_ORDER"
            )
        c1 = validate_sql_identifier(checkpoint_column, field="checkpoint_column")
        c2 = validate_sql_identifier(checkpoint_order_column, field="checkpoint_order_column")
        w1, w2 = q_ident(c1), q_ident(c2)
        pair = _extract_composite(checkpoint_value, c1, c2)
        if pair is not None:
            lw, lo = pair
            if isinstance(query_params, dict):
                where_parts.append(
                    f"({inner_alias}.{w1} > %(gdc_wm)s OR ({inner_alias}.{w1} = %(gdc_wm_eq)s AND {inner_alias}.{w2} > %(gdc_ord)s))"
                )
                extra_named["gdc_wm"] = lw
                extra_named["gdc_wm_eq"] = lw
                extra_named["gdc_ord"] = lo
            else:
                where_parts.append(
                    f"({inner_alias}.{w1} > %s OR ({inner_alias}.{w1} = %s AND {inner_alias}.{w2} > %s))"
                )
                extra_pos.extend([lw, lw, lo])
    else:
        raise SourceFetchError(f"unsupported checkpoint_mode: {checkpoint_mode}")

    order_parts: list[str] = []
    if mode in {"SINGLE_COLUMN", "COMPOSITE_ORDER"} and checkpoint_column:
        c1 = validate_sql_identifier(str(checkpoint_column), field="checkpoint_column")
        order_parts.append(f"{inner_alias}.{q_ident(c1)} ASC")
        if mode == "COMPOSITE_ORDER" and checkpoint_order_column:
            c2 = validate_sql_identifier(str(checkpoint_order_column), field="checkpoint_order_column")
            order_parts.append(f"{inner_alias}.{q_ident(c2)} ASC")

    where_sql = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""
    order_sql = (" ORDER BY " + ", ".join(order_parts)) if order_parts else ""

    outer = f"SELECT * FROM ({inner_sql}) AS {inner_alias}{where_sql}{order_sql} LIMIT {int(lim)}"

    merged = _merge_params(query_params, extra_pos, extra_named)
    return outer, merged


def _merge_params(
    user: tuple | dict[str, Any] | None,
    extra_pos: list[Any],
    extra_named: dict[str, Any],
) -> tuple | dict[str, Any] | None:
    if isinstance(user, dict):
        if extra_pos:
            raise SourceFetchError("internal error: positional checkpoint binds with dict query_params")
        if not extra_named:
            return user if user else None
        out = dict(user)
        for k, v in extra_named.items():
            if k in out:
                raise SourceFetchError(f"query_params must not use reserved key {k!r} (GDC checkpoint bind)")
            out[k] = v
        return out

    tail_t = tuple(extra_pos)
    if user is None:
        return tail_t if tail_t else None
    if isinstance(user, tuple):
        return user + tail_t
    raise SourceFetchError("query_params must be a JSON array (positional) or object (named)")


def _extract_watermark_only(checkpoint_value: dict[str, Any] | None, checkpoint_column: str) -> Any | None:
    pair = _extract_composite(checkpoint_value, checkpoint_column, None)
    if pair is None:
        return None
    return pair[0]


def _extract_composite(
    checkpoint_value: dict[str, Any] | None,
    checkpoint_column: str,
    order_column: str | None,
) -> tuple[Any, Any] | tuple[Any, None] | None:
    if not isinstance(checkpoint_value, dict):
        return None

    lw = checkpoint_value.get("last_processed_db_watermark")
    lo = checkpoint_value.get("last_processed_db_order")

    last_ev = checkpoint_value.get("last_success_event")
    if isinstance(last_ev, dict):
        ck = str(checkpoint_column)
        if ck in last_ev:
            lw = last_ev.get(ck)
        if order_column:
            ok = str(order_column)
            if ok in last_ev:
                lo = last_ev.get(ok)

    if lw is None:
        return None
    if order_column is None:
        return (lw, None)
    if lo is None:
        lo = _default_order_seed(lw)
    return (lw, lo)


def _default_order_seed(watermark: Any) -> Any:
    if isinstance(watermark, (int, float)):
        return 0
    return ""
