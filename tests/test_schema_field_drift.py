"""Schema drift Milestone 2 — field added / field removed detection."""

from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.schema_observation.drift_detection import DRIFT_CATEGORY_FIELD_ADDED, DRIFT_CATEGORY_FIELD_REMOVED
from app.schema_observation.models import StreamObservedSchema, StreamSchemaFieldDrift
from app.schema_observation.service import observe_extracted_events


def _seed_stream(db_session: Session) -> int:
    from app.connectors.models import Connector
    from app.sources.models import Source
    from app.streams.models import Stream

    connector = Connector(name="drift-conn", description="", status="STOPPED")
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
        name="drift-stream",
        stream_type="HTTP_API_POLLING",
        config_json={},
        enabled=True,
        status="STOPPED",
    )
    db_session.add(stream)
    db_session.commit()
    return stream.id


@pytest.fixture
def drift_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_OBSERVATION_ENABLED", True)
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_DRIFT_DETECTION_ENABLED", True)
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_BASELINE_MIN_RUNS", 1)
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_BASELINE_MIN_EVENTS", 1)
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_DRIFT_ADDED_CONFIRM_RUNS", 1)
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_DRIFT_REMOVED_ABSENT_RUNS", 2)


def _open_findings(db_session: Session, stream_id: int) -> list[StreamSchemaFieldDrift]:
    return list(
        db_session.execute(
            select(StreamSchemaFieldDrift).where(
                StreamSchemaFieldDrift.stream_id == stream_id,
                StreamSchemaFieldDrift.status == "open",
            )
        ).scalars()
    )


def test_new_field_detected(db_session: Session, drift_settings: None) -> None:
    stream_id = _seed_stream(db_session)
    observe_extracted_events(db_session, stream_id, [{"stable": "a"}])
    db_session.commit()

    observe_extracted_events(db_session, stream_id, [{"stable": "b", "new_field": "x"}])
    db_session.commit()

    findings = _open_findings(db_session, stream_id)
    added = [f for f in findings if f.category == DRIFT_CATEGORY_FIELD_ADDED]
    assert any(f.field_path == "$.new_field" for f in added)


def test_removed_field_detected(db_session: Session, drift_settings: None) -> None:
    stream_id = _seed_stream(db_session)
    observe_extracted_events(db_session, stream_id, [{"keep": 1, "drop_me": "gone"}])
    db_session.commit()

    observe_extracted_events(db_session, stream_id, [{"keep": 2}])
    db_session.commit()
    observe_extracted_events(db_session, stream_id, [{"keep": 3}])
    db_session.commit()

    findings = _open_findings(db_session, stream_id)
    removed = [f for f in findings if f.category == DRIFT_CATEGORY_FIELD_REMOVED]
    assert any(f.field_path == "$.drop_me" for f in removed)


def test_no_drift_when_schema_unchanged(db_session: Session, drift_settings: None) -> None:
    stream_id = _seed_stream(db_session)
    payload = {"alpha": 1, "nested": {"beta": "ok"}}
    for _ in range(4):
        observe_extracted_events(db_session, stream_id, [payload])
        db_session.commit()

    assert _open_findings(db_session, stream_id) == []


def test_nested_field_detection(db_session: Session, drift_settings: None) -> None:
    stream_id = _seed_stream(db_session)
    observe_extracted_events(db_session, stream_id, [{"outer": {"inner": 1}}])
    db_session.commit()

    observe_extracted_events(db_session, stream_id, [{"outer": {"inner": 2, "sibling": True}}])
    db_session.commit()

    findings = _open_findings(db_session, stream_id)
    paths = {f.field_path for f in findings if f.category == DRIFT_CATEGORY_FIELD_ADDED}
    assert "$.outer.sibling" in paths


def test_array_field_path_detection(db_session: Session, drift_settings: None) -> None:
    stream_id = _seed_stream(db_session)
    observe_extracted_events(db_session, stream_id, [{"items": [{"id": "a"}]}])
    db_session.commit()

    observe_extracted_events(
        db_session,
        stream_id,
        [{"items": [{"id": "b", "score": 10}]}],
    )
    db_session.commit()

    findings = _open_findings(db_session, stream_id)
    paths = {f.field_path for f in findings if f.category == DRIFT_CATEGORY_FIELD_ADDED}
    assert "$.items[].score" in paths


def test_drift_detection_disabled_is_noop(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_OBSERVATION_ENABLED", True)
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_DRIFT_DETECTION_ENABLED", False)
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_BASELINE_MIN_RUNS", 1)
    stream_id = _seed_stream(db_session)
    observe_extracted_events(db_session, stream_id, [{"a": 1}])
    db_session.commit()
    observe_extracted_events(db_session, stream_id, [{"a": 1, "b": 2}])
    db_session.commit()

    row = db_session.get(StreamObservedSchema, stream_id)
    assert row is not None
    assert row.baseline_paths_json is None
    assert _open_findings(db_session, stream_id) == []


def test_baseline_established_after_threshold(db_session: Session, drift_settings: None) -> None:
    stream_id = _seed_stream(db_session)
    observe_extracted_events(db_session, stream_id, [{"x": 1}])
    db_session.commit()

    row = db_session.get(StreamObservedSchema, stream_id)
    assert row is not None
    assert row.baseline_established_at is not None
    assert row.baseline_paths_json is not None
    assert "$.x" in row.baseline_paths_json.get("paths", {})


def test_runtime_metadata_does_not_create_or_drive_drift(db_session: Session, drift_settings: None) -> None:
    from app.schema_observation.drift_detection import list_open_field_drifts

    stream_id = _seed_stream(db_session)
    observe_extracted_events(db_session, stream_id, [{"stable": "a"}])
    db_session.commit()
    observe_extracted_events(db_session, stream_id, [
        {"stable": "b", "new_field": "x", "__gdc_dedup_key": "b",
         "__gdc_dedup_queue_id": 3, "gdc_db_watermark": 5, "gdc_db_order_value": 6}
    ])
    db_session.commit()
    row = db_session.get(StreamObservedSchema, stream_id)
    assert set(row.paths_json["paths"]) == {"$.stable", "$.new_field"}
    assert {finding.field_path for finding in _open_findings(db_session, stream_id)} == {"$.new_field"}
    # Older builds could already have recorded internal findings. Retain their
    # historical rows, but never feed them back into runtime drift policy.
    db_session.add(StreamSchemaFieldDrift(stream_id=stream_id,
                   field_path="$.__gdc_dedup_key", category=DRIFT_CATEGORY_FIELD_ADDED))
    db_session.commit()
    assert {finding.field_path for finding in list_open_field_drifts(db_session, stream_id)} == {"$.new_field"}
    assert {finding.field_path for finding in _open_findings(db_session, stream_id)} == {
        "$.new_field", "$.__gdc_dedup_key"
    }
