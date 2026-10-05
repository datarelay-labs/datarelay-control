"""Replay engine delivery_logs observability (no delivery_logs table scans for summary)."""

from __future__ import annotations

from typing import Any, Callable

from sqlalchemy.orm import Session

from app.logs.models import DeliveryLog

REPLAY_EVENT_RECORDED_STAGE = "replay_event_recorded"
REPLAY_EVENT_RECORD_FAILED_STAGE = "replay_event_record_failed"
REPLAY_EVENT_REPLAY_STARTED_STAGE = "replay_event_replay_started"
REPLAY_EVENT_REPLAYED_STAGE = "replay_event_replayed"
REPLAY_EVENT_REPLAY_FAILED_STAGE = "replay_event_replay_failed"
REPLAY_EVENT_DISCARDED_STAGE = "replay_event_discarded"


def _base_payload(
    *,
    stream_id: int,
    destination_id: int,
    replay_event_id: int,
    status: str,
    retry_count: int,
    **extra: Any,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "stream_id": stream_id,
        "destination_id": destination_id,
        "replay_event_id": replay_event_id,
        "status": status,
        "retry_count": max(0, int(retry_count)),
    }
    payload.update(extra)
    return payload


def persist_replay_observability_log(
    db: Session,
    *,
    stage: str,
    stream_id: int,
    destination_id: int,
    replay_event_id: int,
    status: str,
    retry_count: int,
    route_id: int | None = None,
    message: str = "",
    level: str = "INFO",
    log_status: str = "OK",
    error_code: str | None = None,
    extra: dict[str, Any] | None = None,
) -> None:
    payload = _base_payload(
        stream_id=stream_id,
        destination_id=destination_id,
        replay_event_id=replay_event_id,
        status=status,
        retry_count=retry_count,
    )
    if route_id is not None:
        payload["route_id"] = route_id
    if extra:
        payload.update(extra)

    row = DeliveryLog(
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
        stage=stage,
        level=level,
        status=log_status,
        message=message or stage,
        payload_sample=payload,
        retry_count=max(0, int(retry_count)),
        error_code=error_code,
    )
    db.add(row)
    db.flush()
    try:
        from app.logs.incremental_aggregates import ingest_delivery_log_row

        ingest_delivery_log_row(row)
    except Exception:
        pass


def log_replay_event_recorded(
    db: Session,
    *,
    stream_id: int,
    destination_id: int,
    replay_event_id: int,
    delivery_kind: str,
    event_count: int,
    route_id: int | None = None,
) -> None:
    persist_replay_observability_log(
        db,
        stage=REPLAY_EVENT_RECORDED_STAGE,
        stream_id=stream_id,
        destination_id=destination_id,
        replay_event_id=replay_event_id,
        status="pending",
        retry_count=0,
        route_id=route_id,
        message="replay event recorded",
        extra={"delivery_kind": delivery_kind, "event_count": event_count},
    )


def log_replay_event_record_failed(
    db: Session,
    *,
    stream_id: int,
    destination_id: int,
    route_id: int | None,
    delivery_kind: str,
    error_message: str,
) -> None:
    persist_replay_observability_log(
        db,
        stage=REPLAY_EVENT_RECORD_FAILED_STAGE,
        stream_id=stream_id,
        destination_id=destination_id,
        replay_event_id=0,
        status="pending",
        retry_count=0,
        route_id=route_id,
        message=error_message[:500],
        level="ERROR",
        log_status="FAILED",
        error_code="REPLAY_RECORD_FAILED",
        extra={"delivery_kind": delivery_kind},
    )


def log_via_runner(
    log_fn: Callable[[dict[str, Any]], None],
    *,
    stage: str,
    stream_id: int,
    destination_id: int,
    replay_event_id: int,
    status: str,
    retry_count: int,
    route_id: int | None = None,
    **extra: Any,
) -> None:
    payload = _base_payload(
        stream_id=stream_id,
        destination_id=destination_id,
        replay_event_id=replay_event_id,
        status=status,
        retry_count=retry_count,
        route_id=route_id,
        **extra,
    )
    payload["stage"] = stage
    payload["message"] = stage
    log_fn(payload)
