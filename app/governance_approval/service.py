"""Governance policy approval workflow service (M19.5)."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.governance_approval.models import (
    APPROVAL_EVENT_ACTIVATED,
    APPROVAL_EVENT_APPROVED,
    APPROVAL_EVENT_CANCELLED,
    APPROVAL_EVENT_REJECTED,
    APPROVAL_EVENT_REQUEST_CHANGES,
    APPROVAL_EVENT_SUBMITTED,
    APPROVAL_EVENT_TYPES,
    APPROVAL_WINDOW_24H,
    APPROVAL_WINDOW_30D,
    APPROVAL_WINDOW_7D,
    DEFAULT_ACTOR,
    GovernancePolicyApprovalEvent,
)
from app.governance_approval.schemas import (
    GovernanceApprovalDetailResponse,
    GovernanceApprovalHistoryEntry,
    GovernanceApprovalImpactSummary,
    GovernanceApprovalPolicySummary,
    GovernanceApprovalQueueEntry,
    GovernanceApprovalSimulationSummary,
)
from app.governance_policies.models import (
    POLICY_STATUS_ACTIVE,
    POLICY_STATUS_DRAFT,
    POLICY_STATUS_RETIRED,
    POLICY_STATUS_REVIEW,
    GovernancePolicy,
)
from app.governance_policies.service import (
    GovernancePolicyLifecycleError,
    GovernancePolicyNotFoundError,
    activate_policy,
    get_governance_policy,
    get_governance_policy_entry,
    submit_policy_for_review,
)


logger = logging.getLogger(__name__)


class GovernanceApprovalError(Exception):
    pass


class GovernanceSelfApprovalError(GovernanceApprovalError):
    """The acting user submitted this policy and did not explicitly allow self-approval (F-187)."""

    def __init__(self, action: str) -> None:
        self.action = action
        super().__init__(
            f"you submitted this policy for review, so you cannot {action} it yourself; "
            "ask another reviewer, or confirm an explicit self-approval override"
        )


SELF_APPROVAL_OVERRIDE_MARKER = "[self-approval override]"


class GovernanceApprovalNotFoundError(Exception):
    def __init__(self, policy_id: int) -> None:
        self.policy_id = policy_id
        super().__init__(f"governance approval not found for policy: {policy_id}")


_TERMINAL_REVIEW_EVENTS = frozenset(
    {
        APPROVAL_EVENT_REJECTED,
        APPROVAL_EVENT_REQUEST_CHANGES,
        APPROVAL_EVENT_ACTIVATED,
        APPROVAL_EVENT_CANCELLED,
    }
)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _window_bounds(window: str, *, until: datetime | None = None) -> tuple[datetime, datetime]:
    end = until or _utc_now()
    if window == APPROVAL_WINDOW_7D:
        return end - timedelta(days=7), end
    if window == APPROVAL_WINDOW_30D:
        return end - timedelta(days=30), end
    return end - timedelta(hours=24), end


def _load_events_for_policy(db: Session, policy_id: int) -> list[GovernancePolicyApprovalEvent]:
    return list(
        db.execute(
            select(GovernancePolicyApprovalEvent)
            .where(GovernancePolicyApprovalEvent.policy_id == int(policy_id))
            .order_by(GovernancePolicyApprovalEvent.created_at.asc(), GovernancePolicyApprovalEvent.id.asc())
        ).scalars()
    )


def _latest_submit_index(events: list[GovernancePolicyApprovalEvent]) -> int | None:
    for idx in range(len(events) - 1, -1, -1):
        if events[idx].event_type == APPROVAL_EVENT_SUBMITTED:
            return idx
    return None


def _is_approved_cycle(events: list[GovernancePolicyApprovalEvent]) -> bool:
    submit_idx = _latest_submit_index(events)
    if submit_idx is None:
        return False
    cycle = events[submit_idx:]
    if any(ev.event_type in _TERMINAL_REVIEW_EVENTS for ev in cycle if ev.event_type != APPROVAL_EVENT_ACTIVATED):
        for ev in cycle:
            if ev.event_type in {APPROVAL_EVENT_REJECTED, APPROVAL_EVENT_REQUEST_CHANGES, APPROVAL_EVENT_CANCELLED}:
                return False
    return any(ev.event_type == APPROVAL_EVENT_APPROVED for ev in cycle)


def _derive_approval_status(policy_status: str, events: list[GovernancePolicyApprovalEvent]) -> str:
    if policy_status == POLICY_STATUS_ACTIVE:
        return "ACTIVATED"
    if policy_status == POLICY_STATUS_RETIRED:
        return "RETIRED"
    submit_idx = _latest_submit_index(events)
    if submit_idx is None:
        return "DRAFT"
    cycle = events[submit_idx:]
    for ev in reversed(cycle):
        if ev.event_type == APPROVAL_EVENT_APPROVED:
            return "APPROVED"
        if ev.event_type in {APPROVAL_EVENT_REJECTED, APPROVAL_EVENT_REQUEST_CHANGES}:
            return ev.event_type
        if ev.event_type == APPROVAL_EVENT_CANCELLED:
            return "CANCELLED"
    if policy_status == POLICY_STATUS_REVIEW:
        return "PENDING_REVIEW"
    return policy_status


def _same_actor(a: str | None, b: str | None) -> bool:
    left = (a or "").strip().casefold()
    right = (b or "").strip().casefold()
    return bool(left) and left == right


def current_cycle_requester(db: Session, policy_id: int) -> str | None:
    """Actor of the latest SUBMITTED_FOR_REVIEW event for the policy, if any."""

    events = _load_events_for_policy(db, policy_id)
    submit_idx = _latest_submit_index(events)
    return events[submit_idx].actor if submit_idx is not None else None


def enforce_separation_of_duties(
    db: Session,
    row: GovernancePolicy,
    *,
    action: str,
    actor: str,
    allow_self_approval: bool,
    comment: str | None = None,
) -> str | None:
    """Refuse approve/activate by the user who submitted the policy (F-187).

    Only a REVIEW policy has an open submission to protect. Rejecting your own submission is not
    restricted and never calls this. ``allow_self_approval`` must be an explicit opt-in from the
    caller; when it is used, the override is logged and marked in the recorded comment so other
    reviewers can see it in the approval history. Returns the comment that should be recorded.
    """

    if row.status != POLICY_STATUS_REVIEW:
        return comment
    requester = current_cycle_requester(db, int(row.id))
    if requester is None or not _same_actor(requester, actor):
        return comment
    if not allow_self_approval:
        raise GovernanceSelfApprovalError(action)
    logger.warning(
        "governance self-approval override: actor=%s action=%s policy_id=%s",
        actor,
        action,
        row.id,
    )
    text = (comment or "").strip()
    return f"{SELF_APPROVAL_OVERRIDE_MARKER} {text}".strip()


def _record_event(
    db: Session,
    *,
    policy_id: int,
    event_type: str,
    actor: str = DEFAULT_ACTOR,
    comment: str | None = None,
) -> GovernancePolicyApprovalEvent:
    if event_type not in APPROVAL_EVENT_TYPES:
        raise GovernanceApprovalError(f"unsupported approval event type: {event_type!r}")
    row = GovernancePolicyApprovalEvent(
        policy_id=int(policy_id),
        event_type=event_type,
        actor=actor.strip() or DEFAULT_ACTOR,
        comment=comment.strip() if comment else None,
        created_at=_utc_now(),
    )
    db.add(row)
    db.flush()
    _notify_approval_event(db, event_type=event_type, policy_id=policy_id, actor=actor, comment=comment)
    return row


def _notify_approval_event(
    db: Session,
    *,
    event_type: str,
    policy_id: int,
    actor: str,
    comment: str | None = None,
) -> None:
    from app.governance_notifications.models import (
        EVENT_POLICY_ACTIVATED,
        EVENT_POLICY_APPROVED,
        EVENT_POLICY_REJECTED,
        EVENT_POLICY_SUBMITTED,
    )
    from app.governance_notifications.service import NotificationService

    mapping = {
        APPROVAL_EVENT_SUBMITTED: EVENT_POLICY_SUBMITTED,
        APPROVAL_EVENT_APPROVED: EVENT_POLICY_APPROVED,
        APPROVAL_EVENT_REJECTED: EVENT_POLICY_REJECTED,
        APPROVAL_EVENT_REQUEST_CHANGES: EVENT_POLICY_REJECTED,
        APPROVAL_EVENT_ACTIVATED: EVENT_POLICY_ACTIVATED,
    }
    notify_type = mapping.get(event_type)
    if notify_type is None:
        return
    NotificationService.record_event(
        db,
        event_type=notify_type,
        severity="INFO",
        payload={
            "policy_id": int(policy_id),
            "actor": actor,
            "comment": comment,
            "approval_event_type": event_type,
        },
    )
    NotificationService.dispatch_pending(db)


def revert_policy_to_draft(db: Session, policy_id: int) -> GovernancePolicy:
    """Return a REVIEW policy to DRAFT for approval rejection (M19.5)."""
    row = get_governance_policy(db, policy_id)
    if row is None:
        raise GovernancePolicyNotFoundError(policy_id)
    if row.status != POLICY_STATUS_REVIEW:
        raise GovernanceApprovalError(
            f"only policies in REVIEW can be returned to DRAFT (current: {row.status})"
        )
    now = _utc_now()
    row.status = POLICY_STATUS_DRAFT
    row.updated_at = now
    db.flush()
    return row


def _history_entries(events: list[GovernancePolicyApprovalEvent]) -> list[GovernanceApprovalHistoryEntry]:
    return [
        GovernanceApprovalHistoryEntry(
            event_time=ev.created_at,
            event_type=ev.event_type,  # type: ignore[arg-type]
            actor=ev.actor,
            comment=ev.comment,
        )
        for ev in events
    ]


def _impact_label(entry: dict[str, Any] | None) -> str | None:
    if not entry:
        return None
    if not entry.get("impact_data_available"):
        return "No impact data"
    matched = entry.get("impact_matched_events")
    if matched is None:
        return "Impact estimated"
    return f"{matched} events (24h)"


def _policy_summary_from_entry(entry: dict[str, Any]) -> GovernanceApprovalPolicySummary:
    return GovernanceApprovalPolicySummary(
        id=int(entry["id"]),
        name=str(entry["name"]),
        description=entry.get("description"),
        category=str(entry["category"]),
        status=entry["status"],  # type: ignore[arg-type]
        version=int(entry["version"]),
        assigned_stream_count=int(entry.get("assigned_stream_count") or 0),
        assigned_stream_ids=list(entry.get("assigned_stream_ids") or []),
    )


def _build_impact_summary(entry: dict[str, Any] | None) -> GovernanceApprovalImpactSummary | None:
    if entry is None:
        return None
    impact_raw = entry.get("impact_summary")
    return GovernanceApprovalImpactSummary(
        impact_data_available=bool(entry.get("impact_data_available")),
        impact_matched_events=entry.get("impact_matched_events"),
        impact_summary=dict(impact_raw) if isinstance(impact_raw, dict) else None,
        affected_stream_count=int(entry.get("assigned_stream_count") or 0),
    )


def _build_simulation_summary(entry: dict[str, Any] | None) -> GovernanceApprovalSimulationSummary | None:
    if entry is None:
        return None
    impact_raw = entry.get("impact_summary")
    if not isinstance(impact_raw, dict):
        return GovernanceApprovalSimulationSummary(simulation_available=False)
    breakdown = impact_raw.get("action_breakdown")
    if not isinstance(breakdown, dict):
        breakdown = {}
    action_breakdown = {str(k): int(v) for k, v in breakdown.items() if isinstance(v, (int, float))}
    dry_run = impact_raw.get("dry_run_summary")
    return GovernanceApprovalSimulationSummary(
        simulation_available=bool(action_breakdown or dry_run),
        dry_run_summary=str(dry_run) if dry_run else None,
        action_breakdown=action_breakdown,
    )


def _queue_entry_from_policy(
    db: Session,
    policy: GovernancePolicy,
    events: list[GovernancePolicyApprovalEvent],
    *,
    policy_entry: dict[str, Any] | None = None,
) -> GovernanceApprovalQueueEntry | None:
    submit_idx = _latest_submit_index(events)
    if submit_idx is None and policy.status not in {POLICY_STATUS_REVIEW, POLICY_STATUS_ACTIVE}:
        return None

    entry = policy_entry or get_governance_policy_entry(db, int(policy.id))
    requester: str | None = None
    reviewer: str | None = None
    submitted_at: datetime | None = None
    if submit_idx is not None:
        submit_ev = events[submit_idx]
        requester = submit_ev.actor
        submitted_at = submit_ev.created_at
        cycle = events[submit_idx:]
        for ev in cycle:
            if ev.event_type == APPROVAL_EVENT_APPROVED:
                reviewer = ev.actor
            if ev.event_type in {APPROVAL_EVENT_REJECTED, APPROVAL_EVENT_REQUEST_CHANGES}:
                reviewer = ev.actor

    last_ev = events[-1] if events else None
    return GovernanceApprovalQueueEntry(
        policy_id=int(policy.id),
        policy_name=str(policy.name),
        policy_status=policy.status,  # type: ignore[arg-type]
        approval_status=_derive_approval_status(policy.status, events),
        requester=requester,
        reviewer=reviewer,
        submitted_at=submitted_at,
        last_action=last_ev.event_type if last_ev else None,  # type: ignore[arg-type]
        last_action_at=last_ev.created_at if last_ev else None,
        last_comment=last_ev.comment if last_ev else None,
        impact_label=_impact_label(entry),
    )


def list_governance_approvals(
    db: Session,
    *,
    window: str = APPROVAL_WINDOW_24H,
    policy_id: int | None = None,
    status: str | None = None,
    requester: str | None = None,
    reviewer: str | None = None,
    limit: int = 100,
) -> list[GovernanceApprovalQueueEntry]:
    since, until = _window_bounds(window)

    event_rows = list(
        db.execute(
            select(GovernancePolicyApprovalEvent)
            .where(
                GovernancePolicyApprovalEvent.created_at >= since,
                GovernancePolicyApprovalEvent.created_at < until,
            )
            .order_by(GovernancePolicyApprovalEvent.created_at.desc())
        ).scalars()
    )

    policy_ids: set[int] = set()
    if policy_id is not None:
        policy_ids.add(int(policy_id))
    for ev in event_rows:
        policy_ids.add(int(ev.policy_id))

    review_policies = list(
        db.execute(
            select(GovernancePolicy).where(GovernancePolicy.status == POLICY_STATUS_REVIEW)
        ).scalars()
    )
    for row in review_policies:
        policy_ids.add(int(row.id))

    if not policy_ids:
        return []

    policies = {
        int(row.id): row
        for row in db.execute(select(GovernancePolicy).where(GovernancePolicy.id.in_(policy_ids))).scalars()
    }

    entries: list[GovernanceApprovalQueueEntry] = []
    seen: set[int] = set()
    for pid in sorted(policy_ids, reverse=True):
        policy = policies.get(pid)
        if policy is None:
            continue
        events = _load_events_for_policy(db, pid)
        if not events and policy.status == POLICY_STATUS_DRAFT:
            continue
        has_window_activity = any(since <= ev.created_at < until for ev in events)
        if not has_window_activity and policy.status not in {POLICY_STATUS_REVIEW}:
            if policy_id is None:
                continue
        queue_item = _queue_entry_from_policy(db, policy, events)
        if queue_item is None:
            continue
        if status is not None:
            st = str(status).upper()
            if queue_item.policy_status != st and queue_item.approval_status != st:
                continue
        if requester is not None and (queue_item.requester or "").lower() != requester.strip().lower():
            continue
        if reviewer is not None and (queue_item.reviewer or "").lower() != reviewer.strip().lower():
            continue
        entries.append(queue_item)
        seen.add(pid)

    entries.sort(
        key=lambda item: item.submitted_at or item.last_action_at or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )
    return entries[: max(1, min(int(limit), 200))]


def get_governance_approval_detail(db: Session, policy_id: int) -> GovernanceApprovalDetailResponse:
    entry = get_governance_policy_entry(db, policy_id)
    if entry is None:
        raise GovernanceApprovalNotFoundError(policy_id)

    events = _load_events_for_policy(db, policy_id)
    submit_idx = _latest_submit_index(events)
    requester: str | None = None
    reviewer: str | None = None
    submitted_at: datetime | None = None
    review_comment: str | None = None
    if submit_idx is not None:
        submit_ev = events[submit_idx]
        requester = submit_ev.actor
        submitted_at = submit_ev.created_at
        review_comment = submit_ev.comment
        for ev in events[submit_idx:]:
            if ev.event_type == APPROVAL_EVENT_APPROVED:
                reviewer = ev.actor
                if ev.comment:
                    review_comment = ev.comment
            if ev.event_type in {APPROVAL_EVENT_REJECTED, APPROVAL_EVENT_REQUEST_CHANGES}:
                reviewer = ev.actor
                review_comment = ev.comment

    policy_status = str(entry["status"])
    approved = _is_approved_cycle(events)
    return GovernanceApprovalDetailResponse(
        policy=_policy_summary_from_entry(entry),
        current_status=policy_status,  # type: ignore[arg-type]
        approval_status=_derive_approval_status(policy_status, events),
        requester=requester,
        reviewer=reviewer,
        submitted_at=submitted_at,
        review_comment=review_comment,
        is_approved=approved,
        history=_history_entries(events),
        impact=_build_impact_summary(entry),
        simulation=_build_simulation_summary(entry),
    )


def submit_policy_approval(
    db: Session,
    policy_id: int,
    *,
    comment: str | None = None,
    actor: str = DEFAULT_ACTOR,
) -> GovernancePolicy:
    row = get_governance_policy(db, policy_id)
    if row is None:
        raise GovernancePolicyNotFoundError(policy_id)
    if row.status == POLICY_STATUS_ACTIVE:
        raise GovernanceApprovalError("active policies cannot be submitted for review")
    if row.status == POLICY_STATUS_RETIRED:
        raise GovernanceApprovalError("retired policies cannot be submitted for review")
    if row.status != POLICY_STATUS_DRAFT:
        raise GovernanceApprovalError(f"only DRAFT policies can be submitted (current: {row.status})")

    updated = submit_policy_for_review(db, policy_id)
    _record_event(
        db,
        policy_id=policy_id,
        event_type=APPROVAL_EVENT_SUBMITTED,
        actor=actor,
        comment=comment,
    )
    return updated


def approve_policy(
    db: Session,
    policy_id: int,
    *,
    comment: str | None = None,
    actor: str = DEFAULT_ACTOR,
    allow_self_approval: bool = False,
) -> GovernancePolicy:
    row = get_governance_policy(db, policy_id)
    if row is None:
        raise GovernancePolicyNotFoundError(policy_id)
    if row.status == POLICY_STATUS_RETIRED:
        raise GovernanceApprovalError("retired policies cannot be approved")
    if row.status == POLICY_STATUS_DRAFT:
        raise GovernanceApprovalError("draft policies cannot be approved — submit for review first")
    if row.status == POLICY_STATUS_ACTIVE:
        raise GovernanceApprovalError("active policies cannot be approved")
    if row.status != POLICY_STATUS_REVIEW:
        raise GovernanceApprovalError(f"only REVIEW policies can be approved (current: {row.status})")

    comment = enforce_separation_of_duties(
        db,
        row,
        action="approve",
        actor=actor,
        allow_self_approval=allow_self_approval,
        comment=comment,
    )
    _record_event(
        db,
        policy_id=policy_id,
        event_type=APPROVAL_EVENT_APPROVED,
        actor=actor,
        comment=comment,
    )
    row.updated_at = _utc_now()
    db.flush()
    return row


def reject_policy(
    db: Session,
    policy_id: int,
    *,
    comment: str | None = None,
    actor: str = DEFAULT_ACTOR,
    request_changes: bool = False,
) -> GovernancePolicy:
    row = get_governance_policy(db, policy_id)
    if row is None:
        raise GovernancePolicyNotFoundError(policy_id)
    if row.status == POLICY_STATUS_ACTIVE:
        raise GovernanceApprovalError("active policies cannot be rejected")
    if row.status == POLICY_STATUS_RETIRED:
        raise GovernanceApprovalError("retired policies cannot be rejected")
    if row.status != POLICY_STATUS_REVIEW:
        raise GovernanceApprovalError(f"only REVIEW policies can be rejected (current: {row.status})")

    event_type = APPROVAL_EVENT_REQUEST_CHANGES if request_changes else APPROVAL_EVENT_REJECTED
    _record_event(
        db,
        policy_id=policy_id,
        event_type=event_type,
        actor=actor,
        comment=comment,
    )
    return revert_policy_to_draft(db, policy_id)


def activate_approved_policy(
    db: Session,
    policy_id: int,
    *,
    comment: str | None = None,
    actor: str = DEFAULT_ACTOR,
    allow_self_approval: bool = False,
) -> GovernancePolicy:
    row = get_governance_policy(db, policy_id)
    if row is None:
        raise GovernancePolicyNotFoundError(policy_id)
    if row.status == POLICY_STATUS_RETIRED:
        raise GovernanceApprovalError("retired policies cannot be activated")
    if row.status == POLICY_STATUS_ACTIVE:
        raise GovernanceApprovalError("policy is already active")
    if row.status != POLICY_STATUS_REVIEW:
        raise GovernanceApprovalError(f"only approved REVIEW policies can be activated (current: {row.status})")

    events = _load_events_for_policy(db, policy_id)
    if not _is_approved_cycle(events):
        raise GovernanceApprovalError("policy must be approved before activation")

    comment = enforce_separation_of_duties(
        db,
        row,
        action="activate",
        actor=actor,
        allow_self_approval=allow_self_approval,
        comment=comment,
    )
    try:
        updated = activate_policy(db, policy_id)
    except GovernancePolicyLifecycleError as exc:
        raise GovernanceApprovalError(str(exc)) from exc

    _record_event(
        db,
        policy_id=policy_id,
        event_type=APPROVAL_EVENT_ACTIVATED,
        actor=actor,
        comment=comment,
    )
    return updated


def list_approval_events_for_audit(
    db: Session,
    *,
    since: datetime,
    until: datetime,
) -> list[GovernancePolicyApprovalEvent]:
    return list(
        db.execute(
            select(GovernancePolicyApprovalEvent)
            .where(
                GovernancePolicyApprovalEvent.created_at >= since,
                GovernancePolicyApprovalEvent.created_at < until,
            )
            .order_by(GovernancePolicyApprovalEvent.created_at.desc())
        ).scalars()
    )
