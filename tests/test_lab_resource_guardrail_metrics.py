"""Regression coverage for lab throughput/resource-budget accounting."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy.orm import Session

from app.config import settings
from app.connectors.models import Connector
from app.dev_validation_lab.lab_resource_guardrail import _collect_db_metrics, evaluate_lab_resource_budget
from app.logs.models import DeliveryLog
from app.sources.models import Source
from app.streams.models import Stream


def _enable_lab(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "ENABLE_DEV_VALIDATION_LAB", True, raising=False)
    monkeypatch.setattr(settings, "APP_ENV", "development", raising=False)


def _stream(db: Session, name: str) -> Stream:
    connector = Connector(name=f"connector-{name}", status="RUNNING")
    db.add(connector)
    db.flush()
    source = Source(
        connector_id=connector.id,
        source_type="HTTP_API_POLLING",
        config_json={},
        auth_json={},
        enabled=True,
    )
    db.add(source)
    db.flush()
    stream = Stream(
        connector_id=connector.id,
        source_id=source.id,
        name=name,
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=1,
        enabled=True,
        status="RUNNING",
        rate_limit_json={},
    )
    db.add(stream)
    db.flush()
    return stream


def _log(db: Session, *, stream_id: int, stage: str, payload: dict) -> None:
    db.add(
        DeliveryLog(
            stream_id=stream_id,
            stage=stage,
            level="INFO",
            status="OK",
            message=stage,
            payload_sample=payload,
            created_at=datetime.now(timezone.utc),
        )
    )


def test_recent_eps_uses_max_lab_stream_input_events_not_stage_log_rows(
    monkeypatch: pytest.MonkeyPatch, db_session: Session
) -> None:
    _enable_lab(monkeypatch)
    lab_a = _stream(db_session, "[DEV E2E] A")
    lab_b = _stream(db_session, "[DEV VALIDATION] B")
    normal = _stream(db_session, "Operator Stream")

    # Lab A = 120 input events/10m => 0.2 EPS; Lab B = 300 => 0.5 EPS.
    _log(db_session, stream_id=lab_a.id, stage="run_complete", payload={"input_events": 40})
    _log(db_session, stream_id=lab_a.id, stage="run_complete", payload={"input_events": 80})
    _log(db_session, stream_id=lab_b.id, stage="run_complete", payload={"input_events": 300})
    # Stage amplification must not inflate event EPS.
    for _ in range(30):
        _log(db_session, stream_id=lab_b.id, stage="policy_complete", payload={})
    # Non-lab operator traffic must not set the lab throughput guardrail.
    _log(db_session, stream_id=normal.id, stage="run_complete", payload={"input_events": 60_000})
    db_session.commit()

    metrics = _collect_db_metrics(db_session)
    assert metrics["lab_run_rows_last_10m"] == 3
    assert metrics["max_stream_input_events_last_10m"] == 300
    assert metrics["recent_eps"] == 0.5
    assert metrics["delivery_logs_rows_last_10m"] >= 34


def test_run_activity_budget_ignores_stage_amplification_when_new_metric_present(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_lab(monkeypatch)
    result = evaluate_lab_resource_budget(
        metrics_override={
            "delivery_logs_rows": 50_000,
            "delivery_logs_rows_last_10m": 50_000,
            "lab_run_rows_last_10m": 100,
            "delivery_logs_estimated_size": 10_000,
            "recent_eps": 10.0,
            "alert_history_rows": 0,
            "replay_event_rows": 0,
            "wiremock_journal_entries": 0,
        }
    )
    assert result["status"] == "ok"
    assert result["should_pause_lab"] is False
    assert not any("rows_last_10m" in reason for reason in result["exceeded_reasons"])


def test_legacy_metrics_override_keeps_rows_last_10m_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_lab(monkeypatch)
    result = evaluate_lab_resource_budget(
        metrics_override={
            "delivery_logs_rows": 50_000,
            "delivery_logs_rows_last_10m": 12_001,
            "delivery_logs_estimated_size": 10_000,
            "recent_eps": 10.0,
            "alert_history_rows": 0,
            "replay_event_rows": 0,
            "wiremock_journal_entries": 0,
        }
    )
    assert result["status"] == "exceeded"
    assert result["should_pause_lab"] is True
    assert "delivery_logs_rows_last_10m>12000" in result["exceeded_reasons"]
