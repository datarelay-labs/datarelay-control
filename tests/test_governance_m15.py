"""M15 / M15.1 Governance Control Plane — summary API aggregation and hardening."""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.ai_gateway.metrics import AI_GATEWAY_EVALUATION_COMPLETE_STAGE
from app.ai_gateway.models import AiGatewayPolicy, AiGatewayRequest
from app.classification.metrics import CLASSIFICATION_COMPLETE_STAGE
from app.classification.models import StreamClassificationRule
from app.database import get_db_read_bounded
from app.governance.cache import clear_governance_summary_cache
from app.governance.service import build_governance_summary
from app.logs.models import DeliveryLog
from app.protection.metrics import PROTECTION_COMPLETE_STAGE
from app.protection.models import StreamProtectionRule
from app.quarantine.metrics import QUARANTINE_EVENT_CREATED_STAGE
from app.quarantine.models import QUARANTINE_SOURCE_POLICY, QUARANTINE_STATUS_QUARANTINED, StreamQuarantineEvent
from app.replay.metrics import REPLAY_EVENT_REPLAYED_STAGE
from app.replay.models import REPLAY_STATUS_PENDING, StreamReplayEvent
from tests.test_stream_runner_e2e import _seed_stream_runtime


def _governance_app() -> FastAPI:
    from app.governance.router import router

    app = FastAPI()
    app.include_router(router, prefix="/api/v1/governance")
    return app


@pytest.fixture
def governance_client(db_session: Session) -> TestClient:
    clear_governance_summary_cache()
    app = _governance_app()

    def _override_db():
        yield db_session

    app.dependency_overrides[get_db_read_bounded] = _override_db
    client = TestClient(app)
    yield client
    clear_governance_summary_cache()


def test_governance_summary_empty_state(governance_client: TestClient, db_session: Session) -> None:
    db_session.commit()
    resp = governance_client.get("/api/v1/governance/summary")
    assert resp.status_code == 200
    body = resp.json()
    assert body["classification_rules"] == 0
    assert body["protection_rules"] == 0
    assert body["policy_rules"] == 0
    assert body["pending_replay_events"] == 0
    assert body["pending_quarantine_events"] == 0
    assert body["ai_gateway_policies"] == 0
    assert body["has_governance_rules"] is False
    assert body["recent_24h"]["classified_events"] == 0
    assert body["risk_overview"]["restricted_events"] == 0
    assert body["health"]["status"] == "healthy"
    assert body["activity_timeline"] == []
    assert body["cards"]["classification"]["rule_count"] == 0


def test_governance_summary_aggregates_rules_pending_and_24h(
    governance_client: TestClient,
    db_session: Session,
) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    now = datetime.now(timezone.utc)

    db_session.add(
        StreamClassificationRule(
            stream_id=stream_id,
            name="gov-class",
            enabled=True,
            condition_json={"sensitivity_class": "pii"},
            classification_level="RESTRICTED",
        )
    )
    db_session.add(
        StreamProtectionRule(
            stream_id=stream_id,
            field_path="$.email",
            sensitivity_class="pii",
            protection_mode="partial_mask",
            enabled=True,
            created_by="test",
        )
    )
    db_session.add(
        AiGatewayPolicy(
            name="block-restricted",
            enabled=True,
            condition_json={"classification_level": "RESTRICTED"},
            action_type="block",
        )
    )
    db_session.add(
        StreamQuarantineEvent(
            stream_id=stream_id,
            quarantine_reason="policy:test",
            quarantine_source=QUARANTINE_SOURCE_POLICY,
            status=QUARANTINE_STATUS_QUARANTINED,
            protected_payload_json={"events": []},
            metadata_json={"event_count": 1},
        )
    )
    db_session.add(
        StreamReplayEvent(
            stream_id=stream_id,
            destination_id=int(seeded["destination_ids"][0]),
            route_id=int(seeded["route_ids"][0]),
            status=REPLAY_STATUS_PENDING,
            retry_count=0,
            delivery_kind="base_route",
            event_count=1,
            protected_payload_json={"events": []},
            delivery_context_json={"destination_type": "WEBHOOK_POST"},
        )
    )
    db_session.add(
        DeliveryLog(
            stream_id=stream_id,
            stage=CLASSIFICATION_COMPLETE_STAGE,
            level="INFO",
            status="OK",
            message="classification complete",
            payload_sample={
                "classification_level": "RESTRICTED",
                "total_restricted_count": 3,
                "total_confidential_count": 2,
            },
            created_at=now - timedelta(hours=1),
        )
    )
    db_session.add(
        DeliveryLog(
            stream_id=stream_id,
            stage=PROTECTION_COMPLETE_STAGE,
            level="INFO",
            status="OK",
            message="protection complete",
            payload_sample={"protected_event_count": 5},
            created_at=now - timedelta(hours=2),
        )
    )
    db_session.add(
        DeliveryLog(
            stream_id=stream_id,
            stage=QUARANTINE_EVENT_CREATED_STAGE,
            level="INFO",
            status="OK",
            message="quarantine created",
            payload_sample={"quarantine_event_id": 1},
            created_at=now - timedelta(hours=3),
        )
    )
    db_session.add(
        DeliveryLog(
            stream_id=stream_id,
            stage=REPLAY_EVENT_REPLAYED_STAGE,
            level="INFO",
            status="OK",
            message="replay complete",
            payload_sample={"replay_event_id": 1},
            created_at=now - timedelta(hours=4),
        )
    )
    db_session.add(
        DeliveryLog(
            stream_id=stream_id,
            stage=AI_GATEWAY_EVALUATION_COMPLETE_STAGE,
            level="INFO",
            status="OK",
            message="ai gateway evaluation complete",
            payload_sample={"decision": "block"},
            created_at=now - timedelta(hours=1),
        )
    )
    db_session.add(
        AiGatewayRequest(
            request_id="req-block-1",
            stream_id=stream_id,
            classification_level="RESTRICTED",
            decision="block",
            provider="mock",
            processing_time_ms=12,
            matched_policy_count=1,
            created_at=now - timedelta(hours=1),
        )
    )
    db_session.commit()

    resp = governance_client.get("/api/v1/governance/summary")
    assert resp.status_code == 200
    body = resp.json()

    assert body["classification_rules"] == 1
    assert body["protection_rules"] == 1
    # AI Gateway is out of Data Relay OSS product scope — governance no longer couples to AI tables.
    assert body["ai_gateway_policies"] == 0
    assert body["has_governance_rules"] is True
    assert body["pending_quarantine_events"] == 1
    assert body["pending_replay_events"] == 1
    assert body["recent_24h"]["classified_events"] == 1
    assert body["recent_24h"]["protected_events"] == 5
    assert body["recent_24h"]["quarantined_events"] == 1
    assert body["recent_24h"]["replayed_events"] == 1
    assert body["recent_24h"]["blocked_ai_requests"] == 0
    assert body["risk_overview"]["restricted_events"] == 3
    assert body["risk_overview"]["confidential_events"] == 2
    assert body["risk_overview"]["quarantine_pending"] == body["pending_quarantine_events"]
    assert body["risk_overview"]["replay_pending"] == body["pending_replay_events"]
    assert body["risk_overview"]["ai_gateway_blocks"] == 0
    assert body["health"]["status"] == "healthy"
    assert body["health"]["ai_gateway_blocks_24h"] == 0
    assert len(body["activity_timeline"]) >= 2
    assert body["cards"]["quarantine"]["top_stream_id"] == stream_id
    assert body["cards"]["replay"]["top_stream_id"] == stream_id


def test_governance_summary_large_counts(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    now = datetime.now(timezone.utc)

    for i in range(50):
        db_session.add(
            StreamClassificationRule(
                stream_id=stream_id,
                name=f"rule-{i}",
                enabled=True,
                condition_json={"sensitivity_class": "pii"},
                classification_level="INTERNAL",
            )
        )
    db_session.add(
        DeliveryLog(
            stream_id=stream_id,
            stage=CLASSIFICATION_COMPLETE_STAGE,
            level="INFO",
            status="OK",
            message="classification complete",
            payload_sample={"classification_level": "INTERNAL", "total_internal_count": 999_999},
            created_at=now - timedelta(minutes=30),
        )
    )
    db_session.commit()

    summary = build_governance_summary(db_session)
    assert summary.classification_rules == 50
    assert summary.recent_24h.classified_events == 1
    assert summary.risk_overview.restricted_events == 0
    assert summary.has_governance_rules is True


def test_governance_summary_health_warning_threshold(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])

    db_session.add(
        StreamClassificationRule(
            stream_id=stream_id,
            name="gov-class",
            enabled=True,
            condition_json={"sensitivity_class": "pii"},
            classification_level="RESTRICTED",
        )
    )
    for _ in range(6):
        db_session.add(
            StreamQuarantineEvent(
                stream_id=stream_id,
                quarantine_reason="policy:test",
                quarantine_source=QUARANTINE_SOURCE_POLICY,
                status=QUARANTINE_STATUS_QUARANTINED,
                protected_payload_json={"events": []},
                metadata_json={"event_count": 1},
            )
        )
    db_session.commit()

    summary = build_governance_summary(db_session)
    assert summary.health.status.value == "warning"
    assert summary.health.pending_quarantine_events == 6
    assert any("quarantine" in reason.lower() for reason in summary.health.reasons)


def test_governance_summary_ai_blocks_outside_24h_excluded_from_risk(
    db_session: Session,
) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    now = datetime.now(timezone.utc)

    db_session.add(
        AiGatewayPolicy(
            name="block-restricted",
            enabled=True,
            condition_json={"classification_level": "RESTRICTED"},
            action_type="block",
        )
    )
    db_session.add(
        AiGatewayRequest(
            request_id="req-old-block",
            stream_id=stream_id,
            classification_level="RESTRICTED",
            decision="block",
            provider="mock",
            processing_time_ms=12,
            matched_policy_count=1,
            created_at=now - timedelta(days=3),
        )
    )
    db_session.commit()

    summary = build_governance_summary(db_session)
    assert summary.recent_24h.blocked_ai_requests == 0
    assert summary.risk_overview.ai_gateway_blocks == 0
    assert summary.health.ai_gateway_blocks_24h == 0


def test_governance_summary_bounded_delivery_log_queries(db_session: Session) -> None:
    """24h metrics must use a single bounded delivery_logs aggregate (no per-stage COUNT loop)."""

    from app.governance import service as governance_service

    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    now = datetime.now(timezone.utc)
    db_session.add(
        DeliveryLog(
            stream_id=stream_id,
            stage=CLASSIFICATION_COMPLETE_STAGE,
            level="INFO",
            status="OK",
            message="classification complete",
            payload_sample={"classification_level": "INTERNAL"},
            created_at=now - timedelta(minutes=10),
        )
    )
    db_session.commit()

    with patch.object(governance_service, "_build_24h_delivery_log_metrics", wraps=governance_service._build_24h_delivery_log_metrics) as delivery_metrics:
        with patch.object(governance_service, "_build_24h_blocked_ai_requests", wraps=governance_service._build_24h_blocked_ai_requests) as ai_blocks:
            build_governance_summary(db_session)
            assert delivery_metrics.call_count == 1
            assert ai_blocks.call_count == 1


def test_governance_summary_performance_large_dataset(db_session: Session) -> None:
    """Smoke performance: 2k recent rows should stay well under 2s on SQLite test DB."""

    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    now = datetime.now(timezone.utc)

    db_session.add(
        StreamClassificationRule(
            stream_id=stream_id,
            name="perf-rule",
            enabled=True,
            condition_json={"sensitivity_class": "pii"},
            classification_level="INTERNAL",
        )
    )
    for i in range(2000):
        db_session.add(
            DeliveryLog(
                stream_id=stream_id,
                stage=CLASSIFICATION_COMPLETE_STAGE if i % 2 == 0 else PROTECTION_COMPLETE_STAGE,
                level="INFO",
                status="OK",
                message="perf row",
                payload_sample={"protected_event_count": 1, "classification_level": "INTERNAL"},
                created_at=now - timedelta(minutes=i % 60),
            )
        )
    db_session.commit()

    started = time.perf_counter()
    summary = build_governance_summary(db_session)
    elapsed = time.perf_counter() - started

    assert summary.recent_24h.classified_events >= 1
    assert elapsed < 2.0, f"summary build took {elapsed:.3f}s (expected < 2s)"


def test_governance_summary_no_unbounded_ai_gateway_count_query(db_session: Session) -> None:
    """OSS governance must not query ai_gateway_* tables at all."""

    engine = db_session.get_bind()
    statements: list[str] = []

    def _capture(_conn, _cursor, statement, _parameters, _context, _executemany):
        statements.append(str(statement))

    event.listen(engine, "before_cursor_execute", _capture)
    try:
        build_governance_summary(db_session)
    finally:
        event.remove(engine, "before_cursor_execute", _capture)

    ai_queries = [sql for sql in statements if "ai_gateway" in sql.lower()]
    assert ai_queries == []
