"""Legacy ambiguous persisted Protection paths must not silently miss sensitive data."""
from __future__ import annotations

from copy import deepcopy

import pytest

from app.protection import engine as protection
from app.protection.models import PROTECTION_MODE_FULL_MASK
from app.route_protection.stage import _raise_on_protection_warnings
from app.runtime.errors import ProtectionApplicationError


class Rule:
    id = 442
    stream_id = 442
    enabled = True
    protection_mode = PROTECTION_MODE_FULL_MASK

    def __init__(self, path: str):
        self.field_path = path


@pytest.mark.parametrize(
    ("event", "path"),
    [
        ({"user.email": "synthetic"}, "$.user.email"),
        ({"user.email": "synthetic", "user": {"email": "other"}}, "$.user.email"),
        ({"outer": {"a.b": "synthetic"}}, "$.outer.a.b"),
        ({"items": [{"a.b": "synthetic"}]}, "$.items[].a.b"),
        ({"items": [{"a.b": "synthetic", "a": {"b": "other"}}]}, "$.items[].a.b"),
    ],
)
def test_ambiguous_unquoted_legacy_path_blocks_silent_protection(event, path):
    baseline = deepcopy(event)
    applied, warning = protection.apply_rule_to_event(event, Rule(path))
    assert applied == 0
    assert warning is not None
    assert "ambiguous legacy field path" in warning.error_message
    assert event == baseline


def test_route_delivery_fails_closed_on_ambiguous_protection(monkeypatch):
    monkeypatch.setattr(protection, "protection_enabled", lambda: True)
    events = [{"user.email": "synthetic-secret", "user": {"email": "nested"}}]
    result = protection.protect_batch(events, [Rule("$.user.email")], stream_id=442)
    assert result.warning_count == 1
    with pytest.raises(ProtectionApplicationError):
        _raise_on_protection_warnings(result)
    assert result.events[0]["user.email"] == "synthetic-secret"


def test_explicit_literal_path_protects_only_exact_field():
    event = {"user.email": "synthetic-secret", "user": {"email": "nested"}}
    applied, warning = protection.apply_rule_to_event(event, Rule("$['user.email']"))
    assert applied == 1 and warning is None
    assert event == {"user.email": "********", "user": {"email": "nested"}}


def test_explicit_nested_path_is_safe_without_literal_dotted_key():
    event = {"user": {"email": "synthetic-secret"}, "other": "safe"}
    applied, warning = protection.apply_rule_to_event(event, Rule("$.user.email"))
    assert applied == 1 and warning is None
    assert event == {"user": {"email": "********"}, "other": "safe"}


def test_absent_optional_dotted_field_stays_nonblocking_without_alias():
    event = {"other": "present"}
    applied, warning = protection.apply_rule_to_event(event, Rule("$.user.email"))
    assert applied == 0 and warning is None
    assert event == {"other": "present"}


def test_safe_nested_array_protection_unchanged():
    event = {"items": [{"a": {"b": "first"}}, {"a": {"b": "second"}}]}
    applied, warning = protection.apply_rule_to_event(event, Rule("$.items[].a.b"))
    assert applied == 2 and warning is None
    assert all(item["a"]["b"] == "********" for item in event["items"])


def test_single_segment_not_ambiguous_even_if_value_contains_punctuation():
    event = {"user": "a.b"}
    applied, warning = protection.apply_rule_to_event(event, Rule("$.user"))
    assert applied == 1 and warning is None
    assert event == {"user": "********"}

def test_ambiguous_legacy_tokenization_does_not_prefetch_vault_targets():
    from app.protection.engine import collect_tokenization_targets
    from app.protection.models import PROTECTION_MODE_TOKENIZATION

    event = {"user.email": "synthetic-literal", "user": {"email": "synthetic-nested"}}
    rule = Rule("$.user.email")
    rule.protection_mode = PROTECTION_MODE_TOKENIZATION
    assert collect_tokenization_targets([event], [rule]) == []


def test_explicit_tokenization_key_is_still_collected_safely():
    from app.protection.engine import collect_tokenization_targets
    from app.protection.models import PROTECTION_MODE_TOKENIZATION

    event = {"user.email": "synthetic-literal", "user": {"email": "synthetic-nested"}}
    rule = Rule("$['user.email']")
    rule.protection_mode = PROTECTION_MODE_TOKENIZATION
    targets = collect_tokenization_targets([event], [rule])
    assert targets == [{
        "field_path": "$['user.email']",
        "original_value": "synthetic-literal",
    }]


def test_drop_helper_handles_explicit_numeric_index_and_literal_dot():
    from app.protection.field_drop import remove_field_at_path
    event = {
        "items": [{"a.b": "one"}, {"a.b": "two", "keep": "stay"}],
        "keep": "outer",
    }
    assert remove_field_at_path(event, "$['items'][1]['a.b']") == 1
    assert event == {
        "items": [{"a.b": "one"}, {"keep": "stay"}], "keep": "outer",
    }


def test_drop_helper_preserves_legacy_array_wildcard_behavior():
    from app.protection.field_drop import remove_field_at_path
    event = {"items": [{"token": "first"}, {"token": "second"}]}
    assert remove_field_at_path(event, "$.items[].token") == 2
    assert event == {"items": [{}, {}]}



def test_mixed_quoted_parent_with_unquoted_ambiguous_tail_fails_closed():
    event = {"outer": {"a.b": "synthetic-literal", "a": {"b": "nested"}}}
    baseline = deepcopy(event)
    applied, warning = protection.apply_rule_to_event(event, Rule("$['outer'].a.b"))
    assert applied == 0 and warning is not None
    assert "ambiguous legacy field path" in warning.error_message
    assert event == baseline


def test_quoted_child_disambiguates_intent_of_remaining_nested_path():
    event = {"outer": {"a.b": "synthetic-literal", "a": {"b": "nested"}}}
    applied, warning = protection.apply_rule_to_event(event, Rule("$.outer['a'].b"))
    assert applied == 1 and warning is None
    assert event == {"outer": {"a.b": "synthetic-literal", "a": {"b": "********"}}}


def test_quoted_parent_and_explicit_nested_children_are_unambiguous():
    event = {"outer": {"a.b": "synthetic-literal", "a": {"b": "nested"}}}
    applied, warning = protection.apply_rule_to_event(event, Rule("$['outer']['a']['b']"))
    assert applied == 1 and warning is None
    assert event["outer"]["a.b"] == "synthetic-literal"
    assert event["outer"]["a"]["b"] == "********"
