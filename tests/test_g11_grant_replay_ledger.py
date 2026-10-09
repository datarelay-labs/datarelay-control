"""G11 source-only product ledger; disposable SQLite, zero external sends.

These tests do not exercise the Control HTTP route or prove Grant authorization.
They validate the *additional product-owned exactly-once reservation* prerequisite.
"""
from __future__ import annotations

import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.runtime.grant_replay_ledger import (
    DELIVERED, RESERVED, UNKNOWN,
    GrantProtectedReplayLedger, ReplayBinding, ReplayLedgerBindingError,
    arm_after_external_grant_verification, confirm_delivered_after_product_readback,
    reserve,
)


@pytest.fixture
def store(tmp_path):
    # Own unique, disposable local catalog, never gdc_pytest or operator DB.
    engine = create_engine(
        f"sqlite:///{tmp_path / 'grant-g11-disposable.db'}",
        connect_args={"timeout": 15},
    )
    GrantProtectedReplayLedger.__table__.create(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    try:
        yield factory
    finally:
        engine.dispose()


@pytest.fixture
def binding():
    return ReplayBinding(
        operation_key="control-replay-42",
        grant_request_id=str(uuid.uuid4()),
        execution_id="grant-control-execution-42",
        action_hash="a" * 64,
        delivery_log_id=42,
        route_id=7,
        destination_id=9,
    )


def record(factory, key):
    with factory() as db:
        item = db.get(GrantProtectedReplayLedger, key)
        assert item
        return item.state, item.effect_attempts


def test_new_reservation_is_not_permission_to_send(store, binding):
    assert reserve(store, binding) == "NEW_RESERVATION"
    assert record(store, binding.operation_key) == (RESERVED, 0)
    # A lost reserve response cannot silently create a second send claim.
    assert reserve(store, binding) == "RECONCILE_NO_SEND"
    assert record(store, binding.operation_key) == (RESERVED, 0)


def test_atomic_pre_send_unknown_transition_is_durable_and_never_retryable(store, binding):
    assert reserve(store, binding) == "NEW_RESERVATION"
    assert arm_after_external_grant_verification(store, binding) == "ONE_EFFECT_ATTEMPT_ARMED"
    # The transaction has committed before an executor could send.
    assert record(store, binding.operation_key) == (UNKNOWN, 1)
    # Neither an HTTP replay nor recovery from a crashed sender re-arms a send.
    for _ in range(3):
        assert arm_after_external_grant_verification(store, binding) == "RECONCILE_NO_SEND"
    assert record(store, binding.operation_key) == (UNKNOWN, 1)


def test_confirmed_independent_delivery_is_terminal_not_retry_authority(store, binding):
    reserve(store, binding)
    assert confirm_delivered_after_product_readback(store, binding) is False
    arm_after_external_grant_verification(store, binding)
    assert confirm_delivered_after_product_readback(store, binding) is True
    assert record(store, binding.operation_key) == (DELIVERED, 1)
    assert confirm_delivered_after_product_readback(store, binding) is False
    assert arm_after_external_grant_verification(store, binding) == "RECONCILE_NO_SEND"


@pytest.mark.parametrize("wrong", [
    {"operation_key": "control-replay-43"},
    {"execution_id": "different-execution"},
    {"grant_request_id": str(uuid.uuid4())},
    {"action_hash": "b" * 64},
    {"delivery_log_id": 43},
    {"route_id": 8},
    {"destination_id": 10},
])
def test_wrong_binding_never_arms_or_closes_an_existing_operation(store, binding, wrong):
    reserve(store, binding)
    altered = replace(binding, **wrong)
    with pytest.raises(ReplayLedgerBindingError):
        arm_after_external_grant_verification(store, altered)
    assert confirm_delivered_after_product_readback(store, altered) is False
    assert record(store, binding.operation_key) == (RESERVED, 0)


def test_same_operation_different_request_or_effect_is_binding_conflict(store, binding):
    reserve(store, binding)
    for change in (
        {"grant_request_id": str(uuid.uuid4())},
        {"action_hash": "b" * 64},
        {"route_id": 8},
        {"destination_id": 10},
    ):
        with pytest.raises(ReplayLedgerBindingError, match="BINDING_CONFLICT"):
            reserve(store, replace(binding, **change))
    assert record(store, binding.operation_key) == (RESERVED, 0)


def test_execution_id_cannot_be_recycled_as_a_second_operation(store, binding):
    reserve(store, binding)
    another = replace(binding, operation_key="other-operation-key")
    with pytest.raises(ReplayLedgerBindingError, match="BINDING_CONFLICT"):
        reserve(store, another)


@pytest.mark.parametrize("change", [
    {"grant_request_id": "malformed"},
    {"grant_request_id": "ABC"},
    {"operation_key": "has\nnewline"},
    {"operation_key": ""},
    {"execution_id": "x" * 129},
    {"action_hash": "A" * 64},
    {"action_hash": "short"},
    {"delivery_log_id": True},
    {"route_id": 0},
    {"destination_id": False},
])
def test_malformed_grant_or_product_binding_rejected_before_database_effect(store, binding, change):
    bad = replace(binding, **change)
    with pytest.raises(ReplayLedgerBindingError, match="BINDING_INVALID"):
        reserve(store, bad)
    with pytest.raises(ReplayLedgerBindingError, match="BINDING_INVALID"):
        arm_after_external_grant_verification(store, bad)
    with store() as db:
        assert db.query(GrantProtectedReplayLedger).count() == 0


def test_missing_reservation_never_arms(store, binding):
    with pytest.raises(ReplayLedgerBindingError, match="BINDING_INVALID"):
        arm_after_external_grant_verification(store, binding)


def test_competing_product_attempts_share_one_durable_state_transition(store, binding):
    reserve(store, binding)

    def attempt(_):
        return arm_after_external_grant_verification(store, binding)

    with ThreadPoolExecutor(max_workers=8) as pool:
        outcomes = list(pool.map(attempt, range(8)))

    assert outcomes.count("ONE_EFFECT_ATTEMPT_ARMED") == 1
    assert outcomes.count("RECONCILE_NO_SEND") == 7
    assert record(store, binding.operation_key) == (UNKNOWN, 1)
