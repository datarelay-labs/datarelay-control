"""Read-only analytics orchestration for delivery_logs aggregates."""

from __future__ import annotations

import logging
import math
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

from sqlalchemy.orm import Session

from app.logs.aggregates import aggregate_delivery_outcomes_by_destination
from app.routes.models import Route
from app.runtime import analytics_repository as repo
from app.runtime.analytics_schemas import (
    AnalyticsScopeFilters,
    AnalyticsTimeWindow,
    CodeCount,
    DestinationDeliveryOutcomeRow,
    DestinationDeliveryOutcomesResponse,
    DimensionCount,
    FailureTotals,
    FailureTrendBucket,
    RetrySummaryResponse,
    RouteFailuresAnalyticsResponse,
    RouteFailuresScopedResponse,
    RouteOutcomeRow,
    RouteRetryRow,
    StageCount,
    StreamRetriesAnalyticsResponse,
    StreamRetryRow,
    UnstableRouteCandidate,
)
from app.runtime.metrics_window import (
    bucket_seconds_for_window,
    normalize_metrics_window_token,
    parse_metrics_window,
)
from app.runtime.aggregate_summaries import summarize_delivery_outcomes
from app.runtime.metric_contract import metric_meta_map
from app.runtime.query_boundary import materialize_historical_aggregate_snapshot, select_aggregate_query_path
from app.runtime.visualization_contract import bucket_meta, visualization_meta_map
from app.runtime.read_service import RouteNotFoundError

UTC = timezone.utc


def _ensure_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def resolve_analytics_window(
    *,
    window: str | None,
    since: datetime | None,
    snapshot_id: str | None = None,
) -> tuple[str, datetime, datetime, str]:
    """Return window label, inclusive since, inclusive until (UTC now).

    When ``since`` is provided it overrides the rolling window; the label becomes ``custom``.
    """

    if snapshot_id:
        try:
            until = _ensure_utc(datetime.fromisoformat(snapshot_id.replace("Z", "+00:00")))
        except ValueError as exc:
            raise ValueError("snapshot_id must be an ISO-8601 timestamp") from exc
    else:
        until = datetime.now(UTC)
    if since is not None:
        start = _ensure_utc(since)
        return "custom", start, until, until.isoformat()
    token = normalize_metrics_window_token(window or "24h")
    td = parse_metrics_window(token)
    start = until - td
    return token, start, until, until.isoformat()


def _dense_failure_trend(
    rows: list[object],
    *,
    start: datetime,
    until: datetime,
    bucket_seconds: int,
) -> list[FailureTrendBucket]:
    bs = max(1, int(bucket_seconds))
    start_epoch = _ensure_utc(start).timestamp()
    end_epoch = _ensure_utc(until).timestamp()
    first = math.floor(start_epoch / bs) * bs
    by_epoch: dict[float, int] = {}
    for row in rows:
        bucket_start = getattr(row, "bucket_start")
        ep = _ensure_utc(bucket_start).timestamp()
        key = math.floor(ep / bs) * bs
        by_epoch[key] = int(getattr(row, "failure_count") or 0)

    out: list[FailureTrendBucket] = []
    t = first
    while t < end_epoch and len(out) < 256:
        out.append(
            FailureTrendBucket(
                bucket_start=datetime.fromtimestamp(t, tz=UTC),
                failure_count=by_epoch.get(t, 0),
            )
        )
        t += bs
    return out


def _failure_rate(failures: int, successes: int) -> float:
    denom = failures + successes
    if denom <= 0:
        return 0.0
    return round(failures / denom, 6)


def _pick_unstable(
    rows: list[RouteOutcomeRow],
    *,
    min_samples: int = 5,
    min_rate: float = 0.15,
    limit: int = 25,
) -> list[UnstableRouteCandidate]:
    candidates: list[UnstableRouteCandidate] = []
    for r in rows:
        n = r.failure_count + r.success_count
        if n < min_samples:
            continue
        if r.failure_rate >= min_rate:
            candidates.append(
                UnstableRouteCandidate(
                    route_id=r.route_id,
                    stream_id=r.stream_id,
                    destination_id=r.destination_id,
                    failure_count=r.failure_count,
                    success_count=r.success_count,
                    failure_rate=r.failure_rate,
                    sample_total=n,
                )
            )
    candidates.sort(key=lambda x: (-x.failure_rate, -x.failure_count, x.route_id))
    return candidates[:limit]


def get_route_failures_analytics(
    db: Session,
    *,
    window: str | None,
    since: datetime | None,
    stream_id: int | None,
    route_id: int | None,
    destination_id: int | None,
    snapshot_id: str | None = None,
) -> RouteFailuresAnalyticsResponse:
    path = select_aggregate_query_path("analytics_route_failures")
    if path == "historical" and snapshot_id is not None:
        return materialize_historical_aggregate_snapshot(
            db,
            scope="analytics_route_failures",
            key=(
                f"window={window};since={since.isoformat() if since else ''};stream_id={stream_id};"
                f"route_id={route_id};destination_id={destination_id}"
            ),
            snapshot_id=snapshot_id,
            model_type=RouteFailuresAnalyticsResponse,
            builder=lambda: _build_route_failures_analytics(
                db,
                window=window,
                since=since,
                stream_id=stream_id,
                route_id=route_id,
                destination_id=destination_id,
                snapshot_id=snapshot_id,
            ),
        )
    return _build_route_failures_analytics(
        db,
        window=window,
        since=since,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
        snapshot_id=snapshot_id,
    )


def _build_route_failures_analytics(
    db: Session,
    *,
    window: str | None,
    since: datetime | None,
    stream_id: int | None,
    route_id: int | None,
    destination_id: int | None,
    snapshot_id: str | None = None,
) -> RouteFailuresAnalyticsResponse:
    token, start, until, resolved_snapshot_id = resolve_analytics_window(
        window=window,
        since=since,
        snapshot_id=snapshot_id,
    )
    filters = AnalyticsScopeFilters(
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
    )
    bs = bucket_seconds_for_window(max(timedelta(seconds=60), until - start))

    totals_raw = summarize_delivery_outcomes(
        db,
        start_at=start,
        end_at=until,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
    )
    totals = FailureTotals(
        failure_events=totals_raw.failure_events,
        success_events=totals_raw.success_events,
        overall_failure_rate=totals_raw.failure_rate,
    )

    route_rows_raw = repo.fetch_route_outcome_rows(
        db,
        since=start,
        until=until,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
    )
    outcomes: list[RouteOutcomeRow] = []
    for row in route_rows_raw:
        rid = int(row.route_id)
        fc = int(row.failure_count or 0)
        sc = int(row.success_count or 0)
        outcomes.append(
            RouteOutcomeRow(
                route_id=rid,
                stream_id=int(row.stream_id) if row.stream_id is not None else None,
                destination_id=int(row.destination_id) if row.destination_id is not None else None,
                failure_count=fc,
                success_count=sc,
                failure_rate=_failure_rate(fc, sc),
                last_failure_at=row.last_failure_at,
                last_success_at=row.last_success_at,
            )
        )

    dest_rows = repo.fetch_dimension_failure_counts(
        db,
        since=start,
        until=until,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
        dimension="destination",
    )
    stream_rows = repo.fetch_dimension_failure_counts(
        db,
        since=start,
        until=until,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
        dimension="stream",
    )

    trend_raw = repo.fetch_failure_trend_buckets(
        db,
        since=start,
        until=until,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
        bucket_seconds=bs,
    )
    trend = _dense_failure_trend(trend_raw, start=start, until=until, bucket_seconds=bs)
    bm = bucket_meta(bs, len(trend))

    codes_raw = repo.fetch_top_error_codes(
        db,
        since=start,
        until=until,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
        limit=15,
    )
    top_codes = [
        CodeCount(error_code=r.error_code, count=int(r.row_count or 0)) for r in codes_raw
    ]

    stages_raw = repo.fetch_top_failed_stages(
        db,
        since=start,
        until=until,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
        limit=10,
    )
    top_stages = [StageCount(stage=r.stage, count=int(r.row_count or 0)) for r in stages_raw]

    avg_lat, p95_lat = repo.fetch_latency_avg_p95(
        db,
        since=start,
        until=until,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
    )
    last_fail, last_ok = repo.fetch_last_event_times(
        db,
        since=start,
        until=until,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
    )

    return RouteFailuresAnalyticsResponse(
        time=AnalyticsTimeWindow(
            window=token,
            since=start,
            until=until,
            snapshot_id=resolved_snapshot_id,
            generated_at=until,
        ),
        filters=filters,
        metric_meta=metric_meta_map(
            "delivery_outcomes.window",
            "delivery_outcomes.success",
            "delivery_outcomes.failure",
            "historical_health.routes",
            window_start=start,
            window_end=until,
            generated_at=until,
        ),
        visualization_meta=visualization_meta_map(
            "analytics.delivery_failures.bucket_histogram",
            bucket_size_seconds=bs,
            bucket_count=len(trend),
            snapshot_id=resolved_snapshot_id,
            generated_at=until,
            window_start=start,
            window_end=until,
        ),
        bucket_size_seconds=bm["bucket_size_seconds"],
        bucket_count=bm["bucket_count"],
        bucket_alignment=bm["bucket_alignment"],
        bucket_timezone=bm["bucket_timezone"],
        bucket_mode=bm["bucket_mode"],
        totals=totals,
        latency_ms_avg=avg_lat,
        latency_ms_p95=p95_lat,
        last_failure_at=last_fail,
        last_success_at=last_ok,
        outcomes_by_route=outcomes,
        failures_by_destination=[
            DimensionCount(id=int(r.dim_id), failure_count=int(r.failure_count or 0))
            for r in dest_rows
            if r.dim_id is not None
        ],
        failures_by_stream=[
            DimensionCount(id=int(r.dim_id), failure_count=int(r.failure_count or 0))
            for r in stream_rows
            if r.dim_id is not None
        ],
        failure_trend=trend,
        top_error_codes=top_codes,
        top_failed_stages=top_stages,
        unstable_routes=_pick_unstable(outcomes),
    )


def get_route_failures_for_route(
    db: Session,
    *,
    route_id: int,
    window: str | None,
    since: datetime | None,
    stream_id: int | None,
    destination_id: int | None,
    snapshot_id: str | None = None,
) -> RouteFailuresScopedResponse:
    route = db.query(Route).filter(Route.id == route_id).first()
    if route is None:
        raise RouteNotFoundError(route_id)

    token, start, until, resolved_snapshot_id = resolve_analytics_window(
        window=window,
        since=since,
        snapshot_id=snapshot_id,
    )
    filters = AnalyticsScopeFilters(
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
    )
    span = max(timedelta(seconds=60), until - start)
    bs = bucket_seconds_for_window(span)

    totals_raw = summarize_delivery_outcomes(
        db,
        start_at=start,
        end_at=until,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
    )
    totals = FailureTotals(
        failure_events=totals_raw.failure_events,
        success_events=totals_raw.success_events,
        overall_failure_rate=totals_raw.failure_rate,
    )

    dest_rows = repo.fetch_dimension_failure_counts(
        db,
        since=start,
        until=until,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
        dimension="destination",
    )
    trend_raw = repo.fetch_failure_trend_buckets(
        db,
        since=start,
        until=until,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
        bucket_seconds=bs,
    )
    trend = _dense_failure_trend(trend_raw, start=start, until=until, bucket_seconds=bs)
    bm = bucket_meta(bs, len(trend))
    codes_raw = repo.fetch_top_error_codes(
        db,
        since=start,
        until=until,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
        limit=15,
    )
    top_codes = [
        CodeCount(error_code=r.error_code, count=int(r.row_count or 0)) for r in codes_raw
    ]
    stages_raw = repo.fetch_top_failed_stages(
        db,
        since=start,
        until=until,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
        limit=10,
    )
    top_stages = [StageCount(stage=r.stage, count=int(r.row_count or 0)) for r in stages_raw]

    avg_lat, p95_lat = repo.fetch_latency_avg_p95(
        db,
        since=start,
        until=until,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
    )
    last_fail, last_ok = repo.fetch_last_event_times(
        db,
        since=start,
        until=until,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
    )

    return RouteFailuresScopedResponse(
        route_id=route_id,
        time=AnalyticsTimeWindow(
            window=token,
            since=start,
            until=until,
            snapshot_id=resolved_snapshot_id,
            generated_at=until,
        ),
        filters=filters,
        metric_meta=metric_meta_map(
            "delivery_outcomes.window",
            "delivery_outcomes.success",
            "delivery_outcomes.failure",
            "historical_health.routes",
            window_start=start,
            window_end=until,
            generated_at=until,
        ),
        visualization_meta=visualization_meta_map(
            "analytics.delivery_failures.bucket_histogram",
            bucket_size_seconds=bs,
            bucket_count=len(trend),
            snapshot_id=resolved_snapshot_id,
            generated_at=until,
            window_start=start,
            window_end=until,
        ),
        bucket_size_seconds=bm["bucket_size_seconds"],
        bucket_count=bm["bucket_count"],
        bucket_alignment=bm["bucket_alignment"],
        bucket_timezone=bm["bucket_timezone"],
        bucket_mode=bm["bucket_mode"],
        totals=totals,
        latency_ms_avg=avg_lat,
        latency_ms_p95=p95_lat,
        last_failure_at=last_fail,
        last_success_at=last_ok,
        failures_by_destination=[
            DimensionCount(id=int(r.dim_id), failure_count=int(r.failure_count or 0))
            for r in dest_rows
            if r.dim_id is not None
        ],
        failure_trend=trend,
        top_error_codes=top_codes,
        top_failed_stages=top_stages,
    )


def get_delivery_outcomes_by_destination(
    db: Session,
    *,
    window: str | None,
    since: datetime | None,
    snapshot_id: str | None = None,
) -> DestinationDeliveryOutcomesResponse:
    path = select_aggregate_query_path("analytics_delivery_outcomes_by_destination")
    if path == "historical" and snapshot_id is not None:
        return materialize_historical_aggregate_snapshot(
            db,
            scope="analytics_delivery_outcomes_by_destination",
            key=f"window={window};since={since.isoformat() if since else ''}",
            snapshot_id=snapshot_id,
            model_type=DestinationDeliveryOutcomesResponse,
            builder=lambda: _build_delivery_outcomes_by_destination(
                db,
                window=window,
                since=since,
                snapshot_id=snapshot_id,
            ),
        )
    return _build_delivery_outcomes_by_destination(db, window=window, since=since, snapshot_id=snapshot_id)


def _build_delivery_outcomes_by_destination(
    db: Session,
    *,
    window: str | None,
    since: datetime | None,
    snapshot_id: str | None = None,
) -> DestinationDeliveryOutcomesResponse:
    from app.runtime import runtime_analytics_bucket_read_repository as bucket_read

    token, start, until, resolved_snapshot_id = resolve_analytics_window(
        window=window,
        since=since,
        snapshot_id=snapshot_id,
    )
    window_seconds = max(60, int((until - start).total_seconds()))
    if bucket_read.historical_analytics_available(db):
        bucket_rows = bucket_read.fetch_destination_outcomes_from_buckets(
            db,
            since=start,
            until=until,
            window_seconds=window_seconds,
        )
        rows = [
            type(
                "Row",
                (),
                {
                    "destination_id": r.destination_id,
                    "success_events": r.success_events,
                    "failure_events": r.failure_events,
                },
            )()
            for r in bucket_rows
        ]
    else:
        rows = aggregate_delivery_outcomes_by_destination(db, start_at=start, end_at=until)
    return DestinationDeliveryOutcomesResponse(
        time=AnalyticsTimeWindow(
            window=token,
            since=start,
            until=until,
            snapshot_id=resolved_snapshot_id,
            generated_at=until,
        ),
        filters=AnalyticsScopeFilters(),
        metric_meta=metric_meta_map("delivery_outcomes.window", window_start=start, window_end=until, generated_at=until),
        visualization_meta=visualization_meta_map(
            "routes.destination_delivery_outcomes.donut_count",
            snapshot_id=resolved_snapshot_id,
            generated_at=until,
            window_start=start,
            window_end=until,
        ),
        rows=[
            DestinationDeliveryOutcomeRow(
                destination_id=r.destination_id,
                success_events=r.success_events,
                failure_events=r.failure_events,
            )
            for r in rows
        ],
    )


def get_stream_retries_analytics(
    db: Session,
    *,
    window: str | None,
    since: datetime | None,
    stream_id: int | None,
    route_id: int | None,
    destination_id: int | None,
    limit: int,
    snapshot_id: str | None = None,
) -> StreamRetriesAnalyticsResponse:
    path = select_aggregate_query_path("analytics_stream_retries")
    if path == "historical" and snapshot_id is not None:
        return materialize_historical_aggregate_snapshot(
            db,
            scope="analytics_stream_retries",
            key=(
                f"window={window};since={since.isoformat() if since else ''};stream_id={stream_id};"
                f"route_id={route_id};destination_id={destination_id};limit={int(limit)}"
            ),
            snapshot_id=snapshot_id,
            model_type=StreamRetriesAnalyticsResponse,
            builder=lambda: _build_stream_retries_analytics(
                db,
                window=window,
                since=since,
                stream_id=stream_id,
                route_id=route_id,
                destination_id=destination_id,
                limit=limit,
                snapshot_id=snapshot_id,
            ),
        )
    return _build_stream_retries_analytics(
        db,
        window=window,
        since=since,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
        limit=limit,
        snapshot_id=snapshot_id,
    )


def _build_stream_retries_analytics(
    db: Session,
    *,
    window: str | None,
    since: datetime | None,
    stream_id: int | None,
    route_id: int | None,
    destination_id: int | None,
    limit: int,
    snapshot_id: str | None = None,
) -> StreamRetriesAnalyticsResponse:
    token, start, until, resolved_snapshot_id = resolve_analytics_window(
        window=window,
        since=since,
        snapshot_id=snapshot_id,
    )
    filters = AnalyticsScopeFilters(
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
    )
    lim = max(1, min(int(limit), 50))

    srows = repo.fetch_retry_heavy_streams(
        db,
        since=start,
        until=until,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
        limit=lim,
    )
    rrows = repo.fetch_retry_heavy_routes(
        db,
        since=start,
        until=until,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
        limit=lim,
    )

    return StreamRetriesAnalyticsResponse(
        time=AnalyticsTimeWindow(
            window=token,
            since=start,
            until=until,
            snapshot_id=resolved_snapshot_id,
            generated_at=until,
        ),
        filters=filters,
        metric_meta=metric_meta_map("delivery_outcomes.window", window_start=start, window_end=until, generated_at=until),
        retry_heavy_streams=[
            StreamRetryRow(
                stream_id=int(x.stream_id),
                retry_event_count=int(x.evt or 0),
                retry_column_sum=int(x.rsum or 0),
            )
            for x in srows
        ],
        retry_heavy_routes=[
            RouteRetryRow(
                route_id=int(x.route_id),
                retry_event_count=int(x.evt or 0),
                retry_column_sum=int(x.rsum or 0),
            )
            for x in rrows
        ],
    )


def get_retry_summary(
    db: Session,
    *,
    window: str | None,
    since: datetime | None,
    stream_id: int | None,
    route_id: int | None,
    destination_id: int | None,
    snapshot_id: str | None = None,
) -> RetrySummaryResponse:
    path = select_aggregate_query_path("analytics_retry_summary")
    if path == "historical" and snapshot_id is not None:
        return materialize_historical_aggregate_snapshot(
            db,
            scope="analytics_retry_summary",
            key=(
                f"window={window};since={since.isoformat() if since else ''};stream_id={stream_id};"
                f"route_id={route_id};destination_id={destination_id}"
            ),
            snapshot_id=snapshot_id,
            model_type=RetrySummaryResponse,
            builder=lambda: _build_retry_summary(
                db,
                window=window,
                since=since,
                stream_id=stream_id,
                route_id=route_id,
                destination_id=destination_id,
                snapshot_id=snapshot_id,
            ),
        )
    return _build_retry_summary(
        db,
        window=window,
        since=since,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
        snapshot_id=snapshot_id,
    )


def _build_retry_summary(
    db: Session,
    *,
    window: str | None,
    since: datetime | None,
    stream_id: int | None,
    route_id: int | None,
    destination_id: int | None,
    snapshot_id: str | None = None,
) -> RetrySummaryResponse:
    from app.runtime.runtime_snapshot_analytics_repository import (
        load_retry_summary as _snapshot_retry_summary,
        snapshot_analytics_available,
    )

    if snapshot_analytics_available(db):
        try:
            return _snapshot_retry_summary(
                db,
                window=window,
                since=since,
                stream_id=stream_id,
                route_id=route_id,
                destination_id=destination_id,
                snapshot_id=snapshot_id,
            )
        except Exception:
            logger.exception("analytics_retry_summary_snapshot_degraded")

    token, start, until, resolved_snapshot_id = resolve_analytics_window(
        window=window,
        since=since,
        snapshot_id=snapshot_id,
    )
    filters = AnalyticsScopeFilters(
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
    )
    ok_n, bad_n, rsum = repo.fetch_retry_summary(
        db,
        since=start,
        until=until,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
    )
    return RetrySummaryResponse(
        time=AnalyticsTimeWindow(
            window=token,
            since=start,
            until=until,
            snapshot_id=resolved_snapshot_id,
            generated_at=until,
        ),
        filters=filters,
        metric_meta=metric_meta_map(
            "delivery_outcomes.window",
            "delivery_outcomes.success",
            "delivery_outcomes.failure",
            window_start=start,
            window_end=until,
            generated_at=until,
        ),
        retry_success_events=ok_n,
        retry_failed_events=bad_n,
        total_retry_outcome_events=ok_n + bad_n,
        retry_column_sum=rsum,
    )

