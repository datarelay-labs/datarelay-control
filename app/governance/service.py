"""Governance summary builder — composes existing platform read models only."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import Integer, case, cast, func, select
from sqlalchemy.orm import Session

# AI Gateway / AI Proxy is out of Data Relay OSS product scope.
# Governance keeps zeroed AI card fields for API shape compatibility only.
from app.classification.metrics import (
    CLASSIFICATION_COMPLETE_STAGE,
    build_platform_classification_summary,
)
from app.classification.models import StreamClassificationRule
from app.dynamic_routing.models import StreamDynamicRoute
from app.failover_routing.models import StreamFailoverRoute
from app.governance.dashboard_service import build_policy_dashboard
from app.governance.schemas import (
    GovernanceCardSummary,
    GovernanceCards,
    GovernanceHealth,
    GovernanceHealthLevel,
    GovernanceRecent24h,
    GovernanceRiskOverview,
    GovernanceSummaryResponse,
    GovernanceTimelineEvent,
)
from app.logs.models import DeliveryLog
from app.protection.metrics import PROTECTION_COMPLETE_STAGE
from app.protection.models import StreamPolicyRule, StreamProtectionRule
from app.protection.policy_metrics import POLICY_EVALUATION_COMPLETE_STAGE
from app.quarantine.metrics import QUARANTINE_EVENT_CREATED_STAGE
from app.quarantine.service import build_platform_quarantine_summary
from app.replay.metrics import REPLAY_EVENT_REPLAYED_STAGE
from app.replay.service import build_platform_replay_summary

_TIMELINE_DELIVERY_STAGES = (
    CLASSIFICATION_COMPLETE_STAGE,
    QUARANTINE_EVENT_CREATED_STAGE,
    REPLAY_EVENT_REPLAYED_STAGE,
)
_CARD_LAST_ACTIVITY_STAGES = (
    CLASSIFICATION_COMPLETE_STAGE,
    PROTECTION_COMPLETE_STAGE,
    POLICY_EVALUATION_COMPLETE_STAGE,
    REPLAY_EVENT_REPLAYED_STAGE,
)
_TIMELINE_LIMIT = 20

_HEALTH_PENDING_QUARANTINE_WARNING = 5
_HEALTH_PENDING_QUARANTINE_CRITICAL = 25
_HEALTH_PENDING_REPLAY_WARNING = 5
_HEALTH_PENDING_REPLAY_CRITICAL = 25

@dataclass(frozen=True)
class _GovernanceRuleCounts:
    classification_rules: int
    protection_rules: int
    policy_rules: int
    dynamic_routes: int
    failover_routes: int
    ai_gateway_policies: int


def _load_governance_rule_counts(db: Session) -> _GovernanceRuleCounts:
    """Load rule-table counts once for governance cards (small-table reads)."""

    return _GovernanceRuleCounts(
        classification_rules=int(
            db.execute(select(func.count()).select_from(StreamClassificationRule)).scalar_one() or 0
        ),
        protection_rules=int(
            db.execute(select(func.count()).select_from(StreamProtectionRule)).scalar_one() or 0
        ),
        policy_rules=int(
            db.execute(select(func.count()).select_from(StreamPolicyRule)).scalar_one() or 0
        ),
        dynamic_routes=int(
            db.execute(select(func.count()).select_from(StreamDynamicRoute)).scalar_one() or 0
        ),
        failover_routes=int(
            db.execute(select(func.count()).select_from(StreamFailoverRoute)).scalar_one() or 0
        ),
        ai_gateway_policies=0,  # OSS: AI Gateway out of product scope
    )


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _protected_event_count_expr():
    return func.greatest(
        1,
        func.coalesce(cast(DeliveryLog.payload_sample.op("->>")("protected_event_count"), Integer), 1),
    )


def _top_stream_id(rows: list[dict[str, Any]], *, count_key: str) -> int | None:
    if not rows:
        return None
    first = rows[0]
    stream_id = first.get("stream_id")
    if stream_id is None:
        return None
    return int(stream_id)


def _build_24h_delivery_log_metrics(
    db: Session,
    *,
    since: datetime,
    until: datetime,
) -> dict[str, int]:
    """Bounded delivery_logs aggregates for governance cards (incremental cache first)."""

    try:
        from app.runtime.cumulative_metrics_cache import get_window_kpi_counts

        cached = get_window_kpi_counts(db, since=since, until=until)
        return {
            "classified_events": int(cached["classified_events"]),
            "protected_events": int(cached["protected_events"]),
            "quarantined_events": int(cached["quarantined_events"]),
            "replayed_events": int(cached["replayed_events"]),
            "policy_evaluations": int(cached["policy_evaluations"]),
        }
    except Exception:
        pass

    row = (
        db.query(
            func.coalesce(
                func.sum(case((DeliveryLog.stage == CLASSIFICATION_COMPLETE_STAGE, 1), else_=0)),
                0,
            ).label("classified_events"),
            func.coalesce(
                func.sum(
                    case(
                        (DeliveryLog.stage == PROTECTION_COMPLETE_STAGE, _protected_event_count_expr()),
                        else_=0,
                    )
                ),
                0,
            ).label("protected_events"),
            func.coalesce(
                func.sum(case((DeliveryLog.stage == QUARANTINE_EVENT_CREATED_STAGE, 1), else_=0)),
                0,
            ).label("quarantined_events"),
            func.coalesce(
                func.sum(case((DeliveryLog.stage == REPLAY_EVENT_REPLAYED_STAGE, 1), else_=0)),
                0,
            ).label("replayed_events"),
            func.coalesce(
                func.sum(case((DeliveryLog.stage == POLICY_EVALUATION_COMPLETE_STAGE, 1), else_=0)),
                0,
            ).label("policy_evaluations"),
        )
        .filter(
            DeliveryLog.created_at >= since,
            DeliveryLog.created_at < until,
            DeliveryLog.stage.in_(
                (
                    CLASSIFICATION_COMPLETE_STAGE,
                    PROTECTION_COMPLETE_STAGE,
                    QUARANTINE_EVENT_CREATED_STAGE,
                    REPLAY_EVENT_REPLAYED_STAGE,
                    POLICY_EVALUATION_COMPLETE_STAGE,
                )
            ),
        )
        .one()
    )
    return {
        "classified_events": int(row.classified_events or 0),
        "protected_events": int(row.protected_events or 0),
        "quarantined_events": int(row.quarantined_events or 0),
        "replayed_events": int(row.replayed_events or 0),
        "policy_evaluations": int(row.policy_evaluations or 0),
    }


def _build_24h_blocked_ai_requests(db: Session, *, since: datetime, until: datetime) -> int:
    """OSS: AI Gateway out of product scope — always zero (schema field retained)."""

    _ = (db, since, until)
    return 0


def _build_recent_24h(db: Session, *, since: datetime, until: datetime) -> GovernanceRecent24h:
    delivery_metrics = _build_24h_delivery_log_metrics(db, since=since, until=until)
    blocked_ai_requests = _build_24h_blocked_ai_requests(db, since=since, until=until)
    return GovernanceRecent24h(
        classified_events=delivery_metrics["classified_events"],
        protected_events=delivery_metrics["protected_events"],
        quarantined_events=delivery_metrics["quarantined_events"],
        replayed_events=delivery_metrics["replayed_events"],
        blocked_ai_requests=blocked_ai_requests,
    )


def _last_activity_by_stage(
    db: Session,
    *,
    stages: tuple[str, ...],
    since: datetime,
    until: datetime,
) -> dict[str, datetime]:
    """Bounded MAX(created_at) per stage within the rolling window."""

    rows = (
        db.query(DeliveryLog.stage, func.max(DeliveryLog.created_at))
        .filter(
            DeliveryLog.created_at >= since,
            DeliveryLog.created_at < until,
            DeliveryLog.stage.in_(stages),
        )
        .group_by(DeliveryLog.stage)
        .all()
    )
    return {str(stage): ts for stage, ts in rows if ts is not None}


def _timeline_label(event_type: str) -> str:
    labels = {
        CLASSIFICATION_COMPLETE_STAGE: "Classification complete",
        QUARANTINE_EVENT_CREATED_STAGE: "Quarantine event created",
        REPLAY_EVENT_REPLAYED_STAGE: "Replay event replayed",
    }
    return labels.get(event_type, event_type.replace("_", " ").title())


def _build_activity_timeline(
    db: Session,
    *,
    since: datetime,
    until: datetime,
    limit: int = _TIMELINE_LIMIT,
) -> list[GovernanceTimelineEvent]:
    """Bounded recent governance events (delivery_logs stages + AI blocks)."""

    log_rows = (
        db.query(DeliveryLog)
        .filter(
            DeliveryLog.created_at >= since,
            DeliveryLog.created_at < until,
            DeliveryLog.stage.in_(_TIMELINE_DELIVERY_STAGES),
        )
        .order_by(DeliveryLog.created_at.desc(), DeliveryLog.id.desc())
        .limit(limit)
        .all()
    )
    events: list[GovernanceTimelineEvent] = []
    for row in log_rows:
        events.append(
            GovernanceTimelineEvent(
                event_type=row.stage,
                occurred_at=row.created_at,
                stream_id=int(row.stream_id) if row.stream_id is not None else None,
                label=_timeline_label(row.stage),
            )
        )

    events.sort(key=lambda item: item.occurred_at, reverse=True)
    return events[:limit]


def _build_health(
    *,
    pending_quarantine_events: int,
    pending_replay_events: int,
    ai_gateway_blocks_24h: int,
) -> GovernanceHealth:
    reasons: list[str] = []
    level = GovernanceHealthLevel.healthy

    def _raise_level(new_level: GovernanceHealthLevel) -> None:
        nonlocal level
        order = {
            GovernanceHealthLevel.healthy: 0,
            GovernanceHealthLevel.warning: 1,
            GovernanceHealthLevel.critical: 2,
        }
        if order[new_level] > order[level]:
            level = new_level

    if pending_quarantine_events >= _HEALTH_PENDING_QUARANTINE_CRITICAL:
        _raise_level(GovernanceHealthLevel.critical)
        reasons.append(f"{pending_quarantine_events} quarantine events pending (critical threshold)")
    elif pending_quarantine_events >= _HEALTH_PENDING_QUARANTINE_WARNING:
        _raise_level(GovernanceHealthLevel.warning)
        reasons.append(f"{pending_quarantine_events} quarantine events pending")

    if pending_replay_events >= _HEALTH_PENDING_REPLAY_CRITICAL:
        _raise_level(GovernanceHealthLevel.critical)
        reasons.append(f"{pending_replay_events} replay events pending (critical threshold)")
    elif pending_replay_events >= _HEALTH_PENDING_REPLAY_WARNING:
        _raise_level(GovernanceHealthLevel.warning)
        reasons.append(f"{pending_replay_events} replay events pending")


    return GovernanceHealth(
        status=level,
        pending_quarantine_events=pending_quarantine_events,
        pending_replay_events=pending_replay_events,
        ai_gateway_blocks_24h=ai_gateway_blocks_24h,
        reasons=reasons,
    )


def build_governance_summary(db: Session) -> GovernanceSummaryResponse:
    """Aggregate governance posture from existing tables and bounded window queries."""

    until = _utc_now()
    since = until - timedelta(hours=24)

    rule_counts = _load_governance_rule_counts(db)
    classification_rules = rule_counts.classification_rules
    protection_rules = rule_counts.protection_rules
    policy_rules = rule_counts.policy_rules
    dynamic_routes = rule_counts.dynamic_routes
    failover_routes = rule_counts.failover_routes
    ai_gateway_policies = rule_counts.ai_gateway_policies

    has_governance_rules = (
        classification_rules + protection_rules + policy_rules + ai_gateway_policies > 0
    )

    classification_platform = build_platform_classification_summary(db)
    quarantine_platform = build_platform_quarantine_summary(db)
    replay_platform = build_platform_replay_summary(db)

    pending_quarantine_events = int(quarantine_platform.get("quarantined_count") or 0)
    pending_replay_events = int(replay_platform.get("pending_count") or 0)

    delivery_metrics = _build_24h_delivery_log_metrics(db, since=since, until=until)
    blocked_ai_requests_24h = _build_24h_blocked_ai_requests(db, since=since, until=until)
    recent_24h = GovernanceRecent24h(
        classified_events=delivery_metrics["classified_events"],
        protected_events=delivery_metrics["protected_events"],
        quarantined_events=delivery_metrics["quarantined_events"],
        replayed_events=delivery_metrics["replayed_events"],
        blocked_ai_requests=blocked_ai_requests_24h,
    )

    last_activity = _last_activity_by_stage(
        db,
        stages=_CARD_LAST_ACTIVITY_STAGES,
        since=since,
        until=until,
    )
    activity_timeline = _build_activity_timeline(db, since=since, until=until)

    restricted_events = int(classification_platform.get("restricted_count") or 0)
    confidential_events = int(classification_platform.get("confidential_count") or 0)

    quarantine_streams = list(quarantine_platform.get("streams_with_quarantined") or [])
    replay_streams = list(replay_platform.get("streams_with_pending") or [])

    cards = GovernanceCards(
        classification=GovernanceCardSummary(
            rule_count=classification_rules,
            pending_count=0,
            recent_activity_count=recent_24h.classified_events,
            last_activity_at=last_activity.get(CLASSIFICATION_COMPLETE_STAGE)
            or classification_platform.get("last_classified_at"),
        ),
        protection=GovernanceCardSummary(
            rule_count=protection_rules,
            pending_count=0,
            recent_activity_count=recent_24h.protected_events,
            last_activity_at=last_activity.get(PROTECTION_COMPLETE_STAGE),
        ),
        policy=GovernanceCardSummary(
            rule_count=policy_rules,
            pending_count=0,
            recent_activity_count=delivery_metrics["policy_evaluations"],
            last_activity_at=last_activity.get(POLICY_EVALUATION_COMPLETE_STAGE),
        ),
        quarantine=GovernanceCardSummary(
            rule_count=0,
            pending_count=pending_quarantine_events,
            recent_activity_count=recent_24h.quarantined_events,
            last_activity_at=last_activity.get(QUARANTINE_EVENT_CREATED_STAGE)
            or quarantine_platform.get("last_released_at"),
            top_stream_id=_top_stream_id(quarantine_streams, count_key="quarantined_count"),
        ),
        replay=GovernanceCardSummary(
            rule_count=0,
            pending_count=pending_replay_events,
            recent_activity_count=recent_24h.replayed_events,
            last_activity_at=last_activity.get(REPLAY_EVENT_REPLAYED_STAGE),
            top_stream_id=_top_stream_id(replay_streams, count_key="pending_count"),
        ),
        ai_gateway=GovernanceCardSummary(
            rule_count=ai_gateway_policies,
            pending_count=0,
            recent_activity_count=0,
            last_activity_at=None,
        ),
    )

    risk_overview = GovernanceRiskOverview(
        restricted_events=restricted_events,
        confidential_events=confidential_events,
        quarantine_pending=pending_quarantine_events,
        replay_pending=pending_replay_events,
        ai_gateway_blocks=blocked_ai_requests_24h,
    )

    health = _build_health(
        pending_quarantine_events=pending_quarantine_events,
        pending_replay_events=pending_replay_events,
        ai_gateway_blocks_24h=blocked_ai_requests_24h,
    )

    policy_dashboard = build_policy_dashboard(
        db,
        pending_quarantine_events=pending_quarantine_events,
        replayed_events_24h=recent_24h.replayed_events,
        until=until,
    )

    return GovernanceSummaryResponse(
        classification_rules=classification_rules,
        protection_rules=protection_rules,
        policy_rules=policy_rules,
        dynamic_routes=dynamic_routes,
        failover_routes=failover_routes,
        pending_replay_events=pending_replay_events,
        pending_quarantine_events=pending_quarantine_events,
        ai_gateway_policies=ai_gateway_policies,
        has_governance_rules=has_governance_rules,
        recent_24h=recent_24h,
        risk_overview=risk_overview,
        health=health,
        activity_timeline=activity_timeline,
        cards=cards,
        policy_dashboard=policy_dashboard,
    )
