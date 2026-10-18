"""Protected field identities: independent synthetic P0 regression experiments."""
from copy import deepcopy
import pytest

from app.protection.engine import (
    apply_rule_to_event,
    collect_tokenization_targets,
    parse_field_path_segments,
)
from app.protection.models import (
    PROTECTION_MODE_DROP_FIELD,
    PROTECTION_MODE_FULL_MASK,
    PROTECTION_MODE_TOKENIZATION,
)

class Rule:
    id = 142
    stream_id = 42
    enabled = True
    def __init__(self, path, mode=PROTECTION_MODE_FULL_MASK):
        self.field_path = path
        self.protection_mode = mode


@pytest.mark.parametrize(
    ("query","expected"),
    [
        ("$.user.email", ["user","email"]),
        ("$['user.email']", ["user.email"]),
        ("$['items'][]['a.b']", ["items","[]","a.b"]),
        ("$['items'][*]['a.b']", ["items","[]","a.b"]),
        ("$.arr[0].value", ["arr",0,"value"]),
        ("$.arr[-1].value", ["arr",-1,"value"]),
        ("$['']", [""]),
        ("$['a[]']", ["a[]"]),
        ("$['a.b']['c[]']", ["a.b","c[]"]),
        ("$[\"a'b\"]", ["a'b"]),
    ],
)
def test_schema_and_quoted_parser_paths(query, expected):
    assert parse_field_path_segments(query)==expected


@pytest.mark.parametrize(
    ("input_event","query","expected_applied","expected"),
    [
        (
            {"user.email":"synthetic-secret","user":{"email":"unrelated"},"keep":7},
            "$['user.email']",1,
            {"user.email":"********","user":{"email":"unrelated"},"keep":7},
        ),
        (
            {"user.email":"unrelated","user":{"email":"synthetic-secret"}},
            "$.user.email",1,
            {"user.email":"unrelated","user":{"email":"********"}},
        ),
        (
            {"items":[{"a.b":"synthetic-secret"},{"a.b":"another-secret"}],"keep":7},
            "$['items'][]['a.b']",2,
            {"items":[{"a.b":"********"},{"a.b":"********"}],"keep":7},
        ),
        (
            {"items":[{"a.b":"synthetic-secret"},{"a.b":"another-secret"}]},
            "$['items'][1]['a.b']",1,
            {"items":[{"a.b":"synthetic-secret"},{"a.b":"********"}]},
        ),
        (
            {"items":[{"a.b":"synthetic-secret"},{"a.b":"another-secret"}]},
            "$['items'][-1]['a.b']",1,
            {"items":[{"a.b":"synthetic-secret"},{"a.b":"********"}]},
        ),
        (
            {"a[]":"synthetic-secret","arr":["untouched"]},
            "$['a[]']",1,
            {"a[]":"********","arr":["untouched"]},
        ),
        (
            {"":"synthetic-secret","keep":None},
            "$['']",1,
            {"":"********","keep":None},
        ),
    ],
)
def test_full_mask_applies_only_correct_synthetic_fields(
    input_event, query, expected_applied, expected,
):
    event=deepcopy(input_event)
    count, warning=apply_rule_to_event(event, Rule(query))
    if query == "$.user.email" and "user.email" in input_event:
        # The historical unquoted selector aliases a literal top-level key.
        # Never mask only the nested value and silently leave the literal key.
        assert count == 0 and warning is not None
        assert "ambiguous legacy field path" in warning.error_message
        assert event == input_event
    else:
        assert count==expected_applied
        assert warning is None
        assert event==expected
        assert input_event!=event


def test_syntactically_invalid_selector_gives_explicit_warning():
    source={"user.email":"synthetic-secret","keep":"untouched"}
    event=deepcopy(source)
    count,warning=apply_rule_to_event(event,Rule("$["))
    assert count==0
    assert warning is not None
    assert event==source


def test_legacy_array_wildcard_keeps_existing_behavior():
    event={"items":[{"token":"first"},{"token":"second"}]}
    count,warning=apply_rule_to_event(event,Rule("$.items[].token"))
    assert count==2 and warning is None
    assert event=={"items":[{"token":"********"},{"token":"********"}]}


def test_drop_quoted_field_without_removing_siblings():
    event={"a.b":"synthetic-secret","a":{"b":"keep"},"retain":True}
    count,warning=apply_rule_to_event(
        event,Rule("$['a.b']",PROTECTION_MODE_DROP_FIELD)
    )
    assert count==1 and warning is None
    assert event=={"a":{"b":"keep"},"retain":True}


def test_tokenization_scan_finds_quoted_fields():
    events=[{"a.b":"first"},{"a.b":"second"}]
    rule=Rule("$['a.b']",PROTECTION_MODE_TOKENIZATION)
    items=collect_tokenization_targets(events,[rule])
    assert {(row["field_path"],row["original_value"]) for row in items}=={
        ("$['a.b']","first"),("$['a.b']","second"),
    }


def test_explicit_numeric_array_index_full_mask():
    event={"arr":["first","second","third"]}
    count, warning=apply_rule_to_event(event,Rule("$.arr[-1]"))
    assert count==1 and warning is None
    assert event=={"arr":["first","second","********"]}


def test_optional_absent_path_does_not_mask_or_fake_success():
    event={"keep":"untouched"}
    count,warning=apply_rule_to_event(event,Rule("$['missing']"))
    assert count==0 and warning is None
    assert event=={"keep":"untouched"}
