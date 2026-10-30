"""Runtime read APIs must return a reduced checkpoint view, never the raw last_success_event (C8).

The stored checkpoint keeps the full ``last_success_event`` because incremental fetch and
source adapters read it; only the READ/API path is reduced to metadata plus an
event-id/timestamp preview.
"""

from __future__ import annotations

import copy
import json
from datetime import datetime, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.connectors.models import Connector
from app.logs.models import DeliveryLog
from app.sources.models import Source
from app.streams.models import Stream
from tests.runtime_read_fixtures import (
    clear_runtime_test_db_overrides,
    install_runtime_test_db_overrides,
)

UTC = timezone.utc

pytestmark = pytest.mark.usefixtures("runtime_snapshot_read_disabled")

_PII_EMAIL = "jane.doe.c8@example.com"
_PII_NAME = "Jane C8 Doe"

_RAW_EVENT: dict[str, Any] = {
    "id": "evt-c8-1",
    "@timestamp": "2026-10-30T01:02:03Z",
    "user": {"email": _PII_EMAIL, "name": _PII_NAME},
    "message": f"login by {_PII_EMAIL}",
}

_STORED_CHECKPOINT: dict[str, Any] = {
    "last_success_event": copy.deepcopy(_RAW_EVENT),
    "delivery_checkpoint": {
        "last_success_event": copy.deepcopy(_RAW_EVENT),
        "cursor": "2026-10-30T01:02:03Z",
    },
    "incremental_fetch_watermark": "2026-10-30T01:00:00Z",
    "cursor": "2026-10-30T01:02:03Z",
    "last_delivery_at": "2026-10-30T01:02:04Z",
    "updated_at": "2026-10-30T01:02:04Z",
}


def _assert_reduced(value: Any) -> None:
    dumped = json.dumps(value, default=str)
    assert _PII_EMAIL not in dumped
    assert _PII_NAME not in dumped
    assert "login by" not in dumped


@pytest.fixture
def client(db_session: Session) -> TestClient:
    install_runtime_test_db_overrides(db_session)
    try:
        from app.main import app

        yield TestClient(app)
    finally:
        clear_runtime_test_db_overrides()


def _seed_stream_with_raw_checkpoint(db: Session) -> dict[str, int]:
    connector = Connector(name="c8-connector", description=None, status="RUNNING")
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
        name="c8-stream",
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=60,
        enabled=True,
        status="RUNNING",
        rate_limit_json={},
    )
    db.add(stream)
    db.flush()
    db.add(
        Checkpoint(
            stream_id=stream.id,
            checkpoint_type="EVENT_ID",
            checkpoint_value_json=copy.deepcopy(_STORED_CHECKPOINT),
        )
    )
    db.commit()
    return {"connector_id": int(connector.id), "stream_id": int(stream.id)}


def _stored_checkpoint_value(db: Session, stream_id: int) -> dict[str, Any]:
    db.expire_all()
    row = db.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).one()
    return dict(row.checkpoint_value_json)


def _assert_preview_and_metadata(value: dict[str, Any]) -> None:
    _assert_reduced(value)
    assert value["last_success_event"] == {"id": "evt-c8-1", "@timestamp": "2026-10-30T01:02:03Z"}
    assert value["delivery_checkpoint"]["last_success_event"] == {
        "id": "evt-c8-1",
        "@timestamp": "2026-10-30T01:02:03Z",
    }
    assert value["delivery_checkpoint"]["cursor"] == "2026-10-30T01:02:03Z"
    assert value["incremental_fetch_watermark"] == "2026-10-30T01:00:00Z"
    assert value["cursor"] == "2026-10-30T01:02:03Z"
    assert value["updated_at"] == "2026-10-30T01:02:04Z"


# --- Helper -----------------------------------------------------------------


def test_checkpoint_read_view_reduces_raw_events_and_keeps_metadata() -> None:
    from app.runtime.copy_utils import checkpoint_read_view

    source = copy.deepcopy(_STORED_CHECKPOINT)
    view = checkpoint_read_view(source)
    _assert_preview_and_metadata(view)
    assert source == _STORED_CHECKPOINT


def test_checkpoint_read_view_drops_event_without_preview_keys() -> None:
    from app.runtime.copy_utils import checkpoint_read_view

    view = checkpoint_read_view({"last_success_event": {"email": _PII_EMAIL}, "cursor": 5})
    _assert_reduced(view)
    assert view == {"cursor": 5}


def test_checkpoint_read_view_preview_keeps_only_scalar_ids() -> None:
    from app.runtime.copy_utils import checkpoint_read_view

    view = checkpoint_read_view(
        {"last_success_event": {"id": {"email": _PII_EMAIL}, "event_id": "e-1", "timestamp": 17}}
    )
    _assert_reduced(view)
    assert view == {"last_success_event": {"event_id": "e-1", "timestamp": 17}}


def test_checkpoint_read_view_non_dict_is_empty() -> None:
    from app.runtime.copy_utils import checkpoint_read_view

    assert checkpoint_read_view(None) == {}
    assert checkpoint_read_view("raw") == {}


# --- Pure payload builders not reachable without snapshot/bulk infrastructure ---


def test_snapshot_and_bulk_checkpoint_payloads_are_reduced() -> None:
    from app.runtime import stats_health_bulk_service, stream_runtime_snapshot_read

    row = Checkpoint(stream_id=1, checkpoint_type="EVENT_ID", checkpoint_value_json=copy.deepcopy(_STORED_CHECKPOINT))
    for builder in (stream_runtime_snapshot_read._checkpoint_payload, stats_health_bulk_service._checkpoint_payload):
        payload = builder(row)
        assert payload is not None
        assert payload.type == "EVENT_ID"
        _assert_preview_and_metadata(payload.value)
    assert row.checkpoint_value_json == _STORED_CHECKPOINT


# --- HTTP read endpoints ------------------------------------------------------


def test_stream_stats_endpoint_returns_reduced_checkpoint(client: TestClient, db_session: Session) -> None:
    sid = _seed_stream_with_raw_checkpoint(db_session)["stream_id"]

    res = client.get(f"/api/v1/runtime/stats/stream/{sid}")
    assert res.status_code == 200
    body = res.json()
    _assert_reduced(body)
    assert body["checkpoint"]["type"] == "EVENT_ID"
    _assert_preview_and_metadata(body["checkpoint"]["value"])

    assert _stored_checkpoint_value(db_session, sid) == _STORED_CHECKPOINT


def test_stream_stats_health_endpoint_returns_reduced_checkpoint(client: TestClient, db_session: Session) -> None:
    sid = _seed_stream_with_raw_checkpoint(db_session)["stream_id"]

    res = client.get(f"/api/v1/runtime/streams/{sid}/stats-health")
    assert res.status_code == 200
    body = res.json()
    _assert_reduced(body)
    _assert_preview_and_metadata(body["stats"]["checkpoint"]["value"])

    assert _stored_checkpoint_value(db_session, sid) == _STORED_CHECKPOINT


def test_stream_metrics_endpoint_returns_reduced_checkpoint(client: TestClient, db_session: Session) -> None:
    sid = _seed_stream_with_raw_checkpoint(db_session)["stream_id"]

    res = client.get(f"/api/v1/runtime/streams/{sid}/metrics")
    assert res.status_code == 200
    body = res.json()
    _assert_reduced(body)
    assert body["stream"]["last_checkpoint"]["type"] == "EVENT_ID"
    _assert_preview_and_metadata(body["stream"]["last_checkpoint"]["value"])
    assert "evt-c8-1" in json.dumps(body.get("checkpoint_history") or [])

    assert _stored_checkpoint_value(db_session, sid) == _STORED_CHECKPOINT


def test_checkpoint_trace_and_history_reduce_legacy_raw_log_payloads(
    client: TestClient, db_session: Session
) -> None:
    seeded = _seed_stream_with_raw_checkpoint(db_session)
    sid = seeded["stream_id"]
    run_id = "00000000-0000-0000-0000-0000000000c8"
    t0 = datetime(2026, 10, 30, 1, 2, 4, tzinfo=UTC)
    # Legacy rows may still carry full checkpoints from before log-side slimming.
    for stage in ("run_started", "checkpoint_update", "run_complete"):
        db_session.add(
            DeliveryLog(
                connector_id=seeded["connector_id"],
                stream_id=sid,
                stage=stage,
                level="INFO",
                status="OK",
                message=stage,
                payload_sample={
                    "checkpoint_type": "EVENT_ID",
                    "checkpoint_before": {"last_success_event": copy.deepcopy(_RAW_EVENT)},
                    "checkpoint_after": copy.deepcopy(_STORED_CHECKPOINT),
                    "update_reason": "full_success",
                },
                retry_count=0,
                run_id=run_id,
                created_at=t0,
            )
        )
    db_session.commit()

    trace = client.get("/api/v1/runtime/checkpoints/trace", params={"run_id": run_id})
    assert trace.status_code == 200
    tbody = trace.json()
    _assert_reduced(tbody)
    _assert_preview_and_metadata(tbody["checkpoint_after"])
    assert tbody["checkpoint_before"]["last_success_event"] == {
        "id": "evt-c8-1",
        "@timestamp": "2026-10-30T01:02:03Z",
    }

    run_cp = client.get(f"/api/v1/runtime/runs/{run_id}/checkpoint")
    assert run_cp.status_code == 200
    _assert_reduced(run_cp.json())

    hist = client.get(f"/api/v1/runtime/checkpoints/streams/{sid}/history")
    assert hist.status_code == 200
    hbody = hist.json()
    _assert_reduced(hbody)
    assert hbody["items"][0]["checkpoint_after_preview"] == "evt-c8-1"

    assert _stored_checkpoint_value(db_session, sid) == _STORED_CHECKPOINT
