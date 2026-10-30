"""Bulk stream stats-health reads — one IN/GROUP BY aggregate path per request."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import cast

from sqlalchemy import Integer, and_, case, func, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, joinedload
from app.checkpoints.models import Checkpoint
from app.logs.models import DeliveryLog
from app.routes.models import Route
from app.runtime.health_repository import clamp_health_aggregate_window
from app.runtime.metrics_window import parse_metrics_window
from app.runtime.read_service import (
    _ROUTE_COUNT_FIELDS,
    _SUMMARY_STAGE_FIELDS,
    _build_route_health_items,
    _compute_last_seen,
    _compute_stream_health,
    _dashboard_snapshot_id,
    _dashboard_snapshot_time,
    _load_snapshot_outcome_metadata,
    _merge_health_outcome_metadata,
    _merge_stats_outcome_metadata,
    _recent_log_items,
    _route_last_failure,
    _route_last_success,
)
from app.runtime.copy_utils import checkpoint_read_view
from app.runtime.schemas import (
    BulkStreamStatsHealthResponse,
    CheckpointStatsPayload,
    RouteHealthState,
    RouteHealthItem,
    RouteRuntimeCounts,
    RouteRuntimeStatsItem,
    StreamHealthResponse,
    StreamHealthState,
    StreamHealthSummary,
    StreamRuntimeLastSeen,
    StreamRuntimeStatsHealthBundleResponse,
    StreamRuntimeStatsResponse,
    StreamRuntimeSummary,
    StreamStatsHealthBulkEntry,
)
from app.streams.models import Stream

logger = logging.getLogger(__name__)

_MAX_BULK_STREAM_IDS = 200
_MAX_BULK_RECENT_LOGS_PER_STREAM = 20


def resolve_bulk_stream_ids_param(*, ids: str | None = None, stream_ids: str | None = None) -> list[int]:
    """Parse bulk ids from ``ids`` (frontend) or ``stream_ids`` (legacy alias)."""

    raw = ids if ids is not None and str(ids).strip() else stream_ids
    if raw is None or not str(raw).strip():
        raise ValueError("ids must contain at least one stream id")
    return parse_bulk_stream_ids(raw)


def parse_bulk_stream_ids(raw: str) -> list[int]:
    """Parse comma-separated stream ids for bulk stats-health."""

    if not raw or not str(raw).strip():
        raise ValueError("ids must contain at least one stream id")
    out: list[int] = []
    seen: set[int] = set()
    for part in str(raw).split(","):
        token = part.strip()
        if not token:
            continue
        try:
            sid = int(token)
        except ValueError as exc:
            raise ValueError(f"invalid stream id: {token}") from exc
        if sid <= 0:
            raise ValueError(f"invalid stream id: {token}")
        if sid in seen:
            continue
        seen.add(sid)
        out.append(sid)
    if not out:
        raise ValueError("ids must contain at least one stream id")
    if len(out) > _MAX_BULK_STREAM_IDS:
        raise ValueError(f"ids supports at most {_MAX_BULK_STREAM_IDS} stream ids")
    return out


def _health_label(state: str | None) -> str:
    normalized = str(state or "IDLE").strip().upper()
    if normalized == "HEALTHY":
        return "healthy"
    if normalized == "DEGRADED":
        return "degraded"
    if normalized == "UNHEALTHY":
        return "unhealthy"
    return "idle"


def _last_event_at(last_seen: StreamRuntimeLastSeen | None) -> datetime | None:
    if last_seen is None:
        return None
    candidates = [last_seen.success_at, last_seen.failure_at, last_seen.rate_limited_at]
    present = [ts for ts in candidates if ts is not None]
    return max(present) if present else None


def _derive_issue(*, health: StreamHealthResponse | None) -> str | None:
    if health is None:
        return None
    if health.health in ("UNHEALTHY", "DEGRADED"):
        for route in health.routes:
            if route.health in ("UNHEALTHY", "DEGRADED") and route.last_error_message:
                return route.last_error_message
        return f"stream health {health.health.lower()}"
    return None


def _safe_bulk_until(snapshot_id: str | None) -> datetime:
    if snapshot_id is None:
        return _dashboard_snapshot_time(None)
    try:
        return _dashboard_snapshot_time(snapshot_id)
    except ValueError:
        return _dashboard_snapshot_time(None)


def _bulk_summary_stage_counts(
    db: Session,
    stream_ids: list[int],
    *,
    start_at: datetime,
    end_at: datetime,
) -> dict[int, StreamRuntimeSummary]:
    acc_by_stream: dict[int, dict[str, int]] = {sid: {k: 0 for k in _SUMMARY_STAGE_FIELDS} for sid in stream_ids}
    try:
        rows = (
            db.query(DeliveryLog.stream_id, DeliveryLog.stage, func.count(DeliveryLog.id))
            .filter(
                DeliveryLog.stream_id.in_(stream_ids),
                DeliveryLog.created_at >= start_at,
                DeliveryLog.created_at < end_at,
                DeliveryLog.stage.in_(_SUMMARY_STAGE_FIELDS),
            )
            .group_by(DeliveryLog.stream_id, DeliveryLog.stage)
            .all()
        )
    except OperationalError:
        db.rollback()
        raise
    for stream_id, stage, count in rows:
        sid = int(stream_id)
        key = str(stage)
        bucket = acc_by_stream.setdefault(sid, {k: 0 for k in _SUMMARY_STAGE_FIELDS})
        if key in bucket:
            bucket[key] = int(count or 0)
    return {
        sid: StreamRuntimeSummary(
            total_logs=sum(acc.values()),
            processed_events=0,
            **acc,
        )
        for sid, acc in acc_by_stream.items()
    }


def _bulk_processed_events(
    db: Session,
    stream_ids: list[int],
    *,
    window_start: datetime,
    window_end: datetime,
    day_start: datetime,
) -> tuple[dict[int, int], dict[int, int]]:
    """One GROUP BY query for window + 24h processed source events."""

    input_events = func.greatest(
        0,
        func.coalesce(func.cast(DeliveryLog.payload_sample.op("->>")("input_events"), Integer), 0),
    )
    window_case = case(
        (
            and_(
                DeliveryLog.stage == "run_complete",
                DeliveryLog.created_at >= window_start,
                DeliveryLog.created_at < window_end,
            ),
            input_events,
        ),
        else_=0,
    )
    day_case = case(
        (
            and_(
                DeliveryLog.stage == "run_complete",
                DeliveryLog.created_at >= day_start,
                DeliveryLog.created_at < window_end,
            ),
            input_events,
        ),
        else_=0,
    )
    rows = (
        db.query(
            DeliveryLog.stream_id,
            func.coalesce(func.sum(window_case), 0),
            func.coalesce(func.sum(day_case), 0),
        )
        .filter(
            DeliveryLog.stream_id.in_(stream_ids),
            DeliveryLog.created_at >= day_start,
            DeliveryLog.created_at < window_end,
            DeliveryLog.stage == "run_complete",
            func.upper(func.coalesce(DeliveryLog.level, "")) != "DEBUG",
        )
        .group_by(DeliveryLog.stream_id)
        .all()
    )
    window_map = {sid: 0 for sid in stream_ids}
    day_map = {sid: 0 for sid in stream_ids}
    for stream_id, window_total, day_total in rows:
        sid = int(stream_id)
        window_map[sid] = int(window_total or 0)
        day_map[sid] = int(day_total or 0)
    return window_map, day_map


def _bulk_route_stage_counts(
    db: Session,
    stream_ids: list[int],
    *,
    start_at: datetime,
    end_at: datetime,
) -> dict[int, dict[int, dict[str, int]]]:
    out: dict[int, dict[int, dict[str, int]]] = {}
    rows = (
        db.query(DeliveryLog.stream_id, DeliveryLog.route_id, DeliveryLog.stage, func.count(DeliveryLog.id))
        .filter(
            DeliveryLog.stream_id.in_(stream_ids),
            DeliveryLog.created_at >= start_at,
            DeliveryLog.created_at < end_at,
            DeliveryLog.route_id.isnot(None),
            DeliveryLog.stage.in_(_ROUTE_COUNT_FIELDS),
        )
        .group_by(DeliveryLog.stream_id, DeliveryLog.route_id, DeliveryLog.stage)
        .all()
    )
    for stream_id, route_id, stage, count in rows:
        sid = int(stream_id)
        rid = int(route_id)
        stream_bucket = out.setdefault(sid, {})
        route_bucket = stream_bucket.setdefault(rid, {k: 0 for k in _ROUTE_COUNT_FIELDS})
        key = str(stage)
        if key in route_bucket:
            route_bucket[key] = int(count or 0)
    return out


def _bulk_recent_logs(
    db: Session,
    stream_ids: list[int],
    *,
    start_at: datetime,
    end_at: datetime,
    per_stream_limit: int,
) -> dict[int, list[DeliveryLog]]:
    """Fetch recent logs per stream using bounded LATERAL lookups (no full-table window scan)."""

    if not stream_ids:
        return {}
    cap = max(1, min(int(per_stream_limit), _MAX_BULK_RECENT_LOGS_PER_STREAM))
    id_sql = text(
        """
        SELECT picked.id
        FROM unnest(CAST(:stream_ids AS integer[])) AS requested(stream_id)
        CROSS JOIN LATERAL (
            SELECT delivery_logs.id AS id
            FROM delivery_logs
            WHERE delivery_logs.stream_id = requested.stream_id
              AND delivery_logs.created_at >= :start_at
              AND delivery_logs.created_at < :end_at
            ORDER BY delivery_logs.created_at DESC, delivery_logs.id DESC
            LIMIT :per_stream_limit
        ) picked
        """
    )
    try:
        id_rows = db.execute(
            id_sql,
            {
                "stream_ids": stream_ids,
                "start_at": start_at,
                "end_at": end_at,
                "per_stream_limit": cap,
            },
        ).fetchall()
    except OperationalError:
        db.rollback()
        raise
    log_ids = [int(row[0]) for row in id_rows if row[0] is not None]
    if not log_ids:
        return {sid: [] for sid in stream_ids}
    logs = (
        db.query(DeliveryLog)
        .filter(DeliveryLog.id.in_(log_ids))
        .order_by(DeliveryLog.stream_id.asc(), DeliveryLog.created_at.asc(), DeliveryLog.id.asc())
        .all()
    )
    grouped: dict[int, list[DeliveryLog]] = {sid: [] for sid in stream_ids}
    for row in logs:
        if row.stream_id is None:
            continue
        grouped.setdefault(int(row.stream_id), []).append(row)
    return grouped


def _load_bulk_entities(
    db: Session,
    stream_ids: list[int],
) -> tuple[dict[int, Stream], dict[int, list[Route]], dict[int, Checkpoint | None]]:
    streams = db.query(Stream).filter(Stream.id.in_(stream_ids)).all()
    stream_by_id = {int(s.id): s for s in streams}
    routes = (
        db.query(Route)
        .options(joinedload(Route.destination))
        .filter(Route.stream_id.in_(stream_ids))
        .order_by(Route.stream_id.asc(), Route.id.asc())
        .all()
    )
    routes_by_stream: dict[int, list[Route]] = {sid: [] for sid in stream_ids}
    for route in routes:
        routes_by_stream.setdefault(int(route.stream_id), []).append(route)
    checkpoint_rows = db.query(Checkpoint).filter(Checkpoint.stream_id.in_(stream_ids)).all()
    checkpoints = {sid: None for sid in stream_ids}
    for cp in checkpoint_rows:
        checkpoints[int(cp.stream_id)] = cp
    return stream_by_id, routes_by_stream, checkpoints


def _checkpoint_payload(checkpoint: Checkpoint | None) -> CheckpointStatsPayload | None:
    if checkpoint is None:
        return None
    return CheckpointStatsPayload(
        type=checkpoint.checkpoint_type,
        value=checkpoint_read_view(checkpoint.checkpoint_value_json),
    )


def _entry_from_bundle(
    *,
    bundle: StreamRuntimeStatsHealthBundleResponse,
    events_window: int,
    events_24h: int,
    window_seconds: int,
) -> StreamStatsHealthBulkEntry:
    stats = bundle.stats
    health = bundle.health
    last_seen = stats.last_seen
    eps = round(float(events_window) / max(1, window_seconds), 6) if events_window > 0 else 0.0
    return StreamStatsHealthBulkEntry(
        events_per_second=eps,
        events_1h=events_window,
        events_24h=events_24h,
        health=_health_label(health.health),
        last_event_at=_last_event_at(last_seen),
        issue=_derive_issue(health=health),
        stats=stats,
        health_detail=health,
    )


def _build_from_delivery_logs_bulk(
    db: Session,
    stream_ids: list[int],
    limit: int,
    *,
    window: str,
    snapshot_id: str | None,
) -> BulkStreamStatsHealthResponse:
    until = _safe_bulk_until(snapshot_id)
    token_td = parse_metrics_window(window)
    since = until - token_td
    since, until = clamp_health_aggregate_window(since, until)
    day_since = until - timedelta(hours=24)
    day_since, _ = clamp_health_aggregate_window(day_since, until)
    window_seconds = max(1, int((until - since).total_seconds()))
    recent_log_cap = min(max(int(limit), 1), _MAX_BULK_RECENT_LOGS_PER_STREAM)

    stream_by_id, routes_by_stream, checkpoints = _load_bulk_entities(db, stream_ids)
    summaries = _bulk_summary_stage_counts(db, stream_ids, start_at=since, end_at=until)
    window_processed, day_processed = _bulk_processed_events(
        db,
        stream_ids,
        window_start=since,
        window_end=until,
        day_start=day_since,
    )
    route_counts = _bulk_route_stage_counts(db, stream_ids, start_at=since, end_at=until)
    logs_by_stream = _bulk_recent_logs(
        db,
        stream_ids,
        start_at=since,
        end_at=until,
        per_stream_limit=recent_log_cap,
    )

    stream_last, route_last = _load_snapshot_outcome_metadata(db, stream_ids)
    streams_out: dict[str, StreamStatsHealthBulkEntry] = {}
    for sid in stream_ids:
        stream = stream_by_id.get(sid)
        if stream is None:
            continue
        routes = routes_by_stream.get(sid, [])
        logs = logs_by_stream.get(sid, [])
        summary = summaries.get(sid, StreamRuntimeSummary())
        summary = summary.model_copy(update={"processed_events": window_processed.get(sid, 0)})
        counts_map = route_counts.get(sid, {})
        route_stats: list[RouteRuntimeStatsItem] = []
        for route in routes:
            dest = route.destination
            dest_type = str(dest.destination_type or "").strip().upper() if dest is not None else ""
            rid = int(route.id)
            acc = counts_map.get(rid, {k: 0 for k in _ROUTE_COUNT_FIELDS})
            route_stats.append(
                RouteRuntimeStatsItem(
                    route_id=rid,
                    destination_id=int(route.destination_id),
                    destination_type=dest_type,
                    enabled=bool(route.enabled),
                    failure_policy=str(route.failure_policy),
                    status=str(route.status),
                    counts=RouteRuntimeCounts(**acc),
                    last_success_at=_route_last_success(rid, logs),
                    last_failure_at=_route_last_failure(rid, logs),
                )
            )
        stats = StreamRuntimeStatsResponse(
            stream_id=sid,
            stream_status=str(stream.status),
            checkpoint=_checkpoint_payload(checkpoints.get(sid)),
            summary=summary,
            last_seen=_compute_last_seen(logs),
            routes=route_stats,
            recent_logs=_recent_log_items(logs[-recent_log_cap:] if len(logs) > recent_log_cap else logs),
        )
        route_items, health_summary = _build_route_health_items(logs, routes)
        stream_health = _compute_stream_health(logs, routes)
        health = StreamHealthResponse(
            stream_id=sid,
            stream_status=str(stream.status),
            health=cast(StreamHealthState, stream_health),
            limit=limit,
            summary=health_summary,
            routes=route_items,
        )
        stats = _merge_stats_outcome_metadata(stats, stream_last.get(sid), route_last)
        health = _merge_health_outcome_metadata(health, route_last)
        bundle = StreamRuntimeStatsHealthBundleResponse(stats=stats, health=health)
        streams_out[str(sid)] = _entry_from_bundle(
            bundle=bundle,
            events_window=window_processed.get(sid, 0),
            events_24h=day_processed.get(sid, 0),
            window_seconds=window_seconds,
        )

    return BulkStreamStatsHealthResponse(
        window=window,
        snapshot_id=_dashboard_snapshot_id(until),
        streams=streams_out,
    )


def _route_health_from_snapshots(
    routes: list[Route],
    route_snaps: dict[int, object],
    route_counts: dict[int, RouteRuntimeCounts] | None = None,
) -> tuple[list[RouteHealthItem], StreamHealthSummary]:
    """Same mapping as the single-stream snapshot read (ERROR -> UNHEALTHY, stats counts)."""

    from app.runtime.stream_runtime_snapshot_read import _route_health_from_snapshots as _single

    return _single(routes, route_snaps, route_counts)


def _build_from_runtime_snapshots(
    db: Session,
    stream_ids: list[int],
    limit: int,
    *,
    window: str,
    snapshot_id: str | None,
) -> BulkStreamStatsHealthResponse:
    """Use the physical model selected once by the request entry point."""

    from app.runtime.models import RuntimeRouteSnapshot, RuntimeStreamSnapshot
    from app.runtime.runtime_analytics_bucket_read_repository import (
        fetch_stream_processed_events_from_buckets,
        historical_analytics_available,
    )
    from app.runtime.runtime_snapshot_analytics_repository import _int_events, _operational_scale

    until = _safe_bulk_until(snapshot_id)
    token_td = parse_metrics_window(window)
    since = until - token_td
    since, until = clamp_health_aggregate_window(since, until)
    day_since = until - timedelta(hours=24)
    day_since, _ = clamp_health_aggregate_window(day_since, until)
    window_seconds = max(1, int((until - since).total_seconds()))
    scale = _operational_scale(window_seconds)
    day_scale = _operational_scale(24 * 3600)

    stream_by_id, routes_by_stream, checkpoints = _load_bulk_entities(db, stream_ids)
    stream_snaps = {
        int(r.stream_id): r
        for r in db.query(RuntimeStreamSnapshot).filter(RuntimeStreamSnapshot.stream_id.in_(stream_ids)).all()
    }
    route_snaps = {
        int(r.route_id): r
        for r in db.query(RuntimeRouteSnapshot).filter(RuntimeRouteSnapshot.stream_id.in_(stream_ids)).all()
    }

    # Processed events from analytics buckets when available; otherwise snapshot EPS proxy.
    window_processed: dict[int, int] = {}
    day_processed: dict[int, int] = {}
    if historical_analytics_available(db):
        for sid in stream_ids:
            window_processed[sid] = fetch_stream_processed_events_from_buckets(
                db,
                since=since,
                until=until,
                stream_id=sid,
                window_seconds=window_seconds,
            )
            day_processed[sid] = fetch_stream_processed_events_from_buckets(
                db,
                since=day_since,
                until=until,
                stream_id=sid,
                window_seconds=max(1, int((until - day_since).total_seconds())),
            )

    streams_out: dict[str, StreamStatsHealthBulkEntry] = {}
    for sid in stream_ids:
        stream = stream_by_id.get(sid)
        if stream is None:
            continue
        snap = stream_snaps.get(sid)
        routes = routes_by_stream.get(sid, [])
        route_rows = [route_snaps[r.id] for r in routes if r.id in route_snaps]

        send_success = sum(_int_events(float(r.delivered_eps_1m), 60) for r in route_rows)
        send_failed = sum(_int_events(float(r.failed_eps_1m), 60) for r in route_rows)
        send_success = int(round(send_success * scale))
        send_failed = int(round(send_failed * scale))

        processed_window = window_processed.get(sid)
        if processed_window is None:
            processed_window = int(round(_int_events(float(snap.eps_5m), 300) * scale)) if snap is not None else 0
        processed_24h = day_processed.get(sid)
        if processed_24h is None:
            processed_24h = int(round(_int_events(float(snap.eps_5m), 300) * day_scale)) if snap is not None else 0

        summary = StreamRuntimeSummary(
            processed_events=processed_window,
            route_send_success=send_success,
            route_send_failed=send_failed,
        )
        last_seen = StreamRuntimeLastSeen(
            success_at=snap.last_success_at if snap is not None else None,
            failure_at=snap.last_error_at if snap is not None else None,
        )
        route_stats: list[RouteRuntimeStatsItem] = []
        for route in routes:
            rs = route_snaps.get(int(route.id))
            dest = route.destination
            dest_type = str(dest.destination_type or "").strip().upper() if dest is not None else ""
            counts = RouteRuntimeCounts(
                route_send_success=_int_events(float(rs.delivered_eps_1m), 60) if rs is not None else 0,
                route_send_failed=_int_events(float(rs.failed_eps_1m), 60) if rs is not None else 0,
            )
            route_stats.append(
                RouteRuntimeStatsItem(
                    route_id=int(route.id),
                    destination_id=int(route.destination_id),
                    destination_type=dest_type,
                    enabled=bool(route.enabled),
                    failure_policy=str(route.failure_policy),
                    status=str(route.status),
                    counts=counts,
                    last_success_at=rs.last_success_at if rs is not None else None,
                    last_failure_at=rs.last_error_at if rs is not None else None,
                )
            )

        stats = StreamRuntimeStatsResponse(
            stream_id=sid,
            stream_status=str(stream.status),
            checkpoint=_checkpoint_payload(checkpoints.get(sid)),
            summary=summary,
            last_seen=last_seen,
            routes=route_stats,
            recent_logs=[],
        )
        from app.runtime.stream_runtime_snapshot_read import runtime_health_from_operational

        route_items, health_summary = _route_health_from_snapshots(
            routes,
            route_snaps,
            {item.route_id: item.counts for item in route_stats},
        )
        stream_health = runtime_health_from_operational(snap.health_status if snap is not None else "IDLE")
        health = StreamHealthResponse(
            stream_id=sid,
            stream_status=str(stream.status),
            health=cast(StreamHealthState, stream_health),
            limit=limit,
            summary=health_summary,
            routes=route_items,
        )
        bundle = StreamRuntimeStatsHealthBundleResponse(stats=stats, health=health)
        streams_out[str(sid)] = _entry_from_bundle(
            bundle=bundle,
            events_window=processed_window,
            events_24h=processed_24h,
            window_seconds=window_seconds,
        )

    return BulkStreamStatsHealthResponse(
        window=window,
        snapshot_id=_dashboard_snapshot_id(until),
        streams=streams_out,
    )


def _build_degraded_bulk_entry(
    *,
    sid: int,
    stream: Stream,
    routes: list[Route],
    checkpoints: dict[int, Checkpoint | None],
    limit: int,
) -> StreamStatsHealthBulkEntry:
    route_items: list[RouteHealthItem] = []
    disabled = idle = 0
    for route in routes:
        dest = route.destination
        dest_type = str(dest.destination_type or "").strip().upper() if dest is not None else ""
        dest_enabled = bool(dest.enabled) if dest is not None else False
        health_key: RouteHealthState = "DISABLED" if not bool(route.enabled) else "IDLE"
        if health_key == "DISABLED":
            disabled += 1
        else:
            idle += 1
        route_items.append(
            RouteHealthItem(
                route_id=int(route.id),
                destination_id=int(route.destination_id),
                destination_type=dest_type,
                route_enabled=bool(route.enabled),
                destination_enabled=dest_enabled,
                failure_policy=str(route.failure_policy),
                route_status=str(route.status),
                health=health_key,
                success_count=0,
                failure_count=0,
                rate_limited_count=0,
                consecutive_failure_count=0,
                last_success_at=None,
                last_failure_at=None,
                last_rate_limited_at=None,
                last_error_code=None,
                last_error_message=None,
            )
        )
    empty_summary = StreamRuntimeSummary()
    stats = StreamRuntimeStatsResponse(
        stream_id=sid,
        stream_status=str(stream.status),
        checkpoint=_checkpoint_payload(checkpoints.get(sid)),
        summary=empty_summary,
        last_seen=StreamRuntimeLastSeen(),
        routes=[],
        recent_logs=[],
    )
    health = StreamHealthResponse(
        stream_id=sid,
        stream_status=str(stream.status),
        health="DEGRADED",
        limit=limit,
        summary=StreamHealthSummary(
            total_routes=len(routes),
            healthy_routes=0,
            degraded_routes=0,
            unhealthy_routes=0,
            disabled_routes=disabled,
            idle_routes=idle,
        ),
        routes=route_items,
    )
    bundle = StreamRuntimeStatsHealthBundleResponse(stats=stats, health=health)
    return _entry_from_bundle(
        bundle=bundle,
        events_window=0,
        events_24h=0,
        window_seconds=1,
    )


def _build_degraded_bulk_response(
    db: Session,
    stream_ids: list[int],
    limit: int,
    *,
    window: str,
    snapshot_id: str | None,
) -> BulkStreamStatsHealthResponse:
    until = _safe_bulk_until(snapshot_id)
    stream_by_id, routes_by_stream, checkpoints = _load_bulk_entities(db, stream_ids)
    streams_out: dict[str, StreamStatsHealthBulkEntry] = {}
    for sid in stream_ids:
        stream = stream_by_id.get(sid)
        if stream is None:
            continue
        streams_out[str(sid)] = _build_degraded_bulk_entry(
            sid=sid,
            stream=stream,
            routes=routes_by_stream.get(sid, []),
            checkpoints=checkpoints,
            limit=limit,
        )
    return BulkStreamStatsHealthResponse(
        window=window,
        snapshot_id=_dashboard_snapshot_id(until),
        streams=streams_out,
    )


def get_bulk_stream_stats_health(
    db: Session,
    stream_ids: list[int],
    limit: int,
    *,
    window: str = "1h",
    snapshot_id: str | None = None,
) -> BulkStreamStatsHealthResponse:
    """Bulk stats-health for many streams with bounded SQL (no per-stream SELECT loops)."""

    if not stream_ids:
        return BulkStreamStatsHealthResponse(window=window, snapshot_id=None, streams={})

    try:
        from app.runtime.runtime_snapshot_analytics_repository import snapshot_analytics_available

        if snapshot_analytics_available(db):
            return _build_from_runtime_snapshots(
                db,
                stream_ids,
                limit,
                window=window,
                snapshot_id=snapshot_id,
            )
        return _build_from_delivery_logs_bulk(db, stream_ids, limit, window=window, snapshot_id=snapshot_id)
    except (OperationalError, ValueError):
        db.rollback()
        logger.warning("bulk_stats_health_degraded stream_ids=%s", stream_ids[:5])
        return _build_degraded_bulk_response(
            db,
            stream_ids,
            limit,
            window=window,
            snapshot_id=snapshot_id,
        )
    except Exception:
        logger.exception("bulk_stats_health_degraded stream_ids=%s", stream_ids[:5])
        return _build_degraded_bulk_response(
            db,
            stream_ids,
            limit,
            window=window,
            snapshot_id=snapshot_id,
        )
