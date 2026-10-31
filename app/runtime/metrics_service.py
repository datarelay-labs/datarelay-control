"""Aggregated stream runtime metrics for the Stream Runtime UI (read-only)."""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.checkpoints.models import Checkpoint
from app.logs.aggregates import (
    aggregate_route_trend_buckets,
    aggregate_route_window_stats,
    aggregate_stream_delivery_buckets,
    dense_route_trend_series,
    dense_stream_delivery_buckets,
    latest_failure_messages_for_stream,
)
from app.logs.models import DeliveryLog
from app.routes.models import Route
from app.runtime.health_repository import clamp_health_aggregate_window
from app.runtime.metrics_window import (
    bucket_seconds_for_window,
    max_buckets_for_window,
    parse_metrics_window,
)
from app.runtime.aggregate_summaries import (
    summarize_delivery_outcomes,
    summarize_processed_events,
)
from app.runtime.metric_contract import metric_meta_map
from app.runtime.query_boundary import materialize_live_aggregate_snapshot
from app.runtime.visualization_contract import bucket_meta, visualization_meta_map
from app.runtime.models import RuntimeStreamSnapshot
from app.runtime.read_service import StreamNotFoundError
from app.runtime.copy_utils import checkpoint_read_view
from app.runtime.schemas import (
    RecentRouteErrorItem,
    RouteRuntimeLatencyTrendPoint,
    RouteRuntimeMetricsRow,
    RouteRuntimeSuccessRateTrendPoint,
    StreamMetricsCheckpoint,
    StreamMetricsCheckpointHistoryItem,
    StreamMetricsRecentRun,
    StreamMetricsRouteHealthRow,
    StreamMetricsStreamBlock,
    StreamMetricsTimeBucket,
    StreamRuntimeKpis,
    StreamRuntimeMetricsResponse,
    LatencyTimePoint,
    ThroughputTimePoint,
)
from app.streams.models import Stream

UTC = timezone.utc

_SUCCESS_STAGES = frozenset({"route_send_success", "route_retry_success"})
_FAILURE_STAGES = frozenset({"route_send_failed", "route_retry_failed", "route_unknown_failure_policy"})
_RETRY_OUTCOME_STAGES = frozenset({"route_retry_success", "route_retry_failed"})
_LATENCY_STAGES = _SUCCESS_STAGES | _FAILURE_STAGES
_ROUTE_SEND_SUCCESS = "route_send_success"
_TREND_BUCKETS = 12
# Operational runtime metrics: bounded SQL aggregates (avoid incremental full-table refresh).
_METRICS_PREFER_SQL = True


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


def _input_events_run_complete(ps: dict[str, Any]) -> int:
    return _payload_int(ps, "input_events")


def _event_count_delivery(ps: dict[str, Any]) -> int:
    ec = _payload_int(ps, "event_count")
    return ec if ec > 0 else 1


def _checkpoint_preview(value: dict[str, Any]) -> str:
    try:
        s = json.dumps(value, default=str, separators=(",", ":"))
    except (TypeError, ValueError):
        s = str(value)
    if len(s) > 160:
        return f"{s[:157]}…"
    return s


def _max_dt(current: datetime | None, candidate: datetime | None) -> datetime | None:
    if candidate is None:
        return current
    if current is None or candidate > current:
        return candidate
    return current


def _p95_int(values: list[int]) -> float:
    """Nearest-rank P95 for non-empty integer samples (used by tests and trend helpers)."""
    if not values:
        return 0.0
    s = sorted(values)
    n = len(s)
    if n == 1:
        return float(s[0])
    k = max(0, min(n - 1, math.ceil(0.95 * n) - 1))
    return float(s[k])


def _route_connectivity_state(
    *,
    route_enabled: bool,
    destination_enabled: bool,
    route_status: str,
    delivered_ev: int,
    failed_ev: int,
) -> Literal["HEALTHY", "DEGRADED", "ERROR", "DISABLED", "IDLE"]:
    rs = str(route_status or "").strip().upper()
    if not route_enabled or not destination_enabled or rs != "ENABLED":
        return "DISABLED"
    if delivered_ev <= 0 and failed_ev <= 0:
        # No deliveries observed in the window: no verdict, not HEALTHY.
        return "IDLE"
    if failed_ev <= 0:
        return "HEALTHY"
    if delivered_ev <= 0:
        return "ERROR"
    return "DEGRADED"


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _snapshot_time(snapshot_id: str | None) -> datetime:
    if not snapshot_id:
        return _utc_now()
    try:
        parsed = datetime.fromisoformat(snapshot_id.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("snapshot_id must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _max_created_filter(
    db: Session,
    stream_id: int,
    stages: frozenset[str],
    *,
    start_at: datetime | None = None,
    end_at: datetime | None = None,
) -> datetime | None:
    q = db.query(func.max(DeliveryLog.created_at)).filter(
        DeliveryLog.stream_id == stream_id,
        DeliveryLog.stage.in_(set(stages)),
    )
    if start_at is not None:
        q = q.filter(DeliveryLog.created_at >= start_at)
    if end_at is not None:
        q = q.filter(DeliveryLog.created_at < end_at)
    return q.scalar()


def _stream_last_activity_timestamps(
    db: Session,
    stream_id: int,
    *,
    since: datetime,
    end_at: datetime,
) -> tuple[datetime | None, datetime | None, datetime | None]:
    """Resolve last run/success/error without scanning all historical delivery_logs rows."""

    snap = db.query(RuntimeStreamSnapshot).filter(RuntimeStreamSnapshot.stream_id == stream_id).first()
    last_success = snap.last_success_at if snap is not None else None
    last_error = snap.last_error_at if snap is not None else None
    last_run = _max_created_filter(
        db,
        stream_id,
        frozenset({"run_complete"}),
        start_at=since,
        end_at=end_at,
    )
    if last_run is None and snap is not None:
        last_run = snap.updated_at
    if last_success is None:
        last_success = _max_created_filter(
            db,
            stream_id,
            _SUCCESS_STAGES,
            start_at=since,
            end_at=end_at,
        )
    if last_error is None:
        last_error = _max_created_filter(
            db,
            stream_id,
            _FAILURE_STAGES,
            start_at=since,
            end_at=end_at,
        )
    return last_run, last_success, last_error


def build_stream_runtime_metrics(
    db: Session,
    stream_id: int,
    *,
    window: str = "1h",
    snapshot_id: str | None = None,
) -> StreamRuntimeMetricsResponse:
    if snapshot_id is not None:
        return materialize_live_aggregate_snapshot(
            db,
            scope="stream_runtime_metrics",
            key=f"stream_id={int(stream_id)};window={window}",
            snapshot_id=snapshot_id,
            model_type=StreamRuntimeMetricsResponse,
            builder=lambda: _build_stream_runtime_metrics(db, stream_id, window=window, snapshot_id=snapshot_id),
        )
    return _build_stream_runtime_metrics(db, stream_id, window=window, snapshot_id=snapshot_id)


def _build_stream_runtime_metrics(
    db: Session,
    stream_id: int,
    *,
    window: str = "1h",
    snapshot_id: str | None = None,
) -> StreamRuntimeMetricsResponse:
    """Build metrics from analytics buckets / operational snapshots; delivery_logs fallback."""

    from app.runtime.stream_runtime_snapshot_read import try_build_stream_runtime_metrics

    snapshot_metrics = try_build_stream_runtime_metrics(
        db,
        stream_id,
        window=window,
        snapshot_id=snapshot_id,
    )
    if snapshot_metrics is not None:
        return snapshot_metrics

    stream = db.query(Stream).filter(Stream.id == stream_id).first()
    if stream is None:
        raise StreamNotFoundError(stream_id)

    checkpoint_row = db.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).first()
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

    routes = (
        db.query(Route)
        .options(joinedload(Route.destination))
        .filter(Route.stream_id == stream_id)
        .order_by(Route.id.asc())
        .all()
    )

    td = parse_metrics_window(window)
    now = _snapshot_time(snapshot_id)
    resolved_snapshot_id = now.isoformat()
    since = now - td
    range_end = now
    since, range_end = clamp_health_aggregate_window(since, range_end)
    window_seconds = max(1, int((range_end - since).total_seconds()))
    clamped_td = timedelta(seconds=window_seconds)

    bucket_sec = bucket_seconds_for_window(clamped_td)
    sparse_buckets = aggregate_stream_delivery_buckets(
        db,
        stream_id=stream_id,
        start_at=since,
        end_at=range_end,
        bucket_seconds=bucket_sec,
        prefer_sql=_METRICS_PREFER_SQL,
    )
    mb = max_buckets_for_window(clamped_td, bucket_sec)
    stream_buckets = dense_stream_delivery_buckets(
        sparse_buckets,
        start_at=since,
        end_at=range_end,
        bucket_seconds=bucket_sec,
        max_buckets=mb,
    )

    events_over_time: list[StreamMetricsTimeBucket] = []
    throughput_over_time: list[ThroughputTimePoint] = []
    latency_over_time: list[LatencyTimePoint] = []
    for b in stream_buckets:
        ts = b.bucket_start
        eps = float(b.delivered) / float(bucket_sec) if bucket_sec > 0 else 0.0
        events_over_time.append(
            StreamMetricsTimeBucket(
                timestamp=ts,
                events=int(b.events),
                delivered=int(b.delivered),
                failed=int(b.failed),
            )
        )
        throughput_over_time.append(ThroughputTimePoint(timestamp=ts, events_per_sec=round(eps, 6)))
        latency_over_time.append(LatencyTimePoint(timestamp=ts, avg_latency_ms=round(float(b.avg_latency_ms), 3)))

    processed_summary = summarize_processed_events(
        db,
        stream_id=stream_id,
        start_at=since,
        end_at=range_end,
        prefer_sql=_METRICS_PREFER_SQL,
    )
    delivery_summary = summarize_delivery_outcomes(
        db,
        stream_id=stream_id,
        start_at=since,
        end_at=range_end,
        prefer_sql=_METRICS_PREFER_SQL,
    )
    events_in_window = processed_summary.processed_events
    delivered_in_window = delivery_summary.success_events
    failed_in_window = delivery_summary.failure_events

    if delivery_summary.total_events > 0:
        delivery_success_rate = delivery_summary.success_rate_percent
        error_rate = round(100.0 * delivery_summary.failure_events / delivery_summary.total_events, 1)
    else:
        delivery_success_rate = None
        error_rate = 0.0

    lat_avg_row = (
        db.query(func.avg(DeliveryLog.latency_ms))
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.created_at >= since,
            DeliveryLog.created_at < range_end,
            DeliveryLog.stage.in_(_LATENCY_STAGES),
            DeliveryLog.latency_ms.isnot(None),
            DeliveryLog.latency_ms >= 0,
        )
        .scalar()
    )
    lat_max_row = (
        db.query(func.max(DeliveryLog.latency_ms))
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.created_at >= since,
            DeliveryLog.created_at < range_end,
            DeliveryLog.stage.in_(_LATENCY_STAGES),
            DeliveryLog.latency_ms.isnot(None),
            DeliveryLog.latency_ms >= 0,
        )
        .scalar()
    )
    avg_latency_ms = round(float(lat_avg_row or 0.0), 1)
    max_latency_ms = float(lat_max_row or 0.0)

    kpis = StreamRuntimeKpis(
        events_last_hour=int(events_in_window),
        delivered_last_hour=int(delivered_in_window),
        failed_last_hour=int(failed_in_window),
        delivery_success_rate=delivery_success_rate,
        avg_latency_ms=float(avg_latency_ms),
        max_latency_ms=float(max_latency_ms),
        error_rate=float(error_rate),
        metric_meta=metric_meta_map(
            "processed_events.window",
            "delivery_outcomes.window",
            "delivery_outcomes.success",
            "delivery_outcomes.failure",
            window_start=since,
            window_end=range_end,
            generated_at=range_end,
        ),
    )

    last_run_at, last_success_at, last_error_at = _stream_last_activity_timestamps(
        db,
        stream_id,
        since=since,
        end_at=range_end,
    )

    route_agg = {
        r.route_id: r
        for r in aggregate_route_window_stats(
            db,
            stream_id=stream_id,
            start_at=since,
            end_at=range_end,
            prefer_sql=_METRICS_PREFER_SQL,
        )
    }
    fail_msgs = latest_failure_messages_for_stream(db, stream_id=stream_id, start_at=since, end_at=range_end)

    trend_bucket_sec = max(60, window_seconds // _TREND_BUCKETS)
    trend_rows = aggregate_route_trend_buckets(
        db,
        stream_id=stream_id,
        start_at=since,
        end_at=range_end,
        bucket_seconds=trend_bucket_sec,
        prefer_sql=_METRICS_PREFER_SQL,
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

        rw = route_agg.get(rid)
        succ_c = int(rw.success_attempts) if rw else 0
        fail_c = int(rw.failure_attempts) if rw else 0
        delivered_ev = int(rw.delivered_events) if rw else 0
        failed_ev = int(rw.failed_events) if rw else 0
        events_total = delivered_ev + failed_ev
        success_rate: float | None = (
            round(100.0 * delivered_ev / events_total, 1) if events_total > 0 else None
        )

        lsucc = rw.last_success_at if rw else None
        lfail = rw.last_failure_at if rw else None
        r_avg_lat = round(float(rw.avg_latency_ms), 1) if rw else 0.0
        r_max_lat = float(rw.max_latency_ms) if rw else 0.0
        r_p95_lat = float(r_max_lat)

        retry_count_1h = int(rw.retry_events) if rw else 0
        eps_current = round(delivered_ev / float(window_seconds), 6) if window_seconds > 0 else 0.0

        tr_list = dense_route_trend_series(
            trend_rows,
            route_id=rid,
            start_at=since,
            end_at=range_end,
            bucket_seconds=trend_bucket_sec,
            max_buckets=mb_trend,
        )
        latency_trend: list[RouteRuntimeLatencyTrendPoint] = []
        success_rate_trend: list[RouteRuntimeSuccessRateTrendPoint] = []
        for tr in tr_list:
            latency_trend.append(
                RouteRuntimeLatencyTrendPoint(timestamp=tr.bucket_start, avg_latency_ms=round(tr.avg_latency_ms, 1))
            )
            tot_b = tr.delivered_events + tr.failed_events
            sr_b = None if tot_b <= 0 else round(100.0 * tr.delivered_events / tot_b, 1)
            success_rate_trend.append(RouteRuntimeSuccessRateTrendPoint(timestamp=tr.bucket_start, success_rate=sr_b))

        connectivity = _route_connectivity_state(
            route_enabled=bool(route.enabled),
            destination_enabled=dest_enabled,
            route_status=str(route.status),
            delivered_ev=delivered_ev,
            failed_ev=failed_ev,
        )

        dr = route.disable_reason
        disable_reason_val = str(dr).strip() if dr else None

        msg_t = fail_msgs.get(rid)
        last_err_msg = msg_t[0] if msg_t else None
        last_err_code = msg_t[1] if msg_t else None

        route_runtime_rows.append(
            RouteRuntimeMetricsRow(
                route_id=rid,
                destination_id=int(route.destination_id),
                destination_name=dest_name,
                destination_type=dest_type,
                enabled=bool(route.enabled),
                route_status=str(route.status),
                success_rate=success_rate,
                events_last_hour=int(events_total),
                delivered_last_hour=int(delivered_ev),
                failed_last_hour=int(failed_ev),
                avg_latency_ms=float(r_avg_lat),
                p95_latency_ms=float(r_p95_lat),
                max_latency_ms=float(r_max_lat),
                eps_current=float(eps_current),
                retry_count_last_hour=int(retry_count_1h),
                last_success_at=lsucc,
                last_failure_at=lfail,
                last_error_message=last_err_msg,
                last_error_code=last_err_code,
                failure_policy=str(route.failure_policy),
                connectivity_state=connectivity,
                disable_reason=disable_reason_val,
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
                success_count=int(succ_c),
                failed_count=int(fail_c),
                last_success_at=lsucc,
                last_failure_at=lfail,
                avg_latency_ms=float(r_avg_lat),
                failure_policy=str(route.failure_policy),
                last_error_message=last_err_msg,
            )
        )

    recent_route_errors: list[RecentRouteErrorItem] = []
    route_dest_names: dict[int, str] = {}
    for r in routes:
        rd = r.destination
        route_dest_names[int(r.id)] = (
            str(rd.name).strip() if rd is not None and rd.name else f"Destination #{r.destination_id}"
        )
    fail_rows = (
        db.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.created_at >= since,
            DeliveryLog.created_at < range_end,
            DeliveryLog.stage.in_(_FAILURE_STAGES),
        )
        .order_by(DeliveryLog.created_at.desc())
        .limit(40)
        .all()
    )
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
            DeliveryLog.created_at < range_end,
        )
        .order_by(DeliveryLog.created_at.desc())
        .limit(25)
        .all()
    )
    for row in completes:
        ps = _obs_row_payload(row.payload_sample)
        inp = _input_events_run_complete(ps)
        succ = _payload_int(ps, "success_events")
        if succ <= 0:
            succ = _payload_int(ps, "delivered_event_count")
        failed = max(0, inp - succ) if inp > 0 else 0
        run_status: Literal["SUCCESS", "PARTIAL", "FAILED", "NO_EVENTS"]
        if inp <= 0:
            run_status = "NO_EVENTS"
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
    return StreamRuntimeMetricsResponse(
        snapshot_id=resolved_snapshot_id,
        generated_at=now,
        stream=stream_block,
        kpis=kpis,
        metrics_window_seconds=int(window_seconds),
        window_start=since,
        window_end=range_end,
        metric_meta=metric_meta_map(
            "processed_events.window",
            "delivery_outcomes.window",
            "runtime.throughput.processed_events_per_second",
            "routes.throughput.delivery_outcomes_per_second",
            window_start=since,
            window_end=range_end,
            generated_at=range_end,
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
            window_end=range_end,
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
        recent_runs=recent_runs,
        route_runtime=route_runtime_rows,
        recent_route_errors=recent_route_errors,
    )


def build_degraded_stream_runtime_metrics(
    db: Session,
    stream_id: int,
    *,
    window: str = "1h",
    snapshot_id: str | None = None,
) -> StreamRuntimeMetricsResponse:
    """Minimal metrics payload when aggregation fails (per-stream errors must not 500 list views)."""

    stream = db.query(Stream).filter(Stream.id == stream_id).first()
    if stream is None:
        raise StreamNotFoundError(stream_id)
    td = parse_metrics_window(window)
    window_seconds = max(1, int(td.total_seconds()))
    now = _snapshot_time(snapshot_id)
    since = now - td
    since, now = clamp_health_aggregate_window(since, now)
    window_seconds = max(1, int((now - since).total_seconds()))
    clamped_td = timedelta(seconds=window_seconds)
    kpis = StreamRuntimeKpis(
        metric_meta=metric_meta_map(
            "processed_events.window",
            "delivery_outcomes.window",
            "delivery_outcomes.success",
            "delivery_outcomes.failure",
            window_start=since,
            window_end=now,
            generated_at=now,
        )
    )
    stream_block = StreamMetricsStreamBlock(
        id=int(stream.id),
        name=str(stream.name),
        status=str(stream.status),
    )
    resolved_snapshot_id = now.isoformat()
    return StreamRuntimeMetricsResponse(
        snapshot_id=resolved_snapshot_id,
        generated_at=now,
        stream=stream_block,
        kpis=kpis,
        metrics_window_seconds=int(window_seconds),
        window_start=since,
        window_end=now,
        metric_meta=metric_meta_map(
            "processed_events.window",
            "delivery_outcomes.window",
            "runtime.throughput.processed_events_per_second",
            "routes.throughput.delivery_outcomes_per_second",
            window_start=since,
            window_end=now,
            generated_at=now,
        ),
        visualization_meta=visualization_meta_map(
            "stream.processed_events.bucket_count",
            "stream.delivery_outcomes.bucket_count",
            "routes.throughput.bucket_eps",
            "routes.success_rate.bucket_ratio",
            "routes.latency.bucket_avg_ms",
            bucket_size_seconds=bucket_seconds_for_window(clamped_td),
            bucket_count=0,
            snapshot_id=resolved_snapshot_id,
            generated_at=now,
            window_start=since,
            window_end=now,
        ),
        bucket_size_seconds=bucket_seconds_for_window(clamped_td),
        bucket_count=0,
        bucket_alignment="window_floor_epoch",
        bucket_timezone="UTC",
        bucket_mode="fixed_window",
        events_over_time=[],
        route_health=[],
        checkpoint_history=[],
        recent_runs=[],
        route_runtime=[],
        recent_route_errors=[],
    )
