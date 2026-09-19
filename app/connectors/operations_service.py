"""Connector operations aggregation for the Connectors dashboard (read-only + auth-check persist)."""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy.orm import Session

from app.database import SessionLocal

from app.connectors.models import Connector
from app.runtime import health_repository as health_repo
from app.connectors.operations_schemas import (
    AuthHealthCheckInterval,
    ConnectorAuthCheckPersistedResponse,
    ConnectorOperationsRow,
    ConnectorOperationsSummaryResponse,
    ConnectorStreamHealthLabel,
    ConnectorStreamOpsSummary,
)
from app.routes.models import Route
from app.runtime import health_service
from app.runtime.health_schemas import HealthLevel, StreamHealthRow
from app.runtime.preview_service import _load_source_config_for_connector, run_connector_auth_test
from app.runtime.schemas import ConnectorAuthTestRequest
from app.sources.models import Source
from app.streams.models import Stream

_VALID_AUTH_INTERVALS: frozenset[str] = frozenset({"disabled", "15m", "1h", "6h", "24h"})


def read_operational_config(config: dict[str, Any] | None) -> dict[str, Any]:
    cfg = config if isinstance(config, dict) else {}
    op = cfg.get("operational") if isinstance(cfg.get("operational"), dict) else {}
    interval = str(op.get("auth_health_check_interval") or cfg.get("auth_health_check_interval") or "disabled")
    if interval not in _VALID_AUTH_INTERVALS:
        interval = "disabled"
    status = op.get("last_auth_check_status")
    if status not in (None, "success", "failed"):
        status = None
    return {
        "auth_health_check_interval": interval,
        "last_auth_check_at": op.get("last_auth_check_at"),
        "last_auth_check_status": status,
        "last_auth_error": op.get("last_auth_error"),
    }


def merge_operational_config(config: dict[str, Any] | None, patch: dict[str, Any]) -> dict[str, Any]:
    base = dict(config or {})
    op = dict(base.get("operational") or {})
    for key in ("auth_health_check_interval", "last_auth_check_at", "last_auth_check_status", "last_auth_error"):
        if key in patch and patch[key] is not None:
            op[key] = patch[key]
        elif key in patch:
            op.pop(key, None)
    base["operational"] = op
    return base


def normalize_auth_health_interval(value: str | None) -> AuthHealthCheckInterval:
    raw = str(value or "disabled").strip()
    if raw in _VALID_AUTH_INTERVALS:
        return raw  # type: ignore[return-value]
    return "disabled"


def _health_level_to_label(level: HealthLevel | None, stream_status: str) -> ConnectorStreamHealthLabel:
    st = str(stream_status or "").strip().upper()
    if st in {"STOPPED", "PAUSED", "IDLE"}:
        return "stopped"
    if level in {"CRITICAL", "UNHEALTHY"}:
        return "critical"
    if level == "DEGRADED":
        return "warning"
    return "healthy"


def _window_chip(window: str) -> str:
    w = str(window or "1h").strip().lower()
    if w == "15m":
        return "15m"
    if w == "6h":
        return "6h"
    if w == "24h":
        return "24h"
    return "1h"


def _stream_primary_issue(stream: Stream, health: StreamHealthRow | None, *, window: str) -> str | None:
    st = str(stream.status or "").strip().upper()
    if st in {"STOPPED", "PAUSED", "IDLE"}:
        return None
    chip = _window_chip(window)
    total = 0
    if health is not None:
        total = int(health.metrics.success_count or 0) + int(health.metrics.failure_count or 0)
    if health is None or total <= 0:
        return f"No Data ({chip})"
    if health.level in {"CRITICAL", "UNHEALTHY"}:
        for factor in health.factors:
            code = str(factor.code or "").lower()
            if "source" in code or "poll" in code or "extract" in code:
                return "Source Error"
        return "Destination Error"
    if health.level == "DEGRADED":
        return "Destination Error"
    return None


def _parse_dt(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    raw = str(value).strip()
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def _bulk_load_sources(db: Session, connector_ids: list[int]) -> dict[int, Source]:
    if not connector_ids:
        return {}
    rows = (
        db.query(Source)
        .filter(Source.connector_id.in_(connector_ids))
        .order_by(Source.connector_id.asc(), Source.id.asc())
        .all()
    )
    out: dict[int, Source] = {}
    for source in rows:
        cid = int(source.connector_id)
        existing = out.get(cid)
        if existing is None:
            out[cid] = source
        elif str(source.source_type) == "HTTP_API_POLLING":
            out[cid] = source
    return out


def _is_stale_stream(
    *,
    health_label: ConnectorStreamHealthLabel,
    primary_issue: str | None,
    last_success: datetime | None,
    events_1h: int,
    now: datetime,
) -> bool:
    if health_label == "stopped":
        return False
    if primary_issue and primary_issue.startswith("No Data"):
        return True
    if events_1h <= 0 and primary_issue:
        return True
    if last_success is None:
        return health_label in {"critical", "warning"}
    age = (now - last_success).total_seconds()
    return age >= 3600


def _compute_event_trend_percent(current: int, previous: int) -> float | None:
    if previous <= 0:
        return None
    return round(((current - previous) / previous) * 100.0, 1)


def _events_from_aggregate_row(row: Any) -> int:
    normalized = health_repo.normalize_aggregate_row(row)
    return int(normalized.get("success_count") or 0) + int(normalized.get("failure_count") or 0)


def _events_24h_by_stream(db: Session, *, until: datetime) -> dict[int, int]:
    """Lightweight 24h event totals (one bounded aggregate; no health scoring pass)."""

    start = until - timedelta(hours=24)
    rows = health_repo.fetch_stream_health_aggregates(
        db,
        since=start,
        until=until,
        stream_id=None,
        route_id=None,
        destination_id=None,
    )
    out: dict[int, int] = {}
    for row in rows:
        if row.group_id is None:
            continue
        out[int(row.group_id)] = _events_from_aggregate_row(row)
    return out


def _fetch_previous_1h_events_by_stream(db: Session, *, until: datetime) -> dict[int, int]:
    """Delivery-log event totals for the hour immediately before ``until``."""

    start = until - timedelta(hours=2)
    end = until - timedelta(hours=1)
    rows = health_repo.fetch_stream_health_aggregates(
        db,
        since=start,
        until=end,
        stream_id=None,
        route_id=None,
        destination_id=None,
    )
    out: dict[int, int] = {}
    for row in rows:
        if row.group_id is None:
            continue
        out[int(row.group_id)] = _events_from_aggregate_row(row)
    return out


def _is_active_for_last_event(
    *,
    health_label: ConnectorStreamHealthLabel,
    primary_issue: str | None,
    last_success: datetime | None,
    now: datetime,
) -> bool:
    if health_label in {"stopped", "critical"}:
        return False
    if primary_issue and primary_issue.startswith("No Data"):
        return False
    if last_success is None:
        return False
    age = (now - last_success).total_seconds()
    return age < 3600


def get_connectors_operations_summary(db: Session, *, window: str = "1h") -> ConnectorOperationsSummaryResponse:
    """Aggregate per-connector stream health, destinations, and freshness."""

    w = str(window or "1h").strip().lower()
    streams = db.query(Stream).order_by(Stream.connector_id.asc(), Stream.id.asc()).all()
    routes = db.query(Route).all()
    connector_ids = sorted({int(s.connector_id) for s in streams})
    sources_by_connector = _bulk_load_sources(db, connector_ids)

    dests_by_stream: dict[int, set[int]] = defaultdict(set)
    for route in routes:
        dests_by_stream[int(route.stream_id)].add(int(route.destination_id))

    now = datetime.now(UTC)

    health_resp = health_service.list_stream_health(
        db,
        window=w,
        since=None,
        stream_id=None,
        route_id=None,
        destination_id=None,
        scoring_mode="current_runtime",
    )
    health_by_stream = {int(row.stream_id): row for row in health_resp.rows}
    events_24h_by_stream = _events_24h_by_stream(db, until=now)
    previous_1h_by_stream = _fetch_previous_1h_events_by_stream(db, until=now)

    streams_by_connector: dict[int, list[ConnectorStreamOpsSummary]] = defaultdict(list)
    dests_by_connector: dict[int, set[int]] = defaultdict(set)
    affected_dests_by_connector: dict[int, set[int]] = defaultdict(set)
    events_1h_by_connector: dict[int, int] = defaultdict(int)
    events_previous_1h_by_connector: dict[int, int] = defaultdict(int)
    events_24h_by_connector: dict[int, int] = defaultdict(int)
    last_event_by_connector: dict[int, datetime] = {}
    last_event_active_by_connector: dict[int, datetime] = {}
    healthy_by_connector: dict[int, int] = defaultdict(int)
    warning_by_connector: dict[int, int] = defaultdict(int)
    critical_by_connector: dict[int, int] = defaultdict(int)
    stopped_by_connector: dict[int, int] = defaultdict(int)
    stale_by_connector: dict[int, int] = defaultdict(int)

    for stream in streams:
        sid = int(stream.id)
        cid = int(stream.connector_id)
        health = health_by_stream.get(sid)
        events_1h = 0
        events_24h = events_24h_by_stream.get(sid, 0)
        last_success = None
        if health is not None:
            events_1h = int(health.metrics.success_count or 0) + int(health.metrics.failure_count or 0)
            last_success = health.metrics.last_success_at

        label = _health_level_to_label(health.level if health is not None else None, str(stream.status or ""))
        primary_issue = _stream_primary_issue(stream, health, window=w)
        stream_dests = dests_by_stream.get(sid, set())
        streams_by_connector[cid].append(
            ConnectorStreamOpsSummary(
                stream_id=sid,
                stream_name=str(stream.name or f"Stream #{sid}"),
                status=str(stream.status or "STOPPED"),
                enabled=bool(stream.enabled),
                health=label,
                primary_issue=primary_issue,
                events_1h=events_1h,
                last_success_at=last_success,
                destination_count=len(stream_dests),
            )
        )
        if label == "healthy":
            healthy_by_connector[cid] += 1
        elif label == "warning":
            warning_by_connector[cid] += 1
        elif label == "critical":
            critical_by_connector[cid] += 1
        elif label == "stopped":
            stopped_by_connector[cid] += 1
        if _is_stale_stream(
            health_label=label,
            primary_issue=primary_issue,
            last_success=last_success,
            events_1h=events_1h,
            now=now,
        ):
            stale_by_connector[cid] += 1
        dests_by_connector[cid].update(stream_dests)
        if label in {"warning", "critical"}:
            affected_dests_by_connector[cid].update(stream_dests)
        events_1h_by_connector[cid] += events_1h
        events_previous_1h_by_connector[cid] += previous_1h_by_stream.get(sid, 0)
        events_24h_by_connector[cid] += events_24h
        if last_success is not None:
            prev = last_event_by_connector.get(cid)
            if prev is None or last_success > prev:
                last_event_by_connector[cid] = last_success
            if _is_active_for_last_event(
                health_label=label,
                primary_issue=primary_issue,
                last_success=last_success,
                now=now,
            ):
                prev_active = last_event_active_by_connector.get(cid)
                if prev_active is None or last_success > prev_active:
                    last_event_active_by_connector[cid] = last_success

    rows: list[ConnectorOperationsRow] = []
    for cid in connector_ids:
        source = sources_by_connector.get(cid)
        cfg = source.config_json if source is not None and isinstance(source.config_json, dict) else {}
        op = read_operational_config(cfg)
        events_1h = events_1h_by_connector.get(cid, 0)
        events_previous_1h = events_previous_1h_by_connector.get(cid, 0)
        affected_streams = warning_by_connector.get(cid, 0) + critical_by_connector.get(cid, 0)
        rows.append(
            ConnectorOperationsRow(
                connector_id=cid,
                stream_count=len(streams_by_connector.get(cid, [])),
                destination_count=len(dests_by_connector.get(cid, set())),
                affected_stream_count=affected_streams,
                affected_destination_count=len(affected_dests_by_connector.get(cid, set())),
                streams=sorted(streams_by_connector.get(cid, []), key=lambda s: s.stream_name.lower()),
                streams_healthy_count=healthy_by_connector.get(cid, 0),
                streams_warning_count=warning_by_connector.get(cid, 0),
                streams_critical_count=critical_by_connector.get(cid, 0),
                streams_stopped_count=stopped_by_connector.get(cid, 0),
                stale_stream_count=stale_by_connector.get(cid, 0),
                last_event_at=last_event_by_connector.get(cid),
                last_event_at_active=last_event_active_by_connector.get(cid),
                events_1h=events_1h,
                events_24h=events_24h_by_connector.get(cid, 0),
                events_last_1h=events_1h,
                events_previous_1h=events_previous_1h,
                event_trend_percent=_compute_event_trend_percent(events_1h, events_previous_1h),
                eps=round(events_1h / 3600.0, 2) if events_1h > 0 else 0.0,
                auth_health_check_interval=normalize_auth_health_interval(op.get("auth_health_check_interval")),
                last_auth_check_at=_parse_dt(op.get("last_auth_check_at")),
                last_auth_check_status=op.get("last_auth_check_status"),
                last_auth_error=str(op.get("last_auth_error") or "") or None,
            )
        )

    return ConnectorOperationsSummaryResponse(
        window=w,
        generated_at=datetime.now(UTC),
        connectors=rows,
    )


def _auth_check_status_code(result) -> int | None:
    for attr in ("response_status_code", "final_response_status_code", "probe_http_status", "login_http_status"):
        value = getattr(result, attr, None)
        if value is not None:
            return int(value)
    return None


def _auth_check_outcome_from_result(result) -> tuple[bool, int | None, str | None, str | None]:
    success = bool(getattr(result, "ok", False))
    status_code = _auth_check_status_code(result)
    message = getattr(result, "message", None)
    error_code = getattr(result, "error_type", None)
    return success, status_code, message, error_code


def _normalize_auth_probe_path(raw: str | None) -> str | None:
    text = str(raw or "").strip()
    if not text:
        return None
    return text if text.startswith("/") else f"/{text}"


def _resolve_connector_auth_check_path(
    db: Session,
    connector_id: int,
    *,
    source_config: dict[str, Any] | None,
    requested_path: str,
) -> str:
    """Prefer an explicit auth probe path or a real stream endpoint over bare ``/``.

    Dashboard auth-check historically probed ``base_url/``. Many APIs return 403/404
    on root while a configured stream endpoint authenticates successfully. Prefer:

    1. Non-default ``requested_path`` from the caller
    2. Source/operational ``auth_test_path`` / ``auth_check_path`` / ``health_check_path``
    3. First non-root stream ``config_json.endpoint`` for this connector
    4. ``/`` as last resort
    """

    requested = _normalize_auth_probe_path(requested_path)
    if requested and requested != "/":
        return requested

    cfg = source_config if isinstance(source_config, dict) else {}
    op = cfg.get("operational") if isinstance(cfg.get("operational"), dict) else {}
    for key in ("auth_test_path", "auth_check_path", "health_check_path"):
        for bag in (op, cfg):
            candidate = _normalize_auth_probe_path(bag.get(key) if isinstance(bag, dict) else None)
            if candidate and candidate != "/":
                return candidate

    streams = (
        db.query(Stream)
        .filter(Stream.connector_id == connector_id)
        .order_by(Stream.id.asc())
        .all()
    )
    for stream in streams:
        stream_cfg = stream.config_json if isinstance(stream.config_json, dict) else {}
        endpoint = _normalize_auth_probe_path(stream_cfg.get("endpoint"))
        if endpoint and endpoint != "/":
            return endpoint

    return requested or "/"


def run_connector_auth_check_and_persist(
    connector_id: int,
    *,
    method: str = "GET",
    test_path: str = "/",
) -> ConnectorAuthCheckPersistedResponse:
    """Run connector auth probe and persist last-check metadata on the Source row.

    Phase 1: load Source config and close DB session.
    Phase 2: outbound auth probe without holding a pool connection.
    Phase 3: open a new session, persist results, commit.
    """

    db = SessionLocal()
    try:
        source = (
            db.query(Source)
            .filter(Source.connector_id == connector_id)
            .order_by(Source.id.asc())
            .first()
        )
        if source is None:
            raise ValueError(f"No Source row for connector_id={connector_id}")
        source_id = int(source.id)
        source_config = _load_source_config_for_connector(db, connector_id)
        if source_config is None:
            raise ValueError(f"No Source row for connector_id={connector_id}")
        resolved_path = _resolve_connector_auth_check_path(
            db,
            connector_id,
            source_config=source_config,
            requested_path=test_path,
        )
    finally:
        db.close()

    started = datetime.now(UTC)
    payload = ConnectorAuthTestRequest(
        inline_flat_source=source_config,
        method=method,
        test_path=resolved_path,
    )
    result = run_connector_auth_test(payload, None)
    finished = datetime.now(UTC)
    elapsed_ms = max(0, int((finished - started).total_seconds() * 1000))

    success, status_code, message, error_code = _auth_check_outcome_from_result(result)
    status: str = "success" if success else "failed"
    err_msg: str | None = None
    if not success:
        err_msg = str(message or error_code or "Authentication failed").strip() or "Authentication failed"
        if status_code is not None:
            err_msg = f"{status_code} {err_msg}".strip()

    patch = {
        "last_auth_check_at": finished.isoformat(),
        "last_auth_check_status": status,
        "last_auth_error": None if success else err_msg,
    }

    db = SessionLocal()
    try:
        source = db.query(Source).filter(Source.id == source_id).first()
        if source is None:
            raise ValueError(f"No Source row for connector_id={connector_id}")
        source.config_json = merge_operational_config(
            source.config_json if isinstance(source.config_json, dict) else {},
            patch,
        )
        db.add(source)
        db.commit()
    finally:
        db.close()

    return ConnectorAuthCheckPersistedResponse(
        success=success,
        status_code=status_code,
        message=message,
        error_code=error_code,
        last_auth_check_at=finished,
        last_auth_check_status="success" if success else "failed",
        last_auth_error=None if success else err_msg,
        response_time_ms=elapsed_ms,
    )
