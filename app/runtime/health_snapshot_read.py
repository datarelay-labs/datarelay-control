"""Health scoring reads from physical ``runtime_*_snapshot`` tables (no delivery_logs scan)."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.config import settings
from app.runtime.analytics_schemas import AnalyticsScopeFilters, AnalyticsTimeWindow
from app.runtime.health_schemas import (
    DestinationHealthListResponse,
    DestinationHealthRow,
    HealthOverviewResponse,
    RouteHealthListResponse,
    RouteHealthRow,
    StreamHealthListResponse,
    StreamHealthRow,
)
from app.runtime.health_service import (
    _avg_score,
    _level_breakdown,
    _normalize_scoring_mode,
)
from app.runtime.metric_contract import metric_meta_map
from app.runtime.models import RuntimeDestinationSnapshot, RuntimeRouteSnapshot, RuntimeStreamSnapshot
from app.runtime.runtime_snapshot_repository import read_model_is_populated
from app.runtime.aggregate_summaries import summarize_route_posture_config
from app.runtime import health_repository as repo
from app.runtime.analytics_service import resolve_analytics_window
from app.runtime.health_scoring_model import compute_health_score_for_mode, OutcomeAggregate, resolve_recent_posture_window
from app.streams.models import Stream

UTC = timezone.utc
_WINDOW_SECONDS = 300


def snapshot_health_available(db: Session) -> bool:
    if not bool(getattr(settings, "GDC_RUNTIME_OPERATIONAL_SNAPSHOT_READ_MODEL_ENABLED", True)):
        return False
    return read_model_is_populated(db)


def _events_from_eps(eps: float | None, window_seconds: int) -> int:
    return max(0, int(round(float(eps or 0) * window_seconds)))


def _failure_newer_than_success(row: object) -> bool:
    last_failure_at = getattr(row, "last_error_at", None)
    last_success_at = getattr(row, "last_success_at", None)
    if last_failure_at is None:
        return False
    if last_success_at is None:
        return True
    return last_failure_at > last_success_at


def _snapshot_outcome(row: RuntimeStreamSnapshot | RuntimeRouteSnapshot | RuntimeDestinationSnapshot) -> OutcomeAggregate:
    """Build scoring aggregates from physical snapshot rows.

    Route/destination snapshots store ``delivered_eps_1m`` / ``inbound_eps_1m`` and
    ``failed_eps_1m`` (not stream ``eps_5m``). Reconstructing failures as
    ``success * failure_rate / (100 - failure_rate)`` collapses to zero whenever
    success EPS is 0 — which is exactly the total destination-outage case — and
    falsely scores HEALTHY. Prefer direct failed EPS, and synthesize a minimum
    failure signal when last_error is newer than last_success.
    """

    latency = getattr(row, "avg_latency_ms", None)
    last_failure_at = getattr(row, "last_error_at", None)
    last_success_at = getattr(row, "last_success_at", None)
    retry_rate = float(getattr(row, "retry_rate_5m", 0) or 0)

    failed_eps_1m = getattr(row, "failed_eps_1m", None)
    delivered_eps_1m = getattr(row, "delivered_eps_1m", None)
    inbound_eps_1m = getattr(row, "inbound_eps_1m", None)

    if failed_eps_1m is not None and (delivered_eps_1m is not None or inbound_eps_1m is not None):
        success_eps = float(
            delivered_eps_1m if delivered_eps_1m is not None else (inbound_eps_1m or 0.0)
        )
        success = _events_from_eps(success_eps, 60)
        failure = _events_from_eps(float(failed_eps_1m or 0.0), 60)
        if failure <= 0 and _failure_newer_than_success(row):
            failure = 1
    else:
        success = _events_from_eps(getattr(row, "eps_5m", 0), _WINDOW_SECONDS)
        failure_rate = float(getattr(row, "failure_rate_5m", 0) or 0)
        if failure_rate > 0:
            if success > 0 and failure_rate < 100.0:
                failure = max(
                    0,
                    int(round(success * failure_rate / max(1.0, 100.0 - failure_rate))),
                )
            else:
                # Total (or near-total) failure window: do not collapse to empty.
                failure = max(1, int(round(failure_rate)))
        else:
            failure = 0
        # Source outages set last_error via run_failed without route failure counts.
        # Synthesize a minimum failure signal whenever the error is newer than success.
        if failure <= 0 and _failure_newer_than_success(row):
            failure = 1

    retry = max(0, int(round((success + failure) * retry_rate / 100.0)))
    return OutcomeAggregate(
        failure_count=failure,
        success_count=success,
        retry_event_count=retry,
        retry_count_sum=retry,
        rate_limit_count=0,
        latency_ms_avg=latency,
        latency_ms_p95=latency,
        last_failure_at=last_failure_at,
        last_success_at=last_success_at,
    )


def list_stream_health_from_snapshots(
    db: Session,
    *,
    window: str | None,
    since: datetime | None,
    stream_id: int | None,
    route_id: int | None,
    destination_id: int | None,
    scoring_mode: str | None = None,
    snapshot_id: str | None = None,
) -> StreamHealthListResponse:
    mode = _normalize_scoring_mode(scoring_mode)
    token, start, until, resolved_snapshot_id = resolve_analytics_window(
        window=window, since=since, snapshot_id=snapshot_id
    )
    recent_since, recent_until = resolve_recent_posture_window(start, until)
    q = db.query(RuntimeStreamSnapshot, Stream.name, Stream.connector_id).join(
        Stream, Stream.id == RuntimeStreamSnapshot.stream_id
    )
    if stream_id is not None:
        q = q.filter(RuntimeStreamSnapshot.stream_id == int(stream_id))
    rows = q.order_by(RuntimeStreamSnapshot.stream_id.asc()).all()
    items: list[StreamHealthRow] = []
    for snap, name, conn_id in rows:
        full = _snapshot_outcome(snap)
        score = compute_health_score_for_mode(
            full,
            full,
            scoring_mode=mode,
            include_latency=False,
            recent_window_since=recent_since,
            recent_window_until=recent_until,
        )
        items.append(
            StreamHealthRow(
                stream_id=int(snap.stream_id),
                stream_name=name,
                connector_id=int(conn_id) if conn_id is not None else None,
                score=score.score,
                level=score.level,
                factors=score.factors,
                metrics=score.metrics,
            )
        )
    items.sort(key=lambda r: (r.score, r.stream_id))
    return StreamHealthListResponse(
        time=AnalyticsTimeWindow(
            window=token, since=start, until=until, snapshot_id=resolved_snapshot_id, generated_at=until
        ),
        filters=AnalyticsScopeFilters(stream_id=stream_id, route_id=route_id, destination_id=destination_id),
        scoring_mode=mode,
        metric_meta=metric_meta_map(
            "historical_health.streams" if mode == "historical_analytics" else "current_runtime.healthy_streams",
            window_start=start,
            window_end=until,
            generated_at=until,
        ),
        rows=items,
    )


def list_route_health_from_snapshots(
    db: Session,
    *,
    window: str | None,
    since: datetime | None,
    stream_id: int | None,
    route_id: int | None,
    destination_id: int | None,
    scoring_mode: str | None = None,
    snapshot_id: str | None = None,
) -> RouteHealthListResponse:
    mode = _normalize_scoring_mode(scoring_mode)
    token, start, until, resolved_snapshot_id = resolve_analytics_window(
        window=window, since=since, snapshot_id=snapshot_id
    )
    recent_since, recent_until = resolve_recent_posture_window(start, until)
    q = db.query(RuntimeRouteSnapshot)
    if stream_id is not None:
        q = q.filter(RuntimeRouteSnapshot.stream_id == int(stream_id))
    if route_id is not None:
        q = q.filter(RuntimeRouteSnapshot.route_id == int(route_id))
    if destination_id is not None:
        q = q.filter(RuntimeRouteSnapshot.destination_id == int(destination_id))
    snaps = q.order_by(RuntimeRouteSnapshot.route_id.asc()).all()
    items: list[RouteHealthRow] = []
    for snap in snaps:
        full = _snapshot_outcome(snap)
        score = compute_health_score_for_mode(
            full,
            full,
            scoring_mode=mode,
            include_latency=False,
            recent_window_since=recent_since,
            recent_window_until=recent_until,
        )
        items.append(
            RouteHealthRow(
                route_id=int(snap.route_id),
                stream_id=int(snap.stream_id),
                destination_id=int(snap.destination_id),
                score=score.score,
                level=score.level,
                factors=score.factors,
                metrics=score.metrics,
            )
        )
    items.sort(key=lambda r: (r.score, r.route_id))
    return RouteHealthListResponse(
        time=AnalyticsTimeWindow(
            window=token, since=start, until=until, snapshot_id=resolved_snapshot_id, generated_at=until
        ),
        filters=AnalyticsScopeFilters(stream_id=stream_id, route_id=route_id, destination_id=destination_id),
        scoring_mode=mode,
        metric_meta=metric_meta_map(
            "historical_health.routes" if mode == "historical_analytics" else "current_runtime.failed_routes",
            window_start=start,
            window_end=until,
            generated_at=until,
        ),
        rows=items,
    )


def list_destination_health_from_snapshots(
    db: Session,
    *,
    window: str | None,
    since: datetime | None,
    stream_id: int | None,
    route_id: int | None,
    destination_id: int | None,
    scoring_mode: str | None = None,
    snapshot_id: str | None = None,
) -> DestinationHealthListResponse:
    mode = _normalize_scoring_mode(scoring_mode)
    token, start, until, resolved_snapshot_id = resolve_analytics_window(
        window=window, since=since, snapshot_id=snapshot_id
    )
    recent_since, recent_until = resolve_recent_posture_window(start, until)
    q = db.query(RuntimeDestinationSnapshot)
    if destination_id is not None:
        q = q.filter(RuntimeDestinationSnapshot.destination_id == int(destination_id))
    snaps = q.order_by(RuntimeDestinationSnapshot.destination_id.asc()).all()
    items: list[DestinationHealthRow] = []
    for snap in snaps:
        full = _snapshot_outcome(snap)
        score = compute_health_score_for_mode(
            full,
            full,
            scoring_mode=mode,
            include_latency=False,
            recent_window_since=recent_since,
            recent_window_until=recent_until,
        )
        items.append(
            DestinationHealthRow(
                destination_id=int(snap.destination_id),
                score=score.score,
                level=score.level,
                factors=score.factors,
                metrics=score.metrics,
            )
        )
    items.sort(key=lambda r: (r.score, r.destination_id))
    return DestinationHealthListResponse(
        time=AnalyticsTimeWindow(
            window=token, since=start, until=until, snapshot_id=resolved_snapshot_id, generated_at=until
        ),
        filters=AnalyticsScopeFilters(stream_id=stream_id, route_id=route_id, destination_id=destination_id),
        scoring_mode=mode,
        metric_meta=metric_meta_map("delivery_outcomes.window", window_start=start, window_end=until, generated_at=until),
        rows=items,
    )


def get_health_overview_from_snapshots(
    db: Session,
    *,
    window: str | None,
    since: datetime | None,
    stream_id: int | None,
    route_id: int | None,
    destination_id: int | None,
    worst_limit: int = 5,
    scoring_mode: str | None = None,
    snapshot_id: str | None = None,
) -> HealthOverviewResponse:
    streams = list_stream_health_from_snapshots(
        db,
        window=window,
        since=since,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
        scoring_mode=scoring_mode,
        snapshot_id=snapshot_id,
    )
    routes = list_route_health_from_snapshots(
        db,
        window=window,
        since=since,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
        scoring_mode=scoring_mode,
        snapshot_id=snapshot_id,
    )
    destinations = list_destination_health_from_snapshots(
        db,
        window=window,
        since=since,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
        scoring_mode=scoring_mode,
        snapshot_id=snapshot_id,
    )
    s_scores = [r.score for r in streams.rows]
    r_scores = [r.score for r in routes.rows]
    d_scores = [r.score for r in destinations.rows]
    route_posture = summarize_route_posture_config(
        db,
        active_route_ids=[r.route_id for r in routes.rows],
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
    )
    total_streams = repo.count_streams_in_scope(
        db, stream_id=stream_id, route_id=route_id, destination_id=destination_id
    )
    total_destinations = repo.count_destinations_in_scope(
        db, stream_id=stream_id, route_id=route_id, destination_id=destination_id
    )
    worst_n = max(1, min(int(worst_limit), 25))
    return HealthOverviewResponse(
        time=streams.time,
        filters=streams.filters,
        scoring_mode=streams.scoring_mode,
        metric_meta=metric_meta_map(
            "current_runtime.healthy_streams",
            "current_runtime.failed_routes",
            "historical_health.routes",
            "historical_health.streams",
            "route_config.total",
            "route_config.enabled",
            "route_config.disabled",
            window_start=streams.time.since,
            window_end=streams.time.until,
            generated_at=streams.time.until,
        ),
        streams=_level_breakdown(
            s_scores, total=total_streams, excluded_no_outcome=max(0, total_streams - len(s_scores))
        ),
        routes=_level_breakdown(
            r_scores,
            idle=route_posture.idle_enabled_routes,
            disabled=route_posture.disabled_routes,
            total=route_posture.total_routes,
            excluded_no_outcome=route_posture.idle_enabled_routes,
        ),
        destinations=_level_breakdown(
            d_scores, total=total_destinations, excluded_no_outcome=max(0, total_destinations - len(d_scores))
        ),
        average_stream_score=_avg_score(s_scores),
        average_route_score=_avg_score(r_scores),
        average_destination_score=_avg_score(d_scores),
        worst_routes=routes.rows[:worst_n],
        worst_streams=streams.rows[:worst_n],
        worst_destinations=destinations.rows[:worst_n],
    )
