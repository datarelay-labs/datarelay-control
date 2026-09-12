"""Regression: destination delivery failures must not score as HEALTHY.

Discovered by the 7.51h Continuous E2E overnight soak (webhook_dest / syslog_dest):
input > 0, destination unavailable, delivered = 0, but operational / scored health
remained HEALTHY. Spec 012 snapshot scoring reconstructed failure_count from
success_eps × failure_rate, which collapses to 0 when success EPS is 0.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from app.runtime.health_scoring_model import compute_health_score_for_mode
from app.runtime.health_snapshot_read import _snapshot_outcome
from app.runtime.operational_snapshot_service import (
    classify_destination_health,
    classify_route_health,
    classify_stream_health,
)

UTC = timezone.utc
NOW = datetime(2026, 9, 12, 12, 0, 0, tzinfo=UTC)


def test_snapshot_outcome_total_route_failure_is_not_empty() -> None:
    """Route snapshots have failed_eps_1m, not eps_5m — must not score empty/HEALTHY."""

    row = SimpleNamespace(
        delivered_eps_1m=0.0,
        failed_eps_1m=0.05,
        retry_rate_5m=0.0,
        avg_latency_ms=12.0,
        last_error_at=NOW,
        last_success_at=NOW - timedelta(minutes=2),
    )
    agg = _snapshot_outcome(row)  # type: ignore[arg-type]
    assert agg.success_count == 0
    assert agg.failure_count >= 1
    score = compute_health_score_for_mode(agg, agg, scoring_mode="current_runtime", include_latency=False)
    assert score.level != "HEALTHY"
    assert score.score < 90


def test_snapshot_outcome_total_stream_failure_with_zero_success_eps() -> None:
    """Stream outage window: eps_5m=0 and failure_rate=100 must not collapse to HEALTHY."""

    row = SimpleNamespace(
        eps_5m=0.0,
        failure_rate_5m=100.0,
        retry_rate_5m=0.0,
        failed_route_count=1,
        avg_latency_ms=None,
        last_error_at=NOW,
        last_success_at=NOW - timedelta(minutes=10),
    )
    agg = _snapshot_outcome(row)  # type: ignore[arg-type]
    assert agg.success_count == 0
    assert agg.failure_count >= 1
    score = compute_health_score_for_mode(agg, agg, scoring_mode="current_runtime", include_latency=False)
    assert score.level != "HEALTHY"


def test_snapshot_outcome_destination_failure_eps() -> None:
    row = SimpleNamespace(
        inbound_eps_1m=0.0,
        failed_eps_1m=0.02,
        retry_rate_5m=0.0,
        avg_latency_ms=5.0,
        last_error_at=NOW,
        last_success_at=NOW - timedelta(minutes=1),
    )
    agg = _snapshot_outcome(row)  # type: ignore[arg-type]
    assert agg.failure_count >= 1
    score = compute_health_score_for_mode(agg, agg, scoring_mode="current_runtime", include_latency=False)
    assert score.level != "HEALTHY"


def test_snapshot_outcome_no_data_stays_empty() -> None:
    """No-data / idle: zero success and zero failure must remain empty (not a delivery error)."""

    row = SimpleNamespace(
        eps_5m=0.0,
        failure_rate_5m=0.0,
        retry_rate_5m=0.0,
        failed_route_count=0,
        avg_latency_ms=None,
        last_error_at=None,
        last_success_at=NOW - timedelta(hours=6),
    )
    agg = _snapshot_outcome(row)  # type: ignore[arg-type]
    assert agg.success_count == 0
    assert agg.failure_count == 0


def test_healthy_delivery_scores_healthy() -> None:
    row = SimpleNamespace(
        eps_5m=0.1,
        failure_rate_5m=0.0,
        retry_rate_5m=0.0,
        failed_route_count=0,
        avg_latency_ms=20.0,
        last_error_at=None,
        last_success_at=NOW,
    )
    agg = _snapshot_outcome(row)  # type: ignore[arg-type]
    assert agg.success_count > 0
    assert agg.failure_count == 0
    score = compute_health_score_for_mode(agg, agg, scoring_mode="current_runtime", include_latency=False)
    assert score.level == "HEALTHY"


def test_classify_stream_total_delivery_failure_is_error() -> None:
    assert (
        classify_stream_health(
            enabled=True,
            status="RUNNING",
            last_success_at=NOW - timedelta(minutes=5),
            last_error_at=NOW,
            failure_rate_5m=100.0,
            failed_route_count=1,
            healthy_route_count=0,
            route_count=1,
        )
        == "ERROR"
    )


def test_classify_stream_partial_route_failure_is_degraded() -> None:
    assert (
        classify_stream_health(
            enabled=True,
            status="RUNNING",
            last_success_at=NOW - timedelta(seconds=30),
            last_error_at=NOW,
            failure_rate_5m=25.0,
            failed_route_count=1,
            healthy_route_count=1,
            route_count=2,
        )
        == "DEGRADED"
    )


def test_classify_stream_no_data_is_idle_or_healthy_not_error() -> None:
    idle = classify_stream_health(
        enabled=True,
        status="RUNNING",
        last_success_at=None,
        last_error_at=None,
        failure_rate_5m=0.0,
    )
    assert idle == "IDLE"
    historical_ok = classify_stream_health(
        enabled=True,
        status="RUNNING",
        last_success_at=NOW - timedelta(hours=6),
        last_error_at=None,
        failure_rate_5m=0.0,
        failed_route_count=0,
        healthy_route_count=1,
        route_count=1,
    )
    assert historical_ok == "HEALTHY"


def test_classify_route_and_destination_total_failure() -> None:
    route = classify_route_health(
        enabled=True,
        last_success_at=NOW - timedelta(minutes=2),
        last_error_at=NOW,
        failed_eps_1m=0.05,
        retry_rate_5m=0.0,
    )
    assert route == "ERROR"
    dest = classify_destination_health(
        enabled=True,
        route_healths=["ERROR"],
        last_success_at=NOW - timedelta(minutes=2),
    )
    assert dest == "ERROR"


def test_multi_route_destination_partial_is_degraded() -> None:
    dest = classify_destination_health(
        enabled=True,
        route_healths=["HEALTHY", "ERROR"],
        last_success_at=NOW,
    )
    # Destination rolls up worst route — ERROR when any route is ERROR.
    assert dest == "ERROR"
    # Stream with partial failure rate stays DEGRADED (not total-path ERROR).
    stream = classify_stream_health(
        enabled=True,
        status="RUNNING",
        last_success_at=NOW,
        last_error_at=NOW - timedelta(seconds=1),
        failure_rate_5m=25.0,
        failed_route_count=1,
        healthy_route_count=1,
        route_count=2,
    )
    assert stream == "DEGRADED"
