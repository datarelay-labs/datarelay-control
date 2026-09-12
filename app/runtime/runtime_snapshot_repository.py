"""Incremental recompute and UPSERT for physical runtime operational snapshot tables."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.runtime.models import (
    RuntimeDestinationSnapshot,
    RuntimeRouteSnapshot,
    RuntimeSnapshotUpdaterState,
    RuntimeStreamSnapshot,
)
from app.runtime.operational_snapshot_repository import (
    FAILURE_STAGES,
    LastOutcomeRow,
    _fetch_last_outcomes,
    count_routes_per_destination,
    count_routes_per_stream,
    fetch_destination_last_outcomes,
    fetch_destination_window_aggregates,
    fetch_route_last_outcomes,
    fetch_route_window_aggregates,
    fetch_stream_last_outcomes,
    fetch_stream_window_aggregates,
    load_all_destinations,
    load_all_routes,
    load_all_streams,
    snapshot_now,
)
from app.runtime.operational_snapshot_service import (
    _checkpoint_lag_seconds,
    _eps,
    _rates,
    classify_destination_health,
    classify_route_health,
    classify_stream_health,
)

UTC = timezone.utc
_WINDOW_1M = timedelta(minutes=1)
_WINDOW_5M = timedelta(minutes=5)


@dataclass(frozen=True)
class SnapshotUpdateResult:
    stream_rows: int
    route_rows: int
    destination_rows: int
    deleted_stream_rows: int
    deleted_route_rows: int
    deleted_destination_rows: int
    affected_stream_ids: int
    affected_route_ids: int
    affected_destination_ids: int


def _merge_last_outcome(
    existing: LastOutcomeRow | None,
    scanned: LastOutcomeRow | None,
) -> LastOutcomeRow | None:
    if existing is None:
        return scanned
    if scanned is None:
        return existing
    last_success = existing.last_success_at
    if scanned.last_success_at is not None:
        if last_success is None or scanned.last_success_at > last_success:
            last_success = scanned.last_success_at
    last_failure = existing.last_failure_at
    last_message = existing.last_error_message
    if scanned.last_failure_at is not None:
        if last_failure is None or scanned.last_failure_at > last_failure:
            last_failure = scanned.last_failure_at
            last_message = scanned.last_error_message
        elif scanned.last_failure_at == last_failure and scanned.last_error_message:
            last_message = scanned.last_error_message
    return LastOutcomeRow(
        group_id=existing.group_id,
        last_success_at=last_success,
        last_failure_at=last_failure,
        last_error_message=last_message,
    )


def _load_existing_stream_last_outcomes(db: Session) -> dict[int, LastOutcomeRow]:
    rows = db.execute(
        select(
            RuntimeStreamSnapshot.stream_id,
            RuntimeStreamSnapshot.last_success_at,
            RuntimeStreamSnapshot.last_error_at,
            RuntimeStreamSnapshot.last_error_message,
        )
    ).all()
    return {
        int(r[0]): LastOutcomeRow(
            group_id=int(r[0]),
            last_success_at=r[1],
            last_failure_at=r[2],
            last_error_message=str(r[3]) if r[3] else None,
        )
        for r in rows
    }


def _load_existing_route_last_outcomes(db: Session) -> dict[int, LastOutcomeRow]:
    rows = db.execute(
        select(
            RuntimeRouteSnapshot.route_id,
            RuntimeRouteSnapshot.last_success_at,
            RuntimeRouteSnapshot.last_error_at,
            RuntimeRouteSnapshot.last_error_message,
        )
    ).all()
    return {
        int(r[0]): LastOutcomeRow(
            group_id=int(r[0]),
            last_success_at=r[1],
            last_failure_at=r[2],
            last_error_message=str(r[3]) if r[3] else None,
        )
        for r in rows
    }


def _load_existing_destination_last_outcomes(db: Session) -> dict[int, LastOutcomeRow]:
    rows = db.execute(
        select(
            RuntimeDestinationSnapshot.destination_id,
            RuntimeDestinationSnapshot.last_success_at,
            RuntimeDestinationSnapshot.last_error_at,
            RuntimeDestinationSnapshot.last_error_message,
        )
    ).all()
    return {
        int(r[0]): LastOutcomeRow(
            group_id=int(r[0]),
            last_success_at=r[1],
            last_failure_at=r[2],
            last_error_message=str(r[3]) if r[3] else None,
        )
        for r in rows
    }


def collect_affected_entity_ids(
    db: Session,
    *,
    scan_since: datetime,
    last_delivery_log_id: int | None,
) -> tuple[set[int], set[int], set[int], int | None]:
    """Return stream/route/destination ids touched since the scan window and max log id."""

    clauses = ["created_at >= :scan_since"]
    params: dict[str, object] = {"scan_since": scan_since}
    if last_delivery_log_id is not None:
        clauses.append("id > :last_id")
        params["last_id"] = int(last_delivery_log_id)
    where_sql = " OR ".join(clauses)
    row = db.execute(
        text(
            f"""
            SELECT
                COALESCE(array_agg(DISTINCT stream_id) FILTER (WHERE stream_id IS NOT NULL), '{{}}') AS stream_ids,
                COALESCE(array_agg(DISTINCT route_id) FILTER (WHERE route_id IS NOT NULL), '{{}}') AS route_ids,
                COALESCE(array_agg(DISTINCT destination_id) FILTER (WHERE destination_id IS NOT NULL), '{{}}') AS destination_ids,
                MAX(id) AS max_id
            FROM delivery_logs
            WHERE {where_sql}
            """
        ),
        params,
    ).one()
    stream_ids = {int(x) for x in (row[0] or [])}
    route_ids = {int(x) for x in (row[1] or [])}
    destination_ids = {int(x) for x in (row[2] or [])}
    max_id = int(row[3]) if row[3] is not None else None
    return stream_ids, route_ids, destination_ids, max_id


def cleanup_orphan_snapshots(db: Session) -> tuple[int, int, int]:
    """Remove snapshot rows whose entity no longer exists."""

    stream_deleted = db.execute(
        text(
            """
            DELETE FROM runtime_stream_snapshot s
            WHERE NOT EXISTS (SELECT 1 FROM streams st WHERE st.id = s.stream_id)
            """
        )
    ).rowcount or 0
    route_deleted = db.execute(
        text(
            """
            DELETE FROM runtime_route_snapshot r
            WHERE NOT EXISTS (SELECT 1 FROM routes rt WHERE rt.id = r.route_id)
            """
        )
    ).rowcount or 0
    destination_deleted = db.execute(
        text(
            """
            DELETE FROM runtime_destination_snapshot d
            WHERE NOT EXISTS (SELECT 1 FROM destinations dst WHERE dst.id = d.destination_id)
            """
        )
    ).rowcount or 0
    return int(stream_deleted), int(route_deleted), int(destination_deleted)


def read_model_is_populated(db: Session) -> bool:
    """True when at least one stream snapshot row exists (read path may use physical model)."""

    return db.query(func.count(RuntimeStreamSnapshot.stream_id)).scalar() > 0


def load_updater_state(db: Session) -> RuntimeSnapshotUpdaterState:
    state = db.get(RuntimeSnapshotUpdaterState, 1)
    if state is None:
        state = RuntimeSnapshotUpdaterState(id=1)
        db.add(state)
        db.flush()
    return state


def persist_updater_state(
    db: Session,
    *,
    last_delivery_log_id: int | None,
    last_scan_since: datetime,
) -> None:
    state = load_updater_state(db)
    if last_delivery_log_id is not None:
        current = state.last_delivery_log_id
        state.last_delivery_log_id = (
            max(int(current), int(last_delivery_log_id)) if current is not None else int(last_delivery_log_id)
        )
    state.last_scan_since = last_scan_since
    state.updated_at = datetime.now(UTC)
    db.add(state)


def recompute_and_upsert_snapshots(
    db: Session,
    *,
    scan_minutes: int = 15,
    bootstrap_last_outcomes: bool = False,
) -> SnapshotUpdateResult:
    """Recompute operational snapshots for all entities; merge recent delivery_log deltas."""

    now = snapshot_now()
    since_1m = now - _WINDOW_1M
    since_5m = now - _WINDOW_5M
    scan_since = now - timedelta(minutes=max(5, scan_minutes))

    streams = load_all_streams(db)
    routes = load_all_routes(db)
    destinations = load_all_destinations(db)
    stream_ids = {s.id for s in streams}
    route_ids = {r.id for r in routes}
    destination_ids = {d.id for d in destinations}

    delta_streams, delta_routes, delta_destinations, max_log_id = collect_affected_entity_ids(
        db,
        scan_since=scan_since,
        last_delivery_log_id=load_updater_state(db).last_delivery_log_id,
    )
    affected_streams = delta_streams | stream_ids
    affected_routes = delta_routes | route_ids
    affected_destinations = delta_destinations | destination_ids

    stream_agg_1m = fetch_stream_window_aggregates(db, since=since_1m, until=now)
    stream_agg_5m = fetch_stream_window_aggregates(db, since=since_5m, until=now)
    route_agg_1m = fetch_route_window_aggregates(db, since=since_1m, until=now)
    route_agg_5m = fetch_route_window_aggregates(db, since=since_5m, until=now)
    destination_agg_1m = fetch_destination_window_aggregates(db, since=since_1m, until=now)
    destination_agg_5m = fetch_destination_window_aggregates(db, since=since_5m, until=now)

    existing_stream_last = _load_existing_stream_last_outcomes(db)
    existing_route_last = _load_existing_route_last_outcomes(db)
    existing_destination_last = _load_existing_destination_last_outcomes(db)

    if bootstrap_last_outcomes or not existing_stream_last:
        scanned_stream_last = fetch_stream_last_outcomes(db, group_ids=list(stream_ids))
        scanned_route_last = fetch_route_last_outcomes(db, group_ids=list(route_ids))
        scanned_destination_last = fetch_destination_last_outcomes(
            db, group_ids=list(destination_ids)
        )
    else:
        scanned_stream_last = (
            _fetch_last_outcomes(
                db,
                group_column="stream_id",
                group_ids=sorted(delta_streams),
                failure_stages=tuple(FAILURE_STAGES),
                since=scan_since,
            )
            if delta_streams
            else {}
        )
        scanned_route_last = (
            _fetch_last_outcomes(
                db,
                group_column="route_id",
                group_ids=sorted(delta_routes),
                failure_stages=tuple(FAILURE_STAGES),
                since=scan_since,
            )
            if delta_routes
            else {}
        )
        scanned_destination_last = (
            _fetch_last_outcomes(
                db,
                group_column="destination_id",
                group_ids=sorted(delta_destinations),
                failure_stages=tuple(FAILURE_STAGES),
                since=scan_since,
            )
            if delta_destinations
            else {}
        )

    stream_last: dict[int, LastOutcomeRow] = {}
    for sid in stream_ids:
        stream_last[sid] = _merge_last_outcome(
            existing_stream_last.get(sid),
            scanned_stream_last.get(sid),
        ) or LastOutcomeRow(group_id=sid, last_success_at=None, last_failure_at=None, last_error_message=None)

    route_last: dict[int, LastOutcomeRow] = {}
    for rid in route_ids:
        route_last[rid] = _merge_last_outcome(
            existing_route_last.get(rid),
            scanned_route_last.get(rid),
        ) or LastOutcomeRow(group_id=rid, last_success_at=None, last_failure_at=None, last_error_message=None)

    destination_last: dict[int, LastOutcomeRow] = {}
    for did in destination_ids:
        destination_last[did] = _merge_last_outcome(
            existing_destination_last.get(did),
            scanned_destination_last.get(did),
        ) or LastOutcomeRow(group_id=did, last_success_at=None, last_failure_at=None, last_error_message=None)

    checkpoints = {int(cp.stream_id): cp for cp in db.query(Checkpoint).all()}
    routes_per_stream = count_routes_per_stream(db)
    routes_per_destination = count_routes_per_destination(db)

    route_health_by_id: dict[int, str] = {}
    route_rows: list[dict] = []
    for route in routes:
        agg_1m = route_agg_1m.get(route.id)
        agg_5m = route_agg_5m.get(route.id)
        success_rate_5m, _, retry_rate_5m = _rates(agg_5m)
        last = route_last.get(route.id)
        last_success_at = last.last_success_at if last else None
        last_error_at = last.last_failure_at if last else None
        last_error_message = last.last_error_message if last else None
        health = classify_route_health(
            enabled=route.enabled,
            last_success_at=last_success_at,
            last_error_at=last_error_at,
            failed_eps_1m=_eps(agg_1m.failure_count if agg_1m else 0, 60),
            retry_rate_5m=retry_rate_5m,
        )
        route_health_by_id[route.id] = health
        route_rows.append(
            {
                "route_id": route.id,
                "stream_id": route.stream_id,
                "destination_id": route.destination_id,
                "enabled": route.enabled,
                "health_status": health,
                "delivered_eps_1m": _eps(agg_1m.success_count if agg_1m else 0, 60),
                "failed_eps_1m": _eps(agg_1m.failure_count if agg_1m else 0, 60),
                "success_rate_5m": success_rate_5m,
                "retry_rate_5m": retry_rate_5m,
                "avg_latency_ms": agg_5m.avg_latency_ms if agg_5m else None,
                "last_success_at": last_success_at,
                "last_error_at": last_error_at,
                "last_error_message": last_error_message,
                "updated_at": now,
            }
        )

    routes_by_stream: dict[int, list[int]] = {}
    routes_by_destination: dict[int, list[int]] = {}
    for route in routes:
        routes_by_stream.setdefault(route.stream_id, []).append(route.id)
        routes_by_destination.setdefault(route.destination_id, []).append(route.id)

    stream_rows: list[dict] = []
    for stream in streams:
        agg_1m = stream_agg_1m.get(stream.id)
        agg_5m = stream_agg_5m.get(stream.id)
        success_rate_5m, failure_rate_5m, retry_rate_5m = _rates(agg_5m)
        last = stream_last.get(stream.id)
        last_success_at = last.last_success_at if last else None
        last_error_at = last.last_failure_at if last else None
        last_error_message = last.last_error_message if last else None
        route_ids_for_stream = routes_by_stream.get(stream.id, [])
        route_healths = [route_health_by_id[rid] for rid in route_ids_for_stream]
        route_count = routes_per_stream.get(stream.id, len(route_ids_for_stream))
        healthy_route_count = sum(1 for h in route_healths if h == "HEALTHY")
        failed_route_count = sum(1 for h in route_healths if h in ("ERROR", "DEGRADED"))
        health = classify_stream_health(
            enabled=stream.enabled,
            status=stream.status,
            last_success_at=last_success_at,
            last_error_at=last_error_at,
            failure_rate_5m=failure_rate_5m,
            failed_route_count=failed_route_count,
            healthy_route_count=healthy_route_count,
            route_count=route_count,
        )
        cp = checkpoints.get(stream.id)
        checkpoint_updated_at = cp.updated_at if cp is not None else None
        stream_rows.append(
            {
                "stream_id": stream.id,
                "enabled": stream.enabled,
                "health_status": health,
                "eps_1m": _eps(agg_1m.success_count if agg_1m else 0, 60),
                "eps_5m": _eps(agg_5m.success_count if agg_5m else 0, 300),
                "success_rate_5m": success_rate_5m,
                "failure_rate_5m": failure_rate_5m,
                "retry_rate_5m": retry_rate_5m,
                "avg_latency_ms": agg_5m.avg_latency_ms if agg_5m else None,
                "route_count": route_count,
                "healthy_route_count": healthy_route_count,
                "failed_route_count": failed_route_count,
                "last_success_at": last_success_at,
                "last_error_at": last_error_at,
                "last_error_message": last_error_message,
                "checkpoint_updated_at": checkpoint_updated_at,
                "checkpoint_lag_seconds": _checkpoint_lag_seconds(now, checkpoint_updated_at),
                "updated_at": now,
            }
        )

    destination_rows: list[dict] = []
    for dest in destinations:
        agg_1m = destination_agg_1m.get(dest.id)
        agg_5m = destination_agg_5m.get(dest.id)
        last = destination_last.get(dest.id)
        last_success_at = last.last_success_at if last else None
        last_error_at = last.last_failure_at if last else None
        last_error_message = last.last_error_message if last else None
        route_ids_for_dest = routes_by_destination.get(dest.id, [])
        route_healths = [route_health_by_id[rid] for rid in route_ids_for_dest]
        health = classify_destination_health(
            enabled=dest.enabled,
            route_healths=route_healths,
            last_success_at=last_success_at,
            last_connectivity_test_success=dest.last_connectivity_test_success,
        )
        destination_rows.append(
            {
                "destination_id": dest.id,
                "enabled": dest.enabled,
                "health_status": health,
                "inbound_eps_1m": _eps(agg_1m.success_count if agg_1m else 0, 60),
                "failed_eps_1m": _eps(agg_1m.failure_count if agg_1m else 0, 60),
                "avg_latency_ms": agg_5m.avg_latency_ms if agg_5m else None,
                "route_count": routes_per_destination.get(dest.id, len(route_ids_for_dest)),
                "last_success_at": last_success_at,
                "last_error_at": last_error_at,
                "last_error_message": last_error_message,
                "updated_at": now,
            }
        )

    stream_upserted = _bulk_upsert_stream_snapshots(db, stream_rows)
    route_upserted = _bulk_upsert_route_snapshots(db, route_rows)
    destination_upserted = _bulk_upsert_destination_snapshots(db, destination_rows)
    deleted_stream, deleted_route, deleted_destination = cleanup_orphan_snapshots(db)
    persist_updater_state(db, last_delivery_log_id=max_log_id, last_scan_since=scan_since)

    return SnapshotUpdateResult(
        stream_rows=stream_upserted,
        route_rows=route_upserted,
        destination_rows=destination_upserted,
        deleted_stream_rows=deleted_stream,
        deleted_route_rows=deleted_route,
        deleted_destination_rows=deleted_destination,
        affected_stream_ids=len(affected_streams),
        affected_route_ids=len(affected_routes),
        affected_destination_ids=len(affected_destinations),
    )


def _bulk_upsert_stream_snapshots(db: Session, rows: list[dict]) -> int:
    if not rows:
        return 0
    stmt = pg_insert(RuntimeStreamSnapshot).values(rows)
    excluded = stmt.excluded
    stmt = stmt.on_conflict_do_update(
        index_elements=["stream_id"],
        set_={
            "enabled": excluded.enabled,
            "health_status": excluded.health_status,
            "eps_1m": excluded.eps_1m,
            "eps_5m": excluded.eps_5m,
            "success_rate_5m": excluded.success_rate_5m,
            "failure_rate_5m": excluded.failure_rate_5m,
            "retry_rate_5m": excluded.retry_rate_5m,
            "avg_latency_ms": excluded.avg_latency_ms,
            "route_count": excluded.route_count,
            "healthy_route_count": excluded.healthy_route_count,
            "failed_route_count": excluded.failed_route_count,
            "last_success_at": excluded.last_success_at,
            "last_error_at": excluded.last_error_at,
            "last_error_message": excluded.last_error_message,
            "checkpoint_updated_at": excluded.checkpoint_updated_at,
            "checkpoint_lag_seconds": excluded.checkpoint_lag_seconds,
            "updated_at": excluded.updated_at,
        },
    )
    db.execute(stmt)
    return len(rows)


def _bulk_upsert_route_snapshots(db: Session, rows: list[dict]) -> int:
    if not rows:
        return 0
    stmt = pg_insert(RuntimeRouteSnapshot).values(rows)
    excluded = stmt.excluded
    stmt = stmt.on_conflict_do_update(
        index_elements=["route_id"],
        set_={
            "stream_id": excluded.stream_id,
            "destination_id": excluded.destination_id,
            "enabled": excluded.enabled,
            "health_status": excluded.health_status,
            "delivered_eps_1m": excluded.delivered_eps_1m,
            "failed_eps_1m": excluded.failed_eps_1m,
            "success_rate_5m": excluded.success_rate_5m,
            "retry_rate_5m": excluded.retry_rate_5m,
            "avg_latency_ms": excluded.avg_latency_ms,
            "last_success_at": excluded.last_success_at,
            "last_error_at": excluded.last_error_at,
            "last_error_message": excluded.last_error_message,
            "updated_at": excluded.updated_at,
        },
    )
    db.execute(stmt)
    return len(rows)


def _bulk_upsert_destination_snapshots(db: Session, rows: list[dict]) -> int:
    if not rows:
        return 0
    stmt = pg_insert(RuntimeDestinationSnapshot).values(rows)
    excluded = stmt.excluded
    stmt = stmt.on_conflict_do_update(
        index_elements=["destination_id"],
        set_={
            "enabled": excluded.enabled,
            "health_status": excluded.health_status,
            "inbound_eps_1m": excluded.inbound_eps_1m,
            "failed_eps_1m": excluded.failed_eps_1m,
            "avg_latency_ms": excluded.avg_latency_ms,
            "route_count": excluded.route_count,
            "last_success_at": excluded.last_success_at,
            "last_error_at": excluded.last_error_at,
            "last_error_message": excluded.last_error_message,
            "updated_at": excluded.updated_at,
        },
    )
    db.execute(stmt)
    return len(rows)

