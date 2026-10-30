"""Single-stream runtime reads from operational snapshots and analytics buckets.

No ``delivery_logs`` COUNT/GROUP BY on the primary read path. Forensic top-N row
fetches (recent runs/errors) may still touch ``delivery_logs`` when explicitly
requested.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, cast

from sqlalchemy.orm import Session, joinedload

from app.checkpoints.models import Checkpoint
from app.logs.aggregates import dense_route_trend_series, dense_stream_delivery_buckets
from app.logs.models import DeliveryLog
from app.routes.models import Route
from app.runtime.health_repository import clamp_health_aggregate_window
from app.runtime.metrics_window import (
    OPERATIONAL_WINDOWS,
    bucket_seconds_for_window,
    max_buckets_for_window,
    normalize_metrics_window_token,
    parse_metrics_window,
)
from app.runtime.metric_contract import metric_meta_map
from app.runtime.models import RuntimeRouteSnapshot, RuntimeStreamSnapshot
from app.runtime.read_service import (
    StreamNotFoundError,
    _dashboard_snapshot_id,
    _dashboard_snapshot_time,
)
from app.runtime.runtime_analytics_bucket_read_repository import (
    RouteTrendBucketStatsRow,
    RouteWindowBucketStatsRow,
    StreamScopedDeliveryBucketRow,
    fetch_latency_from_buckets,
    fetch_route_trend_buckets_from_buckets,
    fetch_route_window_stats_from_buckets,
    fetch_stream_processed_events_from_buckets,
    fetch_stream_scoped_outcome_buckets,
)
from app.runtime.runtime_snapshot_analytics_repository import (
    _int_events,
    _operational_scale,
)
from app.runtime.copy_utils import checkpoint_read_view
from app.runtime.schemas import (
    CheckpointStatsPayload,
    RecentRouteErrorItem,
    RouteHealthItem,
    RouteHealthState,
    RouteRuntimeCounts,
    RouteRuntimeLatencyTrendPoint,
    RouteRuntimeMetricsRow,
    RouteRuntimeSuccessRateTrendPoint,
    RouteRuntimeStatsItem,
    StreamHealthResponse,
    StreamHealthState,
    StreamHealthSummary,
    StreamMetricsCheckpoint,
    StreamMetricsCheckpointHistoryItem,
    StreamMetricsRecentRun,
    StreamMetricsRouteHealthRow,
    StreamMetricsStreamBlock,
    StreamMetricsTimeBucket,
    StreamRuntimeKpis,
    StreamRuntimeLastSeen,
    StreamRuntimeMetricsResponse,
    StreamRuntimeStatsHealthBundleResponse,
    StreamRuntimeStatsResponse,
    StreamRuntimeSummary,
    LatencyTimePoint,
    ThroughputTimePoint,
)
from app.runtime.visualization_contract import bucket_meta, visualization_meta_map
from app.streams.models import Stream

logger = logging.getLogger(__name__)

UTC = timezone.utc
_FAILURE_STAGES = frozenset({"route_send_failed", "route_retry_failed", "route_unknown_failure_policy"})
_TREND_BUCKETS = 12


def stream_runtime_snapshot_read_enabled(db: Session) -> bool:
    from app.runtime.runtime_snapshot_analytics_repository import snapshot_analytics_available

    return snapshot_analytics_available(db)


def _checkpoint_payload(row: Checkpoint | None) -> CheckpointStatsPayload | None:
    if row is None:
        return None
    return CheckpointStatsPayload(
        type=row.checkpoint_type,
        value=checkpoint_read_view(row.checkpoint_value_json),
    )


def _route_health_from_snapshots(
    routes: list[Route],
    route_snaps: dict[int, RuntimeRouteSnapshot],
) -> tuple[list[RouteHealthItem], StreamHealthSummary]:
    bucket = {"HEALTHY": 0, "DEGRADED": 0, "UNHEALTHY": 0, "DISABLED": 0, "IDLE": 0}
    items: list[RouteHealthItem] = []
    for route in routes:
        snap = route_snaps.get(int(route.id))
        dest = route.destination
        dest_type = str(dest.destination_type or "").strip().upper() if dest is not None else ""
        dest_enabled = bool(dest.enabled) if dest is not None else False
        if not bool(route.enabled):
            health_key = "DISABLED"
        elif snap is None:
            health_key = "IDLE"
        else:
            health_key = str(snap.health_status or "IDLE").upper()
            if health_key not in bucket:
                health_key = "IDLE"
        bucket[health_key] += 1
        items.append(
            RouteHealthItem(
                route_id=int(route.id),
                destination_id=int(route.destination_id),
                destination_type=dest_type,
                route_enabled=bool(route.enabled),
                destination_enabled=dest_enabled,
                failure_policy=str(route.failure_policy),
                route_status=str(route.status),
                health=cast(RouteHealthState, health_key),
                success_count=0,
                failure_count=0,
                rate_limited_count=0,
                consecutive_failure_count=0,
                last_success_at=snap.last_success_at if snap is not None else None,
                last_failure_at=snap.last_error_at if snap is not None else None,
                last_rate_limited_at=None,
                last_error_code=None,
                last_error_message=snap.last_error_message if snap is not None else None,
            )
        )
    summary = StreamHealthSummary(
        total_routes=len(routes),
        healthy_routes=bucket["HEALTHY"],
        degraded_routes=bucket["DEGRADED"],
        unhealthy_routes=bucket["UNHEALTHY"],
        disabled_routes=bucket["DISABLED"],
        idle_routes=bucket["IDLE"],
    )
    return items, summary


def _scaled_route_counts(
    snap: RuntimeRouteSnapshot | None,
    *,
    scale: float,
) -> RouteRuntimeCounts:
    if snap is None:
        return RouteRuntimeCounts()
    return RouteRuntimeCounts(
        route_send_success=int(round(_int_events(float(snap.delivered_eps_1m), 60) * scale)),
        route_send_failed=int(round(_int_events(float(snap.failed_eps_1m), 60) * scale)),
    )


def build_stream_stats_health_from_snapshot(
    db: Session,
    stream_id: int,
    limit: int,
    *,
    window: str | None = None,
    snapshot_id: str | None = None,
) -> StreamRuntimeStatsHealthBundleResponse | None:
    """Stats + health from ``runtime_*_snapshot`` when the read model is populated."""

    if not stream_runtime_snapshot_read_enabled(db):
        return None

    stream = db.query(Stream).filter(Stream.id == stream_id).first()
    if stream is None:
        raise StreamNotFoundError(stream_id)

    token = normalize_metrics_window_token(window) if window is not None else "1h"
    until = _dashboard_snapshot_time(snapshot_id)
    token_td = parse_metrics_window(token)
    since = until - token_td
    since, until = clamp_health_aggregate_window(since, until)
    window_seconds = max(1, int((until - since).total_seconds()))
    scale = _operational_scale(window_seconds)

    stream_snap = db.query(RuntimeStreamSnapshot).filter(RuntimeStreamSnapshot.stream_id == stream_id).first()
    route_snaps = {
        int(r.route_id): r
        for r in db.query(RuntimeRouteSnapshot).filter(RuntimeRouteSnapshot.stream_id == stream_id).all()
    }
    routes = (
        db.query(Route)
        .options(joinedload(Route.destination))
        .filter(Route.stream_id == stream_id)
        .order_by(Route.id.asc())
        .all()
    )
    checkpoint_row = db.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).first()

    route_rows = [route_snaps[r.id] for r in routes if r.id in route_snaps]
    send_success = sum(_int_events(float(r.delivered_eps_1m), 60) for r in route_rows)
    send_failed = sum(_int_events(float(r.failed_eps_1m), 60) for r in route_rows)
    send_success = int(round(send_success * scale))
    send_failed = int(round(send_failed * scale))

    processed_window = 0
    from app.runtime.runtime_analytics_bucket_read_repository import historical_analytics_available

    if historical_analytics_available(db):
        processed_window = fetch_stream_processed_events_from_buckets(
            db,
            since=since,
            until=until,
            stream_id=stream_id,
            window_seconds=window_seconds,
        )
    elif stream_snap is not None:
        processed_window = int(round(_int_events(float(stream_snap.eps_5m), 300) * scale))

    summary = StreamRuntimeSummary(
        processed_events=processed_window,
        route_send_success=send_success,
        route_send_failed=send_failed,
    )
    last_seen = StreamRuntimeLastSeen(
        success_at=stream_snap.last_success_at if stream_snap is not None else None,
        failure_at=stream_snap.last_error_at if stream_snap is not None else None,
    )
    route_stats: list[RouteRuntimeStatsItem] = []
    for route in routes:
        rs = route_snaps.get(int(route.id))
        dest = route.destination
        dest_type = str(dest.destination_type or "").strip().upper() if dest is not None else ""
        route_stats.append(
            RouteRuntimeStatsItem(
                route_id=int(route.id),
                destination_id=int(route.destination_id),
                destination_type=dest_type,
                enabled=bool(route.enabled),
                failure_policy=str(route.failure_policy),
                status=str(route.status),
                counts=_scaled_route_counts(rs, scale=scale),
                last_success_at=rs.last_success_at if rs is not None else None,
                last_failure_at=rs.last_error_at if rs is not None else None,
            )
        )

    stats = StreamRuntimeStatsResponse(
        stream_id=int(stream.id),
        stream_status=str(stream.status),
        checkpoint=_checkpoint_payload(checkpoint_row),
        summary=summary,
        last_seen=last_seen,
        routes=route_stats,
        recent_logs=[],
    )
    route_items, health_summary = _route_health_from_snapshots(routes, route_snaps)
    stream_health = stream_snap.health_status if stream_snap is not None else "IDLE"
    if stream_health not in ("HEALTHY", "DEGRADED", "UNHEALTHY", "IDLE"):
        stream_health = "IDLE"
    health = StreamHealthResponse(
        stream_id=int(stream.id),
        stream_status=str(stream.status),
        health=cast(StreamHealthState, stream_health),
        limit=limit,
        summary=health_summary,
        routes=route_items,
    )
    return StreamRuntimeStatsHealthBundleResponse(stats=stats, health=health)


def _route_connectivity_state(
    *,
    route_enabled: bool,
    destination_enabled: bool,
    route_status: str,
    delivered_ev: int,
    failed_ev: int,
) -> Literal["HEALTHY", "DEGRADED", "ERROR", "DISABLED"]:
    rs = str(route_status or "").strip().upper()
    if not route_enabled or not destination_enabled or rs != "ENABLED":
        return "DISABLED"
    if failed_ev <= 0:
        return "HEALTHY"
    if delivered_ev <= 0:
        return "ERROR"
    return "DEGRADED"


def _checkpoint_preview(value: dict[str, Any]) -> str:
    import json

    try:
        s = json.dumps(value, default=str, separators=(",", ":"))
    except (TypeError, ValueError):
        s = str(value)
    if len(s) > 160:
        return f"{s[:157]}…"
    return s


def _obs_row_payload(payload_raw: object) -> dict[str, Any]:
    return payload_raw if isinstance(payload_raw, dict) else {}


def _payload_int(ps: dict[str, Any], key: str) -> int:
    v = ps.get(key)
    if isinstance(v, bool):
        return 0
    if isinstance(v, int):
        return max(0, v)
    if isinstance(v, float) and v.is_integer():
        return max(0, int(v))
    try:
        if v is not None:
            return max(0, int(v))
    except (TypeError, ValueError):
        pass
    return 0


def _sparse_buckets_to_stream_rows(
    rows: list[StreamScopedDeliveryBucketRow],
) -> list[Any]:
    from app.logs.aggregates import StreamBucketRow

    return [
        StreamBucketRow(
            bucket_start=r.bucket_start,
            events=r.events,
            delivered=r.delivered,
            failed=r.failed,
            avg_latency_ms=r.avg_latency_ms,
        )
        for r in rows
    ]


def _trend_rows_to_dense(
    trend_rows: list[RouteTrendBucketStatsRow],
    *,
    route_id: int,
    start_at: datetime,
    end_at: datetime,
    bucket_seconds: int,
    max_buckets: int,
) -> list[Any]:
    from app.logs.aggregates import RouteTrendBucketRow

    adapted = [
        RouteTrendBucketRow(
            route_id=row.route_id,
            bucket_start=row.bucket_start,
            avg_latency_ms=row.avg_latency_ms,
            delivered_events=row.delivered_events,
            failed_events=row.failed_events,
        )
        for row in trend_rows
        if row.route_id == route_id
    ]
    return dense_route_trend_series(
        adapted,
        route_id=route_id,
        start_at=start_at,
        end_at=end_at,
        bucket_seconds=bucket_seconds,
        max_buckets=max_buckets,
    )


def _append_forensic_panels(
    db: Session,
    *,
    stream_id: int,
    since: datetime,
    until: datetime,
    routes: list[Route],
    response: StreamRuntimeMetricsResponse,
) -> StreamRuntimeMetricsResponse:
    route_dest_names: dict[int, str] = {}
    for route in routes:
        dest = route.destination
        route_dest_names[int(route.id)] = (
            str(dest.name).strip() if dest is not None and dest.name else f"Destination #{route.destination_id}"
        )

    fail_rows = (
        db.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.created_at >= since,
            DeliveryLog.created_at < until,
            DeliveryLog.stage.in_(_FAILURE_STAGES),
        )
        .order_by(DeliveryLog.created_at.desc())
        .limit(40)
        .all()
    )
    recent_route_errors: list[RecentRouteErrorItem] = []
    for row in fail_rows:
        if row.route_id is None:
            continue
        rid = int(row.route_id)
        recent_route_errors.append(
            RecentRouteErrorItem(
                created_at=row.created_at,
                route_id=rid,
                destination_id=int(row.destination_id) if row.destination_id is not None else None,
                destination_name=route_dest_names.get(rid, f"Destination #{row.destination_id or '?'}"),
                error_code=str(row.error_code) if row.error_code else None,
                message=str(row.message),
            )
        )

    recent_runs: list[StreamMetricsRecentRun] = []
    completes = (
        db.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.stage == "run_complete",
            DeliveryLog.created_at >= since,
            DeliveryLog.created_at < until,
        )
        .order_by(DeliveryLog.created_at.desc())
        .limit(25)
        .all()
    )
    for row in completes:
        ps = _obs_row_payload(row.payload_sample)
        inp = _payload_int(ps, "input_events")
        succ = _payload_int(ps, "success_events")
        if succ <= 0:
            succ = _payload_int(ps, "delivered_event_count")
        failed = max(0, inp - succ) if inp > 0 else 0
        if inp <= 0:
            run_status: Literal["SUCCESS", "PARTIAL", "FAILED", "NO_EVENTS"] = "NO_EVENTS"
        elif succ >= inp:
            run_status = "SUCCESS"
        elif succ > 0:
            run_status = "PARTIAL"
        else:
            run_status = "FAILED"
        recent_runs.append(
            StreamMetricsRecentRun(
                run_id=f"run-{row.id}",
                started_at=row.created_at,
                duration_ms=0,
                status=run_status,
                events=int(inp),
                delivered=int(succ),
                failed=int(failed),
            )
        )
    return response.model_copy(
        update={
            "recent_route_errors": recent_route_errors,
            "recent_runs": recent_runs,
        }
    )


def _build_metrics_from_buckets(
    db: Session,
    stream: Stream,
    routes: list[Route],
    *,
    window: str,
    snapshot_id: str | None,
    since: datetime,
    until: datetime,
    window_seconds: int,
    checkpoint_row: Checkpoint | None,
    stream_snap: RuntimeStreamSnapshot | None,
    route_snaps: dict[int, RuntimeRouteSnapshot],
) -> StreamRuntimeMetricsResponse:
    now = _dashboard_snapshot_time(snapshot_id)
    resolved_snapshot_id = _dashboard_snapshot_id(now)
    clamped_td = timedelta(seconds=window_seconds)
    bucket_sec = bucket_seconds_for_window(clamped_td)

    sparse = fetch_stream_scoped_outcome_buckets(
        db,
        since=since,
        until=until,
        stream_id=int(stream.id),
        window_seconds=window_seconds,
    )
    stream_buckets = dense_stream_delivery_buckets(
        _sparse_buckets_to_stream_rows(sparse),
        start_at=since,
        end_at=until,
        bucket_seconds=bucket_sec,
        max_buckets=max_buckets_for_window(clamped_td, bucket_sec),
    )

    events_over_time: list[StreamMetricsTimeBucket] = []
    throughput_over_time: list[ThroughputTimePoint] = []
    latency_over_time: list[LatencyTimePoint] = []
    for bucket in stream_buckets:
        eps = float(bucket.delivered) / float(bucket_sec) if bucket_sec > 0 else 0.0
        events_over_time.append(
            StreamMetricsTimeBucket(
                timestamp=bucket.bucket_start,
                events=int(bucket.events),
                delivered=int(bucket.delivered),
                failed=int(bucket.failed),
            )
        )
        throughput_over_time.append(
            ThroughputTimePoint(timestamp=bucket.bucket_start, events_per_sec=round(eps, 6))
        )
        latency_over_time.append(
            LatencyTimePoint(timestamp=bucket.bucket_start, avg_latency_ms=round(float(bucket.avg_latency_ms), 3))
        )

    processed_events = fetch_stream_processed_events_from_buckets(
        db,
        since=since,
        until=until,
        stream_id=int(stream.id),
        window_seconds=window_seconds,
    )

    route_bucket_stats = {
        row.route_id: row
        for row in fetch_route_window_stats_from_buckets(
            db,
            since=since,
            until=until,
            stream_id=int(stream.id),
            window_seconds=window_seconds,
        )
    }
    failed_total = sum(row.failure_count for row in route_bucket_stats.values())
    delivered_total = sum(row.success_count for row in route_bucket_stats.values())
    delivery_total = delivered_total + failed_total
    delivery_success_rate = round(100.0 * delivered_total / delivery_total, 1) if delivery_total > 0 else None
    error_rate = round(100.0 * failed_total / delivery_total, 1) if delivery_total > 0 else 0.0

    avg_latency_ms, max_latency_ms = fetch_latency_from_buckets(
        db,
        since=since,
        until=until,
        stream_id=int(stream.id),
        route_id=None,
        destination_id=None,
        window_seconds=window_seconds,
    )

    kpis = StreamRuntimeKpis(
        events_last_hour=int(processed_events),
        delivered_last_hour=int(delivered_total),
        failed_last_hour=int(failed_total),
        delivery_success_rate=delivery_success_rate,
        avg_latency_ms=float(round(avg_latency_ms or 0.0, 1)),
        max_latency_ms=float(max_latency_ms or 0.0),
        error_rate=float(error_rate),
        metric_meta=metric_meta_map(
            "processed_events.window",
            "delivery_outcomes.window",
            "delivery_outcomes.success",
            "delivery_outcomes.failure",
            window_start=since,
            window_end=until,
            generated_at=until,
        ),
    )

    last_cp: StreamMetricsCheckpoint | None = None
    checkpoint_history: list[StreamMetricsCheckpointHistoryItem] = []
    if checkpoint_row is not None:
        val = checkpoint_read_view(checkpoint_row.checkpoint_value_json)
        last_cp = StreamMetricsCheckpoint(type=str(checkpoint_row.checkpoint_type), value=val)
        checkpoint_history.append(
            StreamMetricsCheckpointHistoryItem(
                updated_at=checkpoint_row.updated_at,
                checkpoint_preview=_checkpoint_preview(val),
            )
        )

    last_run_at = stream_snap.updated_at if stream_snap is not None else None
    last_success_at = stream_snap.last_success_at if stream_snap is not None else None
    last_error_at = stream_snap.last_error_at if stream_snap is not None else None

    trend_bucket_sec = max(60, window_seconds // _TREND_BUCKETS)
    trend_rows = fetch_route_trend_buckets_from_buckets(
        db,
        since=since,
        until=until,
        stream_id=int(stream.id),
        bucket_seconds=trend_bucket_sec,
        window_seconds=window_seconds,
    )
    mb_trend = min(_TREND_BUCKETS, max_buckets_for_window(clamped_td, trend_bucket_sec))

    route_health_rows: list[StreamMetricsRouteHealthRow] = []
    route_runtime_rows: list[RouteRuntimeMetricsRow] = []
    for route in routes:
        rid = int(route.id)
        dest = route.destination
        dest_name = str(dest.name).strip() if dest is not None and dest.name else f"Destination #{route.destination_id}"
        dest_type = str(dest.destination_type or "").strip().upper() if dest is not None else ""
        dest_enabled = bool(dest.enabled) if dest is not None else False
        rs = route_bucket_stats.get(rid)
        route_snap = route_snaps.get(rid)
        delivered_ev = int(rs.success_count) if rs else 0
        failed_ev = int(rs.failure_count) if rs else 0
        events_total = delivered_ev + failed_ev
        success_rate = 100.0 if events_total <= 0 else round(100.0 * delivered_ev / events_total, 1)
        lsucc = route_snap.last_success_at if route_snap is not None else None
        lfail = route_snap.last_error_at if route_snap is not None else None
        r_avg_lat = round(float(rs.avg_latency_ms), 1) if rs and rs.avg_latency_ms is not None else 0.0
        r_max_lat = float(rs.max_latency_ms or 0.0) if rs else 0.0
        retry_count = int(rs.retry_count) if rs else 0
        eps_current = round(delivered_ev / float(window_seconds), 6) if window_seconds > 0 else 0.0
        tr_list = _trend_rows_to_dense(
            trend_rows,
            route_id=rid,
            start_at=since,
            end_at=until,
            bucket_seconds=trend_bucket_sec,
            max_buckets=mb_trend,
        )
        latency_trend = [
            RouteRuntimeLatencyTrendPoint(timestamp=tr.bucket_start, avg_latency_ms=round(tr.avg_latency_ms, 1))
            for tr in tr_list
        ]
        success_rate_trend = []
        for tr in tr_list:
            tot_b = tr.delivered_events + tr.failed_events
            sr_b = 100.0 if tot_b <= 0 else round(100.0 * tr.delivered_events / tot_b, 1)
            success_rate_trend.append(
                RouteRuntimeSuccessRateTrendPoint(timestamp=tr.bucket_start, success_rate=sr_b)
            )
        connectivity = _route_connectivity_state(
            route_enabled=bool(route.enabled),
            destination_enabled=dest_enabled,
            route_status=str(route.status),
            delivered_ev=delivered_ev,
            failed_ev=failed_ev,
        )
        last_err_msg = route_snap.last_error_message if route_snap is not None else None
        route_runtime_rows.append(
            RouteRuntimeMetricsRow(
                route_id=rid,
                destination_id=int(route.destination_id),
                destination_name=dest_name,
                destination_type=dest_type,
                enabled=bool(route.enabled),
                route_status=str(route.status),
                success_rate=float(success_rate),
                events_last_hour=int(events_total),
                delivered_last_hour=int(delivered_ev),
                failed_last_hour=int(failed_ev),
                avg_latency_ms=float(r_avg_lat),
                p95_latency_ms=float(r_max_lat),
                max_latency_ms=float(r_max_lat),
                eps_current=float(eps_current),
                retry_count_last_hour=int(retry_count),
                last_success_at=lsucc,
                last_failure_at=lfail,
                last_error_message=last_err_msg,
                last_error_code=None,
                failure_policy=str(route.failure_policy),
                connectivity_state=connectivity,
                disable_reason=str(route.disable_reason).strip() if route.disable_reason else None,
                latency_trend=latency_trend,
                success_rate_trend=success_rate_trend,
            )
        )
        route_health_rows.append(
            StreamMetricsRouteHealthRow(
                route_id=rid,
                destination_name=dest_name,
                destination_type=dest_type,
                enabled=bool(route.enabled),
                success_count=int(rs.success_count) if rs else 0,
                failed_count=int(rs.failure_count) if rs else 0,
                last_success_at=lsucc,
                last_failure_at=lfail,
                avg_latency_ms=float(r_avg_lat),
                failure_policy=str(route.failure_policy),
                last_error_message=last_err_msg,
            )
        )

    stream_block = StreamMetricsStreamBlock(
        id=int(stream.id),
        name=str(stream.name),
        status=str(stream.status),
        last_run_at=last_run_at,
        last_success_at=last_success_at,
        last_error_at=last_error_at,
        last_checkpoint=last_cp,
    )
    bm = bucket_meta(bucket_sec, len(stream_buckets))
    response = StreamRuntimeMetricsResponse(
        snapshot_id=resolved_snapshot_id,
        generated_at=now,
        stream=stream_block,
        kpis=kpis,
        metrics_window_seconds=int(window_seconds),
        window_start=since,
        window_end=until,
        metric_meta=metric_meta_map(
            "processed_events.window",
            "delivery_outcomes.window",
            "runtime.throughput.processed_events_per_second",
            "routes.throughput.delivery_outcomes_per_second",
            window_start=since,
            window_end=until,
            generated_at=until,
        ),
        visualization_meta=visualization_meta_map(
            "stream.processed_events.bucket_count",
            "stream.delivery_outcomes.bucket_count",
            "routes.throughput.bucket_eps",
            "routes.success_rate.bucket_ratio",
            "routes.latency.bucket_avg_ms",
            bucket_size_seconds=bucket_sec,
            bucket_count=len(stream_buckets),
            snapshot_id=resolved_snapshot_id,
            generated_at=now,
            window_start=since,
            window_end=until,
        ),
        bucket_size_seconds=bm["bucket_size_seconds"],
        bucket_count=bm["bucket_count"],
        bucket_alignment=bm["bucket_alignment"],
        bucket_timezone=bm["bucket_timezone"],
        bucket_mode=bm["bucket_mode"],
        events_over_time=events_over_time,
        throughput_over_time=throughput_over_time,
        latency_over_time=latency_over_time,
        route_health=route_health_rows,
        checkpoint_history=checkpoint_history,
        recent_runs=[],
        route_runtime=route_runtime_rows,
        recent_route_errors=[],
    )
    return _append_forensic_panels(
        db,
        stream_id=int(stream.id),
        since=since,
        until=until,
        routes=routes,
        response=response,
    )


def _build_metrics_from_operational_snapshot(
    db: Session,
    stream: Stream,
    routes: list[Route],
    *,
    window: str,
    snapshot_id: str | None,
    since: datetime,
    until: datetime,
    window_seconds: int,
    checkpoint_row: Checkpoint | None,
    stream_snap: RuntimeStreamSnapshot | None,
    route_snaps: dict[int, RuntimeRouteSnapshot],
) -> StreamRuntimeMetricsResponse:
    now = _dashboard_snapshot_time(snapshot_id)
    resolved_snapshot_id = _dashboard_snapshot_id(now)
    scale = _operational_scale(window_seconds)
    delivered_total = 0
    failed_total = 0
    for route in routes:
        rs = route_snaps.get(int(route.id))
        if rs is None:
            continue
        delivered_total += int(round(_int_events(float(rs.delivered_eps_1m), 60) * scale))
        failed_total += int(round(_int_events(float(rs.failed_eps_1m), 60) * scale))
    processed_events = 0
    if stream_snap is not None:
        processed_events = int(round(_int_events(float(stream_snap.eps_5m), 300) * scale))
    delivery_total = delivered_total + failed_total
    delivery_success_rate = round(100.0 * delivered_total / delivery_total, 1) if delivery_total > 0 else None
    error_rate = round(100.0 * failed_total / delivery_total, 1) if delivery_total > 0 else 0.0
    avg_latency_ms = float(stream_snap.avg_latency_ms or 0.0) if stream_snap is not None else 0.0

    last_cp: StreamMetricsCheckpoint | None = None
    checkpoint_history: list[StreamMetricsCheckpointHistoryItem] = []
    if checkpoint_row is not None:
        val = checkpoint_read_view(checkpoint_row.checkpoint_value_json)
        last_cp = StreamMetricsCheckpoint(type=str(checkpoint_row.checkpoint_type), value=val)
        checkpoint_history.append(
            StreamMetricsCheckpointHistoryItem(
                updated_at=checkpoint_row.updated_at,
                checkpoint_preview=_checkpoint_preview(val),
            )
        )

    route_health_rows: list[StreamMetricsRouteHealthRow] = []
    route_runtime_rows: list[RouteRuntimeMetricsRow] = []
    for route in routes:
        rid = int(route.id)
        dest = route.destination
        dest_name = str(dest.name).strip() if dest is not None and dest.name else f"Destination #{route.destination_id}"
        dest_type = str(dest.destination_type or "").strip().upper() if dest is not None else ""
        dest_enabled = bool(dest.enabled) if dest is not None else False
        rs = route_snaps.get(rid)
        delivered_ev = int(round(_int_events(float(rs.delivered_eps_1m), 60) * scale)) if rs else 0
        failed_ev = int(round(_int_events(float(rs.failed_eps_1m), 60) * scale)) if rs else 0
        events_total = delivered_ev + failed_ev
        success_rate = 100.0 if events_total <= 0 else round(100.0 * delivered_ev / events_total, 1)
        r_avg_lat = round(float(rs.avg_latency_ms), 1) if rs and rs.avg_latency_ms is not None else 0.0
        route_runtime_rows.append(
            RouteRuntimeMetricsRow(
                route_id=rid,
                destination_id=int(route.destination_id),
                destination_name=dest_name,
                destination_type=dest_type,
                enabled=bool(route.enabled),
                route_status=str(route.status),
                success_rate=float(success_rate),
                events_last_hour=int(events_total),
                delivered_last_hour=int(delivered_ev),
                failed_last_hour=int(failed_ev),
                avg_latency_ms=float(r_avg_lat),
                p95_latency_ms=float(r_avg_lat),
                max_latency_ms=float(r_avg_lat),
                eps_current=round(delivered_ev / float(window_seconds), 6) if window_seconds > 0 else 0.0,
                retry_count_last_hour=0,
                last_success_at=rs.last_success_at if rs is not None else None,
                last_failure_at=rs.last_error_at if rs is not None else None,
                last_error_message=rs.last_error_message if rs is not None else None,
                last_error_code=None,
                failure_policy=str(route.failure_policy),
                connectivity_state=_route_connectivity_state(
                    route_enabled=bool(route.enabled),
                    destination_enabled=dest_enabled,
                    route_status=str(route.status),
                    delivered_ev=delivered_ev,
                    failed_ev=failed_ev,
                ),
                disable_reason=str(route.disable_reason).strip() if route.disable_reason else None,
                latency_trend=[],
                success_rate_trend=[],
            )
        )
        route_health_rows.append(
            StreamMetricsRouteHealthRow(
                route_id=rid,
                destination_name=dest_name,
                destination_type=dest_type,
                enabled=bool(route.enabled),
                success_count=delivered_ev,
                failed_count=failed_ev,
                last_success_at=rs.last_success_at if rs is not None else None,
                last_failure_at=rs.last_error_at if rs is not None else None,
                avg_latency_ms=float(r_avg_lat),
                failure_policy=str(route.failure_policy),
                last_error_message=rs.last_error_message if rs is not None else None,
            )
        )

    kpis = StreamRuntimeKpis(
        events_last_hour=int(processed_events),
        delivered_last_hour=int(delivered_total),
        failed_last_hour=int(failed_total),
        delivery_success_rate=delivery_success_rate,
        avg_latency_ms=float(avg_latency_ms),
        max_latency_ms=float(avg_latency_ms),
        error_rate=float(error_rate),
        metric_meta=metric_meta_map(
            "processed_events.window",
            "delivery_outcomes.window",
            "delivery_outcomes.success",
            "delivery_outcomes.failure",
            window_start=since,
            window_end=until,
            generated_at=until,
        ),
    )
    stream_block = StreamMetricsStreamBlock(
        id=int(stream.id),
        name=str(stream.name),
        status=str(stream.status),
        last_run_at=stream_snap.updated_at if stream_snap is not None else None,
        last_success_at=stream_snap.last_success_at if stream_snap is not None else None,
        last_error_at=stream_snap.last_error_at if stream_snap is not None else None,
        last_checkpoint=last_cp,
    )
    bucket_sec = bucket_seconds_for_window(timedelta(seconds=window_seconds))
    response = StreamRuntimeMetricsResponse(
        snapshot_id=resolved_snapshot_id,
        generated_at=now,
        stream=stream_block,
        kpis=kpis,
        metrics_window_seconds=int(window_seconds),
        window_start=since,
        window_end=until,
        metric_meta=metric_meta_map(
            "processed_events.window",
            "delivery_outcomes.window",
            "runtime.throughput.processed_events_per_second",
            "routes.throughput.delivery_outcomes_per_second",
            window_start=since,
            window_end=until,
            generated_at=until,
        ),
        visualization_meta=visualization_meta_map(
            "stream.processed_events.bucket_count",
            "stream.delivery_outcomes.bucket_count",
            "routes.throughput.bucket_eps",
            "routes.success_rate.bucket_ratio",
            "routes.latency.bucket_avg_ms",
            bucket_size_seconds=bucket_sec,
            bucket_count=0,
            snapshot_id=resolved_snapshot_id,
            generated_at=now,
            window_start=since,
            window_end=until,
        ),
        bucket_size_seconds=bucket_sec,
        bucket_count=0,
        bucket_alignment="window_floor_epoch",
        bucket_timezone="UTC",
        bucket_mode="fixed_window",
        events_over_time=[],
        throughput_over_time=[],
        latency_over_time=[],
        route_health=route_health_rows,
        checkpoint_history=checkpoint_history,
        recent_runs=[],
        route_runtime=route_runtime_rows,
        recent_route_errors=[],
    )
    return _append_forensic_panels(
        db,
        stream_id=int(stream.id),
        since=since,
        until=until,
        routes=routes,
        response=response,
    )


def try_build_stream_runtime_metrics(
    db: Session,
    stream_id: int,
    *,
    window: str = "1h",
    snapshot_id: str | None = None,
) -> StreamRuntimeMetricsResponse | None:
    """Build stream metrics from buckets or operational snapshots (no delivery_logs aggregates)."""

    stream = db.query(Stream).filter(Stream.id == stream_id).first()
    if stream is None:
        raise StreamNotFoundError(stream_id)

    token = normalize_metrics_window_token(window)
    td = parse_metrics_window(token)
    now = _dashboard_snapshot_time(snapshot_id)
    since = now - td
    since, until = clamp_health_aggregate_window(since, now)
    window_seconds = max(1, int((until - since).total_seconds()))

    routes = (
        db.query(Route)
        .options(joinedload(Route.destination))
        .filter(Route.stream_id == stream_id)
        .order_by(Route.id.asc())
        .all()
    )
    checkpoint_row = db.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).first()
    stream_snap = db.query(RuntimeStreamSnapshot).filter(RuntimeStreamSnapshot.stream_id == stream_id).first()
    route_snaps = {
        int(r.route_id): r
        for r in db.query(RuntimeRouteSnapshot).filter(RuntimeRouteSnapshot.stream_id == stream_id).all()
    }

    from app.runtime.runtime_analytics_bucket_read_repository import historical_analytics_available

    if historical_analytics_available(db):
        try:
            return _build_metrics_from_buckets(
                db,
                stream,
                routes,
                window=token,
                snapshot_id=snapshot_id,
                since=since,
                until=until,
                window_seconds=window_seconds,
                checkpoint_row=checkpoint_row,
                stream_snap=stream_snap,
                route_snaps=route_snaps,
            )
        except Exception:
            logger.exception("stream_runtime_metrics_buckets_degraded stream_id=%s", stream_id)

    if stream_runtime_snapshot_read_enabled(db) and token in OPERATIONAL_WINDOWS:
        return _build_metrics_from_operational_snapshot(
            db,
            stream,
            routes,
            window=token,
            snapshot_id=snapshot_id,
            since=since,
            until=until,
            window_seconds=window_seconds,
            checkpoint_row=checkpoint_row,
            stream_snap=stream_snap,
            route_snaps=route_snaps,
        )

    return None
