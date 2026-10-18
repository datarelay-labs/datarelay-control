"""Source-path presence must distinguish absent member from JSON null.

Exact-source scratch-only smoke/regression; no product/API/DB writes.
"""
import pytest

from app.schema_drift_policy.path_resolve import (
    path_exists_on_event,
    path_exists_in_batch,
    resolve_protection_field_path,
)

@pytest.mark.parametrize(
    ("event","path","expected"),
    [
        ({"x":None},"$.x",True),
        ({"x":0},"$.x",True),
        ({"x":False},"$.x",True),
        ({"x":""},"$.x",True),
        ({"x":[]},"$.x",True),
        ({"x":{}},"$.x",True),
        ({"x":{"y":None}},"$.x.y",True),
        ({"x":{"y":None}},"$.x.missing",False),
        ({"user.email":None},"$['user.email']",True),
        ({"user":{"email":None}},"$.user.email",True),
        ({"user.email":None},"$.user.email",False),
        ({}, "$.x",False),
        ({"x":None},"$.none",False),
        ({"x":None},"$[",False),
        ({"x":None},"$",False),
    ],
)
def test_json_path_presence_null_is_not_missing(event,path,expected):
    assert path_exists_on_event(event,path) is expected


def test_null_is_present_in_batch_even_without_non_null_values():
    assert path_exists_in_batch([{"id":None},{"other":1}],"$.id") is True


def test_absent_path_remains_absent_for_all_events():
    assert path_exists_in_batch([{"id":None},{"other":1}],"$.missing") is False


def test_canonical_quoted_field_resolves_to_selected_runtime_path():
    result=resolve_protection_field_path(
        "$['user.email']",["$['user.email']","$.user.email"],{}
    )
    assert result.ok and result.resolved_path=="$['user.email']"


def test_ambiguous_legacy_field_without_matching_path_is_not_assumed():
    result=resolve_protection_field_path(
        "$.user.email",["$['user.email']"],{}
    )
    assert result.ok is False
