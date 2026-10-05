"""Build governance audit timeline from existing policy, quarantine, replay, and delivery log data."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.governance_audit.models import (
    AUDIT_EVENT_POLICY_ACTIVATED,
    AUDIT_EVENT_POLICY_APPROVAL_ACTIVATED,
    AUDIT_EVENT_POLICY_APPROVED,
    AUDIT_EVENT_POLICY_REJECTED,
    AUDIT_EVENT_POLICY_REQUEST_CHANGES,
    AUDIT_EVENT_POLICY_SUBMITTED,
    AUDIT_EVENT_QUARANTINE_CREATED,
    AUDIT_EVENT_QUARANTINE_DISCARDED,
    AUDIT_EVENT_QUARANTINE_RELEASED,
    AUDIT_EVENT_REPLAY_COMPLETED,
    AUDIT_EVENT_REPLAY_FAILED,
    AUDIT_EVENT_REPLAY_STARTED,
    AUDIT_EVENT_VIOLATION_CREATED,
    AUDIT_OUTCOME_DELIVERED,
    AUDIT_OUTCOME_DISCARDED,
    AUDIT_OUTCOME_FAILED,
    AUDIT_STATUS_ACTIVE,
    AUDIT_STATUS_DELIVERED,
    AUDIT_STATUS_DISCARDED,
    AUDIT_STATUS_FAILED,
    AUDIT_STATUS_IN_PROGRESS,
    AUDIT_STATUS_OPEN,
    AUDIT_STATUS_QUARANTINED,
    AUDIT_STATUS_RELEASED,
    AUDIT_WINDOW_24H,
    AUDIT_WINDOW_30D,
    AUDIT_WINDOW_7D,
)
from app.governance_audit.schemas import (
    GovernanceAuditDetailResponse,
    GovernanceAuditEntry,
    GovernanceAuditQuarantineRef,
    GovernanceAuditReplayRef,
    GovernanceAuditTimelineStep,
    GovernanceAuditViolationRef,
)
from app.governance_policies.models import GovernancePolicy
from app.governance_violations.service import (
    _derive_violation_status,
    _humanize_quarantine_reason,
    _load_replayed_stream_ids,
    _load_stream_names,
    _load_stream_policy_map,
    _resolve_policy_context,
    _violation_id_for_quarantine,
)
from app.logs.models import DeliveryLog
from app.quarantine.metrics import (
    QUARANTINE_EVENT_CREATED_STAGE,
    QUARANTINE_EVENT_DISCARDED_STAGE,
    QUARANTINE_EVENT_RELEASED_STAGE,
)
from app.quarantine.models import (
    QUARANTINE_STATUS_DISCARDED,
    QUARANTINE_STATUS_QUARANTINED,
    QUARANTINE_STATUS_RELEASED,
    StreamQuarantineEvent,
)
from app.replay.metrics import (
    REPLAY_EVENT_REPLAY_STARTED_STAGE,
    REPLAY_EVENT_REPLAYED_STAGE,
    REPLAY_EVENT_REPLAY_FAILED_STAGE,
)
from app.replay.models import (
    DELIVERY_ATTEMPT_CONTEXT_KEY,
    REPLAY_STATUS_FAILED,
    REPLAY_STATUS_REPLAYED,
    StreamReplayEvent,
)

_DEFAULT_LIMIT = 100
_MAX_LIMIT = 200

_EVENT_SUMMARIES = {
    AUDIT_EVENT_POLICY_ACTIVATED: "Policy activated",
    AUDIT_EVENT_POLICY_SUBMITTED: "Submitted for review",
    AUDIT_EVENT_POLICY_APPROVED: "Policy approved",
    AUDIT_EVENT_POLICY_REJECTED: "Policy rejected",
    AUDIT_EVENT_POLICY_REQUEST_CHANGES: "Changes requested",
    AUDIT_EVENT_POLICY_APPROVAL_ACTIVATED: "Policy activated via approval",
    AUDIT_EVENT_VIOLATION_CREATED: "Violation detected",
    AUDIT_EVENT_QUARANTINE_CREATED: "Quarantined",
    AUDIT_EVENT_QUARANTINE_RELEASED: "Released",
    AUDIT_EVENT_QUARANTINE_DISCARDED: "Discarded",
    AUDIT_EVENT_REPLAY_STARTED: "Replay started",
    AUDIT_EVENT_REPLAY_COMPLETED: "Replay completed",
    AUDIT_EVENT_REPLAY_FAILED: "Replay failed",
}

_EVENT_STATUS_MAP = {
    AUDIT_EVENT_POLICY_ACTIVATED: AUDIT_STATUS_ACTIVE,
    AUDIT_EVENT_POLICY_SUBMITTED: AUDIT_STATUS_IN_PROGRESS,
    AUDIT_EVENT_POLICY_APPROVED: AUDIT_STATUS_IN_PROGRESS,
    AUDIT_EVENT_POLICY_REJECTED: AUDIT_STATUS_OPEN,
    AUDIT_EVENT_POLICY_REQUEST_CHANGES: AUDIT_STATUS_OPEN,
    AUDIT_EVENT_POLICY_APPROVAL_ACTIVATED: AUDIT_STATUS_ACTIVE,
    AUDIT_EVENT_VIOLATION_CREATED: AUDIT_STATUS_OPEN,
    AUDIT_EVENT_QUARANTINE_CREATED: AUDIT_STATUS_QUARANTINED,
    AUDIT_EVENT_QUARANTINE_RELEASED: AUDIT_STATUS_RELEASED,
    AUDIT_EVENT_QUARANTINE_DISCARDED: AUDIT_STATUS_DISCARDED,
    AUDIT_EVENT_REPLAY_STARTED: AUDIT_STATUS_IN_PROGRESS,
    AUDIT_EVENT_REPLAY_COMPLETED: AUDIT_STATUS_DELIVERED,
    AUDIT_EVENT_REPLAY_FAILED: AUDIT_STATUS_FAILED,
}


class GovernanceAuditNotFoundError(Exception):
    def __init__(self, correlation_id: str) -> None:
        self.correlation_id = correlation_id
        super().__init__(f"governance audit correlation not found: {correlation_id}")


@dataclass(frozen=True)
class _InternalAuditEvent:
    correlation_id: str
    event_time: datetime
    event_type: str
    status: str
    policy_id: int | None
    policy_name: str
    stream_id: int | None
    stream_name: str | None
    summary: str
    actor: str | None
    quarantine_event_id: int | None = None
    replay_event_id: int | None = None


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _window_bounds(window: str, *, until: datetime | None = None) -> tuple[datetime, datetime]:
    end = until or _utc_now()
    if window == AUDIT_WINDOW_7D:
        return end - timedelta(days=7), end
    if window == AUDIT_WINDOW_30D:
        return end - timedelta(days=30), end
    return end - timedelta(hours=24), end


def _correlation_id_for_quarantine(quarantine_event_id: int) -> str:
    return _violation_id_for_quarantine(int(quarantine_event_id))


def _correlation_id_for_policy(policy_id: int) -> str:
    return f"p-{int(policy_id)}"


def _correlation_id_for_replay(replay_event_id: int) -> str:
    return f"r-{int(replay_event_id)}"


def _parse_correlation_id(correlation_id: str) -> tuple[str, int | None]:
    raw = str(correlation_id).strip()
    if raw.startswith("q-"):
        try:
            return "quarantine", int(raw[2:])
        except ValueError:
            return "unknown", None
    if raw.startswith("p-"):
        try:
            return "policy", int(raw[2:])
        except ValueError:
            return "unknown", None
    if raw.startswith("r-"):
        try:
            return "replay", int(raw[2:])
        except ValueError:
            return "unknown", None
    return "unknown", None


def _status_for_event_type(event_type: str) -> str:
    return _EVENT_STATUS_MAP.get(event_type, AUDIT_STATUS_OPEN)


def _summary_for_event(event_type: str, *, reason: str | None = None) -> str:
    base = _EVENT_SUMMARIES.get(event_type, event_type.replace("_", " ").title())
    if event_type == AUDIT_EVENT_VIOLATION_CREATED and reason:
        return f"{base}: {reason}"
    return base


def _policy_context_for_quarantine(
    db: Session,
    row: StreamQuarantineEvent,
    *,
    stream_policies: dict[int, list[GovernancePolicy]],
) -> tuple[int | None, str]:
    meta = row.metadata_json if isinstance(row.metadata_json, dict) else {}
    runtime_names = [str(n) for n in (meta.get("policy_names") or []) if n]
    ctx = _resolve_policy_context(
        db,
        stream_id=int(row.stream_id),
        stream_policies=stream_policies,
        runtime_policy_names=runtime_names,
    )
    return ctx.policy_id, ctx.policy_name


def _find_quarantine_for_replay(db: Session, replay_row: StreamReplayEvent) -> StreamQuarantineEvent | None:
    return db.execute(
        select(StreamQuarantineEvent)
        .where(
            StreamQuarantineEvent.stream_id == int(replay_row.stream_id),
            StreamQuarantineEvent.created_at <= replay_row.created_at,
        )
        .order_by(StreamQuarantineEvent.created_at.desc(), StreamQuarantineEvent.id.desc())
        .limit(1)
    ).scalar_one_or_none()


def _events_from_quarantine_row(
    db: Session,
    row: StreamQuarantineEvent,
    *,
    stream_names: dict[int, str],
    stream_policies: dict[int, list[GovernancePolicy]],
) -> list[_InternalAuditEvent]:
    policy_id, policy_name = _policy_context_for_quarantine(db, row, stream_policies=stream_policies)
    stream_id = int(row.stream_id)
    stream_name = stream_names.get(stream_id, f"Stream {stream_id}")
    correlation_id = _correlation_id_for_quarantine(int(row.id))
    reason = _humanize_quarantine_reason(str(row.quarantine_reason), quarantine_source=str(row.quarantine_source))
    events: list[_InternalAuditEvent] = []

    created_summary = _summary_for_event(AUDIT_EVENT_VIOLATION_CREATED, reason=reason)
    events.append(
        _InternalAuditEvent(
            correlation_id=correlation_id,
            event_time=row.created_at,
            event_type=AUDIT_EVENT_VIOLATION_CREATED,
            status=AUDIT_STATUS_OPEN,
            policy_id=policy_id,
            policy_name=policy_name,
            stream_id=stream_id,
            stream_name=stream_name,
            summary=created_summary,
            actor="System",
            quarantine_event_id=int(row.id),
        )
    )
    events.append(
        _InternalAuditEvent(
            correlation_id=correlation_id,
            event_time=row.created_at,
            event_type=AUDIT_EVENT_QUARANTINE_CREATED,
            status=AUDIT_STATUS_QUARANTINED,
            policy_id=policy_id,
            policy_name=policy_name,
            stream_id=stream_id,
            stream_name=stream_name,
            summary=_summary_for_event(AUDIT_EVENT_QUARANTINE_CREATED),
            actor="System",
            quarantine_event_id=int(row.id),
        )
    )

    if str(row.status) == QUARANTINE_STATUS_RELEASED and row.released_at is not None:
        events.append(
            _InternalAuditEvent(
                correlation_id=correlation_id,
                event_time=row.released_at,
                event_type=AUDIT_EVENT_QUARANTINE_RELEASED,
                status=AUDIT_STATUS_RELEASED,
                policy_id=policy_id,
                policy_name=policy_name,
                stream_id=stream_id,
                stream_name=stream_name,
                summary=_summary_for_event(AUDIT_EVENT_QUARANTINE_RELEASED),
                actor=row.released_by or "Operator",
                quarantine_event_id=int(row.id),
            )
        )
    elif str(row.status) == QUARANTINE_STATUS_DISCARDED:
        event_time = row.updated_at or row.created_at
        events.append(
            _InternalAuditEvent(
                correlation_id=correlation_id,
                event_time=event_time,
                event_type=AUDIT_EVENT_QUARANTINE_DISCARDED,
                status=AUDIT_STATUS_DISCARDED,
                policy_id=policy_id,
                policy_name=policy_name,
                stream_id=stream_id,
                stream_name=stream_name,
                summary=_summary_for_event(AUDIT_EVENT_QUARANTINE_DISCARDED),
                actor=row.released_by or "Operator",
                quarantine_event_id=int(row.id),
            )
        )

    return events


def _replay_started_at(row: StreamReplayEvent) -> datetime | None:
    ctx = row.delivery_context_json if isinstance(row.delivery_context_json, dict) else {}
    attempt = ctx.get(DELIVERY_ATTEMPT_CONTEXT_KEY)
    raw = attempt.get("claimed_at") if isinstance(attempt, dict) else None
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                return parsed.replace(tzinfo=timezone.utc)
            return parsed
        except ValueError:
            pass
    if str(row.status) in {REPLAY_STATUS_REPLAYED, REPLAY_STATUS_FAILED}:
        return row.created_at
    return None


def _events_from_replay_row(
    db: Session,
    row: StreamReplayEvent,
    *,
    stream_names: dict[int, str],
    stream_policies: dict[int, list[GovernancePolicy]],
    quarantine_row: StreamQuarantineEvent | None,
) -> list[_InternalAuditEvent]:
    if quarantine_row is None:
        return []

    policy_id, policy_name = _policy_context_for_quarantine(db, quarantine_row, stream_policies=stream_policies)
    stream_id = int(row.stream_id)
    stream_name = stream_names.get(stream_id, f"Stream {stream_id}")
    correlation_id = _correlation_id_for_quarantine(int(quarantine_row.id))
    events: list[_InternalAuditEvent] = []

    started_at = _replay_started_at(row)
    if started_at is not None:
        events.append(
            _InternalAuditEvent(
                correlation_id=correlation_id,
                event_time=started_at,
                event_type=AUDIT_EVENT_REPLAY_STARTED,
                status=AUDIT_STATUS_IN_PROGRESS,
                policy_id=policy_id,
                policy_name=policy_name,
                stream_id=stream_id,
                stream_name=stream_name,
                summary=_summary_for_event(AUDIT_EVENT_REPLAY_STARTED),
                actor=quarantine_row.released_by or "Operator",
                quarantine_event_id=int(quarantine_row.id),
                replay_event_id=int(row.id),
            )
        )

    if str(row.status) == REPLAY_STATUS_REPLAYED and row.last_replay_at is not None:
        events.append(
            _InternalAuditEvent(
                correlation_id=correlation_id,
                event_time=row.last_replay_at,
                event_type=AUDIT_EVENT_REPLAY_COMPLETED,
                status=AUDIT_STATUS_DELIVERED,
                policy_id=policy_id,
                policy_name=policy_name,
                stream_id=stream_id,
                stream_name=stream_name,
                summary=_summary_for_event(AUDIT_EVENT_REPLAY_COMPLETED),
                actor=quarantine_row.released_by or "Operator",
                quarantine_event_id=int(quarantine_row.id),
                replay_event_id=int(row.id),
            )
        )
    elif str(row.status) == REPLAY_STATUS_FAILED:
        event_time = row.updated_at or row.created_at
        events.append(
            _InternalAuditEvent(
                correlation_id=correlation_id,
                event_time=event_time,
                event_type=AUDIT_EVENT_REPLAY_FAILED,
                status=AUDIT_STATUS_FAILED,
                policy_id=policy_id,
                policy_name=policy_name,
                stream_id=stream_id,
                stream_name=stream_name,
                summary=_summary_for_event(AUDIT_EVENT_REPLAY_FAILED),
                actor=quarantine_row.released_by or "Operator",
                quarantine_event_id=int(quarantine_row.id),
                replay_event_id=int(row.id),
            )
        )

    return events


def _events_from_policy_activation(
    row: GovernancePolicy,
    *,
    stream_names: dict[int, str],
    assignment_stream_ids: list[int],
) -> list[_InternalAuditEvent]:
    if row.activated_at is None:
        return []

    correlation_id = _correlation_id_for_policy(int(row.id))
    policy_name = str(row.name)
    events: list[_InternalAuditEvent] = []

    if assignment_stream_ids:
        for stream_id in assignment_stream_ids[:3]:
            events.append(
                _InternalAuditEvent(
                    correlation_id=correlation_id,
                    event_time=row.activated_at,
                    event_type=AUDIT_EVENT_POLICY_ACTIVATED,
                    status=AUDIT_STATUS_ACTIVE,
                    policy_id=int(row.id),
                    policy_name=policy_name,
                    stream_id=int(stream_id),
                    stream_name=stream_names.get(int(stream_id), f"Stream {stream_id}"),
                    summary=_summary_for_event(AUDIT_EVENT_POLICY_ACTIVATED),
                    actor="Operator",
                )
            )
    else:
        events.append(
            _InternalAuditEvent(
                correlation_id=correlation_id,
                event_time=row.activated_at,
                event_type=AUDIT_EVENT_POLICY_ACTIVATED,
                status=AUDIT_STATUS_ACTIVE,
                policy_id=int(row.id),
                policy_name=policy_name,
                stream_id=None,
                stream_name=None,
                summary=_summary_for_event(AUDIT_EVENT_POLICY_ACTIVATED),
                actor="Operator",
            )
        )
    return events


def _events_from_approval_row(row) -> list[_InternalAuditEvent]:
    from app.governance_approval.models import (
        APPROVAL_EVENT_ACTIVATED,
        APPROVAL_EVENT_APPROVED,
        APPROVAL_EVENT_REJECTED,
        APPROVAL_EVENT_REQUEST_CHANGES,
        APPROVAL_EVENT_SUBMITTED,
    )

    type_map = {
        APPROVAL_EVENT_SUBMITTED: AUDIT_EVENT_POLICY_SUBMITTED,
        APPROVAL_EVENT_APPROVED: AUDIT_EVENT_POLICY_APPROVED,
        APPROVAL_EVENT_REJECTED: AUDIT_EVENT_POLICY_REJECTED,
        APPROVAL_EVENT_REQUEST_CHANGES: AUDIT_EVENT_POLICY_REQUEST_CHANGES,
        APPROVAL_EVENT_ACTIVATED: AUDIT_EVENT_POLICY_APPROVAL_ACTIVATED,
    }
    event_type = type_map.get(str(row.event_type))
    if event_type is None:
        return []

    correlation_id = _correlation_id_for_policy(int(row.policy_id))
    summary = _summary_for_event(event_type)
    if row.comment:
        summary = f"{summary}: {row.comment}"

    return [
        _InternalAuditEvent(
            correlation_id=correlation_id,
            event_time=row.created_at,
            event_type=event_type,
            status=_status_for_event_type(event_type),
            policy_id=int(row.policy_id),
            policy_name=f"Policy {row.policy_id}",
            stream_id=None,
            stream_name=None,
            summary=summary,
            actor=row.actor,
        )
    ]


def _collect_approval_audit_events(
    db: Session,
    *,
    since: datetime,
    until: datetime,
    policy_names: dict[int, str],
) -> list[_InternalAuditEvent]:
    from app.governance_approval.service import list_approval_events_for_audit

    rows = list_approval_events_for_audit(db, since=since, until=until)
    events: list[_InternalAuditEvent] = []
    for row in rows:
        for ev in _events_from_approval_row(row):
            if ev.policy_id is not None:
                ev = _InternalAuditEvent(
                    correlation_id=ev.correlation_id,
                    event_time=ev.event_time,
                    event_type=ev.event_type,
                    status=ev.status,
                    policy_id=ev.policy_id,
                    policy_name=policy_names.get(int(ev.policy_id), ev.policy_name),
                    stream_id=ev.stream_id,
                    stream_name=ev.stream_name,
                    summary=ev.summary,
                    actor=ev.actor,
                )
            events.append(ev)
    return events


def _extract_id_from_payload(payload: dict, key: str) -> int | None:
    raw = payload.get(key)
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _events_from_delivery_logs(
    db: Session,
    *,
    since: datetime,
    until: datetime,
    stream_names: dict[int, str],
    stream_policies: dict[int, list[GovernancePolicy]],
    known_keys: set[tuple[str, datetime]],
) -> list[_InternalAuditEvent]:
    stage_map = {
        QUARANTINE_EVENT_CREATED_STAGE: AUDIT_EVENT_QUARANTINE_CREATED,
        QUARANTINE_EVENT_RELEASED_STAGE: AUDIT_EVENT_QUARANTINE_RELEASED,
        QUARANTINE_EVENT_DISCARDED_STAGE: AUDIT_EVENT_QUARANTINE_DISCARDED,
        REPLAY_EVENT_REPLAY_STARTED_STAGE: AUDIT_EVENT_REPLAY_STARTED,
        REPLAY_EVENT_REPLAYED_STAGE: AUDIT_EVENT_REPLAY_COMPLETED,
        REPLAY_EVENT_REPLAY_FAILED_STAGE: AUDIT_EVENT_REPLAY_FAILED,
    }
    rows = list(
        db.execute(
            select(DeliveryLog)
            .where(
                DeliveryLog.created_at >= since,
                DeliveryLog.created_at < until,
                DeliveryLog.stage.in_(tuple(stage_map.keys())),
            )
            .order_by(DeliveryLog.created_at.desc())
            .limit(_MAX_LIMIT * 2)
        )
        .scalars()
    )

    events: list[_InternalAuditEvent] = []
    for log_row in rows:
        event_type = stage_map.get(str(log_row.stage))
        if event_type is None:
            continue
        payload = log_row.payload_sample if isinstance(log_row.payload_sample, dict) else {}
        quarantine_id = _extract_id_from_payload(payload, "quarantine_event_id")
        replay_id = _extract_id_from_payload(payload, "replay_event_id")
        stream_id = int(log_row.stream_id) if log_row.stream_id is not None else _extract_id_from_payload(payload, "stream_id")

        if quarantine_id is not None:
            correlation_id = _correlation_id_for_quarantine(quarantine_id)
            q_row = db.get(StreamQuarantineEvent, int(quarantine_id))
            if q_row is not None:
                policy_id, policy_name = _policy_context_for_quarantine(db, q_row, stream_policies=stream_policies)
                stream_id = int(q_row.stream_id)
            else:
                policy_id, policy_name = None, "Response policy"
        elif replay_id is not None:
            replay_row = db.get(StreamReplayEvent, int(replay_id))
            if replay_row is None:
                continue
            q_row = _find_quarantine_for_replay(db, replay_row)
            if q_row is not None:
                # Quarantine-correlated replay lifecycle is reconstructed from the replay
                # row so it remains on the existing q-* correlation without duplicates.
                continue
            stream_id = int(replay_row.stream_id)
            correlation_id = _correlation_id_for_replay(int(replay_row.id))
            ctx = _resolve_policy_context(
                db,
                stream_id=stream_id,
                stream_policies=stream_policies,
                runtime_policy_names=[],
            )
            policy_id, policy_name = ctx.policy_id, ctx.policy_name
            quarantine_id = None
        else:
            continue

        dedupe_key = (event_type, log_row.created_at)
        if dedupe_key in known_keys:
            continue

        stream_name = stream_names.get(int(stream_id), f"Stream {stream_id}") if stream_id is not None else None
        events.append(
            _InternalAuditEvent(
                correlation_id=correlation_id,
                event_time=log_row.created_at,
                event_type=event_type,
                status=_status_for_event_type(event_type),
                policy_id=policy_id,
                policy_name=policy_name,
                stream_id=int(stream_id) if stream_id is not None else None,
                stream_name=stream_name,
                summary=_summary_for_event(event_type),
                actor="System",
                quarantine_event_id=quarantine_id,
                replay_event_id=replay_id,
            )
        )
    return events


def _internal_to_entry(event: _InternalAuditEvent) -> GovernanceAuditEntry:
    return GovernanceAuditEntry(
        event_time=event.event_time,
        policy_id=event.policy_id,
        policy_name=event.policy_name,
        stream_id=event.stream_id,
        stream_name=event.stream_name,
        event_type=event.event_type,  # type: ignore[arg-type]
        status=event.status,  # type: ignore[arg-type]
        correlation_id=event.correlation_id,
    )


def _matches_filters(
    event: _InternalAuditEvent,
    *,
    policy_id: int | None,
    stream_id: int | None,
    event_type: str | None,
    status: str | None,
) -> bool:
    if policy_id is not None and event.policy_id != int(policy_id):
        return False
    if stream_id is not None and event.stream_id != int(stream_id):
        return False
    if event_type is not None and event.event_type != str(event_type):
        return False
    if status is not None and event.status != str(status):
        return False
    return True


def _collect_audit_events(
    db: Session,
    *,
    since: datetime,
    until: datetime,
    per_source_limit: int = 200,
) -> list[_InternalAuditEvent]:
    row_cap = max(10, min(int(per_source_limit), _MAX_LIMIT * 2))
    quarantine_rows = list(
        db.execute(
            select(StreamQuarantineEvent)
            .where(
                StreamQuarantineEvent.created_at >= since,
                StreamQuarantineEvent.created_at < until,
            )
            .order_by(StreamQuarantineEvent.created_at.desc())
            .limit(row_cap)
        )
        .scalars()
    )

    replay_rows = list(
        db.execute(
            select(StreamReplayEvent)
            .where(
                StreamReplayEvent.created_at >= since,
                StreamReplayEvent.created_at < until,
            )
            .order_by(StreamReplayEvent.created_at.desc())
            .limit(row_cap)
        )
        .scalars()
    )

    policy_rows = list(
        db.execute(
            select(GovernancePolicy)
            .where(
                GovernancePolicy.activated_at.isnot(None),
                GovernancePolicy.activated_at >= since,
                GovernancePolicy.activated_at < until,
            )
            .order_by(GovernancePolicy.activated_at.desc())
        )
        .scalars()
    )

    policy_name_rows = list(db.execute(select(GovernancePolicy.id, GovernancePolicy.name)).all())
    policy_names = {int(row.id): str(row.name) for row in policy_name_rows}

    stream_ids: set[int] = set()
    for row in quarantine_rows:
        stream_ids.add(int(row.stream_id))
    for row in replay_rows:
        stream_ids.add(int(row.stream_id))

    from app.governance_policies.models import StreamPolicyAssignment

    for policy in policy_rows:
        assigned = list(
            db.execute(
                select(StreamPolicyAssignment.stream_id)
                .where(StreamPolicyAssignment.policy_id == policy.id)
                .where(StreamPolicyAssignment.enabled.is_(True))
            ).scalars()
        )
        stream_ids.update(int(sid) for sid in assigned)

    stream_names = _load_stream_names(db, stream_ids)
    stream_policies = _load_stream_policy_map(db, stream_ids)

    events: list[_InternalAuditEvent] = []
    known_keys: set[tuple[str, datetime]] = set()

    for row in quarantine_rows:
        q_events = _events_from_quarantine_row(
            db,
            row,
            stream_names=stream_names,
            stream_policies=stream_policies,
        )
        for ev in q_events:
            known_keys.add((ev.event_type, ev.event_time))
        events.extend(q_events)

    for row in replay_rows:
        q_row = _find_quarantine_for_replay(db, row)
        r_events = _events_from_replay_row(
            db,
            row,
            stream_names=stream_names,
            stream_policies=stream_policies,
            quarantine_row=q_row,
        )
        for ev in r_events:
            known_keys.add((ev.event_type, ev.event_time))
        events.extend(r_events)

    for policy in policy_rows:
        assigned = list(
            db.execute(
                select(StreamPolicyAssignment.stream_id)
                .where(StreamPolicyAssignment.policy_id == policy.id)
                .where(StreamPolicyAssignment.enabled.is_(True))
            ).scalars()
        )
        p_events = _events_from_policy_activation(
            policy,
            stream_names=stream_names,
            assignment_stream_ids=[int(sid) for sid in assigned],
        )
        for ev in p_events:
            known_keys.add((ev.event_type, ev.event_time))
        events.extend(p_events)

    events.extend(
        _events_from_delivery_logs(
            db,
            since=since,
            until=until,
            stream_names=stream_names,
            stream_policies=stream_policies,
            known_keys=known_keys,
        )
    )

    for ev in _collect_approval_audit_events(db, since=since, until=until, policy_names=policy_names):
        dedupe_key = (ev.event_type, ev.event_time)
        if dedupe_key not in known_keys:
            known_keys.add(dedupe_key)
            events.append(ev)

    return events


def list_governance_audit_events(
    db: Session,
    *,
    window: str = AUDIT_WINDOW_24H,
    policy_id: int | None = None,
    stream_id: int | None = None,
    event_type: str | None = None,
    status: str | None = None,
    limit: int = _DEFAULT_LIMIT,
    per_source_limit: int | None = None,
) -> list[GovernanceAuditEntry]:
    since, until = _window_bounds(window)
    lim = max(1, min(int(limit), _MAX_LIMIT))
    if per_source_limit is not None:
        per_source = max(10, min(int(per_source_limit), _MAX_LIMIT * 2))
    else:
        per_source = max(50, min(_MAX_LIMIT * 2, lim * 20))

    events = _collect_audit_events(db, since=since, until=until, per_source_limit=per_source)
    filtered: list[_InternalAuditEvent] = []
    for event in sorted(events, key=lambda item: item.event_time, reverse=True):
        if _matches_filters(
            event,
            policy_id=policy_id,
            stream_id=stream_id,
            event_type=event_type,
            status=status,
        ):
            filtered.append(event)
        if len(filtered) >= lim:
            break
    return [_internal_to_entry(event) for event in filtered]


def list_governance_dashboard_recent_activity(
    db: Session,
    *,
    window: str = AUDIT_WINDOW_30D,
    limit: int = 10,
) -> list[GovernanceAuditEntry]:
    """Bounded recent activity for executive dashboard (no delivery_logs scan)."""

    since, until = _window_bounds(window)
    lim = max(1, min(int(limit), 10))
    per_source = max(lim, 12)
    quarantine_rows = list(
        db.execute(
            select(StreamQuarantineEvent)
            .where(
                StreamQuarantineEvent.created_at >= since,
                StreamQuarantineEvent.created_at < until,
            )
            .order_by(StreamQuarantineEvent.created_at.desc())
            .limit(per_source)
        ).scalars()
    )
    replay_rows = list(
        db.execute(
            select(StreamReplayEvent)
            .where(
                StreamReplayEvent.created_at >= since,
                StreamReplayEvent.created_at < until,
            )
            .order_by(StreamReplayEvent.created_at.desc())
            .limit(per_source)
        ).scalars()
    )
    stream_ids: set[int] = set()
    for row in quarantine_rows:
        stream_ids.add(int(row.stream_id))
    for row in replay_rows:
        stream_ids.add(int(row.stream_id))
    stream_names = _load_stream_names(db, stream_ids)
    stream_policies = _load_stream_policy_map(db, stream_ids)
    events: list[_InternalAuditEvent] = []
    for row in quarantine_rows:
        events.extend(
            _events_from_quarantine_row(
                db,
                row,
                stream_names=stream_names,
                stream_policies=stream_policies,
            )
        )
    for row in replay_rows:
        q_row = _find_quarantine_for_replay(db, row)
        events.extend(
            _events_from_replay_row(
                db,
                row,
                stream_names=stream_names,
                stream_policies=stream_policies,
                quarantine_row=q_row,
            )
        )
    policy_names = {
        int(row.id): str(row.name)
        for row in db.execute(select(GovernancePolicy.id, GovernancePolicy.name)).all()
    }
    events.extend(_collect_approval_audit_events(db, since=since, until=until, policy_names=policy_names))
    filtered = sorted(events, key=lambda item: item.event_time, reverse=True)[:lim]
    return [_internal_to_entry(event) for event in filtered]


def _derive_current_status(events: list[_InternalAuditEvent]) -> str:
    priority = [
        AUDIT_STATUS_FAILED,
        AUDIT_STATUS_DELIVERED,
        AUDIT_STATUS_DISCARDED,
        AUDIT_STATUS_IN_PROGRESS,
        AUDIT_STATUS_RELEASED,
        AUDIT_STATUS_QUARANTINED,
        AUDIT_STATUS_OPEN,
        AUDIT_STATUS_ACTIVE,
    ]
    present = {ev.status for ev in events}
    for status in priority:
        if status in present:
            return status
    return AUDIT_STATUS_OPEN


def _derive_outcome(events: list[_InternalAuditEvent]) -> str | None:
    types = {ev.event_type for ev in events}
    if AUDIT_EVENT_REPLAY_COMPLETED in types:
        return AUDIT_OUTCOME_DELIVERED
    if AUDIT_EVENT_QUARANTINE_DISCARDED in types:
        return AUDIT_OUTCOME_DISCARDED
    if AUDIT_EVENT_REPLAY_FAILED in types:
        return AUDIT_OUTCOME_FAILED
    return None


def _build_timeline(events: list[_InternalAuditEvent]) -> list[GovernanceAuditTimelineStep]:
    sorted_events = sorted(events, key=lambda item: item.event_time)
    return [
        GovernanceAuditTimelineStep(
            event_time=ev.event_time,
            event_type=ev.event_type,  # type: ignore[arg-type]
            summary=ev.summary,
            actor=ev.actor,
        )
        for ev in sorted_events
    ]


def get_governance_audit_detail(
    db: Session,
    correlation_id: str,
    *,
    window: str = AUDIT_WINDOW_30D,
) -> GovernanceAuditDetailResponse:
    kind, resource_id = _parse_correlation_id(correlation_id)
    if kind == "unknown" or resource_id is None:
        raise GovernanceAuditNotFoundError(correlation_id)

    since, until = _window_bounds(window)

    if kind == "quarantine":
        q_row = db.get(StreamQuarantineEvent, int(resource_id))
        if q_row is None:
            raise GovernanceAuditNotFoundError(correlation_id)

        stream_ids = {int(q_row.stream_id)}
        stream_names = _load_stream_names(db, stream_ids)
        stream_policies = _load_stream_policy_map(db, stream_ids)
        replayed_streams = _load_replayed_stream_ids(db, stream_ids=stream_ids, since=since, until=until)

        events = _events_from_quarantine_row(
            db,
            q_row,
            stream_names=stream_names,
            stream_policies=stream_policies,
        )

        replay_rows = list(
            db.execute(
                select(StreamReplayEvent)
                .where(
                    StreamReplayEvent.stream_id == int(q_row.stream_id),
                    StreamReplayEvent.created_at >= q_row.created_at,
                    StreamReplayEvent.created_at < until,
                )
                .order_by(StreamReplayEvent.created_at.asc())
            )
            .scalars()
        )
        for replay_row in replay_rows:
            events.extend(
                _events_from_replay_row(
                    db,
                    replay_row,
                    stream_names=stream_names,
                    stream_policies=stream_policies,
                    quarantine_row=q_row,
                )
            )

        policy_id, policy_name = _policy_context_for_quarantine(db, q_row, stream_policies=stream_policies)
        stream_id = int(q_row.stream_id)
        stream_name = stream_names.get(stream_id, f"Stream {stream_id}")

        violation_status = _derive_violation_status(
            db,
            quarantine_status=str(q_row.status),
            stream_id=stream_id,
            event_time=q_row.created_at,
            until=until,
            replayed_streams=replayed_streams,
        )
        related_violation = GovernanceAuditViolationRef(
            violation_id=_violation_id_for_quarantine(int(q_row.id)),
            status=violation_status,
            reason=_humanize_quarantine_reason(
                str(q_row.quarantine_reason),
                quarantine_source=str(q_row.quarantine_source),
            ),
        )
        related_quarantine = GovernanceAuditQuarantineRef(
            quarantine_event_id=int(q_row.id),
            status=str(q_row.status),
        )

        related_replay: GovernanceAuditReplayRef | None = None
        if replay_rows:
            best = replay_rows[-1]
            related_replay = GovernanceAuditReplayRef(
                replay_event_id=int(best.id),
                status=str(best.status),
                event_count=int(best.event_count or 0),
            )

        if policy_id is not None:
            policy_row = db.get(GovernancePolicy, int(policy_id))
            if policy_row is not None and policy_row.activated_at is not None and policy_row.activated_at <= q_row.created_at:
                events.insert(
                    0,
                    _InternalAuditEvent(
                        correlation_id=correlation_id,
                        event_time=policy_row.activated_at,
                        event_type=AUDIT_EVENT_POLICY_ACTIVATED,
                        status=AUDIT_STATUS_ACTIVE,
                        policy_id=int(policy_id),
                        policy_name=policy_name,
                        stream_id=stream_id,
                        stream_name=stream_name,
                        summary=_summary_for_event(AUDIT_EVENT_POLICY_ACTIVATED),
                        actor="Operator",
                    ),
                )

        current_status = _derive_current_status(events)
        return GovernanceAuditDetailResponse(
            correlation_id=correlation_id,
            policy_id=policy_id,
            policy_name=policy_name,
            stream_id=stream_id,
            stream_name=stream_name,
            current_status=current_status,  # type: ignore[arg-type]
            outcome=_derive_outcome(events),  # type: ignore[arg-type]
            timeline=_build_timeline(events),
            related_violation=related_violation,
            related_quarantine=related_quarantine,
            related_replay=related_replay,
        )

    if kind == "replay":
        replay_row = db.get(StreamReplayEvent, int(resource_id))
        if replay_row is None:
            raise GovernanceAuditNotFoundError(correlation_id)

        quarantine_row = _find_quarantine_for_replay(db, replay_row)
        if quarantine_row is not None:
            return get_governance_audit_detail(
                db,
                _correlation_id_for_quarantine(int(quarantine_row.id)),
                window=window,
            )

        stream_id = int(replay_row.stream_id)
        stream_ids = {stream_id}
        stream_names = _load_stream_names(db, stream_ids)
        stream_policies = _load_stream_policy_map(db, stream_ids)
        ctx = _resolve_policy_context(
            db,
            stream_id=stream_id,
            stream_policies=stream_policies,
            runtime_policy_names=[],
        )
        policy_id, policy_name = ctx.policy_id, ctx.policy_name
        stream_name = stream_names.get(stream_id, f"Stream {stream_id}")
        events = [
            event
            for event in _events_from_delivery_logs(
                db,
                since=since,
                until=until,
                stream_names=stream_names,
                stream_policies=stream_policies,
                known_keys=set(),
            )
            if event.replay_event_id == int(replay_row.id)
            and event.correlation_id == correlation_id
        ]
        related_replay = GovernanceAuditReplayRef(
            replay_event_id=int(replay_row.id),
            status=str(replay_row.status),
            event_count=int(replay_row.event_count or 0),
        )
        return GovernanceAuditDetailResponse(
            correlation_id=correlation_id,
            policy_id=policy_id,
            policy_name=policy_name,
            stream_id=stream_id,
            stream_name=stream_name,
            current_status=(
                _derive_current_status(events) if events else AUDIT_STATUS_OPEN
            ),  # type: ignore[arg-type]
            outcome=_derive_outcome(events) if events else None,  # type: ignore[arg-type]
            timeline=_build_timeline(events),
            related_violation=None,
            related_quarantine=None,
            related_replay=related_replay,
        )

    policy_row = db.get(GovernancePolicy, int(resource_id))
    if policy_row is None or policy_row.activated_at is None:
        raise GovernanceAuditNotFoundError(correlation_id)

    from app.governance_policies.models import StreamPolicyAssignment

    assigned = list(
        db.execute(
            select(StreamPolicyAssignment.stream_id)
            .where(StreamPolicyAssignment.policy_id == policy_row.id)
            .where(StreamPolicyAssignment.enabled.is_(True))
        ).scalars()
    )
    stream_ids = {int(sid) for sid in assigned}
    stream_names = _load_stream_names(db, stream_ids)
    events = _events_from_policy_activation(
        policy_row,
        stream_names=stream_names,
        assignment_stream_ids=[int(sid) for sid in assigned],
    )
    if not events:
        raise GovernanceAuditNotFoundError(correlation_id)

    first = events[0]
    return GovernanceAuditDetailResponse(
        correlation_id=correlation_id,
        policy_id=int(policy_row.id),
        policy_name=str(policy_row.name),
        stream_id=first.stream_id,
        stream_name=first.stream_name,
        current_status=AUDIT_STATUS_ACTIVE,  # type: ignore[arg-type]
        outcome=None,
        timeline=_build_timeline(events),
        related_violation=None,
        related_quarantine=None,
        related_replay=None,
    )
