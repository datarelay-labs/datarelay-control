"""Product-owned durable effect ledger for a future opt-in Grant-protected replay.

STAGED / UNMOUNTED: this module does NOT verify Grant authorization, register a
route, call replay_delivery_log, or send any data. The eventual Control executor
MUST obtain and verify a fresh exact-action Grant consume result (with its own
authenticated server-to-server identity) before asking this ledger to arm a
send. A fabricated caller-provided approval flag is never an authority.

An UNKNOWN effect is deliberately non-retryable. After a commit that arms one
send, a crash can happen before/during/after the destination effect; only an
independent product/destination readback may close that ambiguity.
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from sqlalchemy import (
    CheckConstraint, DateTime, Integer, String, UniqueConstraint, func, update,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, mapped_column, sessionmaker

from app.database import Base

RESERVED = "RESERVED"
UNKNOWN = "UNKNOWN"
DELIVERED = "DELIVERED"
LedgerState = Literal["RESERVED", "UNKNOWN", "DELIVERED"]
ReservationResult = Literal["NEW_RESERVATION", "RECONCILE_NO_SEND"]
ArmResult = Literal["ONE_EFFECT_ATTEMPT_ARMED", "RECONCILE_NO_SEND"]


class ReplayLedgerBindingError(ValueError):
    """A sanitized response; never include credentials or payload details."""


@dataclass(frozen=True, slots=True)
class ReplayBinding:
    operation_key: str
    grant_request_id: str
    execution_id: str
    action_hash: str
    delivery_log_id: int
    route_id: int
    destination_id: int


class GrantProtectedReplayLedger(Base):
    __tablename__ = "grant_protected_replay_ledger"
    __table_args__ = (
        UniqueConstraint("execution_id", name="uq_grant_replay_execution"),
        UniqueConstraint("delivery_log_id", name="uq_grant_replay_protected_log"),
        CheckConstraint("delivery_log_id > 0", name="ck_grant_replay_log_positive"),
        CheckConstraint("route_id > 0", name="ck_grant_replay_route_positive"),
        CheckConstraint("destination_id > 0", name="ck_grant_replay_destination_positive"),
        CheckConstraint("effect_attempts IN (0,1)", name="ck_grant_replay_attempt_bound"),
        CheckConstraint(
            "state IN ('RESERVED','UNKNOWN','DELIVERED')",
            name="ck_grant_replay_state",
        ),
    )

    operation_key: Mapped[str] = mapped_column(String(128), primary_key=True)
    grant_request_id: Mapped[str] = mapped_column(String(36), nullable=False)
    execution_id: Mapped[str] = mapped_column(String(128), nullable=False)
    action_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    delivery_log_id: Mapped[int] = mapped_column(Integer, nullable=False)
    route_id: Mapped[int] = mapped_column(Integer, nullable=False)
    destination_id: Mapped[int] = mapped_column(Integer, nullable=False)
    state: Mapped[str] = mapped_column(String(16), nullable=False, default=RESERVED)
    effect_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


def _validate(binding: ReplayBinding) -> None:
    if not isinstance(binding, ReplayBinding):
        raise ReplayLedgerBindingError("GRANT_REPLAY_BINDING_INVALID")
    try:
        request_uuid = str(uuid.UUID(binding.grant_request_id))
    except (ValueError, TypeError, AttributeError):
        raise ReplayLedgerBindingError("GRANT_REPLAY_BINDING_INVALID") from None
    if (
        request_uuid != binding.grant_request_id
        or not isinstance(binding.operation_key, str)
        or not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", binding.operation_key)
        or not isinstance(binding.execution_id, str)
        or not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", binding.execution_id)
        or not isinstance(binding.action_hash, str)
        or not re.fullmatch(r"[0-9a-f]{64}", binding.action_hash)
        or any(
            type(value) is not int or value <= 0
            for value in (
                binding.delivery_log_id, binding.route_id, binding.destination_id,
            )
        )
    ):
        raise ReplayLedgerBindingError("GRANT_REPLAY_BINDING_INVALID")


def _matches(row: GrantProtectedReplayLedger, binding: ReplayBinding) -> bool:
    return all((
        row.operation_key == binding.operation_key,
        row.grant_request_id == binding.grant_request_id,
        row.execution_id == binding.execution_id,
        row.action_hash == binding.action_hash,
        row.delivery_log_id == binding.delivery_log_id,
        row.route_id == binding.route_id,
        row.destination_id == binding.destination_id,
    ))


def reserve(
    factory: sessionmaker,
    binding: ReplayBinding,
) -> ReservationResult:
    """Persist exactly one immutable operation mapping, never arm a send.

    Retry after a lost response does not grant an additional send permit.
    This method owns its own transaction and must not share an operator session.
    """
    _validate(binding)
    try:
        with factory.begin() as db:
            db.add(GrantProtectedReplayLedger(
                operation_key=binding.operation_key,
                grant_request_id=binding.grant_request_id,
                execution_id=binding.execution_id,
                action_hash=binding.action_hash,
                delivery_log_id=binding.delivery_log_id,
                route_id=binding.route_id,
                destination_id=binding.destination_id,
                state=RESERVED,
                effect_attempts=0,
            ))
            db.flush()
        return "NEW_RESERVATION"
    except IntegrityError:
        with factory() as db:
            row = db.get(GrantProtectedReplayLedger, binding.operation_key)
            if row is None or not _matches(row, binding):
                raise ReplayLedgerBindingError("GRANT_REPLAY_BINDING_CONFLICT") from None
            return "RECONCILE_NO_SEND"


def arm_after_external_grant_verification(
    factory: sessionmaker,
    binding: ReplayBinding,
) -> ArmResult:
    """Permanently mark one UNKNOWN attempt *before* any potential send.

    Requires externally verified Grant claim and current product authority;
    the ledger by itself does not confer them. Atomic conditional UPDATE and
    commit must succeed before this function returns a positive disposition.
    A second call, a crash or lost response never yields a second attempt.
    """
    _validate(binding)
    with factory.begin() as db:
        count = db.execute(
            update(GrantProtectedReplayLedger)
            .where(
                GrantProtectedReplayLedger.operation_key == binding.operation_key,
                GrantProtectedReplayLedger.grant_request_id == binding.grant_request_id,
                GrantProtectedReplayLedger.execution_id == binding.execution_id,
                GrantProtectedReplayLedger.action_hash == binding.action_hash,
                GrantProtectedReplayLedger.delivery_log_id == binding.delivery_log_id,
                GrantProtectedReplayLedger.route_id == binding.route_id,
                GrantProtectedReplayLedger.destination_id == binding.destination_id,
                GrantProtectedReplayLedger.state == RESERVED,
                GrantProtectedReplayLedger.effect_attempts == 0,
            )
            .values(state=UNKNOWN, effect_attempts=1, updated_at=func.now())
        ).rowcount
    if count == 1:
        # The UNKNOWN transition has already been durably committed here.
        return "ONE_EFFECT_ATTEMPT_ARMED"
    with factory() as db:
        row = db.get(GrantProtectedReplayLedger, binding.operation_key)
        if row is None or not _matches(row, binding):
            raise ReplayLedgerBindingError("GRANT_REPLAY_BINDING_INVALID")
        return "RECONCILE_NO_SEND"


def confirm_delivered_after_product_readback(
    factory: sessionmaker,
    binding: ReplayBinding,
) -> bool:
    """Record confirmed delivery only; failed/uncertain outcomes stay UNKNOWN."""
    _validate(binding)
    with factory.begin() as db:
        changed = db.execute(
            update(GrantProtectedReplayLedger)
            .where(
                GrantProtectedReplayLedger.operation_key == binding.operation_key,
                GrantProtectedReplayLedger.grant_request_id == binding.grant_request_id,
                GrantProtectedReplayLedger.execution_id == binding.execution_id,
                GrantProtectedReplayLedger.action_hash == binding.action_hash,
                GrantProtectedReplayLedger.delivery_log_id == binding.delivery_log_id,
                GrantProtectedReplayLedger.route_id == binding.route_id,
                GrantProtectedReplayLedger.destination_id == binding.destination_id,
                GrantProtectedReplayLedger.state == UNKNOWN,
                GrantProtectedReplayLedger.effect_attempts == 1,
            )
            .values(state=DELIVERED, updated_at=func.now())
        ).rowcount
    return changed == 1
