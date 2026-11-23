"""C-PERF Mapping should not evaluate the same JSONPath twice per event."""
from __future__ import annotations

import copy

from app.mappers.mapper import apply_compiled_mapping, compile_mappings


def test_selected_matches_reused_with_wildcard_negative_index_and_literal_key() -> None:
    event = {
        "items": [
            {"id": 1, "tag": "a", "keep": {"value": "α"}},
            {"id": 2, "tag": "b", "keep": {"value": "β"}},
        ],
        "strange.key": 9007199254740993,
        "unrelated": {"empty_object": {}, "array": [[], None]},
    }
    original = copy.deepcopy(event)
    paths = {
        "first_id": "$.items[0].id",
        "first_tag": "$.items[*].tag",
        "last_id": "$.items[-1].id",
        "precise": "$['strange.key']",
    }
    mapped = apply_compiled_mapping(
        event, compile_mappings(paths), source_json_paths=tuple(paths.values())
    )
    assert mapped == {
        "first_id": 1, "first_tag": "a", "last_id": 2,
        "precise": 9007199254740993,
        "items": [
            {"keep": {"value": "α"}},
            {"tag": "b", "keep": {"value": "β"}},
        ],
        "unrelated": {"empty_object": {}, "array": [[], None]},
    }
    assert event == original
    mapped["items"][0]["keep"]["value"] = "changed"
    assert event == original


def test_custom_source_paths_independent_from_mapping_compiled_paths() -> None:
    event = {"id": 5, "nested": {"token": "x", "keep": "y"}}
    mapped = apply_compiled_mapping(
        event, compile_mappings({"out": "$.id"}),
        source_json_paths=("$.nested.token",),
    )
    assert mapped == {"out": 5, "id": 5, "nested": {"keep": "y"}}
    assert event == {"id": 5, "nested": {"token": "x", "keep": "y"}}
