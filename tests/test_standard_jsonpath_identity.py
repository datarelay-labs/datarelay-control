"""Isolated candidate: RFC 9535 concrete node identity and lossless pass-through.

This lives in the independent scratch copy; it is NOT an accepted product test
until a later authorized implementation lane adopts it and runs normal gates.
"""

from __future__ import annotations

from copy import deepcopy

import pytest

from app.mappers.pass_through import (
    build_residual_after_mapping,
    mapped_top_level_keys,
    merge_unknown_field_pass_through,
    parse_jsonpath_segments,
    remove_at_jsonpath,
)
from app.mappers.mapper import apply_compiled_mapping, compile_mappings


@pytest.mark.parametrize(
    ("event", "source_query", "expected"),
    [
        (
            {"a.b": 1, "a": {"b": 2}, "keep": 3},
            "$['a.b']",
            {"a": {"b": 2}, "keep": 3},
        ),
        (
            {"a.b": 1, "a": {"b": 2}, "keep": 3},
            "$['a']['b']",
            {"a.b": 1, "keep": 3},
        ),
        ({"": 9, "keep": 3}, "$['']", {"keep": 3}),
        ({"a[0]": 9, "keep": 3}, "$['a[0]']", {"keep": 3}),
        ({"a'b": 9, "keep": 3}, "$[\"a'b\"]", {"keep": 3}),
        ({"a,b": 9, "keep": 3}, "$['a,b']", {"keep": 3}),
        ({"한글": 9, "keep": 3}, "$['한글']", {"keep": 3}),
        ({"a\\b": 9, "keep": 3}, "$['a\\\\b']", {"keep": 3}),
        ({"a/b": 9, "keep": 3}, "$['a/b']", {"keep": 3}),
        ({"~": 9, "keep": 3}, "$['~']", {"keep": 3}),
        ({"nested": [{"a": 1, "retain": True}, {"a": 2, "retain": False}]},
         "$.nested[*].a",
         {"nested": [{"retain": True}, {"a": 2, "retain": False}]}),
        ({"arr": [10, 20, 30]}, "$.arr[1]", {"arr": [10, 30]}),
        ({"arr": [10, 20, 30]}, "$.arr[*]", {"arr": [20, 30]}),
        ({"user": {"value": 1}, "retain": "yes"}, "$.missing",
         {"user": {"value": 1}, "retain": "yes"}),
        ({"already_empty": {}, "keep": 4}, "$.missing",
         {"already_empty": {}, "keep": 4}),
    ],
)
def test_single_selection_preserves_unmapped_fields(
    event: dict, source_query: str, expected: dict
) -> None:
    before = deepcopy(event)
    assert build_residual_after_mapping(event, [source_query]) == expected
    assert event == before


def test_empty_member_key_not_mistaken_for_entire_document() -> None:
    root = {"": "private", "keep": "public"}
    remove_at_jsonpath(root, "$['']")
    assert root == {"keep": "public"}


def test_invalid_path_raises_without_erasing_input() -> None:
    root = {"keep": 1, "a": 2}
    with pytest.raises(Exception):
        remove_at_jsonpath(root, "$[")
    assert root == {"keep": 1, "a": 2}


def test_definite_segment_parser_is_quote_aware() -> None:
    assert parse_jsonpath_segments("$['user.email']") == ["user.email"]
    assert parse_jsonpath_segments("$['user']['email']") == ["user", "email"]
    assert parse_jsonpath_segments("$.arr[0].tag") == ["arr", 0, "tag"]
    assert parse_jsonpath_segments("$['']") == [""]


def test_wildcards_not_pretended_to_be_concrete_paths() -> None:
    with pytest.raises(ValueError, match="unambiguous concrete"):
        parse_jsonpath_segments("$.items[*].tag")
    assert mapped_top_level_keys(["$.items[*].tag", "$['a.b']"]) == {
        "items", "a.b",
    }


def test_selected_array_indexes_do_not_shift() -> None:
    root = {"arr": ["a", "b", "c", "d"], "keep": "x"}
    assert build_residual_after_mapping(root, ["$.arr[0]", "$.arr[2]"]) == {
        "arr": ["b", "d"], "keep": "x",
    }


def test_root_path_intentionally_consumes_whole_event() -> None:
    assert build_residual_after_mapping({"x": 1}, ["$"]) == {}
    assert merge_unknown_field_pass_through({"x": 1}, {"copy": 1}, ["$"]) == {
        "copy": 1,
    }


def test_mapping_output_integration_preserves_sibling() -> None:
    event = {"a.b": "sensitive", "a": {"b": "nested"}, "keep": "remain"}
    mappings = compile_mappings({"target": "$['a.b']"})
    result = apply_compiled_mapping(
        event, mappings, source_json_paths=("$['a.b']",),
    )
    assert result == {"target": "sensitive", "a": {"b": "nested"}, "keep": "remain"}
    assert event["a.b"] == "sensitive"


def test_overlapping_parents_and_wildcard_are_deterministic() -> None:
    event = {"arr": [{"x": 1, "y": "a"}, {"x": 2, "y": "b"}], "keep": 3}
    result = build_residual_after_mapping(event, ["$.arr[*].x", "$.arr[0]"])
    assert result == {"arr": [{"x": 2, "y": "b"}], "keep": 3}


def test_unknown_mapped_field_does_not_drop_others() -> None:
    source = {"id": 23, "keep": 42}
    result = merge_unknown_field_pass_through(source, {"out": None}, ["$['missing']"])
    assert result == {"out": None, "id": 23, "keep": 42}


def test_basic_mapping_wildcard_consumes_first_match_only() -> None:
    source = {"arr": [{"id": "one", "remain": 1}, {"id": "two", "remain": 2}]}
    mapped = apply_compiled_mapping(
        source,
        compile_mappings({"first": "$.arr[*].id"}),
        source_json_paths=("$.arr[*].id",),
    )
    assert mapped == {
        "first": "one",
        "arr": [{"remain": 1}, {"id": "two", "remain": 2}],
    }


def test_unrelated_empty_containers_preserved() -> None:
    source = {"existing_empty": {}, "existing_list": [], "user": {"name": "Kim"}}
    result = build_residual_after_mapping(source, ("$.user.name",))
    assert result == {"existing_empty": {}, "existing_list": []}


def test_overlapping_array_removals_and_selective_prune() -> None:
    source = {
        "arr": [{"x": 1}, {"x": 2, "leave": True}, {"x": 3}],
        "other": {},
    }
    result = build_residual_after_mapping(
        source, ("$.arr[0]", "$.arr[1].x", "$.arr[2]"),
    )
    assert result == {"arr": [{"leave": True}], "other": {}}

@pytest.mark.parametrize(
    ("paths", "expected"),
    [
        (("$.arr[-1]",), ["a", "b", "c"]),
        (("$.arr[-2]",), ["a", "b", "d"]),
        (("$.arr[2]", "$.arr[-2]"), ["a", "b", "d"]),
        (("$.arr[0]", "$.arr[-1]"), ["b", "c"]),
        (("$.arr[-2]", "$.arr[-1]"), ["a", "b"]),
        (("$.arr[0]", "$.arr[-1]", "$.arr[2]"), ["b"]),
        (("$.arr[-4]", "$.arr[0]"), ["b", "c", "d"]),
        (("$.arr[3]", "$.arr[-1]"), ["a", "b", "c"]),
    ],
)
def test_negative_array_indices_canonicalized_against_original_event(
    paths: tuple[str, ...], expected: list[str]
) -> None:
    source = {"arr": ["a", "b", "c", "d"], "keep": "unmapped"}
    assert build_residual_after_mapping(source, paths) == {
        "arr": expected, "keep": "unmapped",
    }
    assert source["arr"] == ["a", "b", "c", "d"]


def test_nested_negative_indexes_in_distinct_arrays() -> None:
    source = {
        "groups": [
            {"items": ["a", "b", "c"]},
            {"items": ["x", "y", "z"]},
        ],
        "keep": 1,
    }
    assert build_residual_after_mapping(
        source, ("$.groups[-1].items[-2]", "$.groups[0].items[-1]")
    ) == {
        "groups": [
            {"items": ["a", "b"]},
            {"items": ["x", "z"]},
        ],
        "keep": 1,
    }


def test_same_nested_array_node_alternate_aliases() -> None:
    source = {"groups": [{"items": [10, 20, 30]}]}
    assert build_residual_after_mapping(
        source, ("$.groups[-1].items[-1]", "$.groups[0].items[2]")
    ) == {"groups": [{"items": [10, 20]}]}


def test_mapping_first_match_negative_index_is_consistent() -> None:
    source = {"arr": ["a", "b", "c", "d"], "keep": True}
    result = apply_compiled_mapping(
        source,
        compile_mappings({"last": "$.arr[-1]", "also_last": "$.arr[3]"}),
        source_json_paths=("$.arr[-1]", "$.arr[3]"),
    )
    assert result == {"last": "d", "also_last": "d", "arr": ["a", "b", "c"], "keep": True}


def test_nonexistent_negative_index_leaves_event_intact() -> None:
    source = {"arr": ["a", "b"], "keep": True}
    assert build_residual_after_mapping(source, ("$.arr[-9]",)) == source

def test_out_of_range_positive_index_preserves_source() -> None:
    source = {"arr": ["a", "b"], "keep": True}
    assert build_residual_after_mapping(source, ("$.arr[99]",)) == source


def test_negative_index_query_returns_concrete_nonnegative_selection() -> None:
    source = {"arr": [10, 20, 30, 40]}
    from app.mappers.pass_through import _selected_concrete_paths
    assert _selected_concrete_paths(source, ("$.arr[-1]",)) == {("arr", 3)}
    assert _selected_concrete_paths(source, ("$.arr[-3]", "$.arr[1]")) == {
        ("arr", 1),
    }

def test_negative_out_of_bounds_is_no_match_through_public_extractor() -> None:
    from app.parsers.jsonpath_parser import extract_one, extract_all
    source = {"arr": ["first", "second"]}
    missing = object()
    assert extract_one(source, "$.arr[-9]", default=missing) is missing
    assert extract_all(source, "$.arr[-9]") == []


def test_negative_out_of_bounds_is_no_match_through_basic_mapping() -> None:
    event = {"arr": ["first", "second"], "keep": "retained"}
    mappings = compile_mappings({"selected": "$.arr[-9]"})
    result = apply_compiled_mapping(
        event, mappings, source_json_paths=("$.arr[-9]",),
    )
    assert result == {
        "selected": None,
        "arr": ["first", "second"],
        "keep": "retained",
    }
