"""Assemble virtual operational snapshot from bulk repository data (no DB in loops)."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.runtime.operational_snapshot_repository import (
    LastOutcomeRow,
    OperationalSnapshotBulkData,
    PhysicalOperationalRows,
    SourceFailureRow,
    WindowAggregateRow,
    fetch_connector_names,
    fetch_stream_source_failures,
    load_operational_snapshot_bulk_data,
    load_physical_operational_rows,
)
from app.runtime.operational_snapshot_schemas import (
    OperationalDestinationSnapshot,
    OperationalGlobalSnapshot,
    OperationalHealthStatus,
    OperationalProblem,
    OperationalRouteSnapshot,
    OperationalSnapshotResponse,
    OperationalStreamSnapshot,
)

_CHECKPOINT_LAG_WARNING_SECONDS = 3600
# "Observed recently" window. Reuses the existing 3600 s checkpoint-stale value
# (also the connectors "No Data (1h)" rule); it is not a separate threshold.
_OBSERVATION_FRESHNESS_SECONDS = _CHECKPOINT_LAG_WARNING_SECONDS
# Operator-controlled stop states: their own operational state, never a failure.
_OPERATOR_STOPPED_STATUSES = frozenset({"PAUSED", "STOPPED", "STOPPING"})
_RATE_WINDOW = timedelta(minutes=5)


def _eps(success_count: int, window_seconds: int) -> float:
    return round(success_count / max(1, window_seconds), 6)


def _rates(agg: WindowAggregateRow | None) -> tuple[float, float, float]:
    """Stored (non-null) rates; zero attempts map to 0.0. API reads use ``_api_rates``."""

    if agg is None:
        return 0.0, 0.0, 0.0
    total = agg.success_count + agg.failure_count
    if total <= 0:
        return 0.0, 0.0, 0.0
    success_rate = round(agg.success_count / total * 100.0, 4)
    failure_rate = round(agg.failure_count / total * 100.0, 4)
    retry_rate = round(agg.retry_count / total * 100.0, 4)
    return success_rate, failure_rate, retry_rate


def _api_rates(agg: WindowAggregateRow | None) -> tuple[float | None, float | None, float]:
    """Success/failure rates for the API: None when there were no completed attempts."""

    success_rate, failure_rate, retry_rate = _rates(agg)
    if agg is None or agg.success_count + agg.failure_count <= 0:
        return None, None, retry_rate
    return success_rate, failure_rate, retry_rate


def _stored_stream_rates(
    success_rate_5m: float, failure_rate_5m: float
) -> tuple[float | None, float | None]:
    """Stored stream rates are 0/0 only when the 5m window had no attempts."""

    if success_rate_5m <= 0.0 and failure_rate_5m <= 0.0:
        return None, None
    return success_rate_5m, failure_rate_5m


def _stored_route_success_rate(snap: object) -> float | None:
    """Map a stored route ``success_rate_5m`` of 0.0 with no attempts to None.

    Stored route rows keep a non-null 0.0 for "no attempts". Any success, retry,
    1m failure, or a failure inside the row's 5m window means attempts existed.
    """

    success_rate_5m = float(snap.success_rate_5m)  # type: ignore[attr-defined]
    if success_rate_5m > 0.0:
        return success_rate_5m
    if float(snap.retry_rate_5m or 0.0) > 0.0 or float(snap.failed_eps_1m or 0.0) > 0.0:  # type: ignore[attr-defined]
        return success_rate_5m
    last_error_at = getattr(snap, "last_error_at", None)
    updated_at = getattr(snap, "updated_at", None)
    if last_error_at is not None and updated_at is not None:
        if _as_utc(last_error_at) >= _as_utc(updated_at) - _RATE_WINDOW:
            return success_rate_5m
    return None


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def is_observation_stale(observed_at: datetime | None, now: datetime | None) -> bool:
    """True when ``observed_at`` is at least the freshness window older than ``now``.

    ``now=None`` disables the freshness check (callers that do not evaluate time).
    """

    if now is None or observed_at is None:
        return False
    age_seconds = (_as_utc(now) - _as_utc(observed_at)).total_seconds()
    return age_seconds >= _OBSERVATION_FRESHNESS_SECONDS


def is_operator_stopped_status(status: str | None) -> bool:
    """PAUSED / STOPPED / STOPPING: no health verdict, never a failure."""

    return str(status or "").strip().upper() in _OPERATOR_STOPPED_STATUSES


def _last_fields(last: LastOutcomeRow | None) -> tuple[datetime | None, datetime | None, str | None]:
    if last is None:
        return None, None, None
    return last.last_success_at, last.last_failure_at, last.last_error_message


def classify_stream_health(
    *,
    enabled: bool,
    status: str,
    last_success_at: datetime | None,
    last_error_at: datetime | None,
    failure_rate_5m: float,
    failed_route_count: int = 0,
    healthy_route_count: int = 0,
    route_count: int = 0,
    now: datetime | None = None,
) -> OperationalHealthStatus:
    """Classify stream operational health.

    Total delivery failure (high failure rate, or every enabled route failed with
    no healthy routes) must not remain HEALTHY merely because a prior success
    still exists. Partial route failure stays DEGRADED.

    Source outages persist as ``run_failed`` and raise stream failure_rate; once
    a newer success lands with no failed routes, recovery must not stay stuck on
    the lagging 5m failure window.

    IDLE means "no health verdict": disabled, operator-stopped (PAUSED/STOPPED/
    STOPPING), or not observed yet. HEALTHY requires a success inside the
    freshness window when ``now`` is given; an older success with nothing newer
    is DEGRADED ("no recent ingest/delivery observed").
    """

    if not enabled:
        return "IDLE"
    status_upper = status.upper()
    if "ERROR" in status_upper:
        return "ERROR"
    if is_operator_stopped_status(status_upper):
        return "IDLE"
    if "RATE_LIMITED" in status_upper:
        return "DEGRADED"

    enabled_routes = max(0, int(route_count or 0))
    failed_routes = max(0, int(failed_route_count or 0))
    healthy_routes = max(0, int(healthy_route_count or 0))
    success_is_fresh = not is_observation_stale(last_success_at, now)

    recovered = (
        last_success_at is not None
        and success_is_fresh
        and (last_error_at is None or last_success_at >= last_error_at)
        and failed_routes == 0
    )
    if recovered:
        return "HEALTHY"

    if last_error_at is not None and last_success_at is None:
        return "ERROR"
    # Apply rate / total-route failure before the newer-error DEGRADED shortcut so
    # sustained destination outages surface as ERROR rather than soft DEGRADED.
    if failure_rate_5m >= 50.0:
        return "ERROR"
    if (
        enabled_routes > 0
        and failed_routes >= enabled_routes
        and healthy_routes == 0
        and last_error_at is not None
    ):
        return "ERROR"
    if last_error_at is not None and last_success_at is not None and last_error_at > last_success_at:
        return "DEGRADED"
    if failure_rate_5m > 0.0:
        return "DEGRADED"
    if failed_routes > 0:
        return "DEGRADED"
    if last_success_at is not None:
        # A success older than the freshness window with nothing newer is no
        # longer evidence of health.
        return "HEALTHY" if success_is_fresh else "DEGRADED"
    return "IDLE"


def classify_route_health(
    *,
    enabled: bool,
    last_success_at: datetime | None,
    last_error_at: datetime | None,
    failed_eps_1m: float,
    retry_rate_5m: float,
    now: datetime | None = None,
) -> OperationalHealthStatus:
    if not enabled:
        return "IDLE"
    if last_error_at is not None and last_success_at is None:
        return "ERROR"
    if last_error_at is not None and last_success_at is not None and last_error_at > last_success_at:
        return "ERROR"
    if failed_eps_1m > 0.0 or retry_rate_5m > 0.0:
        return "DEGRADED"
    # Zero recent traffic is not a failure: an old success is IDLE, not HEALTHY.
    if last_success_at is not None and not is_observation_stale(last_success_at, now):
        return "HEALTHY"
    return "IDLE"


def classify_destination_health(
    *,
    enabled: bool,
    route_healths: list[OperationalHealthStatus],
    last_success_at: datetime | None,
    last_connectivity_test_success: bool | None = None,
    last_error_at: datetime | None = None,
    failed_eps_1m: float = 0.0,
    now: datetime | None = None,
) -> OperationalHealthStatus:
    """Classify destination health from delivery-only evidence.

    ``last_success_at`` / ``last_error_at`` / ``failed_eps_1m`` are the
    destination's own delivery outcomes (policy dispositions excluded). A route
    ERROR escalates the destination only when that delivery evidence shows a
    failure, so policy-only route problems never make a destination unhealthy.
    Route DEGRADED is derived from delivery failures/retries only and still
    escalates. A passing connectivity test without deliveries is not a health
    verdict (IDLE); ``last_connectivity_test_success`` is accepted for callers
    but no longer yields HEALTHY.
    """

    if not enabled:
        return "IDLE"
    delivery_failing = failed_eps_1m > 0.0 or (
        last_error_at is not None and (last_success_at is None or last_error_at >= last_success_at)
    )
    if any(h == "ERROR" for h in route_healths):
        if delivery_failing:
            return "ERROR"
        if last_error_at is not None and not is_observation_stale(last_error_at, now):
            # Recent delivery failure on one route, newer success elsewhere.
            return "DEGRADED"
    if any(h == "DEGRADED" for h in route_healths):
        return "DEGRADED"
    if last_success_at is not None and not is_observation_stale(last_success_at, now):
        return "HEALTHY"
    return "IDLE"


def classify_global_health(
    *,
    enabled_streams: int,
    problems: list[OperationalProblem],
    streams: list[OperationalStreamSnapshot] | None = None,
) -> OperationalHealthStatus:
    """Roll up global health; Unknown/IDLE never hides a confirmed problem.

    With ``streams``, HEALTHY also requires every enabled, not operator-stopped
    stream to have a verdict: one not-observed (IDLE) stream, or every enabled
    stream being paused/stopped, yields IDLE.
    """

    if enabled_streams <= 0:
        return "IDLE"
    if any(p.severity == "critical" for p in problems):
        return "ERROR"
    if any(p.severity == "warning" for p in problems):
        return "DEGRADED"
    if streams is not None:
        active = [s for s in streams if s.enabled and not is_operator_stopped_status(s.status)]
        if not active:
            return "IDLE"
        if any(s.health_status == "IDLE" for s in active):
            return "IDLE"
    return "HEALTHY"


def _checkpoint_lag_seconds(now: datetime, checkpoint_updated_at: datetime | None) -> int | None:
    if checkpoint_updated_at is None:
        return None
    return max(0, int((now - checkpoint_updated_at).total_seconds()))


def should_flag_checkpoint_stale(stream: OperationalStreamSnapshot) -> bool:
    """Warn only when a stream is actively delivering but checkpoint has not advanced."""
    if not stream.enabled:
        return False
    lag = stream.checkpoint_lag_seconds
    if lag is None or lag < _CHECKPOINT_LAG_WARNING_SECONDS:
        return False
    if stream.eps_1m <= 0 and stream.eps_5m <= 0:
        return False
    if stream.last_success_at is None:
        return False
    cp_at = stream.checkpoint_updated_at
    if cp_at is None:
        return True
    return cp_at < stream.last_success_at


def build_operational_snapshot(db: Session) -> OperationalSnapshotResponse:
    physical = load_physical_operational_rows(db)
    if physical is not None:
        snapshot = _assemble_snapshot_from_physical(physical)
    else:
        bulk = load_operational_snapshot_bulk_data(db)
        snapshot = _assemble_snapshot(bulk)
    return _with_source_failure_problems(db, snapshot)


_SOURCE_HTTP_STATUS_RE = re.compile(r"\bHTTP\s+(\d{3})\b")


def _source_failure_http_status(row: SourceFailureRow) -> int | None:
    if row.last_source_failure_http_status is not None:
        return row.last_source_failure_http_status
    match = _SOURCE_HTTP_STATUS_RE.search(row.last_source_failure_message or "")
    return int(match.group(1)) if match else None


def build_source_failure_problems(
    *,
    stream_snapshots: list[OperationalStreamSnapshot],
    source_failures: dict[int, SourceFailureRow],
    connector_names: dict[int, str],
) -> list[OperationalProblem]:
    """Attribute Source/auth collection failures to the Stream and its Connector.

    Evidence only: a Stream needs a recorded ``SOURCE_FETCH_FAILED`` run failure that
    no newer successful fetch has superseded. Disabled and operator-stopped Streams
    carry no verdict, and a Stream with no observation or zero traffic yields nothing.
    The raw upstream message (URL, query string) is never copied into the problem.
    """

    problems: list[OperationalProblem] = []
    for stream in stream_snapshots:
        if not stream.enabled or is_operator_stopped_status(stream.status):
            continue
        failure = source_failures.get(stream.stream_id)
        if failure is None:
            continue
        http_status = _source_failure_http_status(failure)
        connector_name = (
            connector_names.get(stream.connector_id) if stream.connector_id is not None else None
        )
        if http_status == 401:
            title = f"Stream {stream.stream_name}: source authentication failed (HTTP 401)"
            error_code = "SOURCE_AUTH_FAILED"
        elif http_status == 403:
            title = f"Stream {stream.stream_name}: source access denied (HTTP 403)"
            error_code = "SOURCE_AUTH_FAILED"
        else:
            suffix = f" (HTTP {http_status})" if http_status is not None else ""
            title = f"Stream {stream.stream_name}: source fetch failing{suffix}"
            error_code = "SOURCE_FETCH_FAILED"
        where = f"Connector {connector_name}" if connector_name else "its Connector"
        problems.append(
            OperationalProblem(
                severity="critical",
                scope="stream",
                stream_id=stream.stream_id,
                title=title,
                message=(
                    f"The latest source request through {where} failed"
                    f"{f' with HTTP {http_status}' if http_status is not None else ''}. "
                    "Check the Connector authentication and the source endpoint."
                ),
                last_seen_at=failure.last_source_failure_at,
                error_code=error_code,
                http_status=http_status,
                connector_id=stream.connector_id,
                connector_name=connector_name,
            )
        )
    return problems


def _with_source_failure_problems(
    db: Session, snapshot: OperationalSnapshotResponse
) -> OperationalSnapshotResponse:
    """Additive: append Source-failure problems without changing any health verdict."""

    candidates = [s for s in snapshot.streams if s.enabled and not is_operator_stopped_status(s.status)]
    if not candidates:
        return snapshot
    source_failures = fetch_stream_source_failures(db, group_ids=[s.stream_id for s in candidates])
    if not source_failures:
        return snapshot
    connector_names = fetch_connector_names(
        db,
        connector_ids=[
            s.connector_id for s in candidates
            if s.stream_id in source_failures and s.connector_id is not None
        ],
    )
    extra = build_source_failure_problems(
        stream_snapshots=candidates,
        source_failures=source_failures,
        connector_names=connector_names,
    )
    if not extra:
        return snapshot
    return snapshot.model_copy(update={"problems": [*extra, *snapshot.problems]})


def _assemble_snapshot_from_physical(rows: PhysicalOperationalRows) -> OperationalSnapshotResponse:
    """Assemble API contract from materialized runtime_*_snapshot tables."""

    route_snapshots: list[OperationalRouteSnapshot] = []
    route_health_by_id: dict[int, OperationalHealthStatus] = {}

    for route in rows.routes:
        snap = rows.route_snapshots.get(route.id)
        success_rate_5m: float | None
        if snap is not None:
            delivered_eps_1m = float(snap.delivered_eps_1m)  # type: ignore[union-attr]
            failed_eps_1m = float(snap.failed_eps_1m)  # type: ignore[union-attr]
            success_rate_5m = _stored_route_success_rate(snap)
            retry_rate_5m = float(snap.retry_rate_5m)  # type: ignore[union-attr]
            avg_latency_ms = snap.avg_latency_ms  # type: ignore[union-attr]
            last_success_at = snap.last_success_at  # type: ignore[union-attr]
            last_error_at = snap.last_error_at  # type: ignore[union-attr]
            last_error_message = snap.last_error_message  # type: ignore[union-attr]
            health = classify_route_health(
                enabled=route.enabled,
                last_success_at=last_success_at,
                last_error_at=last_error_at,
                failed_eps_1m=failed_eps_1m,
                retry_rate_5m=retry_rate_5m,
                now=rows.now,
            )
        else:
            health = classify_route_health(
                enabled=route.enabled,
                last_success_at=None,
                last_error_at=None,
                failed_eps_1m=0.0,
                retry_rate_5m=0.0,
                now=rows.now,
            )
            delivered_eps_1m = failed_eps_1m = retry_rate_5m = 0.0
            success_rate_5m = None
            avg_latency_ms = last_success_at = last_error_at = last_error_message = None

        route_health_by_id[route.id] = health
        route_snapshots.append(
            OperationalRouteSnapshot(
                route_id=route.id,
                stream_id=route.stream_id,
                stream_name=route.stream_name,
                destination_id=route.destination_id,
                destination_name=route.destination_name,
                destination_type=route.destination_type,
                enabled=route.enabled,
                failure_policy=route.failure_policy,
                health_status=health,
                delivered_eps_1m=delivered_eps_1m,
                failed_eps_1m=failed_eps_1m,
                success_rate_5m=success_rate_5m,
                retry_rate_5m=retry_rate_5m,
                avg_latency_ms=avg_latency_ms,
                last_success_at=last_success_at,
                last_error_at=last_error_at,
                last_error_message=last_error_message,
            )
        )

    routes_by_stream: dict[int, list[int]] = {}
    routes_by_destination: dict[int, list[int]] = {}
    for route in rows.routes:
        routes_by_stream.setdefault(route.stream_id, []).append(route.id)
        routes_by_destination.setdefault(route.destination_id, []).append(route.id)

    stream_snapshots: list[OperationalStreamSnapshot] = []
    for stream in rows.streams:
        snap = rows.stream_snapshots.get(stream.id)
        stream_success_rate: float | None
        stream_failure_rate: float | None
        if snap is not None:
            eps_1m = float(snap.eps_1m)  # type: ignore[union-attr]
            eps_5m = float(snap.eps_5m)  # type: ignore[union-attr]
            failure_rate_5m = float(snap.failure_rate_5m)  # type: ignore[union-attr]
            stream_success_rate, stream_failure_rate = _stored_stream_rates(
                float(snap.success_rate_5m),  # type: ignore[union-attr]
                failure_rate_5m,
            )
            avg_latency_ms = snap.avg_latency_ms  # type: ignore[union-attr]
            route_count = int(snap.route_count)  # type: ignore[union-attr]
            healthy_route_count = int(snap.healthy_route_count)  # type: ignore[union-attr]
            failed_route_count = int(snap.failed_route_count)  # type: ignore[union-attr]
            last_success_at = snap.last_success_at  # type: ignore[union-attr]
            last_error_at = snap.last_error_at  # type: ignore[union-attr]
            last_error_message = snap.last_error_message  # type: ignore[union-attr]
            checkpoint_updated_at = snap.checkpoint_updated_at  # type: ignore[union-attr]
            checkpoint_lag_seconds = snap.checkpoint_lag_seconds  # type: ignore[union-attr]
            # Re-classify from posture fields so classifier fixes apply on read without
            # waiting for the next updater cycle to rewrite health_status.
            health = classify_stream_health(
                enabled=stream.enabled,
                status=stream.status,
                last_success_at=last_success_at,
                last_error_at=last_error_at,
                failure_rate_5m=failure_rate_5m,
                failed_route_count=failed_route_count,
                healthy_route_count=healthy_route_count,
                route_count=route_count,
                now=rows.now,
            )
        else:
            # Missing snapshot row: no evidence, never HEALTHY.
            health = classify_stream_health(
                enabled=stream.enabled,
                status=stream.status,
                last_success_at=None,
                last_error_at=None,
                failure_rate_5m=0.0,
                now=rows.now,
            )
            eps_1m = eps_5m = 0.0
            stream_success_rate = stream_failure_rate = None
            avg_latency_ms = last_success_at = last_error_at = last_error_message = None
            checkpoint_updated_at = checkpoint_lag_seconds = None
            route_ids = routes_by_stream.get(stream.id, [])
            route_count = rows.routes_per_stream.get(stream.id, len(route_ids))
            healthy_route_count = failed_route_count = 0

        stream_snapshots.append(
            OperationalStreamSnapshot(
                stream_id=stream.id,
                stream_name=stream.name,
                connector_id=stream.connector_id,
                source_id=stream.source_id,
                enabled=stream.enabled,
                status=stream.status,
                health_status=health,
                eps_1m=eps_1m,
                eps_5m=eps_5m,
                success_rate_5m=stream_success_rate,
                failure_rate_5m=stream_failure_rate,
                avg_latency_ms=avg_latency_ms,
                route_count=route_count,
                healthy_route_count=healthy_route_count,
                failed_route_count=failed_route_count,
                last_success_at=last_success_at,
                last_error_at=last_error_at,
                last_error_message=last_error_message,
                checkpoint_updated_at=checkpoint_updated_at,
                checkpoint_lag_seconds=checkpoint_lag_seconds,
            )
        )

    destination_snapshots: list[OperationalDestinationSnapshot] = []
    for dest in rows.destinations:
        snap = rows.destination_snapshots.get(dest.id)
        route_ids = routes_by_destination.get(dest.id, [])
        route_healths = [route_health_by_id[rid] for rid in route_ids if rid in route_health_by_id]
        if snap is not None:
            inbound_eps_1m = float(snap.inbound_eps_1m)  # type: ignore[union-attr]
            failed_eps_1m = float(snap.failed_eps_1m)  # type: ignore[union-attr]
            avg_latency_ms = snap.avg_latency_ms  # type: ignore[union-attr]
            route_count = int(snap.route_count)  # type: ignore[union-attr]
            last_success_at = snap.last_success_at  # type: ignore[union-attr]
            last_error_at = snap.last_error_at  # type: ignore[union-attr]
            last_error_message = snap.last_error_message  # type: ignore[union-attr]
            health = classify_destination_health(
                enabled=dest.enabled,
                route_healths=route_healths,
                last_success_at=last_success_at,
                last_connectivity_test_success=dest.last_connectivity_test_success,
                last_error_at=last_error_at,
                failed_eps_1m=failed_eps_1m,
                now=rows.now,
            )
        else:
            health = classify_destination_health(
                enabled=dest.enabled,
                route_healths=route_healths,
                last_success_at=None,
                last_connectivity_test_success=dest.last_connectivity_test_success,
                now=rows.now,
            )
            inbound_eps_1m = failed_eps_1m = 0.0
            avg_latency_ms = last_success_at = last_error_at = last_error_message = None
            route_count = rows.routes_per_destination.get(dest.id, len(route_ids))

        destination_snapshots.append(
            OperationalDestinationSnapshot(
                destination_id=dest.id,
                destination_name=dest.name,
                destination_type=dest.destination_type,
                enabled=dest.enabled,
                health_status=health,
                inbound_eps_1m=inbound_eps_1m,
                failed_eps_1m=failed_eps_1m,
                avg_latency_ms=avg_latency_ms,
                route_count=route_count,
                last_success_at=last_success_at,
                last_error_at=last_error_at,
                last_error_message=last_error_message,
            )
        )

    problems = _build_problems(
        stream_snapshots=stream_snapshots,
        route_snapshots=route_snapshots,
        destination_snapshots=destination_snapshots,
        now=rows.now,
    )

    enabled_streams = sum(1 for s in rows.streams if s.enabled)
    running_streams = sum(1 for s in rows.streams if s.enabled and s.status.upper() == "RUNNING")
    error_streams = sum(1 for s in rows.streams if "ERROR" in s.status.upper())
    enabled_routes = sum(1 for r in rows.routes if r.enabled)
    enabled_destinations = sum(1 for d in rows.destinations if d.enabled)
    total_eps_1m = round(sum(s.eps_1m for s in stream_snapshots), 6)
    total_eps_5m = round(sum(s.eps_5m for s in stream_snapshots), 6)

    latency_values = [s.avg_latency_ms for s in stream_snapshots if s.avg_latency_ms is not None]
    avg_latency_ms = (
        round(sum(latency_values) / len(latency_values), 4) if latency_values else None
    )

    activity_times: list[datetime] = []
    for snap in stream_snapshots:
        if snap.last_success_at is not None:
            activity_times.append(snap.last_success_at)
        if snap.last_error_at is not None:
            activity_times.append(snap.last_error_at)
    last_activity_at = max(activity_times) if activity_times else None

    global_health = classify_global_health(
        enabled_streams=enabled_streams,
        problems=problems,
        streams=stream_snapshots,
    )

    global_snapshot = OperationalGlobalSnapshot(
        health_status=global_health,
        total_streams=len(rows.streams),
        enabled_streams=enabled_streams,
        running_streams=running_streams,
        error_streams=error_streams,
        total_routes=len(rows.routes),
        enabled_routes=enabled_routes,
        total_destinations=len(rows.destinations),
        enabled_destinations=enabled_destinations,
        total_eps_1m=total_eps_1m,
        total_eps_5m=total_eps_5m,
        avg_latency_ms=avg_latency_ms,
        last_activity_at=last_activity_at,
    )

    return OperationalSnapshotResponse(
        global_=global_snapshot,
        streams=stream_snapshots,
        routes=route_snapshots,
        destinations=destination_snapshots,
        problems=problems,
        updated_at=rows.now,
    )


def _assemble_snapshot(bulk: OperationalSnapshotBulkData) -> OperationalSnapshotResponse:
    route_snapshots: list[OperationalRouteSnapshot] = []
    route_health_by_id: dict[int, OperationalHealthStatus] = {}

    for route in bulk.routes:
        agg_1m = bulk.route_agg_1m.get(route.id)
        agg_5m = bulk.route_agg_5m.get(route.id)
        success_rate_5m, _, retry_rate_5m = _api_rates(agg_5m)
        delivered_eps_1m = _eps(agg_1m.success_count if agg_1m else 0, 60)
        failed_eps_1m = _eps(agg_1m.failure_count if agg_1m else 0, 60)
        last_success_at, last_error_at, last_error_message = _last_fields(bulk.route_last.get(route.id))
        health = classify_route_health(
            enabled=route.enabled,
            last_success_at=last_success_at,
            last_error_at=last_error_at,
            failed_eps_1m=failed_eps_1m,
            retry_rate_5m=retry_rate_5m,
            now=bulk.now,
        )
        route_health_by_id[route.id] = health
        route_snapshots.append(
            OperationalRouteSnapshot(
                route_id=route.id,
                stream_id=route.stream_id,
                stream_name=route.stream_name,
                destination_id=route.destination_id,
                destination_name=route.destination_name,
                destination_type=route.destination_type,
                enabled=route.enabled,
                failure_policy=route.failure_policy,
                health_status=health,
                delivered_eps_1m=delivered_eps_1m,
                failed_eps_1m=failed_eps_1m,
                success_rate_5m=success_rate_5m,
                retry_rate_5m=retry_rate_5m,
                avg_latency_ms=agg_5m.avg_latency_ms if agg_5m else None,
                last_success_at=last_success_at,
                last_error_at=last_error_at,
                last_error_message=last_error_message,
            )
        )

    routes_by_stream: dict[int, list[int]] = {}
    routes_by_destination: dict[int, list[int]] = {}
    for route in bulk.routes:
        routes_by_stream.setdefault(route.stream_id, []).append(route.id)
        routes_by_destination.setdefault(route.destination_id, []).append(route.id)

    stream_snapshots: list[OperationalStreamSnapshot] = []
    for stream in bulk.streams:
        agg_1m = bulk.stream_agg_1m.get(stream.id)
        agg_5m = bulk.stream_agg_5m.get(stream.id)
        success_rate_5m, failure_rate_5m, _ = _api_rates(agg_5m)
        last_success_at, last_error_at, last_error_message = _last_fields(bulk.stream_last.get(stream.id))
        route_ids = routes_by_stream.get(stream.id, [])
        route_healths = [route_health_by_id[rid] for rid in route_ids]
        healthy_route_count = sum(1 for h in route_healths if h == "HEALTHY")
        failed_route_count = sum(1 for h in route_healths if h in ("ERROR", "DEGRADED"))
        route_count = bulk.routes_per_stream.get(stream.id, len(route_ids))
        health = classify_stream_health(
            enabled=stream.enabled,
            status=stream.status,
            last_success_at=last_success_at,
            last_error_at=last_error_at,
            failure_rate_5m=failure_rate_5m or 0.0,
            failed_route_count=failed_route_count,
            healthy_route_count=healthy_route_count,
            route_count=route_count,
            now=bulk.now,
        )
        cp = bulk.checkpoints.get(stream.id)
        checkpoint_updated_at = cp.updated_at if cp is not None else None
        lag = _checkpoint_lag_seconds(bulk.now, checkpoint_updated_at)
        stream_snapshots.append(
            OperationalStreamSnapshot(
                stream_id=stream.id,
                stream_name=stream.name,
                connector_id=stream.connector_id,
                source_id=stream.source_id,
                enabled=stream.enabled,
                status=stream.status,
                health_status=health,
                eps_1m=_eps(bulk.stream_input_1m.get(stream.id, 0), 60),
                eps_5m=_eps(bulk.stream_input_5m.get(stream.id, 0), 300),
                success_rate_5m=success_rate_5m,
                failure_rate_5m=failure_rate_5m,
                avg_latency_ms=agg_5m.avg_latency_ms if agg_5m else None,
                route_count=route_count,
                healthy_route_count=healthy_route_count,
                failed_route_count=failed_route_count,
                last_success_at=last_success_at,
                last_error_at=last_error_at,
                last_error_message=last_error_message,
                checkpoint_updated_at=checkpoint_updated_at,
                checkpoint_lag_seconds=lag,
            )
        )

    destination_snapshots: list[OperationalDestinationSnapshot] = []
    for dest in bulk.destinations:
        agg_1m = bulk.destination_agg_1m.get(dest.id)
        agg_5m = bulk.destination_agg_5m.get(dest.id)
        last_success_at, last_error_at, last_error_message = _last_fields(bulk.destination_last.get(dest.id))
        route_ids = routes_by_destination.get(dest.id, [])
        route_healths = [route_health_by_id[rid] for rid in route_ids]
        dest_failed_eps_1m = _eps(agg_1m.failure_count if agg_1m else 0, 60)
        health = classify_destination_health(
            enabled=dest.enabled,
            route_healths=route_healths,
            last_success_at=last_success_at,
            last_connectivity_test_success=dest.last_connectivity_test_success,
            last_error_at=last_error_at,
            failed_eps_1m=dest_failed_eps_1m,
            now=bulk.now,
        )
        destination_snapshots.append(
            OperationalDestinationSnapshot(
                destination_id=dest.id,
                destination_name=dest.name,
                destination_type=dest.destination_type,
                enabled=dest.enabled,
                health_status=health,
                inbound_eps_1m=_eps(agg_1m.success_count if agg_1m else 0, 60),
                failed_eps_1m=dest_failed_eps_1m,
                avg_latency_ms=agg_5m.avg_latency_ms if agg_5m else None,
                route_count=bulk.routes_per_destination.get(dest.id, len(route_ids)),
                last_success_at=last_success_at,
                last_error_at=last_error_at,
                last_error_message=last_error_message,
            )
        )

    problems = _build_problems(
        stream_snapshots=stream_snapshots,
        route_snapshots=route_snapshots,
        destination_snapshots=destination_snapshots,
        now=bulk.now,
    )

    enabled_streams = sum(1 for s in bulk.streams if s.enabled)
    running_streams = sum(1 for s in bulk.streams if s.enabled and s.status.upper() == "RUNNING")
    error_streams = sum(1 for s in bulk.streams if "ERROR" in s.status.upper())
    enabled_routes = sum(1 for r in bulk.routes if r.enabled)
    enabled_destinations = sum(1 for d in bulk.destinations if d.enabled)
    total_eps_1m = round(sum(s.eps_1m for s in stream_snapshots), 6)
    total_eps_5m = round(sum(s.eps_5m for s in stream_snapshots), 6)

    latency_values = [s.avg_latency_ms for s in stream_snapshots if s.avg_latency_ms is not None]
    avg_latency_ms = (
        round(sum(latency_values) / len(latency_values), 4) if latency_values else None
    )

    activity_times: list[datetime] = []
    for snap in stream_snapshots:
        if snap.last_success_at is not None:
            activity_times.append(snap.last_success_at)
        if snap.last_error_at is not None:
            activity_times.append(snap.last_error_at)
    last_activity_at = max(activity_times) if activity_times else None

    global_health = classify_global_health(
        enabled_streams=enabled_streams,
        problems=problems,
        streams=stream_snapshots,
    )

    global_snapshot = OperationalGlobalSnapshot(
        health_status=global_health,
        total_streams=len(bulk.streams),
        enabled_streams=enabled_streams,
        running_streams=running_streams,
        error_streams=error_streams,
        total_routes=len(bulk.routes),
        enabled_routes=enabled_routes,
        total_destinations=len(bulk.destinations),
        enabled_destinations=enabled_destinations,
        total_eps_1m=total_eps_1m,
        total_eps_5m=total_eps_5m,
        avg_latency_ms=avg_latency_ms,
        last_activity_at=last_activity_at,
    )

    return OperationalSnapshotResponse(
        global_=global_snapshot,
        streams=stream_snapshots,
        routes=route_snapshots,
        destinations=destination_snapshots,
        problems=problems,
        updated_at=bulk.now,
    )


def _stream_success_stale(stream: OperationalStreamSnapshot, now: datetime | None) -> bool:
    """DEGRADED only because the last success aged out (no newer error, not rate limited)."""

    if stream.last_success_at is None or not is_observation_stale(stream.last_success_at, now):
        return False
    if "RATE_LIMITED" in str(stream.status or "").upper():
        return False
    return stream.last_error_at is None or stream.last_error_at <= stream.last_success_at


def _build_problems(
    *,
    stream_snapshots: list[OperationalStreamSnapshot],
    route_snapshots: list[OperationalRouteSnapshot],
    destination_snapshots: list[OperationalDestinationSnapshot],
    now: datetime | None = None,
) -> list[OperationalProblem]:
    problems: list[OperationalProblem] = []

    for stream in stream_snapshots:
        if not stream.enabled or is_operator_stopped_status(stream.status):
            # Disabled / paused / stopped is an operational state, not a failure.
            continue
        if stream.health_status == "ERROR":
            problems.append(
                OperationalProblem(
                    severity="critical",
                    scope="stream",
                    stream_id=stream.stream_id,
                    title=f"Stream {stream.stream_name} is in ERROR state",
                    message=stream.last_error_message or f"Stream status: {stream.status or 'unknown'}",
                    last_seen_at=stream.last_error_at or stream.last_success_at,
                )
            )
        elif stream.failure_rate_5m is not None and stream.failure_rate_5m > 0.0:
            problems.append(
                OperationalProblem(
                    severity="warning",
                    scope="stream",
                    stream_id=stream.stream_id,
                    title=f"Stream {stream.stream_name} has delivery failures",
                    message=f"Failure rate (5m): {stream.failure_rate_5m:.2f}%",
                    last_seen_at=stream.last_error_at,
                )
            )
        elif stream.health_status == "DEGRADED" and _stream_success_stale(stream, now):
            problems.append(
                OperationalProblem(
                    severity="warning",
                    scope="stream",
                    stream_id=stream.stream_id,
                    title=f"Stream {stream.stream_name}: no recent ingest/delivery observed",
                    message=(
                        "No recent ingest/delivery observed: no success within "
                        f"{_OBSERVATION_FRESHNESS_SECONDS}s"
                    ),
                    last_seen_at=stream.last_success_at,
                )
            )
        elif stream.health_status == "DEGRADED" and (stream.last_error_message or stream.last_error_at):
            problems.append(
                OperationalProblem(
                    severity="warning",
                    scope="stream",
                    stream_id=stream.stream_id,
                    title=f"Stream {stream.stream_name} is degraded",
                    message=stream.last_error_message or "Recent source or delivery error",
                    last_seen_at=stream.last_error_at,
                )
            )
        if should_flag_checkpoint_stale(stream):
            problems.append(
                OperationalProblem(
                    severity="warning",
                    scope="stream",
                    stream_id=stream.stream_id,
                    title=f"Stream {stream.stream_name} checkpoint is stale",
                    message=f"Checkpoint lag: {stream.checkpoint_lag_seconds}s",
                    last_seen_at=stream.checkpoint_updated_at,
                )
            )

    for route in route_snapshots:
        if route.health_status == "ERROR":
            problems.append(
                OperationalProblem(
                    severity="critical",
                    scope="route",
                    stream_id=route.stream_id,
                    route_id=route.route_id,
                    title=f"Route {route.route_id} delivery failing",
                    message=route.last_error_message or "Recent failures without recovery",
                    last_seen_at=route.last_error_at,
                )
            )

    for dest in destination_snapshots:
        if dest.health_status == "ERROR":
            problems.append(
                OperationalProblem(
                    severity="critical",
                    scope="destination",
                    destination_id=dest.destination_id,
                    title=f"Destination {dest.destination_name} is unhealthy",
                    message=dest.last_error_message or "Connected routes report errors",
                    last_seen_at=dest.last_error_at,
                )
            )

    return problems
