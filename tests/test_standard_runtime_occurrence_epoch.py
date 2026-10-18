"""Scratch-only P0-2 exact field presence and persistence-compatibility tests."""
from __future__ import annotations

from copy import deepcopy

import pytest

from app.schema_observation import service as observation
from app.schema_observation.models import StreamObservedSchema
from app.schema_observation.occurrence_tracking import collect_occurrence_batch
from app.schema_observation.path_walker import collect_paths_from_events
from app.schema_observation.schemas import StreamObservedSchemaResponse


class FakeMemorySession:
    def __init__(self, rows=None):
        self.rows = {r.stream_id: r for r in rows or []}
    def get(self, model, stream_id, **kwargs):
        assert model is StreamObservedSchema
        return self.rows.get(stream_id)
    def add(self, row):
        self.rows[row.stream_id] = row
    def execute(self, statement, parameters=None):
        # In-memory substitute for the scratch-only first-insert parent lock.
        assert parameters and "stream_id" in parameters
        class _ScalarResult:
            def scalar_one_or_none(self):
                return parameters["stream_id"]
        return _ScalarResult()


@pytest.fixture(autouse=True)
def no_database_or_drift(monkeypatch):
    monkeypatch.setattr(observation, "schema_observation_enabled", lambda: True)
    monkeypatch.setattr(observation, "schema_drift_detection_enabled", lambda: False)
    monkeypatch.setattr(observation.settings, "GDC_SCHEMA_OBSERVATION_MAX_EVENTS_PER_RUN", 500)
    monkeypatch.setattr(observation.settings, "GDC_SCHEMA_OBSERVATION_MAX_DEPTH", 32)
    monkeypatch.setattr(observation.settings, "GDC_SCHEMA_OBSERVATION_MAX_PATHS", 500)


def _observe(events, fake=None, stream=301):
    fake = fake or FakeMemorySession()
    observation.observe_extracted_events(fake, stream, events)
    return fake, fake.rows.get(stream)


def _fields(row):
    return row.paths_json["paths"]


def _counting(row):
    return row.paths_json["counting_v1"]


def test_rare_field_true_presence_one_of_twenty():
    events = [{"email": "synthetic@example.invalid"}] + [
        {"username": f"user{i}"} for i in range(19)
    ]
    db, row = _observe(events)
    assert row.total_events_observed == 20
    assert _fields(row)["$.email"]["occurrence_count"] == 1
    assert _fields(row)["$.username"]["occurrence_count"] == 19
    assert _counting(row)["sampled_events"] == 20
    assert _counting(row)["complete"] is True
    assert _fields(row)["$.email"]["observation_count"] == 20  # old, unchanged contract
    assert "synthetic@example.invalid" not in repr(row.paths_json)


def test_multiwindow_frequency_denominator_preserves_absent_events():
    db, row = _observe([{"a": 1}, {"b": 1}])
    observation.observe_extracted_events(db, 301, [{}, {"a": 2}, {}, {"c": None}])
    assert _counting(row)["sampled_events"] == 6
    assert _fields(row)["$.a"]["occurrence_count"] == 2
    assert _fields(row)["$.b"]["occurrence_count"] == 1
    assert _fields(row)["$.c"]["occurrence_count"] == 1
    assert _fields(row)["$.a"]["observation_count"] == 6
    assert row.total_events_observed == 6
    assert row.observation_run_count == 2


def test_null_is_present_and_boolean_type_remains_distinct():
    db, row = _observe([{"x": None}, {"enabled": True}, {"other": 2}])
    assert _fields(row)["$.x"]["occurrence_count"] == 1
    assert _fields(row)["$.x"]["type"] == "null"
    assert _fields(row)["$.enabled"]["type"] == "boolean"
    assert _counting(row)["sampled_events"] == 3


def test_array_instances_are_not_miscounted_as_events():
    db, row = _observe([
        {"arr": [{"k": 1}, {"k": 2}, {"k": 3}]},
        {"arr": [{"other": 1}]},
        {"arr": []},
    ])
    assert _fields(row)["$.arr[].k"]["occurrence_count"] == 1
    assert _fields(row)["$.arr"]["occurrence_count"] == 3
    assert _counting(row)["complete"] is True


def test_dot_key_and_nested_key_have_separate_count_histories():
    _, row = _observe([
        {"user.email": "s", "user": {"email": 1}},
        {"user": {"email": 2}},
    ])
    assert _fields(row)["$['user.email']"]["occurrence_count"] == 1
    assert _fields(row)["$.user.email"]["occurrence_count"] == 2


def test_legacy_observations_never_backfilled_with_fake_precise_counts():
    previous = {
        "paths": {
            "$.email": {
                "type": "string", "observation_count": 80,
                "runs_since_seen": 1, "add_confirm_runs": 0,
                "type_change_confirm_runs": 0,
            },
            "$.username": {"type": "string", "observation_count": 80},
        },
        "some_legacy_extension": {"keep": True},
    }
    baseline = {"paths": {"$.email": {"type": "string"}}, "version": 1}
    row = StreamObservedSchema(
        stream_id=301, paths_json=deepcopy(previous),
        baseline_paths_json=deepcopy(baseline),
        total_events_observed=80, observation_run_count=6,
    )
    fake = FakeMemorySession([row])
    observation.observe_extracted_events(fake, 301, [{"email": "s"}, {"other": 9}])
    assert _counting(row)["historical_events_excluded"] == 80
    assert _counting(row)["sampled_events"] == 2
    assert _fields(row)["$.email"]["occurrence_count"] == 1
    assert _fields(row)["$.username"]["occurrence_count"] == 0
    assert _fields(row)["$.email"]["observation_count"] == 82
    assert row.paths_json["some_legacy_extension"] == {"keep": True}
    assert row.baseline_paths_json == baseline


def test_legacy_read_without_epoch_returns_unknown_not_fabricated_accuracy():
    row=StreamObservedSchema(
        stream_id=301,
        paths_json={"paths": {"$.email": {"type":"string", "observation_count": 200}}},
        total_events_observed=200, observation_run_count=7,
    )
    model=observation.build_observed_schema_read_model(stream_id=301,row=row)
    validated=StreamObservedSchemaResponse.model_validate(model)
    assert validated.occurrence_sampled_events is None
    assert validated.paths[0].occurrence_count is None
    assert validated.paths[0].observation_count == 200


def test_new_read_response_exposes_count_epoch_and_preserves_old_fields():
    _,row=_observe([{"x":9}, {"y":4}])
    model=StreamObservedSchemaResponse.model_validate(
        observation.build_observed_schema_read_model(stream_id=301,row=row)
    )
    assert model.occurrence_sampled_events == 2
    assert model.occurrence_complete is True
    assert model.paths[0].occurrence_count == 1
    assert model.total_events_observed == 2


def test_array_sample_limit_is_explicit_not_exact():
    _,row=_observe([{"arr":[{"k":1},{"k":2},{"k":3},{"k":4}]}])
    assert _counting(row)["complete"] is False
    assert "array_sample_limit" in _counting(row)["warnings"]


def test_event_sample_limit_is_explicit_not_exact(monkeypatch):
    monkeypatch.setattr(observation.settings,"GDC_SCHEMA_OBSERVATION_MAX_EVENTS_PER_RUN",2)
    _,row=_observe([{"k":1}, {"k":2}, {"k":3}])
    assert _counting(row)["sampled_events"] == 2
    assert _counting(row)["complete"] is False
    assert "event_sample_limit" in _counting(row)["warnings"]


def test_invalid_event_object_is_excluded_with_warning():
    _,row=_observe([{"k":1}, "not-an-event", {"k":2}])
    assert _counting(row)["sampled_events"] == 2
    assert _counting(row)["complete"] is False
    assert "non_object_events_ignored" in _counting(row)["warnings"]


def test_existing_epoch_accumulates_without_restarting_or_rewriting():
    fake,row=_observe([{"k":1},{"q":1}])
    observation.observe_extracted_events(fake,301,[{"k":2},{"q":2},{"k":3}])
    assert _counting(row)["sampled_events"] == 5
    assert _counting(row)["historical_events_excluded"] == 0
    assert _fields(row)["$.k"]["occurrence_count"] == 3
    assert _fields(row)["$.q"]["occurrence_count"] == 2


def test_legacy_empty_batch_still_increments_new_frequency_denominator():
    db,row=_observe([{"x":1}])
    observation.observe_extracted_events(db,301,[{},{}])
    assert _counting(row)["sampled_events"] == 3
    assert _fields(row)["$.x"]["occurrence_count"] == 1


def test_all_empty_events_create_valid_epoch_without_fake_fields():
    db,row=_observe([{},{}])
    assert row is not None
    assert row.paths_json["paths"]=={}
    assert _counting(row)["sampled_events"]==2
    observation.observe_extracted_events(db,301,[{"new":"value"}])
    assert _counting(row)["sampled_events"]==3
    assert _fields(row)["$.new"]["occurrence_count"]==1


def test_baseline_reset_serialization_preserves_counting_metadata():
    _,row=_observe([{"k":1},{}])
    copied=deepcopy(row.paths_json)
    meta=observation._paths_from_row(row.paths_json)
    next_json=observation._serialize_paths(meta, source=row.paths_json)
    assert next_json["counting_v1"]==copied["counting_v1"]


def test_reject_impossible_batch_occurrence_count():
    with pytest.raises(ValueError):
        observation.merge_path_inventories(
            {}, {"$.x":"integer"},events_in_batch=2,
            batch_occurrence_counts={"$.x":3},
        )


def test_schema_observation_disabled_is_noop(monkeypatch):
    monkeypatch.setattr(observation, "schema_observation_enabled", lambda: False)
    db,row=_observe([{"x":1}])
    assert row is None


def test_drift_pipeline_preserves_count_epoch(monkeypatch):
    db,row=_observe([{"k":1}])
    monkeypatch.setattr(observation, "schema_drift_detection_enabled", lambda: True)
    monkeypatch.setattr(observation,"detect_field_changes",lambda *args,**kwargs:None)
    observation.observe_extracted_events(db,301,[{"k":2}])
    assert _counting(row)["sampled_events"]==2
    assert _fields(row)["$.k"]["occurrence_count"]==2


def test_sparse_ratio_below_30_percent_but_exactly_30_is_not_rare():
    db,row=_observe([{"x":1}]*3+[{"y":1}]*7)
    assert _fields(row)["$.x"]["occurrence_count"] == 3
    assert _fields(row)["$.x"]["occurrence_count"]/_counting(row)["sampled_events"]==0.3
    db,row=_observe([{"x":1}]*2+[{"y":1}]*8,stream=302)
    assert _fields(row)["$.x"]["occurrence_count"]/_counting(row)["sampled_events"]<0.3


def test_event_fields_input_never_modified():
    events=[{"arr":[{"private":"do-not-log"}]},{"arr":[]}]
    snapshot=deepcopy(events)
    _observe(events)
    assert events==snapshot


def test_actual_baseline_reset_preserves_observation_epoch(monkeypatch):
    """Exercise the production operator helper without a database connection."""
    from app.schema_observation import operator_workflow

    db, row = _observe([{"x": 1}, {"y": 2}])
    before_epoch = deepcopy(_counting(row))
    before_present = _fields(row)["$.x"]["occurrence_count"]
    monkeypatch.setattr(operator_workflow, "list_field_drifts", lambda *a, **k: [])
    returned, affected = operator_workflow.reset_schema_baseline(
        db, stream_id=301, actor_username="synthetic-test",
        reason="synthetic baseline reset",
    )
    assert returned is row
    assert affected == 0
    assert row.baseline_paths_json["paths"]["$.x"]["type"] == "integer"
    assert _counting(row) == before_epoch
    assert _fields(row)["$.x"]["occurrence_count"] == before_present
    assert row.baseline_version == 2


def test_path_inventory_truncation_is_not_promoted_to_complete(monkeypatch):
    monkeypatch.setattr(observation.settings, "GDC_SCHEMA_OBSERVATION_MAX_PATHS", 100)
    keys = {f"k{i}": i for i in range(150)}
    _, row = _observe([keys])
    assert _counting(row)["complete"] is False
    assert "path_sample_limit" in _counting(row)["warnings"]
    assert "union_path_limit" in _counting(row)["warnings"]


def test_an_incomplete_window_stays_incomplete_after_complete_batches():
    db, row = _observe([{"array": [1, 2, 3, 4]}])
    assert _counting(row)["complete"] is False
    observation.observe_extracted_events(db, 301, [{"new": True}])
    assert _counting(row)["sampled_events"] == 2
    assert _counting(row)["complete"] is False
    assert "array_sample_limit" in _counting(row)["warnings"]


def test_old_history_and_new_epoch_are_represented_separately_in_api():
    row = StreamObservedSchema(
        stream_id=301,
        paths_json={
            "paths": {
                "$.x": {"type": "string", "observation_count": 47},
            }
        },
        total_events_observed=47,
        observation_run_count=9,
    )
    session = FakeMemorySession([row])
    observation.observe_extracted_events(session, 301, [{"x": "sample"}])
    model = StreamObservedSchemaResponse.model_validate(
        observation.build_observed_schema_read_model(stream_id=301, row=row)
    )
    assert model.total_events_observed == 48
    assert model.historical_events_excluded == 47
    assert model.occurrence_sampled_events == 1
    assert model.paths[0].occurrence_count == 1
    assert model.paths[0].observation_count == 48
