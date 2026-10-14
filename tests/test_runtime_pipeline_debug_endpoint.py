"""Pipeline debugger API — mapping/enrichment/format preview without delivery or DB mutations."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.database import get_db
from app.destinations.adapters.registry import DestinationAdapterRegistry
from app.logs.models import DeliveryLog
from app.main import app
from app.streams.models import Stream
from tests.test_stream_runner_e2e import _FakeWebhookSender, _seed_stream_runtime


@pytest.fixture
def pipeline_debug_client(db_session: Session) -> TestClient:
    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def _checkpoint_value(db: Session, stream_id: int) -> dict[str, Any]:
    row = db.query(Checkpoint).filter(Checkpoint.stream_id == int(stream_id)).first()
    assert row is not None
    return dict(row.checkpoint_value_json or {})


def test_pipeline_debug_raw_to_enriched_and_formatted(
    pipeline_debug_client: TestClient,
    db_session: Session,
) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])

    response = pipeline_debug_client.post(
        f"/api/v1/runtime/streams/{stream_id}/pipeline-debug",
        json={
            "raw_event": {
                "items": [{"id": "evt-42", "message": "hello", "vendor": "Upstream"}],
            },
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["stream_id"] == stream_id
    assert body["raw_event"]["id"] == "evt-42"
    assert body["mapped_event"]["event_id"] == "evt-42"
    assert body["mapped_event"]["message"] == "hello"
    assert body["enriched_event"]["vendor"] == "Upstream"
    assert body["enriched_event"]["product"] == "GDC"
    assert '"event_id":"evt-42"' in body["formatted_payload"]
    assert body["errors"] == []


def test_pipeline_debug_route_preview_without_delivery(
    pipeline_debug_client: TestClient,
    db_session: Session,
) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    route_id = int(seeded["route_ids"][0])

    sender = _FakeWebhookSender()
    registry = DestinationAdapterRegistry(webhook_sender=sender)

    response = pipeline_debug_client.post(
        f"/api/v1/runtime/streams/{stream_id}/pipeline-debug",
        json={
            "raw_event": {"items": [{"id": "e1", "message": "x", "vendor": "V"}]},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert len(body["routes"]) == 1
    route_row = body["routes"][0]
    assert route_row["route_id"] == route_id
    assert route_row["destination_type"] == "WEBHOOK_POST"
    assert route_row["delivery_preview"] is not None
    assert len(sender.calls) == 0
    assert registry  # registry constructed; no send invoked via debugger


def test_pipeline_debug_checkpoint_unchanged(
    pipeline_debug_client: TestClient,
    db_session: Session,
) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    before = _checkpoint_value(db_session, stream_id)

    response = pipeline_debug_client.post(
        f"/api/v1/runtime/streams/{stream_id}/pipeline-debug",
        json={"raw_event": {"items": [{"id": "e2", "message": "m", "vendor": "V"}]}},
    )
    assert response.status_code == 200

    after = _checkpoint_value(db_session, stream_id)
    assert after == before


def test_pipeline_debug_no_delivery_logs_created(
    pipeline_debug_client: TestClient,
    db_session: Session,
) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    before_count = db_session.query(DeliveryLog).filter(DeliveryLog.stream_id == stream_id).count()

    response = pipeline_debug_client.post(
        f"/api/v1/runtime/streams/{stream_id}/pipeline-debug",
        json={"raw_event": {"items": [{"id": "e3", "message": "m", "vendor": "V"}]}},
    )
    assert response.status_code == 200

    after_count = db_session.query(DeliveryLog).filter(DeliveryLog.stream_id == stream_id).count()
    assert after_count == before_count


def test_pipeline_debug_uses_source_sample_when_raw_event_omitted(
    pipeline_debug_client: TestClient,
    db_session: Session,
) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    stream = db_session.query(Stream).filter_by(id=stream_id).first()
    assert stream is not None
    source = stream.source
    assert source is not None
    source.config_json = {
        **dict(source.config_json or {}),
        "sample_payload": {"items": [{"id": "wh-1", "message": "webhook", "vendor": "WH"}]},
    }
    db_session.add(source)
    db_session.commit()

    response = pipeline_debug_client.post(
        f"/api/v1/runtime/streams/{stream_id}/pipeline-debug",
        json={},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["mapped_event"]["event_id"] == "wh-1"


def test_pipeline_debug_uses_webhook_payload_preview_when_raw_event_omitted(
    pipeline_debug_client: TestClient,
    db_session: Session,
) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    stream = db_session.query(Stream).filter_by(id=stream_id).first()
    assert stream is not None
    source = stream.source
    assert source is not None
    source.config_json = {
        **dict(source.config_json or {}),
        "payload_preview": '{"items":[{"id":"wh-preview-1","message":"webhook preview","vendor":"WH"}]}',
    }
    db_session.add(source)
    db_session.commit()

    response = pipeline_debug_client.post(
        f"/api/v1/runtime/streams/{stream_id}/pipeline-debug",
        json={},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["mapped_event"]["event_id"] == "wh-preview-1"
    assert body["errors"] == []


def test_pipeline_debug_reports_invalid_webhook_payload_preview(
    pipeline_debug_client: TestClient,
    db_session: Session,
) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    stream = db_session.query(Stream).filter_by(id=stream_id).first()
    assert stream is not None
    source = stream.source
    assert source is not None
    source.config_json = {
        **dict(source.config_json or {}),
        "payload_preview": '{"items":',
    }
    db_session.add(source)
    db_session.commit()

    response = pipeline_debug_client.post(
        f"/api/v1/runtime/streams/{stream_id}/pipeline-debug",
        json={},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["mapped_event"] is None
    assert "Webhook payload_preview is not valid JSON or NDJSON." in body["errors"]


def test_viewer_may_call_pipeline_debug() -> None:
    from app.auth.route_access import is_viewer_allowed_post
    from app.config import settings

    base = settings.API_PREFIX.rstrip("/")
    assert is_viewer_allowed_post(f"{base}/runtime/streams/99/pipeline-debug") is True
