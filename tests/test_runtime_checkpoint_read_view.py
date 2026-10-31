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


# No log-metadata keys and a top-level event without id/timestamp keys: slim_checkpoint_for_log
# used to fall back to a full copy of this checkpoint.
_NO_META_CHECKPOINT: dict[str, Any] = {
    "last_success_event": {"user": {"email": _PII_EMAIL, "name": _PII_NAME}, "message": f"login by {_PII_EMAIL}"},
    "delivery_checkpoint": {
        "last_success_event": copy.deepcopy(_RAW_EVENT),
        "cursor": "2026-10-30T01:02:03Z",
    },
    "cursor": "2026-10-30T01:02:03Z",
}

_PREVIEW = {"id": "evt-c8-1", "@timestamp": "2026-10-30T01:02:03Z"}


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


def _seed_stream_with_raw_checkpoint(
    db: Session,
    *,
    checkpoint_value: dict[str, Any] | None = None,
    stream_config: dict[str, Any] | None = None,
) -> dict[str, int]:
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
        config_json=copy.deepcopy(stream_config or {}),
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
            checkpoint_value_json=copy.deepcopy(_STORED_CHECKPOINT if checkpoint_value is None else checkpoint_value),
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


_S3_EVENT: dict[str, Any] = {
    "s3_key": "logs/2026/10/30/part-0001.json.gz",
    "gdc_remote_path": "/exports/2026-10-30/part-0001.json.gz",
    "remote_path": {"path": "not-a-scalar"},
    "user": {"email": _PII_EMAIL, "name": _PII_NAME},
    "message": f"login by {_PII_EMAIL}",
}
_S3_PREVIEW = {
    "s3_key": "logs/2026/10/30/part-0001.json.gz",
    "gdc_remote_path": "/exports/2026-10-30/part-0001.json.gz",
}


def test_checkpoint_read_view_preview_keeps_object_locators() -> None:
    # Old code: the event had no id/timestamp keys, so the preview was dropped entirely and
    # the console lost the S3 key / remote path display.
    from app.runtime.copy_utils import checkpoint_read_view

    view = checkpoint_read_view(
        {
            "last_success_event": copy.deepcopy(_S3_EVENT),
            "delivery_checkpoint": {"last_success_event": {**_S3_EVENT, "id": "e-9"}},
        }
    )
    _assert_reduced(view)
    assert view["last_success_event"] == _S3_PREVIEW
    assert view["delivery_checkpoint"]["last_success_event"] == {**_S3_PREVIEW, "id": "e-9"}


def test_slim_checkpoint_for_log_preview_keeps_object_locators() -> None:
    # Old code: the log preview held only "id" (no s3_key / gdc_remote_path).
    from app.runtime.copy_utils import slim_checkpoint_for_log

    slim = slim_checkpoint_for_log(
        {"last_processed_key": "logs/2026/10/30/part-0001.json.gz", "last_success_event": {**_S3_EVENT, "id": "e-9"}}
    )
    assert slim is not None
    _assert_reduced(slim)
    assert slim["last_success_event"] == {**_S3_PREVIEW, "id": "e-9"}
    assert slim["last_processed_key"] == "logs/2026/10/30/part-0001.json.gz"


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


# --- Log snapshot fallback (C8b) ------------------------------------------------


def test_slim_checkpoint_for_log_fallback_reduces_raw_events() -> None:
    # Old code: with no metadata keys and no id-preview, the fallback returned a full copy
    # (top-level and nested raw events) -> _assert_reduced fails.
    from app.runtime.copy_utils import slim_checkpoint_for_log

    source = copy.deepcopy(_NO_META_CHECKPOINT)
    slim = slim_checkpoint_for_log(source)
    assert slim is not None
    _assert_reduced(slim)
    assert "last_success_event" not in slim
    assert slim["delivery_checkpoint"] == {"last_success_event": _PREVIEW, "cursor": "2026-10-30T01:02:03Z"}
    assert slim["cursor"] == "2026-10-30T01:02:03Z"
    assert source == _NO_META_CHECKPOINT

    # Old code: returned {"last_success_event": {"email": ...}} unchanged.
    only_raw = slim_checkpoint_for_log({"last_success_event": {"email": _PII_EMAIL}})
    _assert_reduced(only_raw)
    assert not only_raw


# --- Stream configuration view (C8b) ---------------------------------------------


def test_stream_configuration_view_never_displays_raw_checkpoint_event(
    client: TestClient, db_session: Session
) -> None:
    # Old code: "Last Checkpoint"/"Current Checkpoint" rendered the full slim fallback copy,
    # including the raw event (email/name/message) -> _assert_reduced fails.
    sid = _seed_stream_with_raw_checkpoint(db_session, checkpoint_value=_NO_META_CHECKPOINT)["stream_id"]

    res = client.get(f"/api/v1/runtime/streams/{sid}/configuration")
    assert res.status_code == 200, res.text
    body = res.json()
    _assert_reduced(body)
    assert "evt-c8-1" in json.dumps(body)

    assert _stored_checkpoint_value(db_session, sid) == _NO_META_CHECKPOINT


def test_checkpoint_display_does_not_fall_back_to_raw_checkpoint() -> None:
    # Old code: an empty slim result fell back to the raw checkpoint dict -> PII in the display string.
    from app.runtime.stream_configuration_service import NOT_CONFIGURED, _checkpoint_display

    shown = _checkpoint_display({"last_success_event": {"email": _PII_EMAIL}})
    _assert_reduced(shown)
    assert shown == NOT_CONFIGURED


# --- Checkpoint manage endpoints (C8b) -------------------------------------------


def test_checkpoint_manage_get_legacy_mode_returns_reduced_checkpoint(
    client: TestClient, db_session: Session
) -> None:
    # Old code: legacy_checkpoint was the full stored checkpoint (raw top-level and nested events).
    sid = _seed_stream_with_raw_checkpoint(db_session)["stream_id"]

    res = client.get(f"/api/v1/runtime/streams/{sid}/checkpoint")
    assert res.status_code == 200, res.text
    body = res.json()
    _assert_reduced(body)
    assert body["framework_enabled"] is False
    assert body["checkpoint_type"] == "EVENT_ID"
    _assert_preview_and_metadata(body["legacy_checkpoint"])
    assert body["checkpoint_value"]["last_success_event"] == _PREVIEW

    assert _stored_checkpoint_value(db_session, sid) == _STORED_CHECKPOINT


def test_checkpoint_manage_get_framework_mode_returns_reduced_delivery_checkpoint(
    client: TestClient, db_session: Session
) -> None:
    # Old code: delivery_checkpoint carried the nested raw last_success_event.
    sid = _seed_stream_with_raw_checkpoint(
        db_session,
        stream_config={"incremental_fetch": {"strategy": "timestamp_watermark", "watermark_field": "$.timestamp"}},
    )["stream_id"]

    res = client.get(f"/api/v1/runtime/streams/{sid}/checkpoint")
    assert res.status_code == 200, res.text
    body = res.json()
    _assert_reduced(body)
    assert body["framework_enabled"] is True
    assert body["delivery_checkpoint"] == {"last_success_event": _PREVIEW, "cursor": "2026-10-30T01:02:03Z"}
    assert body["fetch_checkpoint"]["cursor"] == "2026-10-30T01:02:03Z"

    assert _stored_checkpoint_value(db_session, sid) == _STORED_CHECKPOINT


def _audit_details(db: Session, action: str, stream_id: int) -> dict[str, Any]:
    from app.platform_admin.models import PlatformAuditEvent

    db.expire_all()
    row = (
        db.query(PlatformAuditEvent)
        .filter(PlatformAuditEvent.action == action, PlatformAuditEvent.entity_id == stream_id)
        .order_by(PlatformAuditEvent.id.desc())
        .first()
    )
    assert row is not None
    return dict(row.details_json or {})


def test_checkpoint_manage_put_stores_full_value_and_returns_reduced_view(
    client: TestClient, db_session: Session
) -> None:
    # Old code: the PUT response and the audit previous/new values echoed the raw event.
    sid = _seed_stream_with_raw_checkpoint(db_session, checkpoint_value={"cursor": "old"})["stream_id"]

    res = client.put(
        f"/api/v1/runtime/streams/{sid}/checkpoint",
        json={"checkpoint_type": "EVENT_ID", "checkpoint_value": _STORED_CHECKPOINT},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    _assert_reduced(body)
    _assert_preview_and_metadata(body["legacy_checkpoint"])

    # The write path is unchanged: the full value is stored for the runner.
    assert _stored_checkpoint_value(db_session, sid) == _STORED_CHECKPOINT
    details = _audit_details(db_session, "STREAM_CHECKPOINT_UPDATED", sid)
    _assert_reduced(details)
    assert details["new_value"]["last_success_event"] == _PREVIEW


def test_checkpoint_manage_reset_audit_previous_value_is_reduced(
    client: TestClient, db_session: Session
) -> None:
    # Old code: the reset audit previous_value.legacy_checkpoint held the raw stored event.
    sid = _seed_stream_with_raw_checkpoint(db_session)["stream_id"]

    res = client.post(f"/api/v1/runtime/streams/{sid}/checkpoint/reset", json={"reason": "c8b"})
    assert res.status_code == 200, res.text
    _assert_reduced(res.json())

    details = _audit_details(db_session, "STREAM_CHECKPOINT_RESET", sid)
    _assert_reduced(details)
    _assert_preview_and_metadata(details["previous_value"]["legacy_checkpoint"])


# --- Incremental fetch status and incremental test (C8b) ----------------------------


def test_incremental_fetch_status_returns_reduced_delivery_checkpoint(
    client: TestClient, db_session: Session
) -> None:
    # Old code: delivery_checkpoint was the nested stored blob with the raw event.
    sid = _seed_stream_with_raw_checkpoint(db_session)["stream_id"]

    res = client.get(f"/api/v1/runtime/streams/{sid}/incremental-fetch")
    assert res.status_code == 200, res.text
    body = res.json()
    _assert_reduced(body)
    assert body["delivery_checkpoint"] == {"last_success_event": _PREVIEW, "cursor": "2026-10-30T01:02:03Z"}
    assert body["last_delivery_at"] == "2026-10-30T01:02:04Z"

    assert _stored_checkpoint_value(db_session, sid) == _STORED_CHECKPOINT


def test_incremental_test_without_events_returns_reduced_stored_checkpoint(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Old code: with no fetched events, next_checkpoint_preview was the stored checkpoint and
    # delivery_checkpoint the nested stored blob, both carrying the raw event.
    from app.runtime.schemas import HttpApiTestAnalysis, HttpApiTestResponse, HttpApiTestResponseMeta

    def _fake_api_test(*_args: Any, **_kwargs: Any) -> HttpApiTestResponse:
        return HttpApiTestResponse(
            ok=True,
            request={"method": "GET", "url": "http://example.test", "headers_masked": {}},
            response=HttpApiTestResponseMeta(status_code=200, latency_ms=1, headers={}, raw_body="[]", parsed_json=[]),
            analysis=HttpApiTestAnalysis(
                response_summary={"root_type": "array", "approx_size_bytes": 2, "top_level_keys": []},
                sample_event=None,
            ),
        )

    monkeypatch.setattr("app.runtime.stream_configuration_service.run_http_api_test", _fake_api_test)
    sid = _seed_stream_with_raw_checkpoint(db_session)["stream_id"]

    res = client.post(f"/api/v1/runtime/streams/{sid}/incremental-test", json={})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["fetched"] == 0
    assert body["preview_events"] == []
    _assert_reduced(body)
    _assert_preview_and_metadata(body["next_checkpoint_preview"])
    assert body["delivery_checkpoint"] == {"last_success_event": _PREVIEW, "cursor": "2026-10-30T01:02:03Z"}

    assert _stored_checkpoint_value(db_session, sid) == _STORED_CHECKPOINT


# --- Persisted incremental test copy (stream config) -----------------------------------


def _fake_api_test_returning(events: list[dict[str, Any]]) -> Any:
    from app.runtime.schemas import HttpApiTestAnalysis, HttpApiTestResponse, HttpApiTestResponseMeta

    def _fake(*_args: Any, **_kwargs: Any) -> HttpApiTestResponse:
        return HttpApiTestResponse(
            ok=True,
            request={"method": "GET", "url": "http://example.test", "headers_masked": {}},
            response=HttpApiTestResponseMeta(
                status_code=200,
                latency_ms=1,
                headers={},
                raw_body=json.dumps(events),
                parsed_json=copy.deepcopy(events),
            ),
            analysis=HttpApiTestAnalysis(
                response_summary={"root_type": "array", "approx_size_bytes": 2, "top_level_keys": []},
                sample_event=None,
            ),
        )

    return _fake


def _stored_checkpoint_test_result(db: Session, stream_id: int) -> dict[str, Any]:
    db.expire_all()
    stream = db.get(Stream, stream_id)
    assert stream is not None
    return dict((stream.config_json or {})["incremental_test"]["checkpoint_test_result"])


def test_incremental_test_stores_reduced_checkpoint_test_result_without_events(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Old code: input_checkpoint and next_checkpoint_preview were the stored checkpoint with the
    # raw event, persisted in stream config and returned by GET sample-data.
    monkeypatch.setattr("app.runtime.stream_configuration_service.run_http_api_test", _fake_api_test_returning([]))
    sid = _seed_stream_with_raw_checkpoint(db_session)["stream_id"]

    res = client.post(f"/api/v1/runtime/streams/{sid}/incremental-test", json={})
    assert res.status_code == 200, res.text

    stored = _stored_checkpoint_test_result(db_session, sid)
    _assert_reduced(stored)
    _assert_preview_and_metadata(stored["input_checkpoint"])
    _assert_preview_and_metadata(stored["next_checkpoint_preview"])
    assert "checkpoint_unchanged" in stored

    sample = client.get(f"/api/v1/runtime/streams/{sid}/sample-data")
    assert sample.status_code == 200, sample.text
    _assert_reduced(sample.json()["checkpoint_test_result"])

    # The real stream checkpoint (what the runner reads) is unchanged.
    assert _stored_checkpoint_value(db_session, sid) == _STORED_CHECKPOINT


def test_incremental_test_stores_reduced_next_checkpoint_preview_with_events(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Old code: next_checkpoint_preview stored the full last fetched event (email/name/message).
    monkeypatch.setattr(
        "app.runtime.stream_configuration_service.run_http_api_test",
        _fake_api_test_returning([copy.deepcopy(_RAW_EVENT)]),
    )
    sid = _seed_stream_with_raw_checkpoint(db_session)["stream_id"]

    res = client.post(f"/api/v1/runtime/streams/{sid}/incremental-test", json={})
    assert res.status_code == 200, res.text
    assert res.json()["next_checkpoint_preview"] == {"last_success_event": _PREVIEW}

    stored = _stored_checkpoint_test_result(db_session, sid)
    _assert_reduced(stored)
    assert stored["next_checkpoint_preview"] == {"last_success_event": _PREVIEW}
    assert _stored_checkpoint_value(db_session, sid) == _STORED_CHECKPOINT


def test_sample_data_save_and_get_reduce_checkpoint_test_result(client: TestClient, db_session: Session) -> None:
    # Old code: a client-submitted checkpoint_test_result was stored and echoed verbatim.
    sid = _seed_stream_with_raw_checkpoint(db_session)["stream_id"]
    submitted = {
        "input_checkpoint": copy.deepcopy(_STORED_CHECKPOINT),
        "next_checkpoint_preview": {"last_success_event": copy.deepcopy(_RAW_EVENT)},
        "checkpoint_unchanged": True,
    }

    res = client.put(f"/api/v1/runtime/streams/{sid}/sample-data", json={"checkpoint_test_result": submitted})
    assert res.status_code == 200, res.text
    returned = res.json()["checkpoint_test_result"]
    _assert_reduced(returned)
    _assert_preview_and_metadata(returned["input_checkpoint"])
    assert returned["next_checkpoint_preview"] == {"last_success_event": _PREVIEW}
    assert returned["checkpoint_unchanged"] is True

    stored = _stored_checkpoint_test_result(db_session, sid)
    _assert_reduced(stored)
    assert stored == returned
    assert _stored_checkpoint_value(db_session, sid) == _STORED_CHECKPOINT


def test_sample_data_get_reduces_legacy_stored_checkpoint_test_result(
    client: TestClient, db_session: Session
) -> None:
    # Old code: rows written before the reduction returned the raw events on GET.
    legacy = {
        "incremental_test": {
            "checkpoint_test_result": {
                "input_checkpoint": copy.deepcopy(_STORED_CHECKPOINT),
                "next_checkpoint_preview": {"last_success_event": copy.deepcopy(_RAW_EVENT)},
                "checkpoint_unchanged": True,
            }
        }
    }
    sid = _seed_stream_with_raw_checkpoint(db_session, stream_config=legacy)["stream_id"]

    res = client.get(f"/api/v1/runtime/streams/{sid}/sample-data")
    assert res.status_code == 200, res.text
    returned = res.json()["checkpoint_test_result"]
    _assert_reduced(returned)
    _assert_preview_and_metadata(returned["input_checkpoint"])
    assert returned["next_checkpoint_preview"] == {"last_success_event": _PREVIEW}
