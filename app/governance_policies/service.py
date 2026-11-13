"""Governance policy CRUD, assignment, and preview (M18.1)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.governance_policies.models import (
    CONDITION_FIELDS,
    CONDITION_OPERATORS,
    POLICY_ACTION_TYPES,
    POLICY_CATEGORIES,
    POLICY_LIFECYCLE_TRANSITIONS,
    POLICY_STATUS_ACTIVE,
    POLICY_STATUS_DRAFT,
    POLICY_STATUS_RETIRED,
    POLICY_STATUSES,
    GovernancePolicy,
    StreamPolicyAssignment,
)
from app.streams.repository import get_stream_by_id


class GovernancePolicyNotFoundError(Exception):
    def __init__(self, policy_id: int) -> None:
        self.policy_id = policy_id
        super().__init__(f"governance policy not found: {policy_id}")


class GovernancePolicyValidationError(Exception):
    pass


class GovernancePolicyLifecycleError(Exception):
    pass


class GovernancePolicyStreamNotFoundError(Exception):
    def __init__(self, stream_id: int) -> None:
        self.stream_id = stream_id
        super().__init__(f"stream not found: {stream_id}")


_OPERATOR_LABELS = {
    "equals": "=",
    "not_equals": "!=",
    "contains": "contains",
}


def _validate_status(status: str) -> None:
    if status not in POLICY_STATUSES:
        raise GovernancePolicyValidationError(f"unsupported status: {status!r}")


def _validate_category(category: str) -> None:
    if category not in POLICY_CATEGORIES:
        raise GovernancePolicyValidationError(f"unsupported category: {category!r}")


def _validate_policy_json(policy_json: dict[str, Any]) -> None:
    if not isinstance(policy_json, dict):
        raise GovernancePolicyValidationError("policy_json must be an object")
    conditions = policy_json.get("conditions")
    actions = policy_json.get("actions")
    if not isinstance(conditions, list):
        raise GovernancePolicyValidationError("policy_json.conditions must be an array")
    if not isinstance(actions, list):
        raise GovernancePolicyValidationError("policy_json.actions must be an array")
    if not conditions:
        raise GovernancePolicyValidationError("policy_json requires at least one condition")
    if not actions:
        raise GovernancePolicyValidationError("policy_json requires at least one action")
    for idx, condition in enumerate(conditions):
        if not isinstance(condition, dict):
            raise GovernancePolicyValidationError(f"conditions[{idx}] must be an object")
        field = condition.get("field")
        operator = condition.get("operator")
        value = condition.get("value")
        if not isinstance(field, str) or field not in CONDITION_FIELDS:
            raise GovernancePolicyValidationError(f"unsupported condition field: {field!r}")
        if not isinstance(operator, str) or operator not in CONDITION_OPERATORS:
            raise GovernancePolicyValidationError(f"unsupported operator: {operator!r}")
        if not isinstance(value, str) or not value.strip():
            raise GovernancePolicyValidationError(f"conditions[{idx}].value is required")
    for idx, action in enumerate(actions):
        if not isinstance(action, dict):
            raise GovernancePolicyValidationError(f"actions[{idx}] must be an object")
        action_type = action.get("type")
        if not isinstance(action_type, str) or action_type not in POLICY_ACTION_TYPES:
            raise GovernancePolicyValidationError(f"unsupported action type: {action_type!r}")


def _assignment_counts(db: Session, policy_ids: list[int]) -> dict[int, tuple[int, list[int]]]:
    if not policy_ids:
        return {}
    rows = db.execute(
        select(
            StreamPolicyAssignment.policy_id,
            StreamPolicyAssignment.stream_id,
        )
        .where(StreamPolicyAssignment.policy_id.in_(policy_ids))
        .where(StreamPolicyAssignment.enabled.is_(True))
        .order_by(StreamPolicyAssignment.stream_id)
    ).all()
    out: dict[int, tuple[int, list[int]]] = {}
    for policy_id, stream_id in rows:
        count, ids = out.get(policy_id, (0, []))
        ids.append(stream_id)
        out[policy_id] = (count + 1, ids)
    return out


def policy_entry_for_row(
    row: GovernancePolicy,
    *,
    assigned_stream_count: int = 0,
    assigned_stream_ids: list[int] | None = None,
    impact_summary: dict[str, Any] | None = None,
) -> dict[str, Any]:
    impact = impact_summary or {}
    return {
        "id": row.id,
        "name": row.name,
        "description": row.description,
        "category": row.category,
        "status": row.status,
        "policy_json": dict(row.policy_json),
        "version": row.version,
        "assigned_stream_count": assigned_stream_count,
        "assigned_stream_ids": list(assigned_stream_ids or []),
        "impact_matched_events": impact.get("impact_matched_events"),
        "impact_data_available": bool(impact.get("impact_data_available")),
        "impact_summary": impact.get("impact_summary"),
        "activated_at": row.activated_at,
        "retired_at": row.retired_at,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


def list_governance_policies(db: Session) -> list[dict[str, Any]]:
    from app.governance_policies.impact_service import impact_summary_for_policy

    rows = list(db.execute(select(GovernancePolicy).order_by(GovernancePolicy.name)).scalars())
    counts = _assignment_counts(db, [row.id for row in rows])
    return [
        policy_entry_for_row(
            row,
            assigned_stream_count=counts.get(row.id, (0, []))[0],
            assigned_stream_ids=counts.get(row.id, (0, []))[1],
            impact_summary=impact_summary_for_policy(
                db,
                policy_id=row.id,
                policy_json=dict(row.policy_json),
                stream_ids=counts.get(row.id, (0, []))[1],
            ),
        )
        for row in rows
    ]


def get_governance_policy(db: Session, policy_id: int) -> GovernancePolicy | None:
    return db.get(GovernancePolicy, policy_id)


def get_governance_policy_entry(db: Session, policy_id: int) -> dict[str, Any] | None:
    from app.governance_policies.impact_service import impact_summary_for_policy

    row = get_governance_policy(db, policy_id)
    if row is None:
        return None
    counts = _assignment_counts(db, [row.id])
    count, ids = counts.get(row.id, (0, []))
    return policy_entry_for_row(
        row,
        assigned_stream_count=count,
        assigned_stream_ids=ids,
        impact_summary=impact_summary_for_policy(
            db,
            policy_id=row.id,
            policy_json=dict(row.policy_json),
            stream_ids=ids,
        ),
    )


def create_governance_policy(
    db: Session,
    *,
    name: str,
    description: str | None,
    category: str,
    status: str,
    policy_json: dict[str, Any],
) -> GovernancePolicy:
    label = name.strip()
    if not label:
        raise GovernancePolicyValidationError("name is required")
    _validate_category(category)
    if status != POLICY_STATUS_DRAFT:
        raise GovernancePolicyValidationError("new policies must be created in DRAFT status")
    _validate_policy_json(policy_json)
    now = datetime.now(timezone.utc)
    row = GovernancePolicy(
        name=label,
        description=description.strip() if description else None,
        category=category,
        status=POLICY_STATUS_DRAFT,
        policy_json=dict(policy_json),
        version=1,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.flush()
    return row


def update_governance_policy(
    db: Session,
    *,
    policy_id: int,
    name: str | None = None,
    description: str | None = None,
    category: str | None = None,
    status: str | None = None,
    policy_json: dict[str, Any] | None = None,
) -> GovernancePolicy:
    row = get_governance_policy(db, policy_id)
    if row is None:
        raise GovernancePolicyNotFoundError(policy_id)
    if row.status == POLICY_STATUS_RETIRED:
        raise GovernancePolicyLifecycleError("retired policies are view-only")
    if name is not None:
        label = name.strip()
        if not label:
            raise GovernancePolicyValidationError("name is required")
        row.name = label
    if description is not None:
        row.description = description.strip() if description else None
    if category is not None:
        _validate_category(category)
        row.category = category
    if status is not None:
        _validate_status(status)
        if status != row.status:
            raise GovernancePolicyLifecycleError(
                f"status changes must use lifecycle endpoints (current: {row.status}, requested: {status})"
            )
    if policy_json is not None:
        if row.status in {POLICY_STATUS_ACTIVE, POLICY_STATUS_RETIRED}:
            raise GovernancePolicyLifecycleError(f"policy_json cannot be changed while status is {row.status}")
        _validate_policy_json(policy_json)
        row.policy_json = dict(policy_json)
        row.version = int(row.version) + 1
    row.updated_at = datetime.now(timezone.utc)
    db.flush()
    return row


def _transition_policy_status(db: Session, *, policy_id: int, target_status: str) -> GovernancePolicy:
    row = get_governance_policy(db, policy_id)
    if row is None:
        raise GovernancePolicyNotFoundError(policy_id)
    allowed = POLICY_LIFECYCLE_TRANSITIONS.get(row.status)
    if allowed != target_status:
        raise GovernancePolicyLifecycleError(
            f"invalid status transition: {row.status} -> {target_status}"
        )
    now = datetime.now(timezone.utc)
    row.status = target_status
    row.updated_at = now
    if target_status == POLICY_STATUS_ACTIVE:
        row.activated_at = now
    if target_status == POLICY_STATUS_RETIRED:
        row.retired_at = now
    db.flush()
    return row


def submit_policy_for_review(
    db: Session,
    policy_id: int,
    *,
    actor: str,
    comment: str | None = None,
) -> GovernancePolicy:
    """The only way a policy enters REVIEW. Records who submitted it (F-187).

    ``actor`` is required: the separation-of-duties check on approve/activate compares against the
    recorded submitter, so no caller may move a policy into REVIEW anonymously.
    """

    from app.governance_approval.service import record_submission_event
    from app.governance_policies.models import POLICY_STATUS_REVIEW

    updated = _transition_policy_status(db, policy_id=policy_id, target_status=POLICY_STATUS_REVIEW)
    record_submission_event(db, policy_id, actor=actor, comment=comment)
    return updated


def activate_policy(db: Session, policy_id: int) -> GovernancePolicy:
    return _transition_policy_status(db, policy_id=policy_id, target_status=POLICY_STATUS_ACTIVE)


def retire_policy(db: Session, policy_id: int) -> GovernancePolicy:
    return _transition_policy_status(db, policy_id=policy_id, target_status=POLICY_STATUS_RETIRED)


def delete_governance_policy(db: Session, policy_id: int) -> None:
    row = get_governance_policy(db, policy_id)
    if row is None:
        raise GovernancePolicyNotFoundError(policy_id)
    if row.status != POLICY_STATUS_RETIRED:
        raise GovernancePolicyLifecycleError(
            f"only retired policies can be deleted (current status: {row.status})"
        )
    db.delete(row)
    db.flush()


def list_policy_assignments(db: Session, policy_id: int) -> list[dict[str, Any]]:
    row = get_governance_policy(db, policy_id)
    if row is None:
        raise GovernancePolicyNotFoundError(policy_id)
    assignments = db.execute(
        select(StreamPolicyAssignment)
        .where(StreamPolicyAssignment.policy_id == policy_id)
        .order_by(StreamPolicyAssignment.stream_id)
    ).scalars()
    return [{"stream_id": a.stream_id, "enabled": a.enabled} for a in assignments]


def set_policy_assignments(
    db: Session,
    *,
    policy_id: int,
    assignments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    row = get_governance_policy(db, policy_id)
    if row is None:
        raise GovernancePolicyNotFoundError(policy_id)
    for entry in assignments:
        stream_id = entry.get("stream_id")
        if not isinstance(stream_id, int):
            raise GovernancePolicyValidationError("assignments[].stream_id must be an integer")
        if get_stream_by_id(db, stream_id) is None:
            raise GovernancePolicyStreamNotFoundError(stream_id)
    existing = {
        a.stream_id: a
        for a in db.execute(
            select(StreamPolicyAssignment).where(StreamPolicyAssignment.policy_id == policy_id)
        ).scalars()
    }
    requested_ids = {int(entry["stream_id"]) for entry in assignments}
    for stream_id, assignment in list(existing.items()):
        if stream_id not in requested_ids:
            db.delete(assignment)
    for entry in assignments:
        stream_id = int(entry["stream_id"])
        enabled = bool(entry.get("enabled", True))
        if stream_id in existing:
            existing[stream_id].enabled = enabled
        else:
            db.add(
                StreamPolicyAssignment(
                    stream_id=stream_id,
                    policy_id=policy_id,
                    enabled=enabled,
                )
            )
    row.updated_at = datetime.now(timezone.utc)
    db.flush()
    return list_policy_assignments(db, policy_id)


def _format_condition(condition: dict[str, Any]) -> str:
    field = str(condition.get("field", ""))
    operator = str(condition.get("operator", "equals"))
    value = str(condition.get("value", ""))
    op_label = _OPERATOR_LABELS.get(operator, operator)
    return f"{field} {op_label} {value}"


def _format_action(action: dict[str, Any]) -> str:
    return str(action.get("type", "unknown"))


def build_policy_preview(policy_json: dict[str, Any]) -> dict[str, Any]:
    _validate_policy_json(policy_json)
    conditions = policy_json.get("conditions", [])
    actions = policy_json.get("actions", [])
    rules: list[dict[str, str]] = []
    for action in actions:
        action_text = _format_action(action)
        condition_parts = [_format_condition(c) for c in conditions]
        condition_text = " AND ".join(condition_parts)
        combined = f"IF {condition_text} THEN {action_text}"
        rules.append(
            {
                "condition_text": condition_text,
                "action_text": action_text,
                "combined": combined,
            }
        )
    summary = " · ".join(rule["combined"] for rule in rules)
    return {
        "policy_json": dict(policy_json),
        "rules": rules,
        "summary": summary,
    }


def preview_governance_policy(db: Session, policy_id: int) -> dict[str, Any]:
    row = get_governance_policy(db, policy_id)
    if row is None:
        raise GovernancePolicyNotFoundError(policy_id)
    preview = build_policy_preview(dict(row.policy_json))
    preview["policy_id"] = policy_id
    return preview


def preview_policy_json(policy_json: dict[str, Any]) -> dict[str, Any]:
    return build_policy_preview(policy_json)
