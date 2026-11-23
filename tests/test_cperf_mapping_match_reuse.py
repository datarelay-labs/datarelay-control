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



def test_optimized_matching_equals_legacy_residual_for_varied_paths() -> None:
    from app.mappers.pass_through import merge_unknown_field_pass_through
    from app.parsers.jsonpath_parser import extract_one_compiled
    from app.runtime.copy_utils import copy_json_value

    source = {
        "records": [
            {"id": 9007199254740993, "tag": "é", "details": {"keep": None}},
            {"id": 9007199254740994, "tag": "🛡️", "details": {"empty": []}},
        ],
        "empty": {}, "plain": [None, {"nested": [1, 2]}],
        "strange.key": {"v": 7},
    }
    suites = [
        {"one": "$.records[0].id", "two": "$.records[1].tag"},
        {"one": "$.records[*].tag", "two": "$.records[-1].id"},
        {"one": "$['strange.key'].v", "two": "$.missing"},
        {"whole": "$"},
        {},
        {"o": "$.records[10].id", "p": "$.records[-5].tag"},
        {"o": "$.plain[1].nested", "p": "$.empty"},
    ]
    for paths in suites:
        compiled = compile_mappings(paths)
        before = copy.deepcopy(source)
        expected = {
            key: copy_json_value(extract_one_compiled(expr, source, default=None))
            for key, expr in compiled.items()
        }
        if compiled:
            expected = merge_unknown_field_pass_through(source, expected, tuple(paths.values()))
        else:
            expected = copy_json_value(source)
        observed = apply_compiled_mapping(
            source, compiled, source_json_paths=tuple(paths.values())
        )
        assert observed == expected, paths
        assert source == before, paths
