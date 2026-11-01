"""Governance Operations Center aggregates from existing governance data (M19.6)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.governance_approval.models import GovernancePolicyApprovalEvent
from app.governance_approval.service import _derive_approval_status
from app.governance_audit.service import list_governance_audit_events
from app.governance_operations.schemas import (
    ACTIVITY_LIMIT_DEFAULT,
    ACTIVITY_LIMIT_MAX,
    QUEUE_ITEM_LIMIT,
    GovernanceOperationsActionRequiredItem,
    GovernanceOperationsActivityEntry,
    GovernanceOperationsActivityResponse,
    GovernanceOperationsApprovalQueueItem,
    GovernanceOperationsAttentionItem,
    GovernanceOperationsAttentionResponse,
    GovernanceOperationsNotificationQueueItem,
    GovernanceOperationsQueueResponse,
    GovernanceOperationsQuarantineQueueItem,
    GovernanceOperationsReplayQueueItem,
    GovernanceOperationsSummaryResponse,
    GovernanceOperationsViolationQueueItem,
)
from app.governance_policies.models import (
    POLICY_STATUS_ACTIVE,
    POLICY_STATUS_RETIRED,
    POLICY_STATUS_REVIEW,
    GovernancePolicy,
)
from app.governance_violations.models import VIOLATION_SEVERITY_HIGH
from app.governance_violations.service import list_governance_violations
from app.quarantine.models import (
    QUARANTINE_STATUS_QUARANTINED,
    StreamQuarantineEvent,
)
from app.replay.models import REPLAY_STATUS_FAILED, REPLAY_STATUS_PENDING, StreamReplayEvent

_ACTIVITY_LABELS: dict[str, str] = {
    "SUBMITTED_FOR_REVIEW": "Policy submitted for review",
    "APPROVED": "Policy approved",
    "REJECTED": "Policy rejected",
    "REQUEST_CHANGES": "Changes requested",
    "ACTIVATED": "Policy activated",
    "APPROVAL_ACTIVATED": "Policy activated via approval",
    "POLICY_ACTIVATED": "Policy activated",
    "VIOLATION_CREATED": "Violation created",
    "QUARANTINE_CREATED": "Quarantined",
    "QUARANTINE_RELEASED": "Quarantine released",
    "QUARANTINE_DISCARDED": "Quarantine discarded",
    "REPLAY_STARTED": "Replay started",
    "REPLAY_COMPLETED": "Replay completed",
    "REPLAY_FAILED": "Replay failed",
}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _count_policies_by_status(db: Session) -> dict[str, int]:
    rows = db.execute(
        select(GovernancePolicy.status, func.count())
        .group_by(GovernancePolicy.status)
    ).all()
    return {str(status): int(count) for status, count in rows}


def _count_pending_approvals(db: Session) -> int:
    review_policies = list(
        db.execute(
            select(GovernancePolicy).where(GovernancePolicy.status == POLICY_STATUS_REVIEW)
        ).scalars()
    )
    if not review_policies:
        return 0

    policy_ids = [int(p.id) for p in review_policies]
    event_rows = list(
        db.execute(
            select(GovernancePolicyApprovalEvent)
            .where(GovernancePolicyApprovalEvent.policy_id.in_(policy_ids))
            .order_by(
                GovernancePolicyApprovalEvent.policy_id.asc(),
                GovernancePolicyApprovalEvent.created_at.asc(),
                GovernancePolicyApprovalEvent.id.asc(),
            )
        ).scalars()
    )

    events_by_policy: dict[int, list[GovernancePolicyApprovalEvent]] = {}
    for ev in event_rows:
        events_by_policy.setdefault(int(ev.policy_id), []).append(ev)

    pending = 0
    for policy in review_policies:
        events = events_by_policy.get(int(policy.id), [])
        if _derive_approval_status(policy.status, events) == "PENDING_REVIEW":
            pending += 1
    return pending


def _count_open_violations(db: Session) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(StreamQuarantineEvent)
            .where(StreamQuarantineEvent.status == QUARANTINE_STATUS_QUARANTINED)
        )
        or 0
    )


def _count_quarantined_events(db: Session) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(StreamQuarantineEvent)
            .where(StreamQuarantineEvent.status == QUARANTINE_STATUS_QUARANTINED)
        )
        or 0
    )


def _count_failed_replays(db: Session) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(StreamReplayEvent)
            .where(StreamReplayEvent.status == REPLAY_STATUS_FAILED)
        )
        or 0
    )


def _count_pending_replays(db: Session) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(StreamReplayEvent)
            .where(StreamReplayEvent.status == REPLAY_STATUS_PENDING)
        )
        or 0
    )


def _count_high_severity_violations_24h(db: Session) -> int:
    violations = list_governance_violations(
        db,
        window="24h",
        severity=VIOLATION_SEVERITY_HIGH,
        limit=200,
    )
    return len(violations)


def _count_quarantined_events_24h(db: Session, *, since: datetime, until: datetime) -> int:
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


def _count_replay_failures_24h(db: Session, *, since: datetime, until: datetime) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(StreamReplayEvent)
            .where(
                StreamReplayEvent.status == REPLAY_STATUS_FAILED,
                StreamReplayEvent.updated_at >= since,
                StreamReplayEvent.updated_at < until,
            )
        )
        or 0
    )


def get_governance_operations_summary(db: Session) -> GovernanceOperationsSummaryResponse:
    from app.governance_notifications.service import NotificationService

    notification_health = NotificationService.get_health(db)

    return GovernanceOperationsSummaryResponse(
        pending_approvals=_count_pending_approvals(db),
        open_violations=_count_open_violations(db),
        quarantined_events=_count_quarantined_events(db),
        pending_replays=_count_pending_replays(db),
        failed_replays=_count_failed_replays(db),
        failed_notifications=notification_health.failed_notifications,
        pending_notifications=notification_health.pending_notifications,
    )


def _attention_label(category: str, count: int) -> str:
    n = int(count)
    if category == "pending_approvals":
        unit = "Policy" if n == 1 else "Policies"
        return f"{n} {unit} waiting for approval"
    if category == "open_violations":
        unit = "Open violation" if n == 1 else "Open violations"
        return f"{n} {unit}"
    if category == "failed_replays":
        unit = "Failed replay job" if n == 1 else "Failed replay jobs"
        return f"{n} {unit}"
    if category == "pending_replays":
        unit = "Pending replay job" if n == 1 else "Pending replay jobs"
        return f"{n} {unit}"
    if category == "failed_notifications":
        unit = "Failed notification" if n == 1 else "Failed notifications"
        return f"{n} {unit}"
    if category == "quarantined_events":
        unit = "Quarantined event" if n == 1 else "Quarantined events"
        return f"{n} {unit}"
    return f"{n} items"


def _attention_priority(category: str) -> str:
    if category in {"failed_replays", "failed_notifications"}:
        return "critical"
    if category in {"pending_approvals", "open_violations"}:
        return "high"
    return "medium"


def get_governance_operations_attention(db: Session) -> GovernanceOperationsAttentionResponse:
    summary = get_governance_operations_summary(db)
    items: list[GovernanceOperationsAttentionItem] = []

    candidates = [
        ("pending_approvals", summary.pending_approvals),
        ("open_violations", summary.open_violations),
        ("failed_replays", summary.failed_replays),
        ("failed_notifications", summary.failed_notifications),
        ("pending_replays", summary.pending_replays),
        ("quarantined_events", summary.quarantined_events),
    ]
    for category, count in candidates:
        if count <= 0:
            continue
        items.append(
            GovernanceOperationsAttentionItem(
                category=category,  # type: ignore[arg-type]
                count=count,
                label=_attention_label(category, count),
                priority=_attention_priority(category),  # type: ignore[arg-type]
            )
        )

    priority_order = {"critical": 0, "high": 1, "medium": 2}
    items.sort(key=lambda item: (priority_order.get(item.priority, 9), -item.count))
    return GovernanceOperationsAttentionResponse(items=items, is_empty=len(items) == 0)


def _recommended_action(category: str) -> str:
    mapping = {
        "failed_replays": "Execute or retry failed replay jobs",
        "failed_notifications": "Review delivery failures and retry",
        "pending_approvals": "Approve or reject pending policies",
        "open_violations": "Investigate open violations",
        "quarantined_events": "Release, discard, or replay quarantined events",
        "pending_replays": "Execute pending replay jobs",
    }
    return mapping.get(category, "Review and take action")


def get_governance_operations_queue(db: Session) -> GovernanceOperationsQueueResponse:
    from app.governance_approval.service import list_governance_approvals
    from app.governance_notifications.service import NotificationService
    from app.governance_quarantine.service import list_governance_quarantine_events
    from app.governance_replay.service import list_governance_replay_events

    summary = get_governance_operations_summary(db)
    action_required: list[GovernanceOperationsActionRequiredItem] = []

    for category, count, priority in [
        ("failed_replays", summary.failed_replays, "critical"),
        ("failed_notifications", summary.failed_notifications, "critical"),
        ("pending_approvals", summary.pending_approvals, "high"),
        ("open_violations", summary.open_violations, "high"),
        ("quarantined_events", summary.quarantined_events, "medium"),
        ("pending_replays", summary.pending_replays, "medium"),
    ]:
        if count <= 0:
            continue
        action_required.append(
            GovernanceOperationsActionRequiredItem(
                priority=priority,  # type: ignore[arg-type]
                category=category,  # type: ignore[arg-type]
                count=count,
                label=_attention_label(category, count),
                recommended_action=_recommended_action(category),
            )
        )

    priority_order = {"critical": 0, "high": 1, "medium": 2}
    action_required.sort(key=lambda item: (priority_order.get(item.priority, 9), -item.count))

    approvals = list_governance_approvals(db, window="30d", status="PENDING_REVIEW", limit=QUEUE_ITEM_LIMIT)
    pending_approvals = [
        GovernanceOperationsApprovalQueueItem(
            policy_id=int(item.policy_id),
            policy_name=str(item.policy_name),
            approval_status=str(item.approval_status),
            requester=item.requester,
            submitted_at=item.submitted_at,
        )
        for item in approvals
        if str(item.approval_status) == "PENDING_REVIEW"
    ][:QUEUE_ITEM_LIMIT]

    violations_raw = list_governance_violations(db, window="30d", limit=QUEUE_ITEM_LIMIT)
    violations = [
        GovernanceOperationsViolationQueueItem(
            violation_id=str(item.id),
            policy_name=item.policy_name,
            stream_name=item.stream_name,
            severity=str(item.severity),
            status=str(item.status),
        )
        for item in violations_raw
        if str(item.status).upper() not in {"RELEASED", "REPLAYED"}
    ][:QUEUE_ITEM_LIMIT]

    quarantine_raw = list_governance_quarantine_events(db, window="30d", status="QUARANTINED", limit=QUEUE_ITEM_LIMIT)
    quarantine = [
        GovernanceOperationsQuarantineQueueItem(
            quarantine_id=int(item.id),
            stream_name=item.stream_name,
            policy_name=item.policy_name,
            status=str(item.status),
            quarantine_reason=item.reason,
        )
        for item in quarantine_raw
    ][:QUEUE_ITEM_LIMIT]

    replay_failed, _, _, _ = list_governance_replay_events(db, window="30d", status="FAILED", limit=QUEUE_ITEM_LIMIT)
    replay_pending, _, _, _ = list_governance_replay_events(db, window="30d", status="PENDING", limit=QUEUE_ITEM_LIMIT)
    replays = [
        GovernanceOperationsReplayQueueItem(
            replay_id=int(item.id),
            stream_name=item.stream_name,
            status=str(item.status),
            outcome=str(item.outcome) if item.outcome else None,
            error_message=None,
        )
        for item in list(replay_failed) + list(replay_pending)
    ][:QUEUE_ITEM_LIMIT]

    failed_notifications = NotificationService.list_events(db, status="FAILED", limit=QUEUE_ITEM_LIMIT)
    notifications = [
        GovernanceOperationsNotificationQueueItem(
            notification_id=int(item.id),
            event_type=item.event_type,
            severity=item.severity,
            status=item.status,
            created_at=item.created_at,
        )
        for item in failed_notifications.events
    ]

    return GovernanceOperationsQueueResponse(
        action_required=action_required,
        pending_approvals=pending_approvals,
        violations=violations,
        quarantine=quarantine,
        replays=replays,
        notifications=notifications,
    )


def _activity_label(event_type: str) -> str:
    return _ACTIVITY_LABELS.get(str(event_type), str(event_type).replace("_", " ").title())


def get_governance_operations_activity(
    db: Session,
    *,
    limit: int = ACTIVITY_LIMIT_DEFAULT,
) -> GovernanceOperationsActivityResponse:
    lim = max(1, min(int(limit), ACTIVITY_LIMIT_MAX))
    audit_events = list_governance_audit_events(db, window="30d", limit=lim)

    events: list[GovernanceOperationsActivityEntry] = []
    for row in audit_events:
        events.append(
            GovernanceOperationsActivityEntry(
                event_time=row.event_time,
                event_type=str(row.event_type),
                event_label=_activity_label(str(row.event_type)),
                policy_id=row.policy_id,
                policy_name=row.policy_name or None,
                stream_id=row.stream_id,
                stream_name=row.stream_name,
                status=str(row.status),
            )
        )

    return GovernanceOperationsActivityResponse(total=len(events), events=events)
