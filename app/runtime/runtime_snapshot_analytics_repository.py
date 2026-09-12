"""Operational analytics reads from physical ``runtime_*_snapshot`` tables only.

No ``delivery_logs`` aggregates on this module's request path. When the read model
is empty, callers fall back to legacy aggregate paths in ``read_service`` /
``analytics_service``.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.runtime.aggregate_summaries import summarize_runtime_current
from app.runtime.analytics_schemas import (
    AnalyticsScopeFilters,
    AnalyticsTimeWindow,
    RetrySummaryResponse,
)
from app.runtime.metric_contract import metric_meta_map
from app.runtime.metrics_window import (
    normalize_operational_metrics_window_token,
    parse_metrics_window,
)
from app.runtime.models import RuntimeDestinationSnapshot, RuntimeRouteSnapshot, RuntimeStreamSnapshot
from app.runtime.operational_snapshot_repository import load_all_routes, load_all_streams
from app.runtime.read_service import (
    _dashboard_snapshot_id,
    _dashboard_snapshot_time,
    _runtime_engine_status,
    degraded_validation_operational_summary,
)
from app.runtime.runtime_snapshot_repository import read_model_is_populated
from app.runtime.schemas import (
    DashboardOutcomeBucket,
    DashboardOutcomeTimeseriesResponse,
    DashboardSummaryNumbers,
    DashboardSummaryResponse,
    RecentProblemRouteItem,
    RecentRateLimitedRouteItem,
    RecentUnhealthyStreamItem,
)
from app.scheduler.runtime_state import active_worker_count, scheduler_started_at, scheduler_uptime_seconds
from app.runtime.visualization_contract import bucket_meta, visualization_meta_map
from app.streams.models import Stream

logger = logging.getLogger(__name__)

UTC = timezone.utc
_OPERATIONAL_WINDOW_SECONDS = 300  # 5m snapshot window semantics for KPI fields


def snapshot_analytics_available(db: Session) -> bool:
    """True when physical operational snapshots are populated and enabled."""

    from app.config import settings

    if not bool(getattr(settings, "GDC_RUNTIME_OPERATIONAL_SNAPSHOT_READ_MODEL_ENABLED", True)):
        return False
    return read_model_is_populated(db)


def _operational_scale(window_seconds: int) -> float:
    """Scale 5m operational rates to the requested window (capped at 5m)."""

    return min(1.0, max(1, int(window_seconds)) / float(_OPERATIONAL_WINDOW_SECONDS))


def _int_events(eps: float, seconds: int) -> int:
    return max(0, int(round(float(eps) * max(1, int(seconds)))))


def _load_snapshot_rows(
    db: Session,
) -> tuple[
    list[Any],
    list[Any],
    dict[int, RuntimeStreamSnapshot],
    dict[int, RuntimeRouteSnapshot],
    dict[int, RuntimeDestinationSnapshot],
    dict[int, str],
]:
    streams = load_all_streams(db)
    routes = load_all_routes(db)
    stream_snaps = {int(r.stream_id): r for r in db.query(RuntimeStreamSnapshot).all()}
    route_snaps = {int(r.route_id): r for r in db.query(RuntimeRouteSnapshot).all()}
    destination_snaps = {int(r.destination_id): r for r in db.query(RuntimeDestinationSnapshot).all()}
    status_rows = db.query(Stream.id, Stream.status).all()
    stream_status_by_id = {int(r[0]): str(r[1]) for r in status_rows}
    return streams, routes, stream_snaps, route_snaps, destination_snaps, stream_status_by_id


def _stream_health_counts(
    stream_snaps: dict[int, RuntimeStreamSnapshot],
    stream_status_by_id: dict[int, str],
) -> tuple[int, int, int, int]:
    healthy = degraded = unhealthy = critical = 0
    for stream_id, snap in stream_snaps.items():
        status = snap.health_status
        stream_status = stream_status_by_id.get(stream_id, "")
        if status == "HEALTHY":
            healthy += 1
        elif status == "DEGRADED":
            degraded += 1
        elif status == "ERROR":
            if "ERROR" in stream_status.upper():
                critical += 1
            else:
                unhealthy += 1
    return healthy, degraded, unhealthy, critical


def _recent_problem_routes(
    routes: list[Any],
    route_snaps: dict[int, RuntimeRouteSnapshot],
    *,
    since: datetime,
    limit: int,
) -> list[RecentProblemRouteItem]:
    candidates: list[RecentProblemRouteItem] = []
    for route in routes:
        snap = route_snaps.get(route.id)
        if snap is None or snap.last_error_at is None:
            continue
        if snap.last_error_at < since:
            continue
        if snap.health_status not in ("ERROR", "DEGRADED"):
            continue
        candidates.append(
            RecentProblemRouteItem(
                stream_id=int(route.stream_id),
                route_id=int(route.id),
                destination_id=int(route.destination_id),
                stage="route_send_failed",
                error_code=None,
                message=str(snap.last_error_message or "delivery failure"),
                created_at=snap.last_error_at,
            )
        )
    candidates.sort(key=lambda x: x.created_at, reverse=True)
    return candidates[: max(1, min(int(limit), 50))]


def _recent_rate_limited_routes(
    routes: list[Any],
    stream_status_by_id: dict[int, str],
    route_snaps: dict[int, RuntimeRouteSnapshot],
    *,
    since: datetime,
    limit: int,
) -> list[RecentRateLimitedRouteItem]:
    out: list[RecentRateLimitedRouteItem] = []
    seen_route: set[int] = set()
    for route in routes:
        status = stream_status_by_id.get(int(route.stream_id), "")
        if "RATE_LIMITED" not in status.upper():
            continue
        rid = int(route.id)
        if rid in seen_route:
            continue
        snap = route_snaps.get(rid)
        at = snap.updated_at if snap is not None else since
        if at < since:
            continue
        seen_route.add(rid)
        out.append(
            RecentRateLimitedRouteItem(
                stream_id=int(route.stream_id),
                route_id=rid,
                destination_id=int(route.destination_id),
                stage="destination_rate_limited" if "DESTINATION" in status.upper() else "source_rate_limited",
                error_code=None,
                message=f"stream status {status}",
                created_at=at,
            )
        )
        if len(out) >= max(1, min(int(limit), 50)):
            break
    return out


def _recent_unhealthy_streams(
    streams: list[Any],
    stream_snaps: dict[int, RuntimeStreamSnapshot],
    stream_status_by_id: dict[int, str],
    *,
    since: datetime,
    limit: int,
) -> list[RecentUnhealthyStreamItem]:
    out: list[RecentUnhealthyStreamItem] = []
    for stream in streams:
        snap = stream_snaps.get(stream.id)
        if snap is None or snap.health_status == "HEALTHY":
            continue
        at = snap.last_error_at or snap.updated_at
        if at < since:
            continue
        stage = "route_send_failed"
        status = stream_status_by_id.get(int(stream.id), "")
        if "RATE_LIMITED" in status.upper():
            stage = "source_rate_limited" if "SOURCE" in status.upper() else "destination_rate_limited"
        out.append(
            RecentUnhealthyStreamItem(
                stream_id=int(stream.id),
                stream_status=status,
                last_problem_stage=stage,
                last_error_code=None,
                last_error_message=snap.last_error_message,
                last_problem_at=at,
            )
        )
    out.sort(key=lambda x: x.last_problem_at, reverse=True)
    return out[: max(1, min(int(limit), 50))]


def load_runtime_dashboard_summary(
    db: Session,
    limit: int,
    *,
    window: str = "1h",
    snapshot_id: str | None = None,
) -> DashboardSummaryResponse:
    """Build dashboard summary from ``runtime_*_snapshot`` (+ entity metadata joins)."""

    generated_at = _dashboard_snapshot_time(snapshot_id)
    resolved_snapshot_id = _dashboard_snapshot_id(generated_at)
    token = normalize_operational_metrics_window_token(window)
    td = parse_metrics_window(token)
    until = generated_at
    since = until - td
    scale = _operational_scale(int(td.total_seconds()))

    current = summarize_runtime_current(db)
    streams, routes, stream_snaps, route_snaps, _dest_snaps, stream_status_by_id = _load_snapshot_rows(db)

    delivery_success = 0
    delivery_failure = 0
    for snap in route_snaps.values():
        delivery_success += _int_events(float(snap.delivered_eps_1m), 60)
        delivery_failure += _int_events(float(snap.failed_eps_1m), 60)
    delivery_success = int(round(delivery_success * scale))
    delivery_failure = int(round(delivery_failure * scale))

    processed_events = sum(_int_events(float(s.eps_5m), _OPERATIONAL_WINDOW_SECONDS) for s in stream_snaps.values())
    processed_events = int(round(processed_events * scale))

    rate_limited_streams = sum(
        1 for sid, status in stream_status_by_id.items() if "RATE_LIMITED" in status.upper()
    )
    recent_logs = delivery_success + delivery_failure + rate_limited_streams

    healthy, degraded, unhealthy, critical = _stream_health_counts(stream_snaps, stream_status_by_id)

    summary = DashboardSummaryNumbers(
        total_streams=current.total_streams,
        running_streams=current.running_streams,
        paused_streams=current.paused_streams,
        error_streams=current.error_streams,
        stopped_streams=current.stopped_streams,
        rate_limited_source_streams=current.rate_limited_source_streams,
        rate_limited_destination_streams=current.rate_limited_destination_streams,
        total_routes=current.total_routes,
        enabled_routes=current.enabled_routes,
        disabled_routes=current.disabled_routes,
        total_destinations=current.total_destinations,
        enabled_destinations=current.enabled_destinations,
        disabled_destinations=current.disabled_destinations,
        recent_logs=recent_logs,
        recent_successes=delivery_success,
        recent_failures=delivery_failure,
        recent_rate_limited=rate_limited_streams,
        processed_events=processed_events,
        delivery_outcome_events=delivery_success + delivery_failure,
        delivery_success_events=delivery_success,
        delivery_failure_events=delivery_failure,
        current_runtime_streams_healthy=healthy,
        current_runtime_streams_degraded=degraded,
        current_runtime_streams_unhealthy=unhealthy,
        current_runtime_streams_critical=critical,
    )

    from app.startup_readiness import get_startup_snapshot

    snap = get_startup_snapshot()
    started = scheduler_started_at()
    uptime = scheduler_uptime_seconds()
    workers = active_worker_count()
    engine = _runtime_engine_status(snap)

    from app.runtime.schemas import ValidationOperationalSummaryResponse

    validation_operational = ValidationOperationalSummaryResponse.model_validate(
        degraded_validation_operational_summary(scoring_mode="current_runtime")
    )

    return DashboardSummaryResponse(
        snapshot_id=resolved_snapshot_id,
        generated_at=generated_at,
        summary=summary,
        recent_problem_routes=_recent_problem_routes(routes, route_snaps, since=since, limit=limit),
        recent_rate_limited_routes=_recent_rate_limited_routes(
            routes, stream_status_by_id, route_snaps, since=since, limit=limit
        ),
        recent_unhealthy_streams=_recent_unhealthy_streams(
            streams, stream_snaps, stream_status_by_id, since=since, limit=limit
        ),
        scheduler_started_at=started,
        scheduler_uptime_seconds=uptime,
        runtime_engine_status=engine,
        active_worker_count=workers,
        metrics_window_seconds=int(td.total_seconds()),
        window_start=since,
        window_end=until,
        metric_meta=metric_meta_map(
            "processed_events.window",
            "delivery_outcomes.window",
            "delivery_outcomes.success",
            "delivery_outcomes.failure",
            "runtime_telemetry_rows.window",
            "current_runtime.healthy_streams",
            "current_runtime.failed_routes",
            "route_config.total",
            "route_config.enabled",
            "route_config.disabled",
            "runtime.throughput.processed_events_per_second",
            window_start=since,
            window_end=until,
            generated_at=until,
        ),
        visualization_meta=visualization_meta_map(
            "runtime.throughput.window_avg_eps",
            "runtime.top_streams.throughput_share.window_avg_eps",
            snapshot_id=resolved_snapshot_id,
            generated_at=generated_at,
            window_start=since,
            window_end=until,
        ),
        validation_operational=validation_operational,
    )


def load_retry_summary(
    db: Session,
    *,
    window: str | None,
    since: datetime | None,
    stream_id: int | None,
    route_id: int | None,
    destination_id: int | None,
    snapshot_id: str | None = None,
) -> RetrySummaryResponse:
    """Operational retry KPIs from snapshot retry_rate_5m and route EPS (bounded)."""

    from app.runtime.analytics_service import resolve_analytics_window

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

    q = db.query(RuntimeRouteSnapshot)
    if stream_id is not None:
        q = q.filter(RuntimeRouteSnapshot.stream_id == int(stream_id))
    if route_id is not None:
        q = q.filter(RuntimeRouteSnapshot.route_id == int(route_id))
    if destination_id is not None:
        q = q.filter(RuntimeRouteSnapshot.destination_id == int(destination_id))
    route_snaps = list(q.all())

    retry_success = 0
    retry_failed = 0
    for snap in route_snaps:
        activity = _int_events(float(snap.delivered_eps_1m) + float(snap.failed_eps_1m), 60)
        retry_events = int(round(activity * float(snap.retry_rate_5m) / 100.0))
        if retry_events <= 0:
            continue
        if snap.health_status == "ERROR" and snap.last_error_at and (
            snap.last_success_at is None or snap.last_error_at > snap.last_success_at
        ):
            retry_failed += retry_events
        else:
            # Recovered / non-ERROR posture: count reconstructed retry activity as
            # successes. Do not subtract 1 (that collapsed single-retry success to 0).
            retry_success += retry_events

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
        retry_success_events=retry_success,
        retry_failed_events=retry_failed,
        total_retry_outcome_events=retry_success + retry_failed,
        retry_column_sum=0,
    )


def load_operational_outcome_timeseries(
    db: Session,
    *,
    window: str = "1h",
    snapshot_id: str | None = None,
) -> DashboardOutcomeTimeseriesResponse | None:
    """Short operational stacked chart: one dense bucket from current snapshot EPS.

    Returns ``None`` when the caller should use the legacy ``delivery_logs`` bucket
    path (deep historical windows).
    """

    token = normalize_operational_metrics_window_token(window)
    td = parse_metrics_window(token)
    if int(td.total_seconds()) > 3600:
        return None

    generated_at = _dashboard_snapshot_time(snapshot_id)
    resolved_snapshot_id = _dashboard_snapshot_id(generated_at)
    now = generated_at
    since = now - td
    bucket_sec = max(60, min(300, int(td.total_seconds())))
    bucket_start = now - timedelta(seconds=bucket_sec)

    _, _, _stream_snaps, route_snaps, _dest_snaps, stream_status_by_id = _load_snapshot_rows(db)
    success = sum(_int_events(float(s.delivered_eps_1m), 60) for s in route_snaps.values())
    failed = sum(_int_events(float(s.failed_eps_1m), 60) for s in route_snaps.values())
    rate_limited = sum(1 for status in stream_status_by_id.values() if "RATE_LIMITED" in status.upper())

    buckets = [
        DashboardOutcomeBucket(
            bucket_start=bucket_start,
            success=success,
            failed=failed,
            rate_limited=rate_limited,
        )
    ]
    bm = bucket_meta(bucket_sec, len(buckets))
    return DashboardOutcomeTimeseriesResponse(
        snapshot_id=resolved_snapshot_id,
        generated_at=generated_at,
        metrics_window_seconds=int(td.total_seconds()),
        window_start=since,
        window_end=now,
        metric_meta=metric_meta_map("delivery_outcomes.window", window_start=since, window_end=now, generated_at=now),
        visualization_meta=visualization_meta_map(
            "dashboard.delivery_outcomes.bucket_count",
            bucket_size_seconds=bucket_sec,
            bucket_count=len(buckets),
            snapshot_id=resolved_snapshot_id,
            generated_at=generated_at,
            window_start=since,
            window_end=now,
        ),
        bucket_size_seconds=bm["bucket_size_seconds"],
        bucket_count=bm["bucket_count"],
        bucket_alignment=bm["bucket_alignment"],
        bucket_timezone=bm["bucket_timezone"],
        bucket_mode=bm["bucket_mode"],
        buckets=buckets,
    )
