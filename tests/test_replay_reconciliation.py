"""WP-E replay correctness: de-duplication, reconciliation, override and discard.

Covers audit findings E-051 (Logs replay vs Replay Center job), E-113 (jobs stay executable
after the events were delivered), E-114 (one new Pending job per poll) and E-116 (no discard).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.auth.jwt_service import issue_access_token
from app.database import get_db, get_db_read_bounded
from app.destinations.adapters.registry import DestinationAdapterRegistry
from app.logs.models import DeliveryLog
from app.replay.models import (
    REPLAY_CONTEXT_FAILURE_OCCURRENCES_KEY,
    REPLAY_STATUS_DISCARDED,
    REPLAY_STATUS_PENDING,
    REPLAY_STATUS_REPLAYED,
    StreamReplayEvent,
)
from app.replay.reconciliation import (
    SUPERSEDE_SOURCE_RUNTIME_DELIVERY,
    compute_event_identities,
    supersede_delivered_jobs,
)
from app.replay.recording import record_stream_replay_event
from app.replay.service import ReplayEventStateError, discard_replay_event, execute_replay_event
from app.runners.stream_loader import load_stream_context
from app.runtime import replay_service
from app.runtime.errors import DestinationSendError
from tests.test_governance_replay_m20_1 import _governance_app
from tests.test_replay_engine_m11 import _ReplayWebhookSender
from tests.test_stream_runner_e2e import _FakePoller, _FakeWebhookSender, _build_runner, _seed_stream_runtime

_EVENTS = [{"id": 341, "message": "m341"}, {"id": 342, "message": "m342"}, {"id": 343, "message": "m343"}]


def _record(
    db: Session,
    seeded: dict[str, Any],
    events: list[dict[str, Any]] | None = None,
    *,
    error: Exception | None = None,
    window: str | None = "w1",
    run_id: str | None = None,
) -> StreamReplayEvent | None:
    row = record_stream_replay_event(
        db,
        stream_id=int(seeded["stream_id"]),
        destination_id=int(seeded["destination_ids"][0]),
        delivery_kind="base_route",
        events=list(events if events is not None else _EVENTS),
        destination_type="WEBHOOK_POST",
        formatter_override=None,
        prefix_context=None,
        error=error if error is not None else DestinationSendError("HTTP 500"),
        route_id=int(seeded["route_ids"][0]),
        source_window=window,
        run_id=run_id,
    )
    db.commit()
    return row


def _job_count(db: Session, seeded: dict[str, Any]) -> int:
    db.expire_all()
    return db.query(StreamReplayEvent).filter(StreamReplayEvent.stream_id == int(seeded["stream_id"])).count()


def _supersede(
    db: Session,
    seeded: dict[str, Any],
    events: list[dict[str, Any]],
    *,
    window: str | None = "w1",
    run_ids: tuple[str, ...] = (),
) -> list[int]:
    ids = supersede_delivered_jobs(
        db,
        stream_id=int(seeded["stream_id"]),
        destination_id=int(seeded["destination_ids"][0]),
        route_id=int(seeded["route_ids"][0]),
        delivered_events=events,
        source=SUPERSEDE_SOURCE_RUNTIME_DELIVERY,
        window=window,
        known_run_ids=run_ids,
    )
    db.commit()
    return ids


# --------------------------------------------------------------------------- E-114


def test_repeated_failure_of_same_events_reuses_open_job(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    first = _record(db_session, seeded)
    second = _record(db_session, seeded)
    third = _record(db_session, seeded)

    assert first is not None and second is not None and third is not None
    assert first.id == second.id == third.id
    assert _job_count(db_session, seeded) == 1
    db_session.refresh(first)
    assert first.delivery_context_json[REPLAY_CONTEXT_FAILURE_OCCURRENCES_KEY] == 3
    assert first.status == REPLAY_STATUS_PENDING


def test_different_events_or_route_get_their_own_job(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session, failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE"])
    base = _record(db_session, seeded)
    other_events = _record(db_session, seeded, [{"id": 999, "message": "other"}])
    other_route = record_stream_replay_event(
        db_session,
        stream_id=int(seeded["stream_id"]),
        destination_id=int(seeded["destination_ids"][1]),
        delivery_kind="base_route",
        events=list(_EVENTS),
        destination_type="WEBHOOK_POST",
        formatter_override=None,
        prefix_context=None,
        error=DestinationSendError("HTTP 500"),
        route_id=int(seeded["route_ids"][1]),
    )
    db_session.commit()

    assert base is not None and other_events is not None and other_route is not None
    assert len({base.id, other_events.id, other_route.id}) == 3


def test_grown_batch_is_a_new_job_and_runtime_metadata_is_ignored(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    first = _record(db_session, seeded, [{"id": 1, "m": "a", "__gdc_dedup_queue_id": 1}])
    same = _record(db_session, seeded, [{"id": 1, "m": "a", "__gdc_dedup_queue_id": 7}])
    grown = _record(db_session, seeded, [{"id": 1, "m": "a"}, {"id": 2, "m": "b"}])
    assert first is not None and same is not None and grown is not None
    assert first.id == same.id
    assert grown.id != first.id


@pytest.mark.parametrize("terminal", [REPLAY_STATUS_REPLAYED, REPLAY_STATUS_DISCARDED])
def test_closed_job_is_not_reused_for_a_new_failure(db_session: Session, terminal: str) -> None:
    seeded = _seed_stream_runtime(db_session)
    first = _record(db_session, seeded)
    assert first is not None
    first.status = terminal
    db_session.commit()
    again = _record(db_session, seeded)
    assert again is not None and again.id != first.id


def test_pushes_without_a_window_are_never_folded_together(db_session: Session) -> None:
    """Codex P1: independent webhook pushes with identical payloads stay separate jobs."""

    seeded = _seed_stream_runtime(db_session)
    a = _record(db_session, seeded, window=None, run_id="push-1")
    b = _record(db_session, seeded, window=None, run_id="push-2")
    assert a is not None and b is not None
    assert a.id != b.id
    assert _job_count(db_session, seeded) == 2


def test_different_windows_with_same_content_are_separate_jobs(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    a = _record(db_session, seeded, window="w1", run_id="r1")
    b = _record(db_session, seeded, window="w2", run_id="r2")
    c = _record(db_session, seeded, window="w1", run_id="r3")
    assert a is not None and b is not None and c is not None
    assert a.id != b.id and a.id == c.id
    db_session.refresh(a)
    assert a.delivery_context_json["run_ids"] == ["r1", "r3"]


def test_delivery_of_another_push_does_not_supersede_an_undelivered_push(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    failed_push = _record(db_session, seeded, window=None, run_id="push-1")
    assert failed_push is not None
    # An identical later push (different run, no window) delivered fine: push-1 was NOT delivered.
    assert _supersede(db_session, seeded, list(_EVENTS), window=None, run_ids=("push-2",)) == []
    # A different window does not close it either.
    assert _supersede(db_session, seeded, list(_EVENTS), window="w9") == []
    db_session.refresh(failed_push)
    assert failed_push.status == REPLAY_STATUS_PENDING
    # Only the same run (e.g. retry/failover inside that push) proves the occurrence.
    assert _supersede(db_session, seeded, list(_EVENTS), window=None, run_ids=("push-1",)) == [int(failed_push.id)]


def test_logs_replay_does_not_supersede_job_of_another_run(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    other_push_job = _record(db_session, seeded, window=None, run_id="some-other-push")
    log_row = _failed_log(db_session, seeded, _EVENTS)  # run_id == "run-wpe"
    assert other_push_job is not None
    replay_service.replay_delivery_log(
        db_session, int(log_row.id), destination_registry=DestinationAdapterRegistry(webhook_sender=_FakeWebhookSender())
    )
    db_session.commit()
    db_session.refresh(other_push_job)
    assert other_push_job.status == REPLAY_STATUS_PENDING


# --------------------------------------------------------------------------- E-113


def test_delivery_of_all_events_supersedes_open_job(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    job = _record(db_session, seeded)
    assert job is not None

    assert _supersede(db_session, seeded, list(_EVENTS)) == [int(job.id)]

    db_session.refresh(job)
    assert job.status == REPLAY_STATUS_DISCARDED
    assert job.delivery_context_json["reconciliation"]["state"] == "superseded"
    with pytest.raises(ReplayEventStateError) as exc:
        execute_replay_event(
            db_session,
            int(job.id),
            destination_registry=DestinationAdapterRegistry(webhook_sender=_ReplayWebhookSender()),
        )
    assert exc.value.error_code == "REPLAY_SUPERSEDED"
    assert "already" in exc.value.message.lower() or "automatically" in exc.value.message.lower()


def test_partial_or_foreign_delivery_leaves_job_executable(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session, failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE"])
    job = _record(db_session, seeded)
    assert job is not None

    assert _supersede(db_session, seeded, _EVENTS[:2]) == []
    # Same events delivered by a different Route/Destination do not satisfy this job.
    assert (
        supersede_delivered_jobs(
            db_session,
            stream_id=int(seeded["stream_id"]),
            destination_id=int(seeded["destination_ids"][1]),
            route_id=int(seeded["route_ids"][1]),
            delivered_events=list(_EVENTS),
            source=SUPERSEDE_SOURCE_RUNTIME_DELIVERY,
            window="w1",
        )
        == []
    )
    db_session.refresh(job)
    assert job.status == REPLAY_STATUS_PENDING


def test_superset_delivery_supersedes_job(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    job = _record(db_session, seeded, _EVENTS[:2])
    assert job is not None
    assert _supersede(db_session, seeded, list(_EVENTS)) == [int(job.id)]


def test_runner_failure_poll_dedupes_then_recovery_supersedes(db_session: Session) -> None:
    """E-114 + E-113 end to end: failing polls keep one job; a healthy poll closes it."""

    seeded = _seed_stream_runtime(db_session, failure_policies=["RETRY_AND_BACKOFF"])
    url = "https://receiver-0.example.com/events"
    sender = _FakeWebhookSender(fail_urls={url})
    items = [{"id": f"evt-{i}", "message": f"m{i}", "vendor": "V"} for i in range(1, 4)]
    runner = _build_runner(poller=_FakePoller(response={"items": items}), webhook_sender=sender)

    for _ in range(3):
        runner.run(load_stream_context(db_session, int(seeded["stream_id"])), db=db_session)
        db_session.commit()

    db_session.expire_all()
    jobs = db_session.query(StreamReplayEvent).filter(StreamReplayEvent.stream_id == int(seeded["stream_id"])).all()
    assert len(jobs) == 1, "one job per (stream, route, event set), not one per poll"
    assert jobs[0].status == REPLAY_STATUS_PENDING
    assert jobs[0].delivery_context_json[REPLAY_CONTEXT_FAILURE_OCCURRENCES_KEY] == 3

    sender.fail_urls.clear()
    runner.run(load_stream_context(db_session, int(seeded["stream_id"])), db=db_session)
    db_session.commit()

    db_session.expire_all()
    job = db_session.get(StreamReplayEvent, int(jobs[0].id))
    assert job is not None
    assert job.status == REPLAY_STATUS_DISCARDED
    assert job.delivery_context_json["reconciliation"]["source"] == SUPERSEDE_SOURCE_RUNTIME_DELIVERY


def test_replayed_sibling_blocks_legacy_duplicate_without_override(db_session: Session) -> None:
    """Legacy duplicate jobs (#33..#37 in the audit): replaying one must not silently re-send the rest.

    Legacy rows carry no occurrence identity, so they are never auto-closed (that could drop an
    undelivered occurrence) but the execute guard refuses them until the operator overrides.
    """

    seeded = _seed_stream_runtime(db_session)
    now = datetime.now(timezone.utc)
    rows: list[StreamReplayEvent] = []
    for i in range(3):
        row = StreamReplayEvent(
            stream_id=int(seeded["stream_id"]),
            destination_id=int(seeded["destination_ids"][0]),
            route_id=int(seeded["route_ids"][0]),
            delivery_kind="base_route",
            status=REPLAY_STATUS_PENDING,
            protected_payload_json={"events": list(_EVENTS)},
            delivery_context_json={"destination_type": "WEBHOOK_POST", "replay_origin": "delivery_failure"},
            event_count=len(_EVENTS),
            created_at=now - timedelta(minutes=10 - i),
            updated_at=now - timedelta(minutes=10 - i),
        )
        db_session.add(row)
        rows.append(row)
    db_session.commit()

    sender = _ReplayWebhookSender()
    registry = DestinationAdapterRegistry(webhook_sender=sender)
    execute_replay_event(db_session, int(rows[0].id), destination_registry=registry)
    db_session.commit()
    assert len(sender.calls) == 1

    for sibling in rows[1:]:
        with pytest.raises(ReplayEventStateError) as exc:
            execute_replay_event(db_session, int(sibling.id), destination_registry=registry)
        assert exc.value.error_code == "REPLAY_ALREADY_DELIVERED"
    assert len(sender.calls) == 1
    # Explicit override still works.
    execute_replay_event(db_session, int(rows[1].id), destination_registry=registry, allow_redelivery=True)
    assert len(sender.calls) == 2


def test_replay_job_supersedes_same_window_siblings(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    first = _record(db_session, seeded, window="w1", run_id="run-a")
    # Force a second open job for the same window (e.g. rows recorded before dedup existed).
    twin = StreamReplayEvent(
        stream_id=first.stream_id,
        destination_id=first.destination_id,
        route_id=first.route_id,
        delivery_kind="base_route",
        status=REPLAY_STATUS_PENDING,
        protected_payload_json=first.protected_payload_json,
        delivery_context_json=dict(first.delivery_context_json),
        event_count=first.event_count,
    )
    db_session.add(twin)
    db_session.commit()

    sender = _ReplayWebhookSender()
    execute_replay_event(
        db_session, int(first.id), destination_registry=DestinationAdapterRegistry(webhook_sender=sender)
    )
    db_session.commit()
    db_session.refresh(twin)
    assert twin.status == REPLAY_STATUS_DISCARDED
    assert twin.delivery_context_json["reconciliation"]["source"] == "replay_job"


def test_execute_guard_blocks_then_override_delivers(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    open_job = _record(db_session, seeded)
    assert open_job is not None
    # A sibling replayed after this failure was recorded, but never superseded it (e.g. its
    # events were a different batch shape) -> guard must still stop an unaware duplicate.
    sibling = StreamReplayEvent(
        stream_id=int(seeded["stream_id"]),
        destination_id=int(seeded["destination_ids"][0]),
        route_id=int(seeded["route_ids"][0]),
        delivery_kind="base_route",
        status=REPLAY_STATUS_REPLAYED,
        protected_payload_json={"events": list(_EVENTS) + [{"id": 344, "message": "m344"}]},
        delivery_context_json={"destination_type": "WEBHOOK_POST", "replay_origin": "delivery_failure"},
        event_count=4,
        updated_at=datetime.now(timezone.utc) + timedelta(seconds=1),
        last_replay_at=datetime.now(timezone.utc) + timedelta(seconds=1),
    )
    db_session.add(sibling)
    db_session.commit()

    sender = _ReplayWebhookSender()
    registry = DestinationAdapterRegistry(webhook_sender=sender)
    with pytest.raises(ReplayEventStateError) as exc:
        execute_replay_event(db_session, int(open_job.id), destination_registry=registry)
    assert exc.value.error_code == "REPLAY_ALREADY_DELIVERED"
    assert sender.calls == []

    result = execute_replay_event(
        db_session, int(open_job.id), destination_registry=registry, allow_redelivery=True
    )
    assert result["outcome"] == "replayed"
    assert len(sender.calls) == 1


def test_identical_content_delivered_before_the_failure_does_not_block(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    old = StreamReplayEvent(
        stream_id=int(seeded["stream_id"]),
        destination_id=int(seeded["destination_ids"][0]),
        route_id=int(seeded["route_ids"][0]),
        delivery_kind="base_route",
        status=REPLAY_STATUS_REPLAYED,
        protected_payload_json={"events": list(_EVENTS)},
        delivery_context_json={"destination_type": "WEBHOOK_POST", "replay_origin": "delivery_failure"},
        event_count=len(_EVENTS),
        created_at=datetime.now(timezone.utc) - timedelta(days=1),
        updated_at=datetime.now(timezone.utc) - timedelta(days=1),
        last_replay_at=datetime.now(timezone.utc) - timedelta(days=1),
    )
    db_session.add(old)
    db_session.commit()
    job = _record(db_session, seeded)
    assert job is not None

    sender = _ReplayWebhookSender()
    result = execute_replay_event(
        db_session, int(job.id), destination_registry=DestinationAdapterRegistry(webhook_sender=sender)
    )
    assert result["outcome"] == "replayed"


# --------------------------------------------------------------------------- E-051 (Logs path)


def _failed_log(db: Session, seeded: dict[str, Any], events: list[dict[str, Any]]) -> DeliveryLog:
    row = DeliveryLog(
        connector_id=None,
        stream_id=int(seeded["stream_id"]),
        route_id=int(seeded["route_ids"][0]),
        destination_id=int(seeded["destination_ids"][0]),
        stage="route_send_failed",
        level="ERROR",
        status="FAILED",
        message="webhook send failed",
        payload_sample={"stage": "route_send_failed", "replay_events": list(events)},
        retry_count=0,
        error_code="RuntimeError",
        run_id="run-wpe",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def test_logs_replay_supersedes_open_job_for_same_events(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    job = _record(db_session, seeded, run_id="run-wpe")
    log_row = _failed_log(db_session, seeded, _EVENTS)
    assert job is not None

    sender = _FakeWebhookSender()
    registry = DestinationAdapterRegistry(webhook_sender=sender)
    result = replay_service.replay_delivery_log(db_session, int(log_row.id), destination_registry=registry)
    db_session.commit()

    assert result.outcome == "delivered"
    db_session.refresh(job)
    assert job.status == REPLAY_STATUS_DISCARDED
    assert job.delivery_context_json["reconciliation"]["source"] == "logs_replay"
    with pytest.raises(ReplayEventStateError) as exc:
        execute_replay_event(
            db_session,
            int(job.id),
            destination_registry=DestinationAdapterRegistry(webhook_sender=_ReplayWebhookSender()),
        )
    assert exc.value.error_code == "REPLAY_SUPERSEDED"
    assert len(sender.calls) == 1


def test_logs_replay_blocked_after_job_replayed_and_override_allowed(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    job = _record(db_session, seeded, run_id="run-wpe")
    log_row = _failed_log(db_session, seeded, _EVENTS)
    assert job is not None
    execute_replay_event(
        db_session,
        int(job.id),
        destination_registry=DestinationAdapterRegistry(webhook_sender=_ReplayWebhookSender()),
    )
    db_session.commit()

    sender = _FakeWebhookSender()
    registry = DestinationAdapterRegistry(webhook_sender=sender)
    with pytest.raises(replay_service.ReplayAlreadyDeliveredError) as exc:
        replay_service.replay_delivery_log(db_session, int(log_row.id), destination_registry=registry)
    assert exc.value.error_code == "REPLAY_ALREADY_DELIVERED"
    assert sender.calls == []

    # A dry run never delivers, so it is never blocked.
    dry = replay_service.replay_delivery_log(db_session, int(log_row.id), dry_run=True, destination_registry=registry)
    assert dry.outcome == "dry_run_ok"

    forced = replay_service.replay_delivery_log(
        db_session, int(log_row.id), destination_registry=registry, allow_redelivery=True
    )
    assert forced.outcome == "delivered"
    assert len(sender.calls) == 1


def test_logs_replay_twice_is_blocked_without_override(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    log_row = _failed_log(db_session, seeded, _EVENTS)
    sender = _FakeWebhookSender()
    registry = DestinationAdapterRegistry(webhook_sender=sender)
    replay_service.replay_delivery_log(db_session, int(log_row.id), destination_registry=registry)
    db_session.commit()
    with pytest.raises(replay_service.ReplayAlreadyDeliveredError):
        replay_service.replay_delivery_log(db_session, int(log_row.id), destination_registry=registry)
    assert len(sender.calls) == 1


# --------------------------------------------------------------------------- Governance API


def _bearer(role: str) -> dict[str, str]:
    token, _ = issue_access_token(username="wpe-test", user_id=7, role=role, token_version=1)
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def gov_client(db_session: Session) -> TestClient:
    app = _governance_app()

    def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_db_read_bounded] = _override_db
    return TestClient(app)


@pytest.fixture
def gov_rbac_client(db_session: Session) -> TestClient:
    app = _governance_app(with_rbac=True)

    def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_db_read_bounded] = _override_db
    return TestClient(app)


def test_detail_and_list_expose_reconciliation_fields(gov_client: TestClient, db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    job = _record(db_session, seeded)
    _record(db_session, seeded)
    assert job is not None

    listed = gov_client.get("/api/v1/governance/replay").json()["replay_events"]
    assert len(listed) == 1
    assert listed[0]["occurrence_count"] == 2
    assert listed[0]["route_id"] == int(seeded["route_ids"][0])
    assert listed[0]["destination_id"] == int(seeded["destination_ids"][0])

    detail = gov_client.get(f"/api/v1/governance/replay/{job.id}").json()
    assert detail["can_execute"] is True and detail["can_discard"] is True

    _supersede(db_session, seeded, list(_EVENTS))
    detail = gov_client.get(f"/api/v1/governance/replay/{job.id}").json()
    assert detail["entry"]["status"] == "DISCARDED"
    assert detail["can_execute"] is False and detail["can_discard"] is False
    assert "automatically" in detail["entry"]["status_note"]


def test_governance_execute_blocked_then_override(gov_client: TestClient, db_session: Session, monkeypatch) -> None:
    seeded = _seed_stream_runtime(db_session)
    job = _record(db_session, seeded)
    assert job is not None
    sibling = StreamReplayEvent(
        stream_id=int(seeded["stream_id"]),
        destination_id=int(seeded["destination_ids"][0]),
        route_id=int(seeded["route_ids"][0]),
        delivery_kind="base_route",
        status=REPLAY_STATUS_REPLAYED,
        protected_payload_json={"events": list(_EVENTS)},
        delivery_context_json={"destination_type": "WEBHOOK_POST", "replay_origin": "delivery_failure"},
        event_count=len(_EVENTS),
        updated_at=datetime.now(timezone.utc) + timedelta(seconds=1),
        last_replay_at=datetime.now(timezone.utc) + timedelta(seconds=1),
    )
    db_session.add(sibling)
    db_session.commit()

    sender = _ReplayWebhookSender()
    monkeypatch.setattr(
        "app.replay.service.WebhookSender", lambda *a, **k: sender
    )

    blocked = gov_client.post(f"/api/v1/governance/replay/{job.id}/execute")
    assert blocked.status_code == 200
    body = blocked.json()
    assert body["outcome"] == "failed"
    assert body["error_code"] == "REPLAY_ALREADY_DELIVERED"
    assert sender.calls == []

    forced = gov_client.post(f"/api/v1/governance/replay/{job.id}/execute", json={"allow_redelivery": True})
    assert forced.status_code == 200
    assert forced.json()["outcome"] == "replayed"
    assert len(sender.calls) == 1


def test_governance_discard_pending_job(gov_client: TestClient, db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    job = _record(db_session, seeded)
    assert job is not None

    resp = gov_client.post(f"/api/v1/governance/replay/{job.id}/discard")
    assert resp.status_code == 200
    body = resp.json()
    assert body["outcome"] == "discarded"
    assert body["status"] == REPLAY_STATUS_DISCARDED
    db_session.refresh(job)
    assert job.status == REPLAY_STATUS_DISCARDED

    again = gov_client.post(f"/api/v1/governance/replay/{job.id}/discard").json()
    assert again["outcome"] == "failed"
    assert gov_client.post("/api/v1/governance/replay/999999/discard").status_code == 404


def test_governance_discard_rejects_replayed_job(gov_client: TestClient, db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    job = _record(db_session, seeded)
    assert job is not None
    job.status = REPLAY_STATUS_REPLAYED
    db_session.commit()
    body = gov_client.post(f"/api/v1/governance/replay/{job.id}/discard").json()
    assert body["outcome"] == "failed"
    db_session.refresh(job)
    assert job.status == REPLAY_STATUS_REPLAYED


def test_governance_bulk_discard(gov_client: TestClient, db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    a = _record(db_session, seeded, [{"id": 1}])
    b = _record(db_session, seeded, [{"id": 2}])
    assert a is not None and b is not None
    resp = gov_client.post("/api/v1/governance/replay/bulk-discard", json={"ids": [a.id, b.id, 999999]})
    assert resp.status_code == 200
    body = resp.json()
    assert body["succeeded"] == 2 and body["failed"] == 1
    db_session.expire_all()
    assert {db_session.get(StreamReplayEvent, i).status for i in (a.id, b.id)} == {REPLAY_STATUS_DISCARDED}


def test_discard_does_not_cancel_fresh_replaying_claim(db_session: Session) -> None:
    from app.replay.models import REPLAY_STATUS_REPLAYING
    from app.replay.service import ReplayInProgressError

    seeded = _seed_stream_runtime(db_session)
    job = _record(db_session, seeded)
    assert job is not None
    job.status = REPLAY_STATUS_REPLAYING
    job.delivery_context_json = {
        **job.delivery_context_json,
        "delivery_attempt": {"attempt_id": "a1", "claimed_at": datetime.now(timezone.utc).isoformat()},
    }
    db_session.commit()
    with pytest.raises(ReplayInProgressError):
        discard_replay_event(db_session, int(job.id))


@pytest.mark.parametrize(
    ("role", "expected"),
    [
        ("GOVERNANCE_OPERATOR", 200),
        ("ADMINISTRATOR", 200),
        ("GOVERNANCE_REVIEWER", 403),
        ("GOVERNANCE_AUDITOR", 403),
        ("VIEWER", 403),
    ],
)
def test_discard_rbac_matches_execute(
    gov_rbac_client: TestClient, db_session: Session, role: str, expected: int
) -> None:
    seeded = _seed_stream_runtime(db_session)
    job = _record(db_session, seeded)
    assert job is not None
    execute_status = gov_rbac_client.post(
        f"/api/v1/governance/replay/{job.id}/execute", headers=_bearer(role)
    ).status_code
    discard = gov_rbac_client.post(f"/api/v1/governance/replay/{job.id}/discard", headers=_bearer(role))
    bulk = gov_rbac_client.post(
        "/api/v1/governance/replay/bulk-discard", json={"ids": [job.id]}, headers=_bearer(role)
    )
    assert discard.status_code == expected
    assert bulk.status_code == expected
    assert (execute_status == 403) == (expected == 403), "discard must never be looser than execute"


def test_compute_event_identities_ignores_runtime_meta() -> None:
    a = compute_event_identities([{"id": 1, "__gdc_dedup_queue_id": 1}])
    b = compute_event_identities([{"id": 1, "__gdc_dedup_queue_id": 9}])
    assert a == b
