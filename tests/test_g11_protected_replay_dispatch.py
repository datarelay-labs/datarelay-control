"""Control native replay dispatch must enforce durable Grant protection at send boundary.

Disposable per-test SQLite ledger only; network/real native replay verified in
the separate, owner-authorized isolated PostgreSQL + loopback API E2E.
"""
from dataclasses import dataclass
from dataclasses import replace
import uuid

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.runtime.grant_replay_dispatch import (
    ProtectedReplayDenied, ReplayDispatchPermit,
    arm_protected_dispatch_once, enforce_native_replay_boundary,
)
from app.runtime.grant_replay_ledger import (
    GrantProtectedReplayLedger, ReplayBinding, reserve,
)


@dataclass(frozen=True)
class LogIdentity:
    id: int
    route_id: int
    destination_id: int


@pytest.fixture
def ledger(tmp_path):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'g11-dispatch.db'}", connect_args={"timeout": 10},
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
        operation_key="g11-native-replay-42",
        grant_request_id=str(uuid.uuid4()),
        execution_id="g11-control-execution-42",
        action_hash="a" * 64,
        delivery_log_id=42, route_id=7, destination_id=9,
    )


def test_nonprotected_legacy_source_remains_eligible_without_permit(ledger):
    with ledger() as db:
        assert enforce_native_replay_boundary(
            db, LogIdentity(42, 7, 9), protected_permit=None, dry_run=False,
        ) is False
        assert enforce_native_replay_boundary(
            db, LogIdentity(42, 7, 9), protected_permit=None, dry_run=True,
        ) is False


def test_persistently_protected_log_rejects_all_unchecked_internal_calls(ledger, binding):
    assert reserve(ledger, binding) == "NEW_RESERVATION"
    with ledger() as db:
        for dry_run in (False, True):
            with pytest.raises(ProtectedReplayDenied, match="GRANT_PROTECTED_REPLAY_REQUIRED"):
                enforce_native_replay_boundary(
                    db, LogIdentity(42, 7, 9), protected_permit=None,
                    dry_run=dry_run,
                )


def test_one_native_permit_requires_durable_arm_and_can_only_be_consumed_once(ledger, binding):
    assert reserve(ledger, binding) == "NEW_RESERVATION"
    permit = arm_protected_dispatch_once(ledger, binding)
    assert permit is not None
    with ledger() as db:
        assert enforce_native_replay_boundary(
            db, LogIdentity(42, 7, 9), protected_permit=permit, dry_run=False,
        ) is True
        with pytest.raises(ProtectedReplayDenied):
            enforce_native_replay_boundary(
                db, LogIdentity(42, 7, 9), protected_permit=permit, dry_run=False,
            )
        with pytest.raises(ProtectedReplayDenied):
            enforce_native_replay_boundary(
                db, LogIdentity(42, 7, 9), protected_permit=None, dry_run=False,
            )
    assert arm_protected_dispatch_once(ledger, binding) is None


def test_mismatched_route_or_destination_never_accepts_native_permit(ledger, binding):
    reserve(ledger, binding)
    permit = arm_protected_dispatch_once(ledger, binding)
    assert permit is not None
    with ledger() as db:
        for row in (LogIdentity(42, 8, 9), LogIdentity(42, 7, 10)):
            with pytest.raises(ProtectedReplayDenied):
                enforce_native_replay_boundary(
                    db, row, protected_permit=permit, dry_run=False,
                )


def test_external_fabrication_of_nonce_cannot_impersonate_a_native_permit(ledger, binding):
    reserve(ledger, binding)
    genuine = arm_protected_dispatch_once(ledger, binding)
    assert genuine is not None
    forged = ReplayDispatchPermit(nonce="forged-token")
    with ledger() as db:
        with pytest.raises(ProtectedReplayDenied):
            enforce_native_replay_boundary(
                db, LogIdentity(42, 7, 9), protected_permit=forged, dry_run=False,
            )
        assert enforce_native_replay_boundary(
            db, LogIdentity(42, 7, 9), protected_permit=genuine, dry_run=False,
        ) is True


def test_a_permit_from_other_log_cannot_unlock_this_protected_log(ledger, binding):
    reserve(ledger, binding)
    other = replace(
        binding, operation_key="other-native",
        execution_id="other-execution",
        grant_request_id=str(uuid.uuid4()),
        delivery_log_id=43,
    )
    reserve(ledger, other)
    permit = arm_protected_dispatch_once(ledger, other)
    with ledger() as db:
        with pytest.raises(ProtectedReplayDenied):
            enforce_native_replay_boundary(
                db, LogIdentity(42, 7, 9), protected_permit=permit, dry_run=False,
            )


def test_protected_dry_run_cannot_consume_an_armed_permit(ledger, binding):
    reserve(ledger, binding)
    permit = arm_protected_dispatch_once(ledger, binding)
    with ledger() as db:
        with pytest.raises(ProtectedReplayDenied):
            enforce_native_replay_boundary(
                db, LogIdentity(42, 7, 9), protected_permit=permit, dry_run=True,
            )


def test_orphan_permit_never_unlocks_nonprotected_log(ledger, binding):
    reserve(ledger, binding)
    permit = arm_protected_dispatch_once(ledger, binding)
    with ledger() as db:
        with pytest.raises(ProtectedReplayDenied):
            enforce_native_replay_boundary(
                db, LogIdentity(999, 7, 9), protected_permit=permit, dry_run=False,
            )
