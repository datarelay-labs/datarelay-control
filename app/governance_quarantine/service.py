"""Build governance quarantine feed and bulk operations from existing runtime data."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.classification.field_keys import read_classification_level
from app.classification.models import CLASSIFICATION_LEVELS
from app.governance_policies.models import GovernancePolicy
from app.governance_policies.service import build_policy_preview
from app.governance_quarantine.models import (
    QUARANTINE_DISPLAY_DISCARDED,
    QUARANTINE_DISPLAY_QUARANTINED,
    QUARANTINE_DISPLAY_RELEASED,
    QUARANTINE_DISPLAY_REPLAYED,
    QUARANTINE_WINDOW_24H,
    QUARANTINE_WINDOW_7D,
    QUARANTINE_WINDOW_30D,
)
from app.governance_quarantine.schemas import (
    GovernanceQuarantineBulkItemResult,
    GovernanceQuarantineBulkResponse,
    GovernanceQuarantineDetailResponse,
    GovernanceQuarantineEntry,
    GovernanceQuarantineMetadata,
    GovernanceQuarantinePolicyDecision,
    GovernanceQuarantinePolicySummary,
    GovernanceQuarantineProtectionAction,
    GovernanceQuarantineReplayRef,
    GovernanceQuarantineRootCauseStrip,
    GovernanceQuarantineSensitiveFinding,
    GovernanceQuarantineViolationRef,
)
from app.governance_violations.service import (
    _derive_severity,
    _derive_violation_status,
    _humanize_quarantine_reason,
    _load_replayed_stream_ids,
    _load_stream_names,
    _load_stream_policy_map,
    _related_replays_for_stream,
    _resolve_policy_context,
    _violation_id_for_quarantine,
    _window_bounds,
)
from app.protection.models import PROTECTION_MODE_TOKENIZATION, StreamProtectionRule
from app.quarantine.models import (
    QUARANTINE_SOURCE_POLICY,
    QUARANTINE_STATUS_DISCARDED,
    QUARANTINE_STATUS_QUARANTINED,
    QUARANTINE_STATUS_RELEASED,
    StreamQuarantineEvent,
)
from app.replay.models import (
    REPLAY_CONTEXT_ORIGIN_KEY,
    REPLAY_CONTEXT_ORIGIN_QUARANTINE,
    REPLAY_CONTEXT_QUARANTINE_EVENT_ID_KEY,
    REPLAY_STATUS_PENDING,
    StreamReplayEvent,
)
from app.sensitive_detection.models import StreamSensitiveFinding
from app.sensitive_detection.operator_workflow import is_api_visible

_DEFAULT_LIMIT = 100
_MAX_LIMIT = 200


class GovernanceQuarantineNotFoundError(Exception):
    def __init__(self, quarantine_id: int) -> None:
        self.quarantine_id = quarantine_id
        super().__init__(f"governance quarantine event not found: {quarantine_id}")


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _notify_quarantine_governance_event(
    db: Session,
    *,
    event_type: str,
    quarantine_event_id: int,
    message: str | None = None,
) -> None:
    from app.governance_notifications.service import NotificationService

    NotificationService.record_event(
        db,
        event_type=event_type,
        severity="INFO",
        payload={
            "quarantine_event_id": int(quarantine_event_id),
            "message": message,
        },
    )
    NotificationService.dispatch_pending(db)


def _extract_stored_events(row: StreamQuarantineEvent) -> list[dict[str, Any]]:
    raw = row.protected_payload_json if isinstance(row.protected_payload_json, dict) else {}
    events = raw.get("events")
    if not isinstance(events, list):
        return []
    return [item for item in events if isinstance(item, dict)]


def _classification_from_events(events: list[dict[str, Any]]) -> str | None:
    levels: set[str] = set()
    for ev in events:
        level = read_classification_level(ev)
        if level:
            levels.add(str(level).upper())
    if not levels:
        return None
    priority = ["RESTRICTED", "CONFIDENTIAL", "INTERNAL", "PUBLIC"]
    for p in priority:
        if p in levels:
            return p
    return sorted(levels)[0]


def _derive_display_status(
    db: Session,
    *,
    quarantine_status: str,
    stream_id: int,
    event_time: datetime,
    until: datetime,
    replayed_streams: set[int],
) -> str:
    violation_status = _derive_violation_status(
        db,
        quarantine_status=quarantine_status,
        stream_id=int(stream_id),
        event_time=event_time,
        until=until,
        replayed_streams=replayed_streams,
    )
    if violation_status == "REPLAYED":
        return QUARANTINE_DISPLAY_REPLAYED
    if quarantine_status == QUARANTINE_STATUS_QUARANTINED:
        return QUARANTINE_DISPLAY_QUARANTINED
    if quarantine_status == QUARANTINE_STATUS_DISCARDED:
        return QUARANTINE_DISPLAY_DISCARDED
    return QUARANTINE_DISPLAY_RELEASED


def _load_sensitive_findings(db: Session, stream_id: int, *, limit: int = 10) -> list[GovernanceQuarantineSensitiveFinding]:
    rows = list(
        db.execute(
            select(StreamSensitiveFinding)
            .where(StreamSensitiveFinding.stream_id == int(stream_id))
            .order_by(StreamSensitiveFinding.last_confirmed_at.desc().nullslast(), StreamSensitiveFinding.id.desc())
            .limit(limit * 3)
        )
        .scalars()
    )
    out: list[GovernanceQuarantineSensitiveFinding] = []
    for row in rows:
        if not is_api_visible(row):
            continue
        out.append(
            GovernanceQuarantineSensitiveFinding(
                field_path=str(row.field_path),
                sensitivity_class=str(row.sensitivity_class).upper(),
                status=str(row.status),
            )
        )
        if len(out) >= limit:
            break
    return out


def _load_protection_actions(db: Session, stream_id: int, *, limit: int = 10) -> list[GovernanceQuarantineProtectionAction]:
    rows = list(
        db.execute(
            select(StreamProtectionRule)
            .where(
                StreamProtectionRule.stream_id == int(stream_id),
                StreamProtectionRule.enabled.is_(True),
            )
            .order_by(StreamProtectionRule.id.asc())
            .limit(limit)
        )
        .scalars()
    )
    return [
        GovernanceQuarantineProtectionAction(
            field_path=str(row.field_path),
            sensitivity_class=str(row.sensitivity_class).upper(),
            protection_mode=str(row.protection_mode).upper(),
        )
        for row in rows
    ]


def _policy_decision_from_context(ctx_rule_summary: str | None, policy_json: dict[str, Any] | None) -> GovernanceQuarantinePolicyDecision:
    action = "QUARANTINE"
    summary = ctx_rule_summary
    if isinstance(policy_json, dict):
        actions = policy_json.get("actions")
        if isinstance(actions, list) and actions:
            first = actions[0]
            if isinstance(first, dict) and first.get("type"):
                action = str(first.get("type")).upper()
    return GovernanceQuarantinePolicyDecision(action=action, summary=summary)


def _format_protection_mode(mode: str) -> str:
    normalized = str(mode or "").strip().lower()
    if normalized == PROTECTION_MODE_TOKENIZATION:
        return "TOKENIZE"
    return normalized.replace("_", " ").upper() or "PROTECT"


def _primary_detected_label(
    *,
    classification: str | None,
    sensitive_findings: list[GovernanceQuarantineSensitiveFinding],
) -> str:
    if sensitive_findings:
        return sensitive_findings[0].sensitivity_class.upper()
    if classification:
        return classification.upper()
    return "UNKNOWN"


def _primary_action_label(protection_actions: list[GovernanceQuarantineProtectionAction]) -> str:
    if protection_actions:
        return _format_protection_mode(protection_actions[0].protection_mode)
    return "PROTECT"


def _build_root_cause_strip(
    *,
    detected: str,
    action: str,
    policy_name: str,
    result: str,
) -> GovernanceQuarantineRootCauseStrip:
    summary = f"Detected: {detected} → Action: {action} → Policy: {policy_name} → Result: {result}"
    return GovernanceQuarantineRootCauseStrip(
        detected=detected,
        action=action,
        policy=policy_name,
        result=result,
        summary=summary,
    )


def _metadata_from_row(row: StreamQuarantineEvent) -> GovernanceQuarantineMetadata:
    meta = row.metadata_json if isinstance(row.metadata_json, dict) else {}
    return GovernanceQuarantineMetadata(
        quarantine_event_id=int(row.id),
        quarantine_source=str(row.quarantine_source),
        event_count=int(meta.get("event_count") or 0),
        created_at=row.created_at,
        updated_at=row.updated_at,
        released_at=row.released_at,
        released_by=row.released_by,
    )


def _row_to_entry(
    db: Session,
    row: StreamQuarantineEvent,
    *,
    stream_names: dict[int, str],
    stream_policies: dict[int, list[GovernancePolicy]],
    replayed_streams: set[int],
    until: datetime,
) -> GovernanceQuarantineEntry:
    meta = row.metadata_json if isinstance(row.metadata_json, dict) else {}
    runtime_names = [str(n) for n in (meta.get("policy_names") or []) if n]
    ctx = _resolve_policy_context(
        db,
        stream_id=int(row.stream_id),
        stream_policies=stream_policies,
        runtime_policy_names=runtime_names,
    )
    events = _extract_stored_events(row)
    classification = _classification_from_events(events)
    status = _derive_display_status(
        db,
        quarantine_status=str(row.status),
        stream_id=int(row.stream_id),
        event_time=row.created_at,
        until=until,
        replayed_streams=replayed_streams,
    )
    return GovernanceQuarantineEntry(
        id=int(row.id),
        policy_id=ctx.policy_id,
        policy_name=ctx.policy_name,
        stream_id=int(row.stream_id),
        stream_name=stream_names.get(int(row.stream_id), f"Stream {row.stream_id}"),
        classification=classification,
        severity=_derive_severity(quarantine_source=str(row.quarantine_source), quarantine_status=str(row.status)),
        reason=_humanize_quarantine_reason(str(row.quarantine_reason), quarantine_source=str(row.quarantine_source)),
        status=status,
        quarantined_at=row.created_at,
        violation_id=_violation_id_for_quarantine(int(row.id)),
    )


def _matches_filters(
    entry: GovernanceQuarantineEntry,
    *,
    policy_id: int | None,
    stream_id: int | None,
    severity: str | None,
    status: str | None,
    classification: str | None,
) -> bool:
    if policy_id is not None and entry.policy_id != int(policy_id):
        return False
    if stream_id is not None and entry.stream_id != int(stream_id):
        return False
    if severity is not None and entry.severity != str(severity):
        return False
    if status is not None and entry.status != str(status):
        return False
    if classification is not None:
        entry_cls = (entry.classification or "").upper()
        if entry_cls != str(classification).upper():
            return False
    return True


def list_governance_quarantine_events(
    db: Session,
    *,
    window: str = QUARANTINE_WINDOW_24H,
    policy_id: int | None = None,
    stream_id: int | None = None,
    severity: str | None = None,
    classification: str | None = None,
    status: str | None = None,
    limit: int = _DEFAULT_LIMIT,
) -> list[GovernanceQuarantineEntry]:
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

    entries: list[GovernanceQuarantineEntry] = []
    for row in rows:
        entry = _row_to_entry(
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
            classification=classification,
        ):
            entries.append(entry)
        if len(entries) >= lim:
            break
    return entries


def get_governance_quarantine_detail(
    db: Session,
    quarantine_id: int,
    *,
    window: str = QUARANTINE_WINDOW_30D,
) -> GovernanceQuarantineDetailResponse:
    row = db.get(StreamQuarantineEvent, int(quarantine_id))
    if row is None:
        raise GovernanceQuarantineNotFoundError(quarantine_id)

    since, until = _window_bounds(window)
    stream_ids = {int(row.stream_id)}
    stream_names = _load_stream_names(db, stream_ids)
    stream_policies = _load_stream_policy_map(db, stream_ids)
    replayed_streams = _load_replayed_stream_ids(db, stream_ids=stream_ids, since=since, until=until)

    entry = _row_to_entry(
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

    policy_json: dict[str, Any] | None = None
    if ctx.policy_id is not None:
        policy_row = db.get(GovernancePolicy, int(ctx.policy_id))
        if policy_row is not None and isinstance(policy_row.policy_json, dict):
            policy_json = dict(policy_row.policy_json)

    policy_summary = GovernanceQuarantinePolicySummary(
        policy_id=ctx.policy_id,
        policy_name=ctx.policy_name,
        policy_status=ctx.policy_status,
        policy_version=ctx.policy_version,
        rule_summary=ctx.rule_summary,
    )

    events = _extract_stored_events(row)
    classification = _classification_from_events(events)
    sensitive_findings = _load_sensitive_findings(db, int(row.stream_id))
    protection_actions = _load_protection_actions(db, int(row.stream_id))
    policy_decision = _policy_decision_from_context(ctx.rule_summary, policy_json)

    related_replays = [
        GovernanceQuarantineReplayRef(
            replay_event_id=r.replay_event_id,
            status=r.status,
            event_count=r.event_count,
            last_replay_at=r.last_replay_at,
        )
        for r in _related_replays_for_stream(
            db,
            stream_id=int(row.stream_id),
            after=row.created_at,
            until=until,
        )
    ]

    metadata = _metadata_from_row(row)
    violation_id = _violation_id_for_quarantine(int(row.id))
    related_violation = GovernanceQuarantineViolationRef(
        violation_id=violation_id,
        status=entry.status,
        reason=entry.reason,
    )

    detected = _primary_detected_label(classification=classification, sensitive_findings=sensitive_findings)
    action = _primary_action_label(protection_actions)
    result = entry.status if entry.status != QUARANTINE_DISPLAY_RELEASED else "QUARANTINE"
    if row.status == QUARANTINE_STATUS_QUARANTINED:
        result = "QUARANTINE"
    elif entry.status == QUARANTINE_DISPLAY_REPLAYED:
        result = "REPLAYED"
    elif entry.status == QUARANTINE_DISPLAY_DISCARDED:
        result = "DISCARDED"
    elif entry.status == QUARANTINE_DISPLAY_RELEASED:
        result = "RELEASED"

    root_cause_strip = _build_root_cause_strip(
        detected=detected,
        action=action,
        policy_name=ctx.policy_name,
        result=result,
    )

    return GovernanceQuarantineDetailResponse(
        entry=entry,
        policy_summary=policy_summary,
        violation_reason=entry.reason,
        classification=classification,
        sensitive_findings=sensitive_findings,
        protection_actions=protection_actions,
        policy_decision=policy_decision,
        related_replay=related_replays,
        related_violation=related_violation,
        related_quarantine=metadata,
        quarantine_metadata=metadata,
        root_cause_strip=root_cause_strip,
    )


def _find_pending_replay_for_quarantine(db: Session, row: StreamQuarantineEvent) -> StreamReplayEvent | None:
    """Find the pending replay the operator is explicitly associating to this quarantine.

    Replay list/audit correlation never infers quarantine provenance from time alone.
    This legacy-compatible selector is used only inside the explicit Quarantine
    "Replay" action; the selected replay is stamped with durable provenance before
    execution.
    """
    return db.execute(
        select(StreamReplayEvent)
        .where(
            StreamReplayEvent.stream_id == int(row.stream_id),
            StreamReplayEvent.status == REPLAY_STATUS_PENDING,
            StreamReplayEvent.created_at >= row.created_at,
        )
        .order_by(StreamReplayEvent.created_at.asc(), StreamReplayEvent.id.asc())
        .limit(1)
    ).scalar_one_or_none()


def bulk_release_quarantine_events(db: Session, ids: list[int]) -> GovernanceQuarantineBulkResponse:
    from app.quarantine import service as quarantine_service

    results: list[GovernanceQuarantineBulkItemResult] = []
    succeeded = 0
    for event_id in ids:
        try:
            result = quarantine_service.execute_quarantine_release(db, int(event_id))
            outcome = str(result.get("outcome") or "unknown")
            if outcome == "released":
                succeeded += 1
                _notify_quarantine_governance_event(
                    db,
                    event_type="QUARANTINE_RELEASED",
                    quarantine_event_id=int(event_id),
                    message=str(result.get("message") or ""),
                )
            results.append(
                GovernanceQuarantineBulkItemResult(
                    id=int(event_id),
                    outcome=outcome,
                    message=str(result.get("message") or ""),
                    status=str(result.get("status") or ""),
                )
            )
        except quarantine_service.QuarantineEventNotFoundError:
            results.append(
                GovernanceQuarantineBulkItemResult(
                    id=int(event_id),
                    outcome="failed",
                    message=f"quarantine event not found: {event_id}",
                )
            )
        except quarantine_service.QuarantineEventStateError as exc:
            results.append(
                GovernanceQuarantineBulkItemResult(
                    id=int(event_id),
                    outcome="failed",
                    message=str(exc.message),
                    status=None,
                )
            )
        except quarantine_service.QuarantineInProgressError:
            results.append(
                GovernanceQuarantineBulkItemResult(
                    id=int(event_id),
                    outcome="failed",
                    message=f"quarantine release already in progress for event {event_id}",
                )
            )
    db.commit()
    failed = len(results) - succeeded
    return GovernanceQuarantineBulkResponse(
        total=len(results),
        succeeded=succeeded,
        failed=failed,
        results=results,
    )


def bulk_discard_quarantine_events(db: Session, ids: list[int]) -> GovernanceQuarantineBulkResponse:
    from app.quarantine import service as quarantine_service

    results: list[GovernanceQuarantineBulkItemResult] = []
    succeeded = 0
    for event_id in ids:
        try:
            result = quarantine_service.discard_quarantine_event(db, int(event_id))
            succeeded += 1
            _notify_quarantine_governance_event(
                db,
                event_type="QUARANTINE_DISCARDED",
                quarantine_event_id=int(event_id),
                message="Quarantine event discarded.",
            )
            results.append(
                GovernanceQuarantineBulkItemResult(
                    id=int(event_id),
                    outcome="discarded",
                    message="Quarantine event discarded.",
                    status=str(result.get("status") or QUARANTINE_STATUS_DISCARDED),
                )
            )
        except quarantine_service.QuarantineEventNotFoundError:
            results.append(
                GovernanceQuarantineBulkItemResult(
                    id=int(event_id),
                    outcome="failed",
                    message=f"quarantine event not found: {event_id}",
                )
            )
        except quarantine_service.QuarantineEventStateError as exc:
            results.append(
                GovernanceQuarantineBulkItemResult(
                    id=int(event_id),
                    outcome="failed",
                    message=str(exc.message),
                )
            )
        except quarantine_service.QuarantineInProgressError:
            results.append(
                GovernanceQuarantineBulkItemResult(
                    id=int(event_id),
                    outcome="failed",
                    message=f"quarantine operation already in progress for event {event_id}",
                )
            )
    db.commit()
    failed = len(results) - succeeded
    return GovernanceQuarantineBulkResponse(
        total=len(results),
        succeeded=succeeded,
        failed=failed,
        results=results,
    )


def bulk_replay_quarantine_events(db: Session, ids: list[int]) -> GovernanceQuarantineBulkResponse:
    from app.replay import service as replay_service

    results: list[GovernanceQuarantineBulkItemResult] = []
    succeeded = 0
    for quarantine_id in ids:
        row = db.get(StreamQuarantineEvent, int(quarantine_id))
        if row is None:
            results.append(
                GovernanceQuarantineBulkItemResult(
                    id=int(quarantine_id),
                    outcome="failed",
                    message=f"quarantine event not found: {quarantine_id}",
                )
            )
            continue

        replay_row = _find_pending_replay_for_quarantine(db, row)
        if replay_row is None:
            results.append(
                GovernanceQuarantineBulkItemResult(
                    id=int(quarantine_id),
                    outcome="failed",
                    message="No pending replay event found for this quarantine item.",
                )
            )
            continue

        try:
            # The Quarantine Replay action is the authoritative association point.
            # Persist explicit provenance so Replay/Audit surfaces never have to
            # infer correlation from "same stream + earlier quarantine" timing.
            replay_context = (
                dict(replay_row.delivery_context_json)
                if isinstance(replay_row.delivery_context_json, dict)
                else {}
            )
            replay_context[REPLAY_CONTEXT_ORIGIN_KEY] = REPLAY_CONTEXT_ORIGIN_QUARANTINE
            replay_context[REPLAY_CONTEXT_QUARANTINE_EVENT_ID_KEY] = int(row.id)
            replay_row.delivery_context_json = replay_context
            db.flush()
            result = replay_service.execute_replay_event(db, int(replay_row.id))
            outcome = str(result.get("outcome") or "unknown")
            if outcome == "replayed":
                succeeded += 1
            results.append(
                GovernanceQuarantineBulkItemResult(
                    id=int(quarantine_id),
                    outcome=outcome,
                    message=str(result.get("message") or ""),
                    status=str(result.get("status") or ""),
                    replay_event_id=int(replay_row.id),
                )
            )
            db.commit()
        except replay_service.ReplayEventNotFoundError:
            db.rollback()
            results.append(
                GovernanceQuarantineBulkItemResult(
                    id=int(quarantine_id),
                    outcome="failed",
                    message=f"replay event not found: {replay_row.id}",
                    replay_event_id=int(replay_row.id),
                )
            )
        except replay_service.ReplayEventStateError as exc:
            db.rollback()
            results.append(
                GovernanceQuarantineBulkItemResult(
                    id=int(quarantine_id),
                    outcome="failed",
                    message=str(exc.message),
                    replay_event_id=int(replay_row.id),
                )
            )
        except replay_service.ReplayInProgressError:
            db.rollback()
            results.append(
                GovernanceQuarantineBulkItemResult(
                    id=int(quarantine_id),
                    outcome="failed",
                    message=f"replay already in progress for event {replay_row.id}",
                    replay_event_id=int(replay_row.id),
                )
            )
    failed = len(results) - succeeded
    return GovernanceQuarantineBulkResponse(
        total=len(results),
        succeeded=succeeded,
        failed=failed,
        results=results,
    )


def supported_classifications() -> frozenset[str]:
    return CLASSIFICATION_LEVELS
