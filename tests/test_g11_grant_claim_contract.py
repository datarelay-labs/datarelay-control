"""Offline Grant read/consume binding checks. No network or product effects."""
from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import replace

import pytest

from app.runtime.grant_replay_claim import (
    ACTION_KIND,
    GrantClaimContractError,
    canonical_action_hash,
    inspect_exact_grant_consume,
)
from app.runtime.grant_replay_ledger import ReplayBinding

INTEGRATION_ID = str(uuid.uuid4())


def action(log=42, route=7, dest=9):
    return {
        "kind": ACTION_KIND,
        "target": f"delivery-log/{log}",
        "parameters": {"log_id": log, "route_id": route, "destination_id": dest},
    }


@pytest.fixture
def original():
    bound_action = action()
    return ReplayBinding(
        operation_key="control-replay-delivery-log-42",
        grant_request_id=str(uuid.uuid4()),
        execution_id="control-execution-42",
        action_hash=canonical_action_hash(bound_action),
        delivery_log_id=42,
        route_id=7,
        destination_id=9,
    )


def pair(binding):
    requested = {
        "id": binding.grant_request_id,
        "integration_id": INTEGRATION_ID,
        "state": "APPROVED",
        "action_hash": binding.action_hash,
        "action": action(binding.delivery_log_id, binding.route_id, binding.destination_id),
    }
    consumed = {
        "request_id": binding.grant_request_id,
        "execution_id": binding.execution_id,
        "action_hash": binding.action_hash,
        "committed": True,
        "replay": False,
    }
    return requested, consumed


def inspect(binding, request=None, claim=None, integration_id=INTEGRATION_ID):
    req, claimed = pair(binding)
    return inspect_exact_grant_consume(
        binding=binding,
        grant_integration_id=integration_id,
        request=req if request is None else request,
        claim=claimed if claim is None else claim,
    )


def test_grant_canonical_json_action_fingerprint_matches_sha256_reference(original):
    payload = action()
    raw = json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
        allow_nan=False,
    )
    assert canonical_action_hash(payload) == hashlib.sha256(raw.encode("utf-8")).hexdigest()
    assert canonical_action_hash(payload) == original.action_hash
    unicode_action = {"kind": ACTION_KIND, "target": "서비스", "parameters": {"log_id": 42}}
    encoded = json.dumps(
        unicode_action, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    ).encode("utf-8")
    assert canonical_action_hash(unicode_action) == hashlib.sha256(encoded).hexdigest()


def test_matching_read_claim_only_returns_contract_not_send_permission(original):
    result = inspect(original)
    assert result.grant_request_id == original.grant_request_id
    assert result.execution_id == original.execution_id
    assert result.operation_key == original.operation_key
    assert result.action_hash == original.action_hash
    assert result.claim_is_fresh
    assert result.independently_authenticated is False
    assert result.permits_effect is False


@pytest.mark.parametrize("state", [
    "AWAITING", "HELD", "DENIED", "EXPIRED", "CANCELLED", None, "COMMITTED",
])
def test_current_request_must_be_approved_and_not_provisional(original, state):
    request, _ = pair(original)
    with pytest.raises(GrantClaimContractError, match="CONTRACT_INVALID"):
        inspect(original, request={**request, "state": state})


@pytest.mark.parametrize("field, replacement", [
    ("id", str(uuid.uuid4())),
    ("integration_id", str(uuid.uuid4())),
    ("action_hash", "0" * 64),
])
def test_read_binds_exact_request_identity_and_integration(original, field, replacement):
    request, _ = pair(original)
    with pytest.raises(GrantClaimContractError):
        inspect(original, request={**request, field: replacement})


@pytest.mark.parametrize("change", [
    {"request_id": str(uuid.uuid4())},
    {"execution_id": "wrong-execution"},
    {"action_hash": "b" * 64},
    {"committed": False},
    {"committed": 1},
    {"committed": "true"},
    {"replay": True},
    {"replay": None},
    {"replay": 0},
    {"replay": "false"},
])
def test_grant_consume_reply_must_be_fresh_and_identically_bound(original, change):
    _, claim = pair(original)
    with pytest.raises(GrantClaimContractError):
        inspect(original, claim={**claim, **change})


@pytest.mark.parametrize("delta", [
    {"delivery_log_id": 43},
    {"route_id": 8},
    {"destination_id": 10},
    {"action_hash": "0" * 64},
    {"execution_id": "changed"},
    {"grant_request_id": str(uuid.uuid4())},
    {"operation_key": "bad\nheader"},
])
def test_product_ledger_binding_is_product_derived_and_exact(original, delta):
    # The independently captured Grant read/claim must remain tied to the
    # *original* immutable product operation, not a forged caller's binding.
    request, claim = pair(original)
    with pytest.raises(GrantClaimContractError):
        inspect(replace(original, **delta), request=request, claim=claim)


@pytest.mark.parametrize("field,bad", [
    ("kind", "arbitrary.script.execute"),
    ("target", "delivery-log/43"),
    ("parameters", {"log_id": 43, "route_id": 7, "destination_id": 9}),
    ("parameters", {"log_id": 42, "route_id": 99, "destination_id": 9}),
    ("parameters", {"log_id": 42, "route_id": 7, "destination_id": 90}),
    # Python bool compares equal to int, but JSON fingerprints MUST not.
    ("parameters", {"log_id": True, "route_id": 7, "destination_id": 9}),
])
def test_a_changed_grant_protected_business_action_fails_closed(original, field, bad):
    request, _ = pair(original)
    corrupted = {**request["action"], field: bad}
    with pytest.raises(GrantClaimContractError):
        inspect(original, request={**request, "action": corrupted})


@pytest.mark.parametrize("invalid", [
    {"kind": "bad", "target": "x", "parameters": {"password": "embedded-secret"}},
    {"kind": "bad", "target": "x", "parameters": {"nested": float("nan")}},
    {"kind": "bad", "target": "x", "parameters": {"token": "unsafe"}},
    {"kind": "bad", "target": "x", "parameters": {"k": object()}},
    {"kind": "bad", "target": "x", "parameters": {"k": [1] * 101}},
    {"kind": "bad", "target": "", "parameters": {}},
    {"kind": "bad\n", "target": "x", "parameters": {}},
    {"kind": "bad", "target": "x", "parameters": None},
    {"kind": "bad", "target": "x", "parameters": {}, "extra": "unexpected"},
])
def test_canonical_action_validation_rejects_unbounded_or_secret_values(invalid):
    with pytest.raises(GrantClaimContractError):
        canonical_action_hash(invalid)


def test_json_boolean_cannot_impersonate_integer_business_identifier(original):
    # Exact JSON types matter: True == 1 in Python, but true != 1 in
    # Grant's UTF-8 JSON fingerprint.
    new_action = action(log=1, route=7, dest=9)
    bound = replace(
        original,
        delivery_log_id=1,
        action_hash=canonical_action_hash(new_action),
    )
    request, claim = pair(bound)
    request["action"]["parameters"]["log_id"] = True
    with pytest.raises(GrantClaimContractError):
        inspect(bound, request=request, claim=claim)


def test_partial_or_non_object_grant_payloads_rejected(original):
    _, valid_claim = pair(original)
    for value in [None, "string", [], {"id": original.grant_request_id}]:
        with pytest.raises(GrantClaimContractError):
            inspect_exact_grant_consume(
                binding=original, grant_integration_id=INTEGRATION_ID,
                request=value, claim=valid_claim,
            )
    valid_read, _ = pair(original)
    for value in [None, "string", [], {"request_id": original.grant_request_id}]:
        with pytest.raises(GrantClaimContractError):
            inspect_exact_grant_consume(
                binding=original, grant_integration_id=INTEGRATION_ID,
                request=valid_read, claim=value,
            )
