"""Build policy-centric violation feed from quarantine, replay, and delivery log sources."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.governance_policies.models import (
    POLICY_STATUS_ACTIVE,
    GovernancePolicy,
    StreamPolicyAssignment,
)
from app.governance_policies.service import build_policy_preview
from app.governance_violations.models import (
    VIOLATION_SEVERITY_HIGH,
    VIOLATION_SEVERITY_LOW,
    VIOLATION_SEVERITY_MEDIUM,
    VIOLATION_STATUS_DISCARDED,
    VIOLATION_STATUS_OPEN,
    VIOLATION_STATUS_QUARANTINED,
    VIOLATION_STATUS_RELEASED,
    VIOLATION_STATUS_REPLAYED,
    VIOLATION_WINDOW_24H,
    VIOLATION_WINDOW_7D,
    VIOLATION_WINDOW_30D,
)
from app.governance_violations.schemas import (
    GovernanceViolationDetailResponse,
    GovernanceViolationEntry,
    GovernanceViolationPolicySummary,
    GovernanceViolationQuarantineRef,
    GovernanceViolationReplayRef,
)
from app.quarantine.models import (
    QUARANTINE_SOURCE_POLICY,
    QUARANTINE_STATUS_DISCARDED,
    QUARANTINE_STATUS_QUARANTINED,
    QUARANTINE_STATUS_RELEASED,
    StreamQuarantineEvent,
)
from app.replay.metrics import REPLAY_EVENT_REPLAYED_STAGE
from app.replay.models import REPLAY_STATUS_REPLAYED, StreamReplayEvent
from app.streams.models import Stream

_DEFAULT_LIMIT = 100
_MAX_LIMIT = 200


class GovernanceViolationNotFoundError(Exception):
    def __init__(self, violation_id: str) -> None:
        self.violation_id = violation_id
        super().__init__(f"governance violation not found: {violation_id}")


@dataclass(frozen=True)
class _PolicyContext:
    policy_id: int | None
    policy_name: str
    policy_status: str | None
    policy_version: int | None
    rule_summary: str | None


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _window_bounds(window: str, *, until: datetime | None = None) -> tuple[datetime, datetime]:
    end = until or _utc_now()
    if window == VIOLATION_WINDOW_7D:
        return end - timedelta(days=7), end
    if window == VIOLATION_WINDOW_30D:
        return end - timedelta(days=30), end
    return end - timedelta(hours=24), end


def _violation_id_for_quarantine(quarantine_event_id: int) -> str:
    return f"q-{int(quarantine_event_id)}"


def _parse_quarantine_violation_id(violation_id: str) -> int | None:
    raw = str(violation_id).strip()
    if not raw.startswith("q-"):
        return None
    try:
        return int(raw[2:])
    except ValueError:
        return None


def _schema_drift_runtime_policy_label(name: str) -> str | None:
    raw = str(name or "").strip()
    if not raw.startswith("schema_drift:"):
        return None
    tail = raw.split(":", 1)[-1].strip().replace("_", " ")
    if tail == "unknown normal":
        return "Schema Drift Policy — Unknown Normal Field"
    if tail == "unknown sensitive":
        return "Schema Drift Policy — Unknown Sensitive Field"
    return f"Schema Drift Policy — {tail.title()}"


def _humanize_quarantine_reason(reason: str, *, quarantine_source: str | None = None) -> str:
    if str(quarantine_source or "").strip() == "manual":
        return "Manual Quarantine"
    text = str(reason or "").strip()
    if text.startswith("policy:schema_drift:"):
        label = _schema_drift_runtime_policy_label(text[len("policy:") :])
        if label:
            return label
    if text.startswith("policy:"):
        names = text[7:].split(",")
        if names and names[0]:
            first = str(names[0])
            drift_label = _schema_drift_runtime_policy_label(first)
            if drift_label:
                return drift_label
            return f"Policy Rule — {first}"
    if text:
        return text
    return "Policy response triggered quarantine"


def _load_stream_names(db: Session, stream_ids: set[int]) -> dict[int, str]:
    if not stream_ids:
        return {}
    rows = db.execute(select(Stream.id, Stream.name).where(Stream.id.in_(stream_ids))).all()
    return {int(rid): str(name) for rid, name in rows}


def _load_stream_policy_map(db: Session, stream_ids: set[int]) -> dict[int, list[GovernancePolicy]]:
    if not stream_ids:
        return {}
    rows = (
        db.execute(
            select(GovernancePolicy, StreamPolicyAssignment.stream_id)
            .join(StreamPolicyAssignment, StreamPolicyAssignment.policy_id == GovernancePolicy.id)
            .where(
                StreamPolicyAssignment.stream_id.in_(stream_ids),
                StreamPolicyAssignment.enabled.is_(True),
            )
            .order_by(
                StreamPolicyAssignment.stream_id.asc(),
                GovernancePolicy.status.desc(),
                GovernancePolicy.updated_at.desc(),
            )
        )
        .all()
    )
    out: dict[int, list[GovernancePolicy]] = {}
    for policy, stream_id in rows:
        sid = int(stream_id)
        out.setdefault(sid, []).append(policy)
    return out


def _resolve_policy_context(
    db: Session,
    *,
    stream_id: int,
    stream_policies: dict[int, list[GovernancePolicy]],
    runtime_policy_names: list[str],
) -> _PolicyContext:
    candidates = stream_policies.get(int(stream_id), [])
    for runtime_name in runtime_policy_names:
        drift_label = _schema_drift_runtime_policy_label(str(runtime_name))
        if drift_label:
            return _PolicyContext(
                policy_id=None,
                policy_name=drift_label,
                policy_status=None,
                policy_version=None,
                rule_summary="Stream Wizard schema drift policy",
            )
    if runtime_policy_names:
        lowered = {n.lower() for n in runtime_policy_names if n}
        for policy in candidates:
            if policy.name.lower() in lowered:
                preview = build_policy_preview(policy.policy_json)
                return _PolicyContext(
                    policy_id=int(policy.id),
                    policy_name=str(policy.name),
                    policy_status=str(policy.status),
                    policy_version=int(policy.version),
                    rule_summary=str(preview.get("summary") or ""),
                )
    for policy in candidates:
        if policy.status == POLICY_STATUS_ACTIVE:
            preview = build_policy_preview(policy.policy_json)
            return _PolicyContext(
                policy_id=int(policy.id),
                policy_name=str(policy.name),
                policy_status=str(policy.status),
                policy_version=int(policy.version),
                rule_summary=str(preview.get("summary") or ""),
            )
    if candidates:
        policy = candidates[0]
        preview = build_policy_preview(policy.policy_json)
        return _PolicyContext(
            policy_id=int(policy.id),
            policy_name=str(policy.name),
            policy_status=str(policy.status),
            policy_version=int(policy.version),
            rule_summary=str(preview.get("summary") or ""),
        )
    if runtime_policy_names:
        name = runtime_policy_names[0]
        return _PolicyContext(
            policy_id=None,
            policy_name=str(name),
            policy_status=None,
            policy_version=None,
            rule_summary=None,
        )
    return _PolicyContext(
        policy_id=None,
        policy_name="Response policy",
        policy_status=None,
        policy_version=None,
        rule_summary=None,
    )


def _load_replayed_stream_ids(
    db: Session,
    *,
    stream_ids: set[int],
    since: datetime,
    until: datetime,
) -> set[int]:
    if not stream_ids:
        return set()
    replay_rows = db.execute(
        select(StreamReplayEvent.stream_id)
        .where(
            StreamReplayEvent.stream_id.in_(stream_ids),
            StreamReplayEvent.status == REPLAY_STATUS_REPLAYED,
            StreamReplayEvent.last_replay_at.isnot(None),
            StreamReplayEvent.last_replay_at >= since,
            StreamReplayEvent.last_replay_at < until,
        )
        .distinct()
    ).all()
    return {int(row[0]) for row in replay_rows}


def _stream_has_replay_after(
    db: Session,
    *,
    stream_id: int,
    after: datetime,
    until: datetime,
) -> bool:
    replay_row = db.execute(
        select(StreamReplayEvent.id)
        .where(
            StreamReplayEvent.stream_id == int(stream_id),
            StreamReplayEvent.status == REPLAY_STATUS_REPLAYED,
            StreamReplayEvent.last_replay_at.isnot(None),
            StreamReplayEvent.last_replay_at >= after,
            StreamReplayEvent.last_replay_at < until,
        )
        .limit(1)
    ).scalar_one_or_none()
    if replay_row is not None:
        return True
    from app.logs.models import DeliveryLog

    log_row = db.execute(
        select(DeliveryLog.id)
        .where(
            DeliveryLog.stream_id == int(stream_id),
            DeliveryLog.stage == REPLAY_EVENT_REPLAYED_STAGE,
            DeliveryLog.created_at >= after,
            DeliveryLog.created_at < until,
        )
        .limit(1)
    ).scalar_one_or_none()
    return log_row is not None


def _derive_violation_status(
    db: Session,
    *,
    quarantine_status: str,
    stream_id: int,
    event_time: datetime,
    until: datetime,
    replayed_streams: set[int],
) -> str:
    if quarantine_status == QUARANTINE_STATUS_QUARANTINED:
        return VIOLATION_STATUS_QUARANTINED
    if quarantine_status == QUARANTINE_STATUS_DISCARDED:
        # A discarded event is resolved; it must not keep counting as an open violation (F-181).
        return VIOLATION_STATUS_DISCARDED
    if int(stream_id) in replayed_streams or _stream_has_replay_after(
        db,
        stream_id=int(stream_id),
        after=event_time,
        until=until,
    ):
        return VIOLATION_STATUS_REPLAYED
    if quarantine_status == QUARANTINE_STATUS_RELEASED:
        return VIOLATION_STATUS_RELEASED
    return VIOLATION_STATUS_OPEN


def _derive_severity(*, quarantine_source: str, quarantine_status: str) -> str:
    if quarantine_source == QUARANTINE_SOURCE_POLICY:
        return VIOLATION_SEVERITY_HIGH
    if quarantine_status == QUARANTINE_STATUS_DISCARDED:
        return VIOLATION_SEVERITY_LOW
    return VIOLATION_SEVERITY_MEDIUM


def _severity_case_expr():
    return case(
        (StreamQuarantineEvent.quarantine_source == QUARANTINE_SOURCE_POLICY, VIOLATION_SEVERITY_HIGH),
        (StreamQuarantineEvent.status == QUARANTINE_STATUS_DISCARDED, VIOLATION_SEVERITY_LOW),
        else_=VIOLATION_SEVERITY_MEDIUM,
    )


def count_open_violations_by_severity(db: Session) -> dict[str, int]:
    """Bounded SQL counts for executive dashboard risk distribution (no violation feed build)."""

    counts = {VIOLATION_SEVERITY_LOW: 0, VIOLATION_SEVERITY_MEDIUM: 0, VIOLATION_SEVERITY_HIGH: 0}
    rows = db.execute(
        select(_severity_case_expr(), func.count())
        .select_from(StreamQuarantineEvent)
        .where(StreamQuarantineEvent.status == QUARANTINE_STATUS_QUARANTINED)
        .group_by(_severity_case_expr())
    ).all()
    for severity, count in rows:
        key = str(severity or VIOLATION_SEVERITY_MEDIUM).upper()
        if key in counts:
            counts[key] = int(count or 0)
    return counts


def count_quarantine_violations_in_window(
    db: Session,
    *,
    since: datetime,
    until: datetime,
) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(StreamQuarantineEvent)
            .where(
                StreamQuarantineEvent.created_at >= since,
                StreamQuarantineEvent.created_at < until,
            )
        )
        or 0
    )


def _quarantine_row_to_entry(
    db: Session,
    row: StreamQuarantineEvent,
    *,
    stream_names: dict[int, str],
    stream_policies: dict[int, list[GovernancePolicy]],
    replayed_streams: set[int],
    until: datetime,
) -> GovernanceViolationEntry:
    meta = row.metadata_json if isinstance(row.metadata_json, dict) else {}
    runtime_names = [str(n) for n in (meta.get("policy_names") or []) if n]
    ctx = _resolve_policy_context(
        db,
        stream_id=int(row.stream_id),
        stream_policies=stream_policies,
        runtime_policy_names=runtime_names,
    )
    event_time = row.created_at
    status = _derive_violation_status(
        db,
        quarantine_status=str(row.status),
        stream_id=int(row.stream_id),
        event_time=event_time,
        until=until,
        replayed_streams=replayed_streams,
    )
    return GovernanceViolationEntry(
        id=_violation_id_for_quarantine(int(row.id)),
        policy_id=ctx.policy_id,
        policy_name=ctx.policy_name,
        stream_id=int(row.stream_id),
        stream_name=stream_names.get(int(row.stream_id), f"Stream {row.stream_id}"),
        event_time=event_time,
        severity=_derive_severity(quarantine_source=str(row.quarantine_source), quarantine_status=str(row.status)),
        reason=_humanize_quarantine_reason(str(row.quarantine_reason), quarantine_source=str(row.quarantine_source)),
        status=status,
        quarantine_event_id=int(row.id),
    )


def _matches_filters(
    entry: GovernanceViolationEntry,
    *,
    policy_id: int | None,
    stream_id: int | None,
    severity: str | None,
    status: str | None,
) -> bool:
    if policy_id is not None and entry.policy_id != int(policy_id):
        return False
    if stream_id is not None and entry.stream_id != int(stream_id):
        return False
    if severity is not None and entry.severity != str(severity):
        return False
    if status is not None and entry.status != str(status):
        return False
    return True


def list_governance_violations(
    db: Session,
    *,
    window: str = VIOLATION_WINDOW_24H,
    policy_id: int | None = None,
    stream_id: int | None = None,
    severity: str | None = None,
    status: str | None = None,
    limit: int = _DEFAULT_LIMIT,
) -> list[GovernanceViolationEntry]:
    since, until = _window_bounds(window)
    lim = max(1, min(int(limit), _MAX_LIMIT))

    stmt = (
        select(StreamQuarantineEvent)
        .where(
            StreamQuarantineEvent.created_at >= since,
            StreamQuarantineEvent.created_at < until,
        )
        .order_by(StreamQuarantineEvent.created_at.desc(), StreamQuarantineEvent.id.desc())
    )
    if stream_id is not None:
        stmt = stmt.where(StreamQuarantineEvent.stream_id == int(stream_id))

    rows = list(db.execute(stmt.limit(lim * 3)).scalars())
    if not rows:
        return []

    stream_ids = {int(r.stream_id) for r in rows}
    stream_names = _load_stream_names(db, stream_ids)
    stream_policies = _load_stream_policy_map(db, stream_ids)
    replayed_streams = _load_replayed_stream_ids(db, stream_ids=stream_ids, since=since, until=until)

    entries: list[GovernanceViolationEntry] = []
    for row in rows:
        entry = _quarantine_row_to_entry(
            db,
            row,
            stream_names=stream_names,
            stream_policies=stream_policies,
            replayed_streams=replayed_streams,
            until=until,
        )
        if _matches_filters(
            entry,
            policy_id=policy_id,
            stream_id=stream_id,
            severity=severity,
            status=status,
        ):
            entries.append(entry)
        if len(entries) >= lim:
            break
    return entries


def _related_replays_for_stream(
    db: Session,
    *,
    stream_id: int,
    after: datetime,
    until: datetime,
    limit: int = 5,
) -> list[GovernanceViolationReplayRef]:
    rows = list(
        db.execute(
            select(StreamReplayEvent)
            .where(
                StreamReplayEvent.stream_id == int(stream_id),
                StreamReplayEvent.created_at >= after,
                StreamReplayEvent.created_at < until,
            )
            .order_by(StreamReplayEvent.last_replay_at.desc().nullslast(), StreamReplayEvent.id.desc())
            .limit(limit)
        )
        .scalars()
    )
    return [
        GovernanceViolationReplayRef(
            replay_event_id=int(row.id),
            status=str(row.status),
            event_count=int(row.event_count or 0),
            last_replay_at=row.last_replay_at,
        )
        for row in rows
    ]


def get_governance_violation_detail(
    db: Session,
    violation_id: str,
    *,
    window: str = VIOLATION_WINDOW_30D,
) -> GovernanceViolationDetailResponse:
    quarantine_id = _parse_quarantine_violation_id(violation_id)
    if quarantine_id is None:
        raise GovernanceViolationNotFoundError(violation_id)

    row = db.get(StreamQuarantineEvent, int(quarantine_id))
    if row is None:
        raise GovernanceViolationNotFoundError(violation_id)

    since, until = _window_bounds(window)
    stream_ids = {int(row.stream_id)}
    stream_names = _load_stream_names(db, stream_ids)
    stream_policies = _load_stream_policy_map(db, stream_ids)
    replayed_streams = _load_replayed_stream_ids(db, stream_ids=stream_ids, since=since, until=until)

    entry = _quarantine_row_to_entry(
        db,
        row,
        stream_names=stream_names,
        stream_policies=stream_policies,
        replayed_streams=replayed_streams,
        until=until,
    )

    meta = row.metadata_json if isinstance(row.metadata_json, dict) else {}
    runtime_names = [str(n) for n in (meta.get("policy_names") or []) if n]
    ctx = _resolve_policy_context(
        db,
        stream_id=int(row.stream_id),
        stream_policies=stream_policies,
        runtime_policy_names=runtime_names,
    )

    policy_summary = GovernanceViolationPolicySummary(
        policy_id=ctx.policy_id,
        policy_name=ctx.policy_name,
        policy_status=ctx.policy_status,
        policy_version=ctx.policy_version,
        rule_summary=ctx.rule_summary,
    )

    related_quarantine = GovernanceViolationQuarantineRef(
        quarantine_event_id=int(row.id),
        status=str(row.status),
        quarantine_reason=str(row.quarantine_reason),
        created_at=row.created_at,
        released_at=row.released_at,
    )

    related_replays = _related_replays_for_stream(
        db,
        stream_id=int(row.stream_id),
        after=row.created_at,
        until=until,
    )

    return GovernanceViolationDetailResponse(
        violation=entry,
        policy_summary=policy_summary,
        related_quarantine=related_quarantine,
        related_replays=related_replays,
    )


def record_quarantine_governance_notifications(db: Session, row: StreamQuarantineEvent) -> None:
    """Record violation and quarantine notifications for a newly created quarantine event."""

    from app.governance_notifications.models import (
        EVENT_HIGH_SEVERITY_VIOLATION,
        EVENT_QUARANTINE_CREATED,
        EVENT_VIOLATION_CREATED,
    )
    from app.governance_notifications.service import NotificationService

    severity = _derive_severity(
        quarantine_source=str(row.quarantine_source),
        quarantine_status=str(row.status),
    )
    payload = {
        "quarantine_event_id": int(row.id),
        "stream_id": int(row.stream_id),
        "quarantine_reason": str(row.quarantine_reason),
    }
    NotificationService.record_event(
        db,
        event_type=EVENT_VIOLATION_CREATED,
        severity=severity,
        payload=payload,
    )
    if severity == VIOLATION_SEVERITY_HIGH:
        NotificationService.record_event(
            db,
            event_type=EVENT_HIGH_SEVERITY_VIOLATION,
            severity=severity,
            payload=payload,
        )
    NotificationService.record_event(
        db,
        event_type=EVENT_QUARANTINE_CREATED,
        severity=severity,
        payload=payload,
    )
    NotificationService.dispatch_pending(db)
