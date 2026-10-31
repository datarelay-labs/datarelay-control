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
from app.runtime.operational_snapshot_repository import (
    FAILURE_STAGES,
    SUCCESS_STAGES,
    DestinationEntityRow,
    LastOutcomeRow,
    OperationalSnapshotBulkData,
    RouteEntityRow,
    StreamEntityRow,
    WindowAggregateRow,
)
from app.runtime.operational_snapshot_service import (
    _assemble_snapshot,
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
    # Owner decision D3: a route ERROR escalates the destination only with the
    # destination's own delivery-failure evidence (policy blocks are not delivery
    # failures), so the destination's delivery outcome is now passed explicitly.
    dest = classify_destination_health(
        enabled=True,
        route_healths=["ERROR"],
        last_success_at=NOW - timedelta(minutes=2),
        last_error_at=NOW,
        failed_eps_1m=0.05,
    )
    assert dest == "ERROR"


def test_multi_route_destination_partial_is_degraded() -> None:
    # D3: delivery-failure evidence passed explicitly (see test above).
    dest = classify_destination_health(
        enabled=True,
        route_healths=["HEALTHY", "ERROR"],
        last_success_at=NOW,
        last_error_at=NOW,
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


# --- Runtime health semantics: no evidence != Healthy; policy blocks != delivery failure ---


def _route_entity(rid: int, *, destination_id: int) -> RouteEntityRow:
    return RouteEntityRow(
        id=rid,
        stream_id=1,
        stream_name="s1",
        destination_id=destination_id,
        destination_name=f"d{destination_id}",
        destination_type="WEBHOOK_POST",
        enabled=True,
        failure_policy="LOG_AND_CONTINUE",
    )


def _bulk_for_destination(
    *,
    destination: DestinationEntityRow,
    route_last: dict[int, LastOutcomeRow] | None = None,
    destination_last: dict[int, LastOutcomeRow] | None = None,
    route_agg_5m: dict[int, WindowAggregateRow] | None = None,
    route_ids: tuple[int, ...] = (10,),
) -> OperationalSnapshotBulkData:
    return OperationalSnapshotBulkData(
        now=NOW,
        since_1m=NOW - timedelta(minutes=1),
        since_5m=NOW - timedelta(minutes=5),
        streams=[StreamEntityRow(id=1, name="s1", connector_id=1, source_id=1, enabled=True, status="RUNNING")],
        routes=[_route_entity(rid, destination_id=destination.id) for rid in route_ids],
        destinations=[destination],
        checkpoints={},
        routes_per_stream={},
        routes_per_destination={},
        stream_agg_1m={},
        stream_agg_5m={},
        stream_input_1m={},
        stream_input_5m={},
        route_agg_1m={},
        route_agg_5m=route_agg_5m or {},
        destination_agg_1m={},
        destination_agg_5m={},
        stream_last={},
        route_last=route_last or {},
        destination_last=destination_last or {},
    )


def _dest(did: int = 100, *, probe: bool | None = None) -> DestinationEntityRow:
    return DestinationEntityRow(
        id=did,
        name=f"d{did}",
        destination_type="WEBHOOK_POST",
        enabled=True,
        last_connectivity_test_success=probe,
    )


def test_zero_attempts_success_rate_is_none() -> None:
    """Scenario 5: no completed attempts -> success rate None (never 0 or 100)."""

    snap = _assemble_snapshot(
        _bulk_for_destination(
            destination=_dest(),
            # Window row present but with zero completed attempts.
            route_agg_5m={10: WindowAggregateRow(10, 0, 0, 0, None)},
        )
    )
    # Old code: 0.0.
    assert snap.routes[0].success_rate_5m is None
    assert snap.streams[0].success_rate_5m is None
    assert snap.streams[0].failure_rate_5m is None


def test_exact_success_rate_from_completed_attempts() -> None:
    """Scenario 6: 3 successes + 1 failure -> 75.0; policy stages never count as attempts."""

    assert "policy_blocked" not in FAILURE_STAGES
    assert "policy_blocked" not in SUCCESS_STAGES
    snap = _assemble_snapshot(
        _bulk_for_destination(
            destination=_dest(),
            route_agg_5m={10: WindowAggregateRow(10, 3, 1, 0, None)},
            route_last={10: LastOutcomeRow(10, NOW - timedelta(seconds=10), NOW - timedelta(seconds=20), "x")},
        )
    )
    assert snap.routes[0].success_rate_5m == 75.0


def test_policy_blocked_route_error_does_not_escalate_destination() -> None:
    """D3: route keeps ERROR for a policy block; the destination does not escalate."""

    # Route last_error_at includes policy dispositions (ROUTE_DIAGNOSTIC_FAILURE_STAGES);
    # the destination's own outcomes are delivery-only (no failure).
    snap = _assemble_snapshot(
        _bulk_for_destination(
            destination=_dest(),
            route_last={
                10: LastOutcomeRow(10, NOW - timedelta(minutes=2), NOW - timedelta(seconds=10), "policy_blocked")
            },
            destination_last={100: LastOutcomeRow(100, NOW - timedelta(minutes=2), None, None)},
        )
    )
    assert snap.routes[0].health_status == "ERROR"
    # Old code: destination ERROR plus a critical destination problem.
    assert snap.destinations[0].health_status == "HEALTHY"
    assert not any(p.scope == "destination" for p in snap.problems)


def test_route_error_with_delivery_failure_still_escalates_destination() -> None:
    assert (
        classify_destination_health(
            enabled=True,
            route_healths=["ERROR"],
            last_success_at=NOW - timedelta(minutes=2),
            last_error_at=NOW - timedelta(seconds=10),
            now=NOW,
        )
        == "ERROR"
    )
    # Policy-only route ERROR with no delivery failure: no escalation.
    assert (
        classify_destination_health(
            enabled=True,
            route_healths=["ERROR"],
            last_success_at=NOW - timedelta(minutes=2),
            now=NOW,
        )
        == "HEALTHY"
    )
    # Recent delivery failure on one route, newer success elsewhere: DEGRADED.
    assert (
        classify_destination_health(
            enabled=True,
            route_healths=["HEALTHY", "ERROR"],
            last_success_at=NOW - timedelta(seconds=5),
            last_error_at=NOW - timedelta(minutes=3),
            now=NOW,
        )
        == "DEGRADED"
    )


def test_destination_probe_only_is_idle_not_healthy() -> None:
    """D2: passing connectivity test with zero delivery attempts -> IDLE."""

    # Old code: HEALTHY from the probe alone.
    assert (
        classify_destination_health(
            enabled=True,
            route_healths=[],
            last_success_at=None,
            last_connectivity_test_success=True,
            now=NOW,
        )
        == "IDLE"
    )
    snap = _assemble_snapshot(_bulk_for_destination(destination=_dest(probe=True)))
    assert snap.destinations[0].health_status == "IDLE"


def test_destination_and_route_with_old_success_only_are_idle() -> None:
    """Zero recent traffic is not a failure and not HEALTHY."""

    old = NOW - timedelta(hours=2)
    assert (
        classify_route_health(
            enabled=True, last_success_at=old, last_error_at=None, failed_eps_1m=0.0, retry_rate_5m=0.0, now=NOW
        )
        == "IDLE"
    )
    assert (
        classify_destination_health(enabled=True, route_healths=["IDLE"], last_success_at=old, now=NOW) == "IDLE"
    )
