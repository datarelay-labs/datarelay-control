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


def replay_delivery_log(
    db: Session,
    log_id: int,
    *,
    dry_run: bool = False,
    destination_registry: DestinationAdapterRegistry | None = None,
    protected_permit: object | None = None,
) -> ReplayExecutionResult:
    """Replay a failed log. An opt-in Grant-protected log requires a one-use permit."""

    row = db.query(DeliveryLog).filter(DeliveryLog.id == int(log_id)).first()
    if row is None:
        raise DeliveryLogNotFoundError(log_id)

    # Source-bound, not a new operator route: no eligibility/audit/send occurs
    # before this check. The installed product owns protection by persisted log
    # reservation; unprotected legacy logs retain their original behavior.
    import sqlalchemy
    from app.runtime import grant_replay_dispatch as dispatch

    if sqlalchemy.inspect(db.get_bind()).has_table('grant_protected_replay_ledger'):
        dispatch.enforce_native_replay_boundary(
            db, row, protected_permit=protected_permit, dry_run=dry_run,
        )
    elif protected_permit is not None:
        # A product-authenticated protected dispatch must not lose its ledger.
        raise dispatch.ProtectedReplayDenied()

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
