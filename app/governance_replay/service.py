"""Build governance replay feed and operations from existing runtime data (M20.1)."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.governance_policies.models import StreamPolicyAssignment
from app.governance_replay.models import (
    REPLAY_DISPLAY_COMPLETED,
    REPLAY_DISPLAY_DISCARDED,
    REPLAY_DISPLAY_FAILED,
    REPLAY_DISPLAY_PENDING,
    REPLAY_DISPLAY_RUNNING,
    REPLAY_ORIGIN_DELIVERY_FAILURE,
    REPLAY_ORIGIN_QUARANTINE,
    REPLAY_OUTCOME_DISCARDED,
    REPLAY_OUTCOME_FAILURE,
    REPLAY_OUTCOME_SUCCESS,
    REPLAY_WINDOW_24H,
    REPLAY_WINDOW_7D,
    REPLAY_WINDOW_30D,
)
from app.governance_replay.schemas import (
    GovernanceReplayBulkItemResult,
    GovernanceReplayBulkResponse,
    GovernanceReplayDetailResponse,
    GovernanceReplayEntry,
    GovernanceReplayExecuteResponse,
    GovernanceReplayPolicySummary,
    GovernanceReplayQuarantineRef,
    GovernanceReplaySource,
    GovernanceReplayTimelineStep,
    GovernanceReplayViolationRef,
)
from app.governance_violations.service import (
    _derive_violation_status,
    _humanize_quarantine_reason,
    _load_replayed_stream_ids,
    _load_stream_names,
    _load_stream_policy_map,
    _resolve_policy_context,
    _violation_id_for_quarantine,
)
from app.quarantine.models import StreamQuarantineEvent
from app.replay.models import (
    REPLAY_STATUS_DISCARDED,
    REPLAY_STATUS_FAILED,
    REPLAY_STATUS_PENDING,
    REPLAY_STATUS_REPLAYED,
    StreamReplayEvent,
)

_DEFAULT_LIMIT = 100
_MAX_LIMIT = 200

_DISPLAY_TO_DB_STATUS = {
    REPLAY_DISPLAY_PENDING: REPLAY_STATUS_PENDING,
    REPLAY_DISPLAY_COMPLETED: REPLAY_STATUS_REPLAYED,
    REPLAY_DISPLAY_FAILED: REPLAY_STATUS_FAILED,
    REPLAY_DISPLAY_DISCARDED: REPLAY_STATUS_DISCARDED,
}


class GovernanceReplayNotFoundError(Exception):
    def __init__(self, replay_id: int) -> None:
        self.replay_id = replay_id
        super().__init__(f"governance replay event not found: {replay_id}")


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _notify_replay_governance_events(
    db: Session,
    *,
    replay_id: int,
    outcome: str,
    retry_count_before: int,
    message: str | None = None,
) -> None:
    from app.governance_notifications.models import (
        EVENT_REPLAY_COMPLETED,
        EVENT_REPLAY_FAILED,
        EVENT_REPLAY_RETRIED,
    )
    from app.governance_notifications.service import NotificationService

    payload = {
        "replay_event_id": int(replay_id),
        "outcome": outcome,
        "message": message,
    }
    if int(retry_count_before) > 0:
        NotificationService.record_event(
            db,
            event_type=EVENT_REPLAY_RETRIED,
            severity="INFO",
            payload=payload,
        )
    if outcome in {"replayed", "completed"}:
        NotificationService.record_event(
            db,
            event_type=EVENT_REPLAY_COMPLETED,
            severity="INFO",
            payload=payload,
        )
    elif outcome == "failed":
        NotificationService.record_event(
            db,
            event_type=EVENT_REPLAY_FAILED,
            severity="HIGH",
            payload=payload,
        )
    NotificationService.dispatch_pending(db)


def _window_bounds(window: str, *, until: datetime | None = None) -> tuple[datetime, datetime]:
    end = until or _utc_now()
    if window == REPLAY_WINDOW_7D:
        return end - timedelta(days=7), end
    if window == REPLAY_WINDOW_30D:
        return end - timedelta(days=30), end
    return end - timedelta(hours=24), end


def _to_display_status(row: StreamReplayEvent) -> str:
    raw = str(row.status or "")
    if raw == REPLAY_STATUS_PENDING:
        if row.last_replay_at is not None and row.retry_count > 0:
            return REPLAY_DISPLAY_RUNNING
        return REPLAY_DISPLAY_PENDING
    if raw == REPLAY_STATUS_REPLAYED:
        return REPLAY_DISPLAY_COMPLETED
    if raw == REPLAY_STATUS_FAILED:
        return REPLAY_DISPLAY_FAILED
    if raw == REPLAY_STATUS_DISCARDED:
        return REPLAY_DISPLAY_DISCARDED
    return REPLAY_DISPLAY_PENDING


def _outcome_for_row(row: StreamReplayEvent) -> str | None:
    raw = str(row.status or "")
    if raw == REPLAY_STATUS_REPLAYED:
        return REPLAY_OUTCOME_SUCCESS
    if raw == REPLAY_STATUS_FAILED:
        return REPLAY_OUTCOME_FAILURE
    if raw == REPLAY_STATUS_DISCARDED:
        return REPLAY_OUTCOME_DISCARDED
    return None


def _completed_at(row: StreamReplayEvent) -> datetime | None:
    raw = str(row.status or "")
    if raw in {REPLAY_STATUS_REPLAYED, REPLAY_STATUS_FAILED, REPLAY_STATUS_DISCARDED}:
        return row.last_replay_at or row.updated_at
    return None


def _find_quarantine_for_replay(db: Session, row: StreamReplayEvent) -> StreamQuarantineEvent | None:
    mapping = _load_quarantine_for_replays(db, [row])
    return mapping.get(int(row.id))


def _load_quarantine_for_replays(
    db: Session,
    rows: list[StreamReplayEvent],
) -> dict[int, StreamQuarantineEvent | None]:
    """Batch-resolve latest quarantine row at or before each replay's created_at."""

    if not rows:
        return {}

    stream_ids = {int(row.stream_id) for row in rows}
    quarantine_rows = list(
        db.execute(
            select(StreamQuarantineEvent)
            .where(StreamQuarantineEvent.stream_id.in_(stream_ids))
            .order_by(
                StreamQuarantineEvent.stream_id,
                StreamQuarantineEvent.created_at.desc(),
                StreamQuarantineEvent.id.desc(),
            )
        ).scalars()
    )

    by_stream: dict[int, list[StreamQuarantineEvent]] = defaultdict(list)
    for quarantine in quarantine_rows:
        by_stream[int(quarantine.stream_id)].append(quarantine)

    out: dict[int, StreamQuarantineEvent | None] = {}
    for row in rows:
        matched: StreamQuarantineEvent | None = None
        for candidate in by_stream.get(int(row.stream_id), []):
            if candidate.created_at <= row.created_at:
                matched = candidate
                break
        out[int(row.id)] = matched
    return out


def _correlation_id_from_quarantine(quarantine: StreamQuarantineEvent | None) -> str | None:
    if quarantine is None:
        return None
    return _violation_id_for_quarantine(int(quarantine.id))


def _replay_origin_from_quarantine(quarantine: StreamQuarantineEvent | None) -> str:
    if quarantine is not None:
        return REPLAY_ORIGIN_QUARANTINE
    return REPLAY_ORIGIN_DELIVERY_FAILURE


def _correlation_id_for_replay(
    db: Session,
    row: StreamReplayEvent,
    *,
    quarantine: StreamQuarantineEvent | None = None,
) -> str | None:
    if quarantine is None:
        quarantine = _find_quarantine_for_replay(db, row)
    correlated = _correlation_id_from_quarantine(quarantine)
    if correlated is not None:
        return correlated
    return f"r-{int(row.id)}"


def _replay_origin(
    db: Session,
    row: StreamReplayEvent,
    *,
    quarantine: StreamQuarantineEvent | None = None,
) -> str:
    if quarantine is None:
        quarantine = _find_quarantine_for_replay(db, row)
    return _replay_origin_from_quarantine(quarantine)


def _stream_ids_for_policy(db: Session, policy_id: int) -> list[int]:
    rows = list(
        db.execute(
            select(StreamPolicyAssignment.stream_id).where(
                StreamPolicyAssignment.policy_id == int(policy_id),
                StreamPolicyAssignment.enabled.is_(True),
            )
        ).scalars()
    )
    return [int(sid) for sid in rows]


def _row_to_entry(
    db: Session,
    row: StreamReplayEvent,
    *,
    stream_names: dict[int, str],
    stream_policies: dict[int, list],
    quarantine: StreamQuarantineEvent | None = None,
) -> GovernanceReplayEntry:
    ctx = _resolve_policy_context(
        db,
        stream_id=int(row.stream_id),
        stream_policies=stream_policies,
        runtime_policy_names=[],
    )
    return GovernanceReplayEntry(
        id=int(row.id),
        policy_id=ctx.policy_id,
        policy_name=ctx.policy_name,
        stream_id=int(row.stream_id),
        stream_name=stream_names.get(int(row.stream_id), f"Stream {row.stream_id}"),
        status=_to_display_status(row),
        created_at=row.created_at,
        completed_at=_completed_at(row),
        outcome=_outcome_for_row(row),
        event_count=int(row.event_count or 0),
        correlation_id=_correlation_id_for_replay(db, row, quarantine=quarantine),
    )


def _matches_display_status(row: StreamReplayEvent, display_status: str) -> bool:
    current = _to_display_status(row)
    if display_status == REPLAY_DISPLAY_RUNNING:
        return current == REPLAY_DISPLAY_RUNNING
    if display_status == REPLAY_DISPLAY_PENDING:
        return current == REPLAY_DISPLAY_PENDING
    return current == display_status


def list_governance_replay_events(
    db: Session,
    *,
    window: str = REPLAY_WINDOW_24H,
    policy_id: int | None = None,
    stream_id: int | None = None,
    status: str | None = None,
    limit: int = _DEFAULT_LIMIT,
) -> tuple[list[GovernanceReplayEntry], int, int, int]:
    since, until = _window_bounds(window)
    lim = max(1, min(int(limit), _MAX_LIMIT))

    stmt = (
        select(StreamReplayEvent)
        .where(
            StreamReplayEvent.created_at >= since,
            StreamReplayEvent.created_at < until,
        )
        .order_by(StreamReplayEvent.created_at.desc(), StreamReplayEvent.id.desc())
    )

    if stream_id is not None:
        stmt = stmt.where(StreamReplayEvent.stream_id == int(stream_id))

    if policy_id is not None:
        policy_stream_ids = _stream_ids_for_policy(db, int(policy_id))
        if not policy_stream_ids:
            return [], 0, 0, 0
        stmt = stmt.where(StreamReplayEvent.stream_id.in_(policy_stream_ids))

    if status is not None and status != REPLAY_DISPLAY_RUNNING:
        db_status = _DISPLAY_TO_DB_STATUS.get(str(status))
        if db_status is not None:
            stmt = stmt.where(StreamReplayEvent.status == db_status)

    rows = list(db.execute(stmt.limit(lim * 3)).scalars())
    if not rows:
        return [], 0, 0, 0

    stream_ids = {int(r.stream_id) for r in rows}
    stream_names = _load_stream_names(db, stream_ids)
    stream_policies = _load_stream_policy_map(db, stream_ids)
    quarantine_by_replay_id = _load_quarantine_for_replays(db, rows)

    entries: list[GovernanceReplayEntry] = []
    queue_count = 0
    failed_count = 0
    recent_count = 0

    for row in rows:
        if status is not None and not _matches_display_status(row, str(status)):
            continue
        entry = _row_to_entry(
            db,
            row,
            stream_names=stream_names,
            stream_policies=stream_policies,
            quarantine=quarantine_by_replay_id.get(int(row.id)),
        )
        entries.append(entry)
        disp = entry.status
        if disp in {REPLAY_DISPLAY_PENDING, REPLAY_DISPLAY_RUNNING}:
            queue_count += 1
        elif disp == REPLAY_DISPLAY_FAILED:
            failed_count += 1
        elif disp == REPLAY_DISPLAY_COMPLETED:
            recent_count += 1
        if len(entries) >= lim:
            break

    return entries, queue_count, failed_count, recent_count


def get_governance_replay_detail(
    db: Session,
    replay_id: int,
    *,
    window: str = REPLAY_WINDOW_30D,
) -> GovernanceReplayDetailResponse:
    row = db.get(StreamReplayEvent, int(replay_id))
    if row is None:
        raise GovernanceReplayNotFoundError(replay_id)

    since, until = _window_bounds(window)
    stream_ids = {int(row.stream_id)}
    stream_names = _load_stream_names(db, stream_ids)
    stream_policies = _load_stream_policy_map(db, stream_ids)
    replayed_streams = _load_replayed_stream_ids(db, stream_ids=stream_ids, since=since, until=until)

    quarantine_map = _load_quarantine_for_replays(db, [row])
    quarantine = quarantine_map.get(int(row.id))

    entry = _row_to_entry(
        db,
        row,
        stream_names=stream_names,
        stream_policies=stream_policies,
        quarantine=quarantine,
    )
    ctx = _resolve_policy_context(
        db,
        stream_id=int(row.stream_id),
        stream_policies=stream_policies,
        runtime_policy_names=[],
    )
    policy_summary = GovernanceReplayPolicySummary(
        policy_id=ctx.policy_id,
        policy_name=ctx.policy_name,
        policy_status=ctx.policy_status,
        policy_version=ctx.policy_version,
    )

    violation_ref: GovernanceReplayViolationRef | None = None
    quarantine_ref: GovernanceReplayQuarantineRef | None = None
    if quarantine is not None:
        violation_status = _derive_violation_status(
            db,
            quarantine_status=str(quarantine.status),
            stream_id=int(quarantine.stream_id),
            event_time=quarantine.created_at,
            until=until,
            replayed_streams=replayed_streams,
        )
        reason = _humanize_quarantine_reason(
            str(quarantine.quarantine_reason),
            quarantine_source=str(quarantine.quarantine_source),
        )
        violation_id = _violation_id_for_quarantine(int(quarantine.id))
        violation_ref = GovernanceReplayViolationRef(
            violation_id=violation_id,
            status=violation_status,
            reason=reason,
        )
        quarantine_ref = GovernanceReplayQuarantineRef(
            quarantine_event_id=int(quarantine.id),
            status=str(quarantine.status),
            quarantine_reason=str(quarantine.quarantine_reason),
            created_at=quarantine.created_at,
        )

    source = GovernanceReplaySource(
        origin=_replay_origin_from_quarantine(quarantine),
        violation=violation_ref,
        quarantine=quarantine_ref,
    )

    timeline: list[GovernanceReplayTimelineStep] = [
        GovernanceReplayTimelineStep(
            step="replay_created",
            label="Replay created",
            event_time=row.created_at,
        ),
    ]
    if row.last_replay_at is not None or int(row.retry_count or 0) > 0:
        timeline.append(
            GovernanceReplayTimelineStep(
                step="replay_started",
                label="Replay started",
                event_time=row.last_replay_at or row.updated_at,
            )
        )
    if str(row.status) == REPLAY_STATUS_REPLAYED:
        timeline.append(
            GovernanceReplayTimelineStep(
                step="replay_completed",
                label="Replay completed",
                event_time=row.last_replay_at or row.updated_at,
            )
        )
    elif str(row.status) == REPLAY_STATUS_FAILED:
        timeline.append(
            GovernanceReplayTimelineStep(
                step="replay_failed",
                label="Replay failed",
                event_time=row.updated_at or row.last_replay_at,
            )
        )

    can_execute = str(row.status) in {REPLAY_STATUS_PENDING, REPLAY_STATUS_FAILED}

    return GovernanceReplayDetailResponse(
        entry=entry,
        policy_summary=policy_summary,
        correlation_id=entry.correlation_id,
        source=source,
        timeline=timeline,
        outcome=entry.outcome,
        error_type=row.error_type,
        error_message=row.error_message,
        can_execute=can_execute,
    )


def execute_governance_replay(db: Session, replay_id: int) -> GovernanceReplayExecuteResponse:
    from app.replay import service as replay_service

    row = db.get(StreamReplayEvent, int(replay_id))
    retry_before = int(row.retry_count or 0) if row is not None else 0

    try:
        result = replay_service.execute_replay_event(db, int(replay_id))
    except replay_service.ReplayEventNotFoundError as exc:
        raise GovernanceReplayNotFoundError(replay_id) from exc
    except replay_service.ReplayEventStateError as exc:
        _notify_replay_governance_events(
            db,
            replay_id=int(replay_id),
            outcome="failed",
            retry_count_before=retry_before,
            message=str(exc.message),
        )
        db.commit()
        return GovernanceReplayExecuteResponse(
            id=int(replay_id),
            outcome="failed",
            message=str(exc.message),
            status=None,
        )
    except replay_service.ReplayInProgressError:
        return GovernanceReplayExecuteResponse(
            id=int(replay_id),
            outcome="failed",
            message=f"replay already in progress for event {replay_id}",
            status=None,
        )

    outcome = str(result.get("outcome") or "unknown")
    _notify_replay_governance_events(
        db,
        replay_id=int(replay_id),
        outcome=outcome,
        retry_count_before=retry_before,
        message=str(result.get("message") or ""),
    )
    db.commit()
    return GovernanceReplayExecuteResponse(
        id=int(replay_id),
        outcome=outcome,
        message=str(result.get("message") or ""),
        status=str(result.get("status") or ""),
    )


def bulk_execute_governance_replay(db: Session, ids: list[int]) -> GovernanceReplayBulkResponse:
    from app.replay import service as replay_service

    results: list[GovernanceReplayBulkItemResult] = []
    succeeded = 0

    for replay_id in ids:
        try:
            result = replay_service.execute_replay_event(db, int(replay_id))
            outcome = str(result.get("outcome") or "unknown")
            if outcome == "replayed":
                succeeded += 1
            results.append(
                GovernanceReplayBulkItemResult(
                    id=int(replay_id),
                    outcome=outcome,
                    message=str(result.get("message") or ""),
                    status=str(result.get("status") or ""),
                )
            )
            db.commit()
        except replay_service.ReplayEventNotFoundError:
            db.rollback()
            results.append(
                GovernanceReplayBulkItemResult(
                    id=int(replay_id),
                    outcome="failed",
                    message=f"replay event not found: {replay_id}",
                )
            )
        except replay_service.ReplayEventStateError as exc:
            db.rollback()
            results.append(
                GovernanceReplayBulkItemResult(
                    id=int(replay_id),
                    outcome="failed",
                    message=str(exc.message),
                )
            )
        except replay_service.ReplayInProgressError:
            db.rollback()
            results.append(
                GovernanceReplayBulkItemResult(
                    id=int(replay_id),
                    outcome="failed",
                    message=f"replay already in progress for event {replay_id}",
                )
            )
    failed = len(results) - succeeded
    return GovernanceReplayBulkResponse(
        total=len(results),
        succeeded=succeeded,
        failed=failed,
        results=results,
    )
