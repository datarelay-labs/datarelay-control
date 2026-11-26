"""Schema observation Milestone 1 — path walking and StreamRunner integration."""

from __future__ import annotations

import pytest
from sqlalchemy.orm import Session

from app.schema_observation.path_walker import collect_paths_from_event, collect_paths_from_events
from app.schema_observation.service import (
    build_observed_schema_read_model,
    observe_extracted_events,
    schema_observation_enabled,
)
from app.schema_observation.models import StreamObservedSchema
from app.runners.stream_loader import load_stream_context
from app.runners.stream_runner import StreamRunner
from tests.test_stream_runner_e2e import (
    _AllowAllLimiter,
    _FakePoller,
    _FakeWebhookSender,
    _FailIfCalledSyslogSender,
    _seed_stream_runtime,
)


def test_collect_paths_nested_and_array() -> None:
    event = {
        "username": "alice",
        "severity": 3,
        "event": {"id": "e-1", "timestamp": "2026-01-01T00:00:00Z"},
        "roles": [{"name": "admin"}, {"name": "viewer"}],
    }
    paths = collect_paths_from_event(event, max_depth=32, max_paths=500)
    assert paths["$.username"] == "string"
    assert paths["$.severity"] in ("integer", "number")
    assert paths["$.event"] == "object"
    assert paths["$.event.id"] == "string"
    assert paths["$.event.timestamp"] == "string"
    assert paths["$.roles"] == "array"
    assert paths["$.roles[]"] == "array"
    assert paths["$.roles[].name"] == "string"


def test_observe_extracted_events_persists_and_merges(db_session: Session) -> None:
    from app.streams.models import Stream
    from app.connectors.models import Connector
    from app.sources.models import Source

    connector = Connector(name="obs-conn", description="", status="STOPPED")
    db_session.add(connector)
    db_session.flush()
    source = Source(
        connector_id=connector.id,
        source_type="HTTP_API_POLLING",
        config_json={},
        auth_json={},
        enabled=True,
    )
    db_session.add(source)
    db_session.flush()
    stream = Stream(
        connector_id=connector.id,
        source_id=source.id,
        name="obs-stream",
        stream_type="HTTP_API_POLLING",
        config_json={},
        enabled=True,
        status="STOPPED",
    )
    db_session.add(stream)
    db_session.commit()

    events = [{"username": "a", "severity": 1}, {"username": "b", "extra": True}]
    observe_extracted_events(db_session, stream.id, events)
    db_session.commit()

    row = db_session.get(StreamObservedSchema, stream.id)
    assert row is not None
    assert row.total_events_observed == 2
    assert row.observation_run_count == 1
    paths = row.paths_json["paths"]
    assert "$.username" in paths
    assert "$.severity" in paths
    assert "$.extra" in paths

    observe_extracted_events(db_session, stream.id, [{"username": "c"}])
    db_session.commit()
    db_session.refresh(row)
    assert row.observation_run_count == 2
    assert row.total_events_observed == 3
    assert int(paths["$.username"]["observation_count"]) >= 2


def test_stream_runner_records_observed_schema_on_extracted_events(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_OBSERVATION_ENABLED", True)
    seed = _seed_stream_runtime(db_session)
    stream_id = seed["stream_id"]
    poller = _FakePoller(
        {
            "items": [
                {"id": "evt-1", "message": "hello", "vendor": "acme", "nested": {"code": 1}},
            ]
        }
    )
    context = load_stream_context(db_session, stream_id)
    runner = StreamRunner(
        poller=poller,
        source_limiter=_AllowAllLimiter(),
        destination_limiter=_AllowAllLimiter(),
        webhook_sender=_FakeWebhookSender(),
        syslog_sender=_FailIfCalledSyslogSender(),
    )
    summary = runner.run(context, db=db_session)
    db_session.commit()

    assert summary.get("extracted_event_count") == 1
    row = db_session.get(StreamObservedSchema, stream_id)
    assert row is not None
    paths = row.paths_json.get("paths", {})
    assert "$.id" in paths
    assert "$.message" in paths
    assert "$.nested.code" in paths


def test_observed_schema_read_model_empty() -> None:
    model = build_observed_schema_read_model(stream_id=99, row=None)
    assert model["stream_id"] == 99
    assert model["path_count"] == 0
    assert model["observation_enabled"] == schema_observation_enabled()


def test_schema_observation_disabled_is_noop(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_OBSERVATION_ENABLED", False)
    from app.streams.models import Stream
    from app.connectors.models import Connector
    from app.sources.models import Source

    connector = Connector(name="obs-off", description="", status="STOPPED")
    db_session.add(connector)
    db_session.flush()
    source = Source(
        connector_id=connector.id,
        source_type="HTTP_API_POLLING",
        config_json={},
        auth_json={},
        enabled=True,
    )
    db_session.add(source)
    db_session.flush()
    stream = Stream(
        connector_id=connector.id,
        source_id=source.id,
        name="off",
        stream_type="HTTP_API_POLLING",
        config_json={},
        enabled=True,
        status="STOPPED",
    )
    db_session.add(stream)
    db_session.commit()
    observe_extracted_events(db_session, stream.id, [{"x": 1}])
    db_session.commit()
    assert db_session.get(StreamObservedSchema, stream.id) is None


def test_observation_excludes_runtime_metadata_without_mutating_events(monkeypatch):
    from unittest.mock import MagicMock

    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_OBSERVATION_ENABLED", True)
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_DRIFT_DETECTION_ENABLED", False)
    db = MagicMock()
    db.execute.return_value.scalar_one_or_none.return_value = 1
    db.get.return_value = None
    events = [
        {"id": "a", "__gdc_dedup_key": "a", "__gdc_dedup_queue_id": 7,
         "gdc_db_watermark": 10, "gdc_db_order_value": 20,
         "nested": {"__gdc_dedup_key": "vendor-value", "gdc_db_watermark": 5}},
        {"id": "b", "__gdc_dedup_key": "b", "__gdc_future": {"field": 1}},
    ]
    from copy import deepcopy
    original = deepcopy(events)
    observe_extracted_events(db, 1, events)
    row = db.add.call_args.args[0]
    paths = row.paths_json["paths"]
    assert set(paths) == {"$.id", "$.nested", "$.nested.__gdc_dedup_key", "$.nested.gdc_db_watermark"}
    assert paths["$.id"]["occurrence_count"] == 2
    assert paths["$.nested.gdc_db_watermark"]["occurrence_count"] == 1
    assert row.total_events_observed == 2
    assert events == original


def test_legacy_internal_paths_are_excluded_without_rewriting_baseline(monkeypatch):
    from copy import deepcopy
    from unittest.mock import MagicMock
    from app.schema_observation.drift_detection import detect_field_changes

    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_OBSERVATION_ENABLED", True)
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_DRIFT_DETECTION_ENABLED", True)
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_DRIFT_REMOVED_ABSENT_RUNS", 1)
    legacy_paths = {
        "$.__gdc_dedup_queue_id": {"type": "integer", "runs_since_seen": 10},
        "$['__gdc_future.key'].child": {"type": "string", "runs_since_seen": 10},
        "$.gdc_db_watermark": {"type": "integer", "runs_since_seen": 10},
        "$.gdc_db_watermark_actual": {"type": "integer", "runs_since_seen": 0},
        "$.nested.__gdc_dedup_queue_id": {"type": "integer", "runs_since_seen": 0},
    }
    row = StreamObservedSchema(stream_id=1, paths_json={"paths": deepcopy(legacy_paths)},
                               baseline_paths_json={"paths": deepcopy(legacy_paths)},
                               total_events_observed=10, observation_run_count=3)
    old_baseline = deepcopy(row.baseline_paths_json)
    read_model = build_observed_schema_read_model(stream_id=1, row=row)
    visible = {"$.gdc_db_watermark_actual", "$.nested.__gdc_dedup_queue_id"}
    assert {entry["path"] for entry in read_model["paths"]} == visible
    db = MagicMock()
    assert detect_field_changes(db, stream_id=1, row=row, observed_paths=legacy_paths,
                                batch_paths={path: "integer" for path in visible}) == []
    db.execute.assert_not_called()
    assert row.baseline_paths_json == old_baseline
