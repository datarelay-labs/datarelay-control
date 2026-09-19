"""Regression: persistent source outages must not score as HEALTHY.

Discovered by the 8.51h Continuous E2E overnight soak (http_source / postgres /
s3 / sftp): run-once correctly returned SOURCE_FETCH_FAILED (or 5xx), but
operational health_status remained HEALTHY because stream posture only consumed
route delivery stages and ignored delivery_logs.stage=run_failed.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from app.runtime.health_scoring_model import compute_health_score_for_mode
from app.runtime.health_snapshot_read import _snapshot_outcome
from app.runtime.operational_snapshot_repository import (
    FAILURE_STAGES,
    STREAM_FAILURE_STAGES,
    STREAM_OUTCOME_STAGES,
    STREAM_SUCCESS_STAGES,
    is_stream_failure_stage,
)
from app.runtime.operational_snapshot_service import (
    classify_destination_health,
    classify_route_health,
    classify_stream_health,
)

UTC = timezone.utc
NOW = datetime(2026, 9, 13, 12, 0, 0, tzinfo=UTC)


def test_run_failed_is_stream_failure_not_route_failure() -> None:
    assert "run_failed" in STREAM_FAILURE_STAGES
    assert "run_failed" in STREAM_OUTCOME_STAGES
    assert "run_failed" not in FAILURE_STAGES
    assert "source_fetch" in STREAM_SUCCESS_STAGES
    assert "source_fetch" not in FAILURE_STAGES
    assert is_stream_failure_stage("run_failed")
    assert not is_stream_failure_stage("run_complete")
    assert not is_stream_failure_stage("source_fetch")


def test_healthy_source_fetch_scores_healthy() -> None:
    row = SimpleNamespace(
        eps_5m=0.1,
        failure_rate_5m=0.0,
        retry_rate_5m=0.0,
        failed_route_count=0,
        avg_latency_ms=15.0,
        last_error_at=None,
        last_success_at=NOW,
    )
    agg = _snapshot_outcome(row)  # type: ignore[arg-type]
    score = compute_health_score_for_mode(agg, agg, scoring_mode="current_runtime", include_latency=False)
    assert score.level == "HEALTHY"
    assert (
        classify_stream_health(
            enabled=True,
            status="RUNNING",
            last_success_at=NOW,
            last_error_at=None,
            failure_rate_5m=0.0,
            failed_route_count=0,
            healthy_route_count=1,
            route_count=1,
        )
        == "HEALTHY"
    )


def test_empty_successful_fetch_is_idle_or_healthy_not_error() -> None:
    """Valid empty / no-data must not become a source ERROR."""

    idle = classify_stream_health(
        enabled=True,
        status="RUNNING",
        last_success_at=None,
        last_error_at=None,
        failure_rate_5m=0.0,
    )
    assert idle == "IDLE"
    historical_idle = classify_stream_health(
        enabled=True,
        status="RUNNING",
        last_success_at=NOW - timedelta(hours=12),
        last_error_at=None,
        failure_rate_5m=0.0,
        failed_route_count=0,
        healthy_route_count=1,
        route_count=1,
    )
    assert historical_idle == "HEALTHY"
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


def test_transient_retry_success_does_not_leave_error() -> None:
    """Final successful delivery after retry must classify HEALTHY (not stale ERROR)."""

    assert (
        classify_stream_health(
            enabled=True,
            status="RUNNING",
            last_success_at=NOW,
            last_error_at=NOW - timedelta(seconds=30),
            failure_rate_5m=0.0,
            failed_route_count=0,
            healthy_route_count=1,
            route_count=1,
        )
        == "HEALTHY"
    )


def test_persistent_source_outage_not_healthy_via_last_error() -> None:
    """run_failed updates last_error newer than last_success → must not stay HEALTHY."""

    health = classify_stream_health(
        enabled=True,
        status="RUNNING",
        last_success_at=NOW - timedelta(minutes=10),
        last_error_at=NOW,
        failure_rate_5m=0.0,
        failed_route_count=0,
        healthy_route_count=1,
        route_count=1,
    )
    assert health != "HEALTHY"
    assert health in {"DEGRADED", "ERROR"}


def test_persistent_source_outage_error_via_failure_rate() -> None:
    """Window of only run_failed events → failure_rate 100 → ERROR."""

    assert (
        classify_stream_health(
            enabled=True,
            status="RUNNING",
            last_success_at=NOW - timedelta(minutes=10),
            last_error_at=NOW,
            failure_rate_5m=100.0,
            failed_route_count=0,
            healthy_route_count=1,
            route_count=1,
        )
        == "ERROR"
    )


def test_snapshot_outcome_source_outage_without_route_failures() -> None:
    """Scored health must not ignore last_error>last_success when failed_route_count=0."""

    row = SimpleNamespace(
        eps_5m=0.0,
        failure_rate_5m=0.0,
        retry_rate_5m=0.0,
        failed_route_count=0,
        avg_latency_ms=None,
        last_error_at=NOW,
        last_success_at=NOW - timedelta(minutes=5),
    )
    agg = _snapshot_outcome(row)  # type: ignore[arg-type]
    assert agg.failure_count >= 1
    score = compute_health_score_for_mode(agg, agg, scoring_mode="current_runtime", include_latency=False)
    assert score.level != "HEALTHY"


def test_timeout_and_connection_outage_same_classifier_path() -> None:
    """Timeout / connection refused share the same last_error posture as 5xx."""

    for failure_rate in (0.0, 100.0):
        health = classify_stream_health(
            enabled=True,
            status="RUNNING",
            last_success_at=NOW - timedelta(minutes=2),
            last_error_at=NOW,
            failure_rate_5m=failure_rate,
            failed_route_count=0,
            healthy_route_count=1,
            route_count=1,
        )
        assert health != "HEALTHY"


def test_source_recovery_returns_healthy() -> None:
    assert (
        classify_stream_health(
            enabled=True,
            status="RUNNING",
            last_success_at=NOW,
            last_error_at=NOW - timedelta(minutes=3),
            failure_rate_5m=0.0,
            failed_route_count=0,
            healthy_route_count=1,
            route_count=1,
        )
        == "HEALTHY"
    )


def test_source_recovery_not_stuck_on_lagging_failure_window() -> None:
    """After successful fetch, lagging 5m run_failed rate must not keep ERROR."""

    assert (
        classify_stream_health(
            enabled=True,
            status="RUNNING",
            last_success_at=NOW,
            last_error_at=NOW - timedelta(minutes=1),
            failure_rate_5m=100.0,
            failed_route_count=0,
            healthy_route_count=1,
            route_count=1,
        )
        == "HEALTHY"
    )


def test_destination_total_failure_still_error_when_unrecovered() -> None:
    """PR #30: unrecovered total delivery failure remains ERROR despite old success."""

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


def test_destination_total_and_partial_regression() -> None:
    """PR #30 destination semantics must remain intact."""

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
    assert (
        classify_route_health(
            enabled=True,
            last_success_at=NOW - timedelta(minutes=2),
            last_error_at=NOW,
            failed_eps_1m=0.05,
            retry_rate_5m=0.0,
        )
        == "ERROR"
    )
    assert (
        classify_destination_health(
            enabled=True,
            route_healths=["ERROR"],
            last_success_at=NOW - timedelta(minutes=2),
        )
        == "ERROR"
    )
    assert (
        classify_destination_health(
            enabled=True,
            route_healths=["HEALTHY", "DEGRADED"],
            last_success_at=NOW,
        )
        == "DEGRADED"
    )


def test_idle_s3_canonical_no_data_not_error() -> None:
    row = SimpleNamespace(
        eps_5m=0.0,
        failure_rate_5m=0.0,
        retry_rate_5m=0.0,
        failed_route_count=0,
        avg_latency_ms=None,
        last_error_at=None,
        last_success_at=NOW - timedelta(days=1),
    )
    agg = _snapshot_outcome(row)  # type: ignore[arg-type]
    assert agg.failure_count == 0
    health = classify_stream_health(
        enabled=True,
        status="RUNNING",
        last_success_at=NOW - timedelta(days=1),
        last_error_at=None,
        failure_rate_5m=0.0,
        failed_route_count=0,
        healthy_route_count=1,
        route_count=1,
    )
    assert health == "HEALTHY"


def test_degraded_source_outage_surfaces_dashboard_operational_problem() -> None:
    """Source 500 after prior success is DEGRADED; dashboard must still list a problem."""

    from app.runtime.operational_snapshot_schemas import OperationalStreamSnapshot
    from app.runtime.operational_snapshot_service import _build_problems

    stream = OperationalStreamSnapshot(
        stream_id=7,
        stream_name="e2e-http-source",
        enabled=True,
        status="RUNNING",
        health_status="DEGRADED",
        eps_1m=0.0,
        eps_5m=0.2,
        success_rate_5m=80.0,
        failure_rate_5m=0.0,
        route_count=2,
        healthy_route_count=2,
        failed_route_count=0,
        last_success_at=NOW - timedelta(minutes=5),
        last_error_at=NOW,
        last_error_message="HTTP 500 from source",
    )
    problems = _build_problems(stream_snapshots=[stream], route_snapshots=[], destination_snapshots=[])
    assert len(problems) >= 1
    assert problems[0].severity == "warning"
    assert problems[0].stream_id == 7
    assert "500" in (problems[0].message or "")
