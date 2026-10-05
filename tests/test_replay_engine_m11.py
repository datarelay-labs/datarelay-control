"""M11 Replay Engine — stream_replay_events record, replay, discard, summary."""

from __future__ import annotations

import hashlib
import json
from typing import Any

import pytest
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.database import get_db, get_db_read_bounded
from app.destinations.adapters.registry import DestinationAdapterRegistry
from app.destinations.models import Destination
from app.logs.models import DeliveryLog
from app.replay.models import REPLAY_STATUS_DISCARDED, REPLAY_STATUS_FAILED, REPLAY_STATUS_PENDING, REPLAY_STATUS_REPLAYED, StreamReplayEvent
from app.replay.recording import record_stream_replay_event
from app.replay.service import checkpoint_unchanged, discard_replay_event, execute_replay_event
from app.routes.models import Route
from app.runtime.errors import DestinationSendError
from app.runtime.schemas import (
    PlatformReplaySummaryResponse,
    ReplayEventActionResponse,
    ReplayEventItem,
    StreamReplayEventsResponse,
    StreamReplaySummaryResponse,
)
from tests.test_stream_runner_e2e import _FakePoller, _build_runner, _seed_stream_runtime
from app.runners.stream_loader import load_stream_context


class _ReplayWebhookSender:
    def __init__(self, *, fail_urls: set[str] | None = None) -> None:
        self.fail_urls = fail_urls or set()
        self.calls: list[dict[str, Any]] = []
    def send(
        self,
        events: list[dict[str, Any]],
        config: dict[str, Any],
        formatter_override: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        self.calls.append({"events": events, "config": config})
        url = str(config.get("url"))
        if url in self.fail_urls:
            raise DestinationSendError(f"webhook send failed: {url}")


def _replay_test_app() -> FastAPI:
    from app.replay import service as replay_engine_service
    from app.streams.repository import get_stream_by_id

    router = APIRouter()

    @router.get("/replay/summary", response_model=PlatformReplaySummaryResponse)
    async def platform_summary(db: Session = Depends(get_db_read_bounded)) -> PlatformReplaySummaryResponse:
        return PlatformReplaySummaryResponse.model_validate(replay_engine_service.build_platform_replay_summary(db))

    @router.get("/streams/{stream_id}/replay/summary", response_model=StreamReplaySummaryResponse)
    async def stream_summary(stream_id: int, db: Session = Depends(get_db_read_bounded)) -> StreamReplaySummaryResponse:
        if get_stream_by_id(db, stream_id) is None:
            raise HTTPException(status_code=404, detail="stream not found")
        return StreamReplaySummaryResponse.model_validate(replay_engine_service.build_stream_replay_summary(db, stream_id))

    @router.get("/streams/{stream_id}/replay-events", response_model=StreamReplayEventsResponse)
    async def list_events(
        stream_id: int,
        status: str | None = Query(None),
        limit: int = Query(50, ge=1, le=200),
        db: Session = Depends(get_db_read_bounded),
    ) -> StreamReplayEventsResponse:
        if get_stream_by_id(db, stream_id) is None:
            raise HTTPException(status_code=404, detail="stream not found")
        events = replay_engine_service.list_stream_replay_events(db, stream_id, status=status, limit=limit)
        items = [ReplayEventItem.model_validate(e) for e in events]
        return StreamReplayEventsResponse(stream_id=stream_id, events=items, event_count=len(items))

    @router.post("/replay-events/{event_id}/replay", response_model=ReplayEventActionResponse)
    async def replay_event(event_id: int, db: Session = Depends(get_db)) -> ReplayEventActionResponse:
        try:
            result = replay_engine_service.execute_replay_event(db, event_id)
            db.commit()
            return ReplayEventActionResponse.model_validate(result)
        except replay_engine_service.ReplayEventNotFoundError:
            raise HTTPException(status_code=404, detail="not found") from None
        except replay_engine_service.ReplayEventStateError as exc:
            code = 409 if exc.error_code in {"REPLAY_DISCARDED", "REPLAY_ALREADY_REPLAYED"} else 422
            raise HTTPException(
                status_code=code,
                detail={"error_code": exc.error_code, "message": exc.message},
            ) from exc
        except replay_engine_service.ReplayInProgressError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @router.post("/replay-events/{event_id}/discard", response_model=ReplayEventActionResponse)
    async def discard_event(event_id: int, db: Session = Depends(get_db)) -> ReplayEventActionResponse:
        try:
            result = replay_engine_service.discard_replay_event(db, event_id)
            db.commit()
            return ReplayEventActionResponse.model_validate(
                {**result, "outcome": "discarded", "message": "discarded"}
            )
        except replay_engine_service.ReplayEventNotFoundError:
            raise HTTPException(status_code=404, detail="not found") from None
        except replay_engine_service.ReplayEventStateError as exc:
            raise HTTPException(status_code=409, detail=exc.message) from exc

    app = FastAPI()
    app.include_router(router, prefix="/api/v1/runtime")
    return app


@pytest.fixture
def replay_api_client(db_session: Session) -> TestClient:
    app = _replay_test_app()

    def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_db_read_bounded] = _override_db
    return TestClient(app)


def _insert_replay_row(
    db: Session,
    *,
    seeded: dict[str, Any],
    events: list[dict[str, Any]],
    status: str = REPLAY_STATUS_PENDING,
) -> StreamReplayEvent:
    row = StreamReplayEvent(
        stream_id=int(seeded["stream_id"]),
        destination_id=int(seeded["destination_ids"][0]),
        route_id=int(seeded["route_ids"][0]),
        delivery_kind="base_route",
        status=status,
        protected_payload_json={"events": events},
        delivery_context_json={
            "destination_type": "WEBHOOK_POST",
            "formatter_override": None,
            "prefix_context": {
                "stream_name": "test",
                "stream_id": int(seeded["stream_id"]),
                "destination_name": "dest",
                "destination_type": "WEBHOOK_POST",
                "route_id": int(seeded["route_ids"][0]),
            },
        },
        event_count=len(events),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _checkpoint_value(db: Session, stream_id: int) -> dict[str, Any]:
    row = db.query(Checkpoint).filter(Checkpoint.stream_id == int(stream_id)).first()
    assert row is not None
    return dict(row.checkpoint_value_json or {})


def _payload_hash(events: list[dict[str, Any]]) -> str:
    canonical = json.dumps(events, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def test_record_excludes_429(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    err = DestinationSendError("rate limited", http_status=429)
    row = record_stream_replay_event(
        db_session,
        stream_id=int(seeded["stream_id"]),
        destination_id=int(seeded["destination_ids"][0]),
        delivery_kind="base_route",
        events=[{"a": 1}],
        destination_type="WEBHOOK_POST",
        formatter_override=None,
        prefix_context=None,
        error=err,
    )
    assert row is None


def test_replay_success_checkpoint_unchanged(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    events = [{"event_id": "e1", "message": "masked"}]
    row = _insert_replay_row(db_session, seeded=seeded, events=events)
    before = _checkpoint_value(db_session, int(seeded["stream_id"]))

    sender = _ReplayWebhookSender()
    registry = DestinationAdapterRegistry(webhook_sender=sender)
    result = execute_replay_event(db_session, int(row.id), destination_registry=registry)
    db_session.commit()

    assert result["outcome"] == "replayed"
    assert result["status"] == REPLAY_STATUS_REPLAYED
    assert len(sender.calls) == 1
    assert sender.calls[0]["events"] == events
    assert checkpoint_unchanged(db_session, int(seeded["stream_id"]), before)

    stages = [
        r.stage
        for r in db_session.query(DeliveryLog).filter(DeliveryLog.stream_id == int(seeded["stream_id"])).all()
    ]
    assert "replay_event_replay_started" in stages
    assert "replay_event_replayed" in stages


def test_replay_failed_then_replayed(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    events = [{"event_id": "e1"}]
    row = _insert_replay_row(db_session, seeded=seeded, events=events)
    dest = db_session.query(Destination).filter(Destination.id == int(seeded["destination_ids"][0])).first()
    assert dest is not None
    url = str((dest.config_json or {}).get("url"))

    fail_sender = _ReplayWebhookSender(fail_urls={url})
    fail_registry = DestinationAdapterRegistry(webhook_sender=fail_sender)
    fail_result = execute_replay_event(db_session, int(row.id), destination_registry=fail_registry)
    db_session.commit()
    assert fail_result["outcome"] == "failed"
    assert fail_result["status"] == REPLAY_STATUS_FAILED
    assert fail_result["retry_count"] == 1

    ok_sender = _ReplayWebhookSender()
    ok_registry = DestinationAdapterRegistry(webhook_sender=ok_sender)
    ok_result = execute_replay_event(db_session, int(row.id), destination_registry=ok_registry)
    db_session.commit()
    assert ok_result["outcome"] == "replayed"
    assert ok_result["status"] == REPLAY_STATUS_REPLAYED
    assert ok_result["retry_count"] == 2


def test_discarded_cannot_replay(replay_api_client: TestClient, db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    row = _insert_replay_row(
        db_session,
        seeded=seeded,
        events=[{"x": 1}],
        status=REPLAY_STATUS_DISCARDED,
    )
    res = replay_api_client.post(f"/api/v1/runtime/replay-events/{row.id}/replay")
    assert res.status_code == 409


def test_discard_pending(replay_api_client: TestClient, db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    row = _insert_replay_row(db_session, seeded=seeded, events=[{"x": 1}])
    res = replay_api_client.post(f"/api/v1/runtime/replay-events/{row.id}/discard")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == REPLAY_STATUS_DISCARDED


def test_payload_hash_immutable_on_replay(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    events = [{"k": "v", "n": 2}]
    before_hash = _payload_hash(events)
    row = _insert_replay_row(db_session, seeded=seeded, events=events)
    sender = _ReplayWebhookSender()
    result = execute_replay_event(
        db_session,
        int(row.id),
        destination_registry=DestinationAdapterRegistry(webhook_sender=sender),
    )
    assert result["payload_hash"] == before_hash
    sent_hash = _payload_hash(sender.calls[0]["events"])
    assert sent_hash == before_hash


def test_summary_bounded(replay_api_client: TestClient, db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    _insert_replay_row(db_session, seeded=seeded, events=[{"a": 1}])
    res = replay_api_client.get(f"/api/v1/runtime/streams/{seeded['stream_id']}/replay/summary")
    assert res.status_code == 200
    body = res.json()
    assert body["pending_count"] >= 1
    assert body["total_count"] >= 1


def test_runner_records_on_route_failure(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    poller = _FakePoller(
        response={"items": [{"id": "evt-replay-1", "message": "replay-record", "vendor": "MappedVendor"}]}
    )
    sender = _ReplayWebhookSender(fail_urls={"https://receiver-0.example.com/events"})
    runner = _build_runner(poller=poller, webhook_sender=sender)
    ctx = load_stream_context(db_session, int(seeded["stream_id"]))
    runner.run(ctx, db=db_session)
    db_session.commit()

    rows = (
        db_session.query(StreamReplayEvent)
        .filter(StreamReplayEvent.stream_id == int(seeded["stream_id"]))
        .all()
    )
    assert len(rows) >= 1
    assert rows[0].status == REPLAY_STATUS_PENDING
    assert isinstance(rows[0].protected_payload_json, dict)


def test_replayed_cannot_replay_again(db_session: Session) -> None:
    from app.replay.service import ReplayEventStateError

    seeded = _seed_stream_runtime(db_session)
    row = _insert_replay_row(db_session, seeded=seeded, events=[{"id": "c1"}])
    sender = _ReplayWebhookSender()
    registry = DestinationAdapterRegistry(webhook_sender=sender)
    execute_replay_event(db_session, int(row.id), destination_registry=registry)
    db_session.commit()
    with pytest.raises(ReplayEventStateError) as exc:
        execute_replay_event(db_session, int(row.id), destination_registry=registry)
    assert exc.value.error_code == "REPLAY_ALREADY_REPLAYED"
    assert len(sender.calls) == 1
