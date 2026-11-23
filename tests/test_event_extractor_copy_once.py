"""C-PERF-2: event extraction must preserve copies/errors across extraction paths."""
from __future__ import annotations

import copy

import pytest

from app.parsers.event_extractor import extract_events
from app.runtime.errors import MappingError


@pytest.mark.parametrize(
    ("source", "path", "root", "expected"),
    [
        ({"id": 1, "nested": {"v": [2, None]}}, None, None,
         [{"id": 1, "nested": {"v": [2, None]}}]),
        ([{"id": 1}, {"id": 2}], None, None, [{"id": 1}, {"id": 2}]),
        ({"rows": [{"id": 1}, {"id": 2}]}, "$.rows", None,
         [{"id": 1}, {"id": 2}]),
        ({"rows": {"id": 1}}, "$.rows", None, [{"id": 1}]),
        ({"rows": [{"payload": {"value": 9007199254740993, "label": "é🛡"}}]},
         "$.rows", "$.payload",
         [{"value": 9007199254740993, "label": "é🛡"}]),
        ({"rows": [{"id": 1}, {"id": 2}]}, "$.rows[*]", None,
         [{"id": 1}, {"id": 2}]),
    ],
)
def test_copy_isolation_for_all_extraction_shapes(source, path, root, expected):
    original = copy.deepcopy(source)
    result = extract_events(source, path, root)
    assert result == expected
    assert source == original
    result[0]["mutated"] = True
    if isinstance(result[0].get("nested"), dict):
        result[0]["nested"]["v"].append("changed")
    assert source == original


@pytest.mark.parametrize(
    ("source", "path", "root"),
    [
        ([{"ok": 1}, "bad"], None, None),
        ({"rows": [{"ok": 1}, "bad"]}, "$.rows", None),
        ({"rows": [{"payload": [1, 2]}]}, "$.rows", "$.payload"),
        ({"rows": [{"wrong": 1}]}, "$.rows", "$.payload"),
    ],
)
def test_extraction_invalid_elements_are_still_rejected(source, path, root):
    original = copy.deepcopy(source)
    with pytest.raises(MappingError):
        extract_events(source, path, root)
    assert source == original
