"""F-015: a Source/auth failure (HTTP 401 on every poll) must reach operational problems.

The Dashboard "Action needed" list is built from ``problems``. A Source outage used to
surface only as a generic Stream "delivery failures" warning with no cause and no
Connector. These tests pin the additive Source-failure attribution and the H1 runtime
health semantics: failure needs recorded evidence, a newer successful fetch supersedes
it, zero traffic / no observation is never a failure, and stopped Streams carry no
verdict.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.logs.models import DeliveryLog
from app.runtime.operational_snapshot_repository import (
    SourceFailureRow,
    fetch_stream_source_failures,
)
from app.runtime.operational_snapshot_schemas import OperationalStreamSnapshot
from app.runtime.operational_snapshot_service import (
    build_operational_snapshot,
    build_source_failure_problems,
)
from tests.test_operational_snapshot_endpoint import _mk_hierarchy

UTC = timezone.utc
SOURCE_401 = "HTTP 401 for GET http://127.0.0.1:19994/noauth/events?limit=20&api_key=do-not-leak"


def _log(db: Session, h: dict, *, stage: str, when: datetime, message: str, error_code: str | None = None) -> None:
    failed = stage == "run_failed"
    db.add(
        DeliveryLog(
            connector_id=h["connector_id"],
            stream_id=h["stream_id"],
            stage=stage,
            level="ERROR" if failed else "INFO",
            status="FAILED" if failed else "OK",
            message=message,
            payload_sample={},
            retry_count=0,
            error_code=error_code,
            created_at=when,
        )
    )


def _source_problems(db: Session, stream_id: int):
    snapshot = build_operational_snapshot(db)
    return [p for p in snapshot.problems if p.scope == "stream" and p.stream_id == stream_id and p.error_code]


def test_source_401_every_poll_names_stream_and_connector(db_session: Session) -> None:
    h = _mk_hierarchy(db_session, stream_name="src-auth-401")
    now = datetime.now(UTC)
    for minutes in (4, 3, 2, 1):
        _log(
            db_session, h, stage="run_failed", when=now - timedelta(minutes=minutes),
            message=SOURCE_401, error_code="SOURCE_FETCH_FAILED",
        )
    db_session.commit()

    problems = _source_problems(db_session, h["stream_id"])
    assert len(problems) == 1
    problem = problems[0]
    assert problem.severity == "critical"
    assert problem.error_code == "SOURCE_AUTH_FAILED"
    assert problem.http_status == 401
    assert problem.connector_id == h["connector_id"]
    assert problem.connector_name == "conn-src-auth-401"
    assert "src-auth-401" in problem.title and "HTTP 401" in problem.title
    assert problem.last_seen_at is not None
    # The upstream URL / query string is never copied into the operational problem.
    assert "do-not-leak" not in problem.title + problem.message
    assert "127.0.0.1" not in problem.title + problem.message


def test_newer_successful_source_fetch_supersedes_the_failure(db_session: Session) -> None:
    h = _mk_hierarchy(db_session, stream_name="src-recovered")
    now = datetime.now(UTC)
    _log(db_session, h, stage="run_failed", when=now - timedelta(minutes=3), message=SOURCE_401, error_code="SOURCE_FETCH_FAILED")
    _log(db_session, h, stage="source_fetch", when=now - timedelta(minutes=1), message="fetched 0 events")
    db_session.commit()

    assert _source_problems(db_session, h["stream_id"]) == []


def test_failure_after_a_success_is_reported_again(db_session: Session) -> None:
    h = _mk_hierarchy(db_session, stream_name="src-relapse")
    now = datetime.now(UTC)
    _log(db_session, h, stage="source_fetch", when=now - timedelta(minutes=5), message="fetched 3 events")
    _log(db_session, h, stage="run_failed", when=now - timedelta(minutes=1), message="HTTP 403 for GET http://x/y", error_code="SOURCE_FETCH_FAILED")
    db_session.commit()

    (problem,) = _source_problems(db_session, h["stream_id"])
    assert problem.error_code == "SOURCE_AUTH_FAILED"
    assert problem.http_status == 403


def test_no_log_evidence_is_not_a_source_failure(db_session: Session) -> None:
    h = _mk_hierarchy(db_session, stream_name="src-never-observed")
    db_session.commit()

    assert _source_problems(db_session, h["stream_id"]) == []


def test_non_source_run_failures_are_not_attributed_to_the_source(db_session: Session) -> None:
    h = _mk_hierarchy(db_session, stream_name="src-internal-error")
    now = datetime.now(UTC)
    _log(db_session, h, stage="run_failed", when=now - timedelta(minutes=1), message="boom", error_code="RUNTIME_INTERNAL_ERROR")
    db_session.commit()

    assert _source_problems(db_session, h["stream_id"]) == []


def test_stopped_or_disabled_streams_carry_no_source_verdict(db_session: Session) -> None:
    now = datetime.now(UTC)
    stopped = _mk_hierarchy(db_session, stream_name="src-stopped", stream_status="STOPPED")
    disabled = _mk_hierarchy(db_session, stream_name="src-disabled", stream_enabled=False)
    for h in (stopped, disabled):
        _log(db_session, h, stage="run_failed", when=now - timedelta(minutes=1), message=SOURCE_401, error_code="SOURCE_FETCH_FAILED")
    db_session.commit()

    assert _source_problems(db_session, stopped["stream_id"]) == []
    assert _source_problems(db_session, disabled["stream_id"]) == []


def test_non_auth_source_failure_keeps_a_distinct_code(db_session: Session) -> None:
    h = _mk_hierarchy(db_session, stream_name="src-timeout")
    now = datetime.now(UTC)
    _log(db_session, h, stage="run_failed", when=now - timedelta(minutes=1), message="HTTP polling failed after retries: timed out", error_code="SOURCE_FETCH_FAILED")
    db_session.commit()

    (problem,) = _source_problems(db_session, h["stream_id"])
    assert problem.error_code == "SOURCE_FETCH_FAILED"
    assert problem.http_status is None
    assert problem.connector_name == "conn-src-timeout"


def test_repository_ignores_failures_outside_the_last_outcome_window(db_session: Session) -> None:
    h = _mk_hierarchy(db_session, stream_name="src-old")
    now = datetime.now(UTC)
    _log(db_session, h, stage="run_failed", when=now - timedelta(hours=30), message=SOURCE_401, error_code="SOURCE_FETCH_FAILED")
    db_session.commit()

    assert fetch_stream_source_failures(db_session, group_ids=[h["stream_id"]]) == {}


def test_existing_problem_fields_are_unchanged_for_non_source_problems(db_session: Session) -> None:
    h = _mk_hierarchy(db_session, stream_name="src-plain")
    db_session.commit()

    snapshot = build_operational_snapshot(db_session)
    dumped = [p.model_dump() for p in snapshot.problems if p.stream_id == h["stream_id"]]
    for row in dumped:
        assert row["error_code"] is None and row["connector_id"] is None and row["http_status"] is None


def _stream_snapshot(**patch) -> OperationalStreamSnapshot:
    base = dict(
        stream_id=7, stream_name="Orders", connector_id=3, source_id=1, enabled=True, status="RUNNING",
        health_status="DEGRADED", eps_1m=0.0, eps_5m=0.0, success_rate_5m=None, failure_rate_5m=None,
        route_count=1, healthy_route_count=1, failed_route_count=0,
    )
    base.update(patch)
    return OperationalStreamSnapshot(**base)


def _failure(message: str | None = SOURCE_401, http_status: int | None = None) -> SourceFailureRow:
    return SourceFailureRow(
        stream_id=7,
        last_source_failure_at=datetime(2026, 10, 31, 13, 5, tzinfo=UTC),
        last_source_failure_message=message,
        last_source_failure_http_status=http_status,
        last_source_success_at=None,
    )


def test_pure_builder_prefers_the_stored_http_status_and_handles_missing_connector() -> None:
    (problem,) = build_source_failure_problems(
        stream_snapshots=[_stream_snapshot()],
        source_failures={7: _failure(message="opaque", http_status=401)},
        connector_names={},
    )
    assert problem.http_status == 401
    assert problem.connector_id == 3
    assert problem.connector_name is None
    assert "its Connector" in problem.message


def test_pure_builder_skips_paused_streams() -> None:
    assert build_source_failure_problems(
        stream_snapshots=[_stream_snapshot(status="PAUSED")],
        source_failures={7: _failure()},
        connector_names={3: "Orders API"},
    ) == []
