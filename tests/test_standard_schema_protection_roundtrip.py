"""Synthetic Schema Observation -> Protection identity round-trip contract.

Research-only scratch source. These checks do not modify any live database.
"""
from copy import deepcopy

import pytest

from app.schema_observation.path_walker import (
    collect_paths_from_event,
    collect_paths_from_events,
)
from app.protection.engine import apply_rule_to_event
from app.protection.models import PROTECTION_MODE_FULL_MASK


class Rule:
    id=22
    stream_id=22
    protection_mode=PROTECTION_MODE_FULL_MASK
    enabled=True

    def __init__(self,path):
        self.field_path=path


def apply(event,path):
    cloned=deepcopy(event)
    count,warning=apply_rule_to_event(cloned,Rule(path))
    return count,warning,cloned


def test_dotted_literal_and_nested_name_are_distinct_and_both_protectable():
    event={"user.email":"literal-secret", "user":{"email":"nested-secret"}}
    paths=collect_paths_from_event(event,max_depth=8,max_paths=100)
    assert paths["$['user.email']"]=="string"
    assert paths["$.user.email"]=="string"
    assert paths["$.user"]=="object"
    assert len(paths)==3
    n,w,out=apply(event,"$['user.email']")
    assert n==1 and w is None
    assert out=={"user.email":"********","user":{"email":"nested-secret"}}
    n,w,out=apply(event,"$.user.email")
    assert n==1 and w is None
    assert out=={"user.email":"literal-secret","user":{"email":"********"}}


@pytest.mark.parametrize(
    ("key","expected_path"),
    [
        ("a.b","$['a.b']"),
        ("a[]","$['a[]']"),
        ("a-b","$['a-b']"),
        ("a'b","$['a\\'b']"),
        ("한글","$['한글']"),
        ("","$['']"),
        ("a/b","$['a/b']"),
        ("~","$['~']"),
        ("a b","$['a b']"),
    ],
)
def test_literal_key_preserves_identity_for_detection_and_protection(key,expected_path):
    event={key:"synthetic-secret","keep":"do-not-mask"}
    paths=collect_paths_from_event(event,max_depth=4,max_paths=100)
    assert expected_path in paths
    n,w,out=apply(event,expected_path)
    assert n==1 and w is None
    assert out[key]=="********"
    assert out["keep"]=="do-not-mask"
    assert event[key]=="synthetic-secret"


def test_array_schema_pattern_and_protection_are_consistent():
    event={"items":[{"a.b":"s1","remain":"x"},{"a.b":"s2","remain":"y"}]}
    paths=collect_paths_from_event(event,max_depth=5,max_paths=200)
    assert "$.items[]['a.b']" in paths
    n,w,out=apply(event,"$.items[]['a.b']")
    assert n==2 and w is None
    assert [e["a.b"] for e in out["items"]]==["********","********"]
    assert [e["remain"] for e in out["items"]]==["x","y"]


def test_plain_legacy_paths_unchanged():
    event={"user":{"email":"synthetic-secret"},"active":True}
    paths=collect_paths_from_event(event,max_depth=5,max_paths=100)
    assert set(paths)=={"$.user","$.user.email","$.active"}


def test_type_merge_does_not_mix_literal_and_nested_field():
    rows=[{"x.y":"s","x":{"y":1}},{"x.y":"t","x":{"y":2}}]
    paths=collect_paths_from_events(rows,max_depth=5,max_paths=100,max_events=10)
    assert paths["$['x.y']"]=="string"
    assert paths["$.x.y"]=="integer"


@pytest.mark.xfail(
    strict=True,
    reason="jsonpath-ng 1.8.0 does not consistently decode RFC 9535 escaped control-character member names",
)
def test_escaped_newline_key_requires_full_rfc_conformance():
    event={"a\nb":"synthetic-secret"}
    paths=collect_paths_from_event(event,max_depth=4,max_paths=30)
    path="$['a\\nb']"
    assert path in paths
    n,w,out=apply(event,path)
    assert n==1 and w is None and out["a\nb"]=="********"
