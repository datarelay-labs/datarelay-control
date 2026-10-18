from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database import get_db
from app.destinations.models import Destination
from app.destinations.test_delivery_service import run_bounded_destination_test_delivery
from app.main import app
from app.runtime.errors import DestinationSendError


class _RecordingAdapter:
    def __init__(self) -> None:
        self.calls: list[tuple[list[dict[str, Any]], dict[str, Any]]] = []

    def send(self, events, config, formatter_override=None, **kwargs) -> None:
        self.calls.append((events, config))


class _RecordingRegistry:
    def __init__(self, adapter: _RecordingAdapter) -> None:
        self.adapter = adapter
        self.types: list[str] = []

    def get(self, destination_type: str):
        self.types.append(destination_type)
        return self.adapter


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def _destination(
    db_session: Session,
    *,
    enabled: bool = True,
    destination_type: str = "WEBHOOK_POST",
) -> Destination:
    config = (
        {"url": "https://user:secret@example.test/receiver?token=hidden"}
        if destination_type == "WEBHOOK_POST"
        else {"host": "127.0.0.1", "port": 5514}
    )
    row = Destination(
        name="bounded-test",
        destination_type=destination_type,
        config_json=config,
        rate_limit_json={},
        enabled=enabled,
    )
    db_session.add(row)
    db_session.commit()
    db_session.refresh(row)
    return row


def test_service_sends_exact_requested_synthetic_events_without_exposing_webhook_query(
    db_session: Session,
) -> None:
    row = _destination(db_session)
    adapter = _RecordingAdapter()
    registry = _RecordingRegistry(adapter)

    result = run_bounded_destination_test_delivery(row, count=10, registry=registry)

    assert registry.types == ["WEBHOOK_POST"]
    assert len(adapter.calls) == 1
    events, config = adapter.calls[0]
    assert len(events) == 10
    assert [event["sequence"] for event in events] == list(range(1, 11))
    assert all(event["datarelay_test_delivery"] is True for event in events)
    assert len({event["test_delivery_id"] for event in events}) == 1
    assert config["url"].endswith("?token=hidden")
    assert result["logical_event_count"] == 10
    assert result["target"] == "https://example.test/receiver"
    assert "secret" not in result["target"]
    assert "token" not in result["target"]


@pytest.mark.parametrize("count", [0, 101])
def test_service_rejects_out_of_bounds_count(db_session: Session, count: int) -> None:
    row = _destination(db_session)
    with pytest.raises(ValueError, match="between 1 and 100"):
        run_bounded_destination_test_delivery(row, count=count, registry=_RecordingRegistry(_RecordingAdapter()))


def test_endpoint_defaults_to_ten_and_returns_delivery_identity(client: TestClient, db_session: Session) -> None:
    row = _destination(db_session)
    fake = {
        "success": True,
        "destination_id": row.id,
        "destination_name": row.name,
        "destination_type": row.destination_type,
        "target": "https://example.test/receiver",
        "transport_format": "WEBHOOK_POST / SINGLE_EVENT_OBJECT",
        "logical_event_count": 10,
        "test_delivery_id": "test-123",
        "tested_at": "2026-10-14T06:30:00+00:00",
        "message": "Sent 10 synthetic logical test events.",
    }
    with patch("app.destinations.router.run_bounded_destination_test_delivery", return_value=fake) as send:
        response = client.post(f"/api/v1/destinations/{row.id}/test-delivery", json={})

    assert response.status_code == 200
    assert response.json()["logical_event_count"] == 10
    assert response.json()["test_delivery_id"] == "test-123"
    send.assert_called_once_with(row, count=10)


@pytest.mark.parametrize("count", [0, 101])
def test_endpoint_enforces_count_bounds_before_send(
    client: TestClient,
    db_session: Session,
    count: int,
) -> None:
    row = _destination(db_session)
    with patch("app.destinations.router.run_bounded_destination_test_delivery") as send:
        response = client.post(
            f"/api/v1/destinations/{row.id}/test-delivery",
            json={"count": count},
        )
    assert response.status_code == 422
    send.assert_not_called()


def test_endpoint_rejects_disabled_destination_without_send(client: TestClient, db_session: Session) -> None:
    row = _destination(db_session, enabled=False)
    with patch("app.destinations.router.run_bounded_destination_test_delivery") as send:
        response = client.post(
            f"/api/v1/destinations/{row.id}/test-delivery",
            json={"count": 5},
        )
    assert response.status_code == 409
    assert response.json()["detail"]["error_code"] == "DESTINATION_TEST_DELIVERY_DISABLED"
    send.assert_not_called()


def test_endpoint_returns_safe_gateway_failure(client: TestClient, db_session: Session) -> None:
    row = _destination(db_session)
    with patch(
        "app.destinations.router.run_bounded_destination_test_delivery",
        side_effect=DestinationSendError("https://user:secret@example.test/private failed"),
    ):
        response = client.post(
            f"/api/v1/destinations/{row.id}/test-delivery",
            json={"count": 3},
        )
    assert response.status_code == 502
    body = response.json()
    assert body["detail"]["error_code"] == "DESTINATION_TEST_DELIVERY_FAILED"
    assert "secret" not in body["detail"]["message"]
    assert "private" not in body["detail"]["message"]
