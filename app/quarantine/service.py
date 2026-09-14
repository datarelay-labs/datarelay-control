"""M12 Quarantine MVP — list, release, discard, summary."""

from __future__ import annotations

import logging
import time
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.checkpoints.repository import get_checkpoint_by_stream_id
from app.checkpoints.service import CheckpointService
from app.destinations.adapters.registry import DestinationAdapterRegistry
from app.quarantine.metrics import (
    QUARANTINE_EVENT_DISCARDED_STAGE,
    QUARANTINE_EVENT_RELEASE_FAILED_STAGE,
    QUARANTINE_EVENT_RELEASED_STAGE,
    persist_quarantine_observability_log,
)
from app.quarantine.models import (
    QUARANTINE_SOURCE_POLICY,
    QUARANTINE_STATUS_DISCARDED,
    QUARANTINE_STATUS_QUARANTINED,
    QUARANTINE_STATUS_RELEASED,
    QUARANTINE_TERMINAL_STATUSES,
    StreamQuarantineEvent,
)
from app.quarantine.release_delivery import deliver_protected_events_to_routes
from app.streams.repository import get_stream_by_id

logger = logging.getLogger(__name__)

_LOCK_NOT_AVAILABLE_MARKERS = ("could not obtain lock", "lock_not_available", "55p03")


def _lock_quarantine_row(db: Session, event_id: int) -> StreamQuarantineEvent | None:
    try:
        return (
            db.query(StreamQuarantineEvent)
            .filter(StreamQuarantineEvent.id == int(event_id))
            .with_for_update(nowait=True)
            .first()
        )
    except OperationalError as exc:
        err = str(exc).lower()
        if any(marker in err for marker in _LOCK_NOT_AVAILABLE_MARKERS):
            raise QuarantineInProgressError(event_id) from exc
        raise


class QuarantineEventNotFoundError(Exception):
    def __init__(self, event_id: int) -> None:
        self.event_id = event_id
        super().__init__(f"quarantine event not found: {event_id}")


class QuarantineEventStateError(Exception):
    def __init__(self, error_code: str, message: str) -> None:
        self.error_code = error_code
        self.message = message
        super().__init__(message)


class QuarantineInProgressError(Exception):
    def __init__(self, event_id: int) -> None:
        self.event_id = event_id
        super().__init__(f"quarantine release already in progress for event {event_id}")


def _extract_stored_events(row: StreamQuarantineEvent) -> list[dict[str, Any]]:
    raw = row.protected_payload_json if isinstance(row.protected_payload_json, dict) else {}
    events = raw.get("events")
    if not isinstance(events, list):
        return []
    out: list[dict[str, Any]] = []
    for item in events:
        if isinstance(item, dict):
            out.append(deepcopy(item))
    return out


def quarantine_event_to_dict(row: StreamQuarantineEvent) -> dict[str, Any]:
    meta = row.metadata_json if isinstance(row.metadata_json, dict) else {}
    return {
        "id": row.id,
        "stream_id": row.stream_id,
        "route_id": row.route_id,
        "quarantine_reason": row.quarantine_reason,
        "quarantine_source": row.quarantine_source,
        "status": row.status,
        "event_count": int(meta.get("event_count") or 0),
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "released_at": row.released_at,
        "released_by": row.released_by,
    }


def list_stream_quarantine_events(
    db: Session,
    stream_id: int,
    *,
    status: str | None = None,
    route_id: int | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    lim = max(1, min(int(limit), 200))
    stmt = select(StreamQuarantineEvent).where(StreamQuarantineEvent.stream_id == int(stream_id))
    if status:
        stmt = stmt.where(StreamQuarantineEvent.status == str(status))
    if route_id is not None:
        stmt = stmt.where(StreamQuarantineEvent.route_id == int(route_id))
    stmt = stmt.order_by(StreamQuarantineEvent.created_at.desc(), StreamQuarantineEvent.id.desc()).limit(lim)
    rows = list(db.execute(stmt).scalars())
    return [quarantine_event_to_dict(r) for r in rows]


def _count_by_status(db: Session, stream_id: int | None = None) -> dict[str, int]:
    stmt = select(StreamQuarantineEvent.status, func.count(StreamQuarantineEvent.id)).group_by(
        StreamQuarantineEvent.status
    )
    if stream_id is not None:
        stmt = stmt.where(StreamQuarantineEvent.stream_id == int(stream_id))
    counts = {
        QUARANTINE_STATUS_QUARANTINED: 0,
        QUARANTINE_STATUS_RELEASED: 0,
        QUARANTINE_STATUS_DISCARDED: 0,
    }
    for status, cnt in db.execute(stmt).all():
        if status in counts:
            counts[str(status)] = int(cnt or 0)
    return counts


def build_stream_quarantine_summary(db: Session, stream_id: int) -> dict[str, Any]:
    counts = _count_by_status(db, stream_id)
    last_released = db.execute(
        select(StreamQuarantineEvent.released_at)
        .where(
            StreamQuarantineEvent.stream_id == int(stream_id),
            StreamQuarantineEvent.status == QUARANTINE_STATUS_RELEASED,
        )
        .order_by(StreamQuarantineEvent.released_at.desc().nullslast(), StreamQuarantineEvent.id.desc())
        .limit(1)
    ).scalar_one_or_none()
    return {
        "stream_id": stream_id,
        "quarantined_count": counts[QUARANTINE_STATUS_QUARANTINED],
        "released_count": counts[QUARANTINE_STATUS_RELEASED],
        "discarded_count": counts[QUARANTINE_STATUS_DISCARDED],
        "total_count": sum(counts.values()),
        "last_released_at": last_released,
    }


def build_platform_quarantine_summary(db: Session) -> dict[str, Any]:
    counts = _count_by_status(db, None)
    stream_rows = db.execute(
        select(StreamQuarantineEvent.stream_id, func.count(StreamQuarantineEvent.id))
        .where(StreamQuarantineEvent.status == QUARANTINE_STATUS_QUARANTINED)
        .group_by(StreamQuarantineEvent.stream_id)
        .order_by(func.count(StreamQuarantineEvent.id).desc())
        .limit(20)
    ).all()
    last_released = db.execute(
        select(StreamQuarantineEvent.released_at)
        .where(StreamQuarantineEvent.status == QUARANTINE_STATUS_RELEASED)
        .order_by(StreamQuarantineEvent.released_at.desc().nullslast(), StreamQuarantineEvent.id.desc())
        .limit(1)
    ).scalar_one_or_none()
    return {
        "quarantined_count": counts[QUARANTINE_STATUS_QUARANTINED],
        "released_count": counts[QUARANTINE_STATUS_RELEASED],
        "discarded_count": counts[QUARANTINE_STATUS_DISCARDED],
        "total_count": sum(counts.values()),
        "last_released_at": last_released,
        "streams_with_quarantined": [
            {"stream_id": int(sid), "quarantined_count": int(cnt)} for sid, cnt in stream_rows
        ],
    }


def _checkpoint_value_from_last_event(last_ev: dict[str, Any]) -> dict[str, Any]:
    checkpoint_value: dict[str, Any] = {"last_success_event": deepcopy(last_ev)}
    sk = last_ev.get("s3_key")
    slm = last_ev.get("s3_last_modified")
    etag = last_ev.get("s3_etag")
    if sk is not None:
        checkpoint_value["last_processed_key"] = sk
    if slm is not None:
        checkpoint_value["last_processed_last_modified"] = slm
    if etag is not None:
        checkpoint_value["last_processed_etag"] = etag
    wm = last_ev.get("gdc_db_watermark")
    lo = last_ev.get("gdc_db_order_value")
    if wm is not None:
        checkpoint_value["last_processed_db_watermark"] = wm
    if lo is not None:
        checkpoint_value["last_processed_db_order"] = lo
    rp = last_ev.get("remote_path") or last_ev.get("gdc_remote_path")
    rmt = last_ev.get("remote_mtime") or last_ev.get("gdc_remote_mtime")
    rsz = last_ev.get("remote_size")
    if rsz is None:
        rsz = last_ev.get("gdc_remote_size")
    roff = last_ev.get("gdc_remote_offset")
    rhash = last_ev.get("gdc_remote_hash")
    if rp is not None:
        checkpoint_value["last_processed_key"] = rp
        checkpoint_value["last_processed_file"] = rp
    if rmt is not None:
        checkpoint_value["last_processed_last_modified"] = rmt
        checkpoint_value["last_processed_mtime"] = rmt
    if rsz is not None:
        checkpoint_value["last_processed_size"] = rsz
    if roff is not None:
        checkpoint_value["last_processed_offset"] = roff
    if rhash is not None:
        checkpoint_value["last_processed_hash"] = rhash
    return checkpoint_value


def _update_checkpoint_after_release(db: Session, stream_id: int, events: list[dict[str, Any]]) -> dict[str, Any] | None:
    stream = get_stream_by_id(db, stream_id)
    if stream is None or not events:
        return None
    checkpoint_type = str(getattr(stream, "checkpoint_type", "EVENT") or "EVENT")
    last_ev = events[-1]
    if not isinstance(last_ev, dict):
        return None
    checkpoint_value = _checkpoint_value_from_last_event(last_ev)
    svc = CheckpointService()
    return svc.update_checkpoint_after_success(
        db=db,
        stream_id=int(stream_id),
        checkpoint_type=checkpoint_type,
        checkpoint_value=checkpoint_value,
    )


def discard_quarantine_event(db: Session, event_id: int) -> dict[str, Any]:
    row = _lock_quarantine_row(db, event_id)
    if row is None:
        raise QuarantineEventNotFoundError(event_id)
    if row.status in QUARANTINE_TERMINAL_STATUSES:
        raise QuarantineEventStateError(
            "QUARANTINE_INVALID_STATE",
            f"cannot discard quarantine event in status {row.status!r}",
        )
    now = datetime.now(timezone.utc)
    row.status = QUARANTINE_STATUS_DISCARDED
    row.updated_at = now
    persist_quarantine_observability_log(
        db,
        stage=QUARANTINE_EVENT_DISCARDED_STAGE,
        stream_id=int(row.stream_id),
        quarantine_event_id=int(row.id),
        status=row.status,
        quarantine_reason=str(row.quarantine_reason),
        message="quarantine event discarded",
    )
    db.flush()
    return quarantine_event_to_dict(row)


def execute_quarantine_release(
    db: Session,
    event_id: int,
    *,
    released_by: str | None = None,
    destination_registry: DestinationAdapterRegistry | None = None,
    update_checkpoint: bool = True,
) -> dict[str, Any]:
    """Resend stored protected payload to routes; update checkpoint on full success."""

    row = _lock_quarantine_row(db, event_id)
    if row is None:
        raise QuarantineEventNotFoundError(event_id)
    if row.status == QUARANTINE_STATUS_DISCARDED:
        raise QuarantineEventStateError(
            "QUARANTINE_DISCARDED",
            "discarded quarantine events cannot be released",
        )
    if row.status == QUARANTINE_STATUS_RELEASED:
        raise QuarantineEventStateError(
            "QUARANTINE_ALREADY_RELEASED",
            "released events cannot be released again",
        )
    if row.status != QUARANTINE_STATUS_QUARANTINED:
        raise QuarantineEventStateError(
            "QUARANTINE_INVALID_STATE",
            f"release not allowed for status {row.status!r}",
        )

    events = _extract_stored_events(row)
    if not events:
        raise QuarantineEventStateError("QUARANTINE_PAYLOAD_EMPTY", "stored protected payload is empty")

    before_cp = get_checkpoint_by_stream_id(db, int(row.stream_id))
    before_value = (
        deepcopy(before_cp.checkpoint_value_json)
        if before_cp is not None and isinstance(before_cp.checkpoint_value_json, dict)
        else {}
    )

    send_started = time.monotonic()
    now = datetime.now(timezone.utc)
    ok, err_msg = deliver_protected_events_to_routes(
        db,
        stream_id=int(row.stream_id),
        events=events,
        destination_registry=destination_registry,
        route_id=int(row.route_id) if row.route_id is not None else None,
    )
    latency_ms = max(0, int((time.monotonic() - send_started) * 1000))

    if not ok:
        persist_quarantine_observability_log(
            db,
            stage=QUARANTINE_EVENT_RELEASE_FAILED_STAGE,
            stream_id=int(row.stream_id),
            quarantine_event_id=int(row.id),
            status=row.status,
            quarantine_reason=str(row.quarantine_reason),
            message=err_msg or "quarantine release delivery failed",
            level="ERROR",
            log_status="FAILED",
            error_code="QUARANTINE_RELEASE_FAILED",
            extra={"latency_ms": latency_ms, "event_count": len(events)},
        )
        row.updated_at = now
        db.flush()
        return {
            **quarantine_event_to_dict(row),
            "outcome": "failed",
            "message": err_msg or "Release delivery failed.",
            "checkpoint_updated": False,
        }

    checkpoint_after: dict[str, Any] | None = None
    if update_checkpoint:
        try:
            checkpoint_after = _update_checkpoint_after_release(db, int(row.stream_id), events)
        except Exception:
            logger.exception("quarantine_release_checkpoint_failed stream_id=%s", row.stream_id)
            persist_quarantine_observability_log(
                db,
                stage=QUARANTINE_EVENT_RELEASE_FAILED_STAGE,
                stream_id=int(row.stream_id),
                quarantine_event_id=int(row.id),
                status=row.status,
                quarantine_reason=str(row.quarantine_reason),
                message="quarantine release checkpoint update failed",
                level="ERROR",
                log_status="FAILED",
                error_code="QUARANTINE_CHECKPOINT_FAILED",
                extra={
                    "latency_ms": latency_ms,
                    "event_count": len(events),
                    "checkpoint_before": before_value,
                },
            )
            row.updated_at = now
            db.flush()
            return {
                **quarantine_event_to_dict(row),
                "outcome": "failed",
                "message": "Release delivery succeeded but checkpoint update failed.",
                "checkpoint_updated": False,
            }

    row.status = QUARANTINE_STATUS_RELEASED
    row.updated_at = now
    row.released_at = now
    row.released_by = (released_by or "system")[:128]
    persist_quarantine_observability_log(
        db,
        stage=QUARANTINE_EVENT_RELEASED_STAGE,
        stream_id=int(row.stream_id),
        quarantine_event_id=int(row.id),
        status=row.status,
        quarantine_reason=str(row.quarantine_reason),
        message="quarantine event released",
        extra={
            "latency_ms": latency_ms,
            "event_count": len(events),
            "released_by": row.released_by,
            "quarantine_source": row.quarantine_source,
            "checkpoint_before": before_value,
            "checkpoint_after": checkpoint_after,
        },
    )
    db.flush()
    return {
        **quarantine_event_to_dict(row),
        "outcome": "released",
        "message": "Quarantine released successfully.",
        "checkpoint_updated": checkpoint_after is not None,
    }


def try_policy_quarantine_for_batch(
    db: Session | None,
    *,
    stream_id: int,
    delivery_events: list[dict[str, Any]],
    policy_result: Any,
    log_fn: Any | None = None,
) -> bool:
    """If policy quarantine matches, record event and return True (skip fan-out)."""

    from app.protection.policy_engine import PolicyBatchResult
    from app.quarantine.policy_integration import should_quarantine_batch
    from app.quarantine.recording import record_policy_quarantine_event

    if db is None or not delivery_events:
        return False
    if not isinstance(policy_result, PolicyBatchResult):
        return False
    if not should_quarantine_batch(policy_result):
        return False

    row = record_policy_quarantine_event(
        db,
        stream_id=int(stream_id),
        delivery_events=delivery_events,
        policy_result=policy_result,
    )
    if log_fn is not None and row is not None:
        log_fn(
            {
                "stage": "quarantine_applied",
                "stream_id": stream_id,
                "quarantine_event_id": int(row.id),
                "quarantine_reason": row.quarantine_reason,
                "quarantine_source": QUARANTINE_SOURCE_POLICY,
                "event_count": len(delivery_events),
                "message": "policy quarantine — destination delivery skipped",
            }
        )
    return row is not None
