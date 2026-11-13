"""F-124: push (webhook) ingest reports partial delivery and holds the failed route's events for replay."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.replay.models import StreamReplayEvent
from tests.test_webhook_receiver_ingest import (  # noqa: F401  (fixtures re-exported for pytest)
    _seed_webhook_stream,
    client,
    sent_webhook_batches,
)

_HEADERS = {"X-GDC-Webhook-Secret": "secret-1"}
_OK = "https://receiver-ok.example.com/events"
_FAIL = "https://receiver-fail.example.com/events"


def _replay_rows(db: Session, stream_id: int) -> list[StreamReplayEvent]:
    return db.query(StreamReplayEvent).filter(StreamReplayEvent.stream_id == stream_id).all()


@pytest.fixture(autouse=True)
def _no_backoff_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.runners.stream_runner.time.sleep", lambda _s: None)


@pytest.mark.parametrize(
    "policy",
    ["LOG_AND_CONTINUE", "PAUSE_STREAM_ON_FAILURE", "DISABLE_ROUTE_ON_FAILURE", "RETRY_AND_BACKOFF"],
)
def test_partial_failure_is_reported_and_held_once_for_replay(
    policy: str,
    client: TestClient,
    db_session: Session,
    sent_webhook_batches: list[dict[str, Any]],
) -> None:
    seeded = _seed_webhook_stream(
        db_session,
        route_urls=[_OK, _FAIL],
        failure_policies=["LOG_AND_CONTINUE", policy],
    )
    response = client.post(
        "/api/v1/ingest/webhook/rx-test",
        json={"id": "p-1", "message": "partial"},
        headers=_HEADERS,
    )

    assert response.status_code == 200  # compatibility: the payload was received and processed
    body = response.json()
    assert body["accepted"] is True
    assert body["delivery_status"] == "partial"
    assert response.headers["X-GDC-Delivery-Status"] == "partial"
    delivery = body["delivery"]
    assert delivery["delivered_route_count"] == 1
    assert delivery["failed_route_count"] == 1
    assert delivery["resend_not_needed"] is True
    assert "Do not resend" in delivery["message"]

    rows = _replay_rows(db_session, seeded["stream_id"])
    # Exactly one held replay event, and only for the route that failed.
    assert [(row.route_id, row.status, row.event_count) for row in rows] == [(seeded["route_ids"][1], "pending", 1)]
    assert delivery["failed_route_ids"] == [seeded["route_ids"][1]]
    assert delivery["replay_event_ids"] == [rows[0].id]
    assert delivery["replay_pending_event_count"] == 1


def test_all_routes_failing_is_reported_as_failed(
    client: TestClient,
    db_session: Session,
    sent_webhook_batches: list[dict[str, Any]],
) -> None:
    seeded = _seed_webhook_stream(db_session, route_urls=[_FAIL])
    response = client.post("/api/v1/ingest/webhook/rx-test", json={"id": "f-1", "message": "x"}, headers=_HEADERS)

    assert response.status_code == 200
    assert response.json()["delivery_status"] == "failed"
    assert response.headers["X-GDC-Delivery-Status"] == "failed"
    assert len(_replay_rows(db_session, seeded["stream_id"])) == 1


def test_fully_delivered_push_is_complete_without_replay(
    client: TestClient,
    db_session: Session,
    sent_webhook_batches: list[dict[str, Any]],
) -> None:
    seeded = _seed_webhook_stream(db_session, route_urls=[_OK])
    response = client.post("/api/v1/ingest/webhook/rx-test", json={"id": "c-1", "message": "x"}, headers=_HEADERS)

    body = response.json()
    assert body["delivery_status"] == "complete"
    assert body["delivery"]["resend_not_needed"] is False
    assert body["delivery"]["replay_event_ids"] == []
    assert _replay_rows(db_session, seeded["stream_id"]) == []


def test_retry_and_backoff_that_recovers_records_no_replay_event(
    client: TestClient,
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    def _flaky(self: object, events: list[dict[str, Any]], config: dict[str, Any], *args: Any, **kwargs: Any) -> None:
        calls.append(str(config.get("url")))
        if len(calls) == 1:
            raise RuntimeError("first attempt fails, retry succeeds")

    monkeypatch.setattr("app.delivery.webhook_sender.WebhookSender.send", _flaky)
    seeded = _seed_webhook_stream(db_session, route_urls=[_OK], failure_policies=["RETRY_AND_BACKOFF"])
    response = client.post("/api/v1/ingest/webhook/rx-test", json={"id": "r-1", "message": "x"}, headers=_HEADERS)

    assert response.status_code == 200
    assert len(calls) == 2
    # The retry delivered the events; replaying them would deliver a duplicate.
    assert _replay_rows(db_session, seeded["stream_id"]) == []
