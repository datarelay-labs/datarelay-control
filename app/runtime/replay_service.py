"""Manual replay of failed route delivery attempts from delivery_logs evidence."""

from __future__ import annotations

import logging
import time
import uuid
from app.runtime.copy_utils import copy_events
from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session

from app.checkpoints.repository import get_checkpoint_by_stream_id
from app.delivery.syslog_sender import SyslogSender
from app.delivery.webhook_sender import WebhookSender
from app.destinations.adapters.registry import DestinationAdapterRegistry
from app.destinations.repository import get_destination_by_id
from app.formatters.message_prefix import MessagePrefixResolveContext, build_message_prefix_context
from app.logs.models import DeliveryLog
from app.replay.reconciliation import (
    REPLAY_ALREADY_DELIVERED,
    SUPERSEDE_SOURCE_LOGS_REPLAY,
    compute_event_identities,
    describe_prior_delivery,
    find_prior_delivery,
    supersede_delivered_jobs,
)
from app.routes.models import Route
from app.runtime.preview_service import run_route_delivery_preview
from app.runtime.schemas import RouteDeliveryPreviewRequest
from app.streams.repository import get_stream_by_id

logger = logging.getLogger(__name__)

_FAILED_DELIVERY_STAGES = frozenset({"route_send_failed", "route_retry_failed"})
_REPLAY_EVENT_KEYS = ("replay_events", "enriched_events", "events")
_MAX_REPLAY_EVENTS = 500


class DeliveryLogNotFoundError(Exception):
    def __init__(self, log_id: int) -> None:
        super().__init__(log_id)
        self.log_id = log_id


class ReplayNotEligibleError(Exception):
    def __init__(self, error_code: str, message: str) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.message = message


class ReplayAlreadyDeliveredError(ReplayNotEligibleError):
    """The failed events were already delivered by another replay path (E-051)."""

    def __init__(self, message: str) -> None:
        super().__init__(REPLAY_ALREADY_DELIVERED, message)


@dataclass(frozen=True, slots=True)
class ReplayEligibility:
    eligible: bool
    error_code: str | None = None
    message: str | None = None


@dataclass(frozen=True, slots=True)
class ReplayExecutionResult:
    log_id: int
    dry_run: bool
    outcome: str
    message: str
    event_count: int
    route_id: int | None
    destination_id: int | None
    stream_id: int | None
    replay_run_id: str
    preview_message_count: int | None = None
    preview_messages: list[Any] | None = None
    error_type: str | None = None


def extract_replay_events(payload_sample: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Return event dicts stored on the failed delivery log for replay."""

    if not isinstance(payload_sample, dict):
        return []
    for key in _REPLAY_EVENT_KEYS:
        raw = payload_sample.get(key)
        if not isinstance(raw, list) or not raw:
            continue
        events = copy_events([item for item in raw if isinstance(item, dict)], limit=_MAX_REPLAY_EVENTS)
        if events:
            return events
    return []


def assess_replay_eligibility(db: Session, log_row: DeliveryLog) -> ReplayEligibility:
    """Evaluate whether a delivery_logs row can be manually replayed."""

    stage = str(log_row.stage or "").strip()
    if stage not in _FAILED_DELIVERY_STAGES:
        return ReplayEligibility(
            eligible=False,
            error_code="REPLAY_NOT_FAILED_DELIVERY",
            message=f"stage must be route_send_failed or route_retry_failed, got {stage!r}",
        )

    if log_row.route_id is None:
        return ReplayEligibility(
            eligible=False,
            error_code="REPLAY_ROUTE_MISSING",
            message="delivery log has no route_id",
        )

    events = extract_replay_events(log_row.payload_sample if isinstance(log_row.payload_sample, dict) else {})
    if not events:
        return ReplayEligibility(
            eligible=False,
            error_code="REPLAY_PAYLOAD_INSUFFICIENT",
            message="payload_sample must include a non-empty replay_events, enriched_events, or events list",
        )

    route = db.query(Route).filter(Route.id == int(log_row.route_id)).first()
    if route is None:
        return ReplayEligibility(
            eligible=False,
            error_code="REPLAY_ROUTE_NOT_FOUND",
            message=f"route not found: {log_row.route_id}",
        )
    if not bool(route.enabled):
        return ReplayEligibility(
            eligible=False,
            error_code="REPLAY_ROUTE_DISABLED",
            message=f"route {route.id} is disabled",
        )

    destination = get_destination_by_id(db, int(route.destination_id))
    if destination is None:
        return ReplayEligibility(
            eligible=False,
            error_code="REPLAY_DESTINATION_NOT_FOUND",
            message=f"destination not found for route {route.id}",
        )
    if not bool(destination.enabled):
        return ReplayEligibility(
            eligible=False,
            error_code="REPLAY_DESTINATION_DISABLED",
            message=f"destination {destination.id} is disabled",
        )

    return ReplayEligibility(eligible=True)


def _persist_replay_stage_log(
    db: Session,
    *,
    stage: str,
    source_log: DeliveryLog,
    replay_run_id: str,
    message: str,
    dry_run: bool,
    extra: dict[str, Any] | None = None,
    level: str = "INFO",
    status: str = "OK",
    error_code: str | None = None,
) -> DeliveryLog:
    payload: dict[str, Any] = {
        "replay_source_log_id": int(source_log.id),
        "replay_run_id": replay_run_id,
        "dry_run": dry_run,
        "stream_id": source_log.stream_id,
        "route_id": source_log.route_id,
        "destination_id": source_log.destination_id,
    }
    if extra:
        payload.update(extra)

    row = DeliveryLog(
        connector_id=source_log.connector_id,
        stream_id=source_log.stream_id,
        route_id=source_log.route_id,
        destination_id=source_log.destination_id,
        stage=stage,
        level=level,
        status=status,
        message=message,
        payload_sample=payload,
        retry_count=0,
        http_status=None,
        latency_ms=extra.get("latency_ms") if extra and isinstance(extra.get("latency_ms"), int) else None,
        error_code=error_code,
        run_id=replay_run_id,
    )
    db.add(row)
    db.flush()
    return row


def _build_prefix_context(stream_name: str, stream_id: int, route_id: int, destination: Any) -> MessagePrefixResolveContext:
    return build_message_prefix_context(
        stream_name=stream_name,
        stream_id=stream_id,
        destination_name=str(getattr(destination, "name", "") or ""),
        destination_type=str(getattr(destination, "destination_type", "") or ""),
        route_id=route_id,
    )


_PRIOR_LOG_REPLAY_SCAN_LIMIT = 200


def _prior_logs_replay_of(db: Session, row: DeliveryLog) -> DeliveryLog | None:
    """Return an earlier live (non dry-run) Logs replay of the very same failed log row."""

    candidates = (
        db.query(DeliveryLog)
        .filter(
            DeliveryLog.stage == "replay_delivered",
            DeliveryLog.stream_id == row.stream_id,
            DeliveryLog.route_id == row.route_id,
        )
        .order_by(DeliveryLog.id.desc())
        .limit(_PRIOR_LOG_REPLAY_SCAN_LIMIT)
        .all()
    )
    for candidate in candidates:
        payload = candidate.payload_sample if isinstance(candidate.payload_sample, dict) else {}
        if payload.get("replay_source_log_id") == int(row.id) and payload.get("dry_run") is False:
            return candidate
    return None


def _assert_not_already_delivered(
    db: Session,
    row: DeliveryLog,
    *,
    destination_id: int,
    events: list[dict[str, Any]],
) -> None:
    """Refuse a live replay whose events another path already delivered (E-051 / E-113)."""

    prior_log = _prior_logs_replay_of(db, row)
    if prior_log is not None:
        raise ReplayAlreadyDeliveredError(
            f"This failed delivery was already replayed from Logs (log #{int(prior_log.id)}). "
            "Replaying again would duplicate the events at the destination; "
            "confirm the explicit duplicate-delivery override to replay anyway."
        )
    prior_job = find_prior_delivery(
        db,
        stream_id=int(row.stream_id) if row.stream_id is not None else 0,
        destination_id=int(destination_id),
        route_id=int(row.route_id) if row.route_id is not None else None,
        dynamic_route_id=None,
        failover_route_id=None,
        identities=compute_event_identities(events),
        since=row.created_at,
        known_run_ids=[row.run_id] if row.run_id else [],
    )
    if prior_job is not None:
        raise ReplayAlreadyDeliveredError(
            f"These events were already delivered to this destination: {describe_prior_delivery(prior_job)} "
            "Replaying again would duplicate them; confirm the explicit duplicate-delivery override "
            "to replay anyway."
        )


def replay_delivery_log(
    db: Session,
    log_id: int,
    *,
    dry_run: bool = False,
    destination_registry: DestinationAdapterRegistry | None = None,
    allow_redelivery: bool = False,
) -> ReplayExecutionResult:
    """Replay one failed route delivery log without updating source checkpoints.

    A live replay is refused with ``REPLAY_ALREADY_DELIVERED`` when the same failure was
    already delivered (an earlier Logs replay, a replayed or superseded Replay Center job)
    unless ``allow_redelivery`` is set. A successful live replay supersedes the open Replay
    Center jobs for the same events so the two recovery paths stay reconciled.
    """

    row = db.query(DeliveryLog).filter(DeliveryLog.id == int(log_id)).first()
    if row is None:
        raise DeliveryLogNotFoundError(log_id)

    eligibility = assess_replay_eligibility(db, row)
    if not eligibility.eligible:
        raise ReplayNotEligibleError(
            eligibility.error_code or "REPLAY_NOT_ELIGIBLE",
            eligibility.message or "replay not eligible",
        )

    events = extract_replay_events(row.payload_sample if isinstance(row.payload_sample, dict) else {})
    route = db.query(Route).filter(Route.id == int(row.route_id)).first()
    assert route is not None
    destination = get_destination_by_id(db, int(route.destination_id))
    assert destination is not None

    stream = get_stream_by_id(db, int(row.stream_id)) if row.stream_id is not None else None
    stream_name = str(getattr(stream, "name", "") or "") if stream is not None else ""
    stream_id = int(row.stream_id) if row.stream_id is not None else 0

    if not dry_run and not allow_redelivery:
        _assert_not_already_delivered(db, row, destination_id=int(destination.id), events=events)

    replay_run_id = str(uuid.uuid4())
    _persist_replay_stage_log(
        db,
        stage="replay_started",
        source_log=row,
        replay_run_id=replay_run_id,
        message="manual replay started",
        dry_run=dry_run,
        extra={"event_count": len(events), "source_stage": row.stage},
    )

    route_fc = route.formatter_config_json if isinstance(route.formatter_config_json, dict) else {}
    formatter_override = dict(route_fc) if route_fc else None

    if dry_run:
        preview = run_route_delivery_preview(
            db,
            RouteDeliveryPreviewRequest(route_id=int(route.id), events=events),
        )
        _persist_replay_stage_log(
            db,
            stage="replay_delivered",
            source_log=row,
            replay_run_id=replay_run_id,
            message="dry-run replay: formatter resolved, destination send skipped",
            dry_run=True,
            extra={
                "event_count": len(events),
                "preview_message_count": preview.message_count,
                "destination_type": preview.destination_type,
            },
        )
        return ReplayExecutionResult(
            log_id=log_id,
            dry_run=True,
            outcome="dry_run_ok",
            message="Dry-run replay succeeded (no destination send, checkpoint unchanged).",
            event_count=len(events),
            route_id=int(route.id),
            destination_id=int(destination.id),
            stream_id=row.stream_id,
            replay_run_id=replay_run_id,
            preview_message_count=preview.message_count,
            preview_messages=list(preview.preview_messages),
        )

    registry = destination_registry or DestinationAdapterRegistry(
        syslog_sender=SyslogSender(),
        webhook_sender=WebhookSender(),
    )
    from app.ai_providers.runtime_config import resolve_destination_runtime_config

    destination_type = str(destination.destination_type or "").strip().upper()
    destination_config = resolve_destination_runtime_config(
        db,
        destination_type,
        dict(destination.config_json or {}),
    )
    prefix_context = _build_prefix_context(stream_name, stream_id, int(route.id), destination)

    send_started = time.monotonic()
    try:
        registry.get(destination_type).send(
            events,
            destination_config,
            formatter_override=formatter_override,
            prefix_context=prefix_context,
        )
    except Exception as exc:
        latency_ms = max(0, int((time.monotonic() - send_started) * 1000))
        _persist_replay_stage_log(
            db,
            stage="replay_failed",
            source_log=row,
            replay_run_id=replay_run_id,
            message=str(exc),
            dry_run=False,
            level="ERROR",
            status="FAILED",
            error_code=type(exc).__name__,
            extra={
                "event_count": len(events),
                "latency_ms": latency_ms,
                "error_type": type(exc).__name__,
            },
        )
        logger.exception(
            "replay_failed log_id=%s route_id=%s",
            log_id,
            route.id,
            extra={"replay_run_id": replay_run_id},
        )
        return ReplayExecutionResult(
            log_id=log_id,
            dry_run=False,
            outcome="failed",
            message=str(exc),
            event_count=len(events),
            route_id=int(route.id),
            destination_id=int(destination.id),
            stream_id=row.stream_id,
            replay_run_id=replay_run_id,
            error_type=type(exc).__name__,
        )

    latency_ms = max(0, int((time.monotonic() - send_started) * 1000))
    _persist_replay_stage_log(
        db,
        stage="replay_delivered",
        source_log=row,
        replay_run_id=replay_run_id,
        message="manual replay delivered to destination",
        dry_run=False,
        extra={
            "event_count": len(events),
            "latency_ms": latency_ms,
            "destination_type": destination_type,
        },
    )
    superseded_job_ids = supersede_delivered_jobs(
        db,
        stream_id=stream_id,
        destination_id=int(destination.id),
        route_id=int(route.id),
        delivered_events=events,
        source=SUPERSEDE_SOURCE_LOGS_REPLAY,
        detail=f"Logs log #{int(log_id)}",
        known_run_ids=[row.run_id] if row.run_id else [],
    )
    if superseded_job_ids:
        logger.info(
            "replay_jobs_superseded log_id=%s job_ids=%s",
            log_id,
            superseded_job_ids,
            extra={"replay_run_id": replay_run_id},
        )
    return ReplayExecutionResult(
        log_id=log_id,
        dry_run=False,
        outcome="delivered",
        message="Replay delivered successfully (checkpoint unchanged).",
        event_count=len(events),
        route_id=int(route.id),
        destination_id=int(destination.id),
        stream_id=row.stream_id,
        replay_run_id=replay_run_id,
    )


def checkpoint_unchanged(db: Session, stream_id: int, before: dict[str, Any]) -> bool:
    """Return True when stream checkpoint JSON is identical to ``before``."""

    row = get_checkpoint_by_stream_id(db, stream_id)
    if row is None:
        return before == {}
    after = row.checkpoint_value_json if isinstance(row.checkpoint_value_json, dict) else {}
    return after == before
