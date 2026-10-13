"""Non-bypassable native replay boundary for explicitly Grant-protected logs.

A persistent Control ledger reservation is the opt-in protection marker. Every
native replay service invocation checks it before any replay stages/audit/send,
including dry runs and direct internal callers. Protected sends require an
in-process, short-lived, one-use permit minted only after the product ledger
atomically commits UNKNOWN/one effect attempt.

The permit is NOT Grant authorization. Its caller must verify an authenticated
fresh exact-action Grant consume and current Control operator/target authority.
An exception or crash after arming NEVER authorizes retry.
"""
from __future__ import annotations

import secrets
import threading
import time
from dataclasses import dataclass, field

from sqlalchemy.orm import Session, sessionmaker

from app.runtime.grant_replay_ledger import (
    UNKNOWN,
    GrantProtectedReplayLedger,
    ReplayBinding,
    arm_after_external_grant_verification,
)


class ProtectedReplayDenied(Exception):
    """Sanitized caller-visible protected replay failure (no secret details)."""

    code = "GRANT_PROTECTED_REPLAY_REQUIRED"

    def __init__(self) -> None:
        super().__init__(self.code)


@dataclass(frozen=True, slots=True)
class ReplayDispatchPermit:
    nonce: str = field(repr=False)


_PERMITS_LOCK = threading.Lock()
_PENDING: dict[str, tuple[ReplayBinding, float]] = {}
_PERMIT_SECONDS = 30


def arm_protected_dispatch_once(
    factory: sessionmaker, binding: ReplayBinding,
) -> ReplayDispatchPermit | None:
    """Create an in-process permit ONLY for a committed first product arm.

    Use only after authenticated Grant request/read/claim, exact binding and
    current product authority have passed. This private code-level operation
    does not accept caller-supplied approvals or issue an API token.
    """
    disposition = arm_after_external_grant_verification(factory, binding)
    if disposition != "ONE_EFFECT_ATTEMPT_ARMED":
        return None
    nonce = secrets.token_urlsafe(32)
    now = time.monotonic()
    with _PERMITS_LOCK:
        for key, (_, until) in list(_PENDING.items()):
            if until <= now:
                _PENDING.pop(key, None)
        _PENDING[nonce] = (binding, now + _PERMIT_SECONDS)
    return ReplayDispatchPermit(nonce=nonce)


def enforce_native_replay_boundary(
    db: Session, source_log: object,
    *, protected_permit: ReplayDispatchPermit | None,
    dry_run: bool,
) -> bool:
    """Return True iff the product log is protected and the permit is consumed.

    This must be called by replay_service immediately after retrieving the
    source log and before eligibility checks, stage logs, or any destination
    adapter send. A missing migration/table must raise and thus fail closed.
    """
    source_id = getattr(source_log, "id", None)
    if type(source_id) is not int or source_id <= 0:
        raise ProtectedReplayDenied()
    bound = db.query(GrantProtectedReplayLedger).filter(
        GrantProtectedReplayLedger.delivery_log_id == source_id,
    ).one_or_none()
    if bound is None:
        if protected_permit is not None:
            raise ProtectedReplayDenied()
        return False
    if (
        dry_run
        or not isinstance(protected_permit, ReplayDispatchPermit)
        or type(getattr(source_log, "route_id", None)) is not int
        or type(getattr(source_log, "destination_id", None)) is not int
        or source_log.route_id != bound.route_id
        or source_log.destination_id != bound.destination_id
        or bound.state != UNKNOWN
        or bound.effect_attempts != 1
    ):
        raise ProtectedReplayDenied()
    # One permit is never valid for two calls, even in the same server process.
    # A forged object or token not minted by the current product arm is rejected.
    with _PERMITS_LOCK:
        entry = _PENDING.pop(protected_permit.nonce, None)
    if entry is None:
        raise ProtectedReplayDenied()
    binding, until = entry
    if time.monotonic() >= until or (
        binding.delivery_log_id != bound.delivery_log_id
        or binding.route_id != bound.route_id
        or binding.destination_id != bound.destination_id
        or binding.operation_key != bound.operation_key
        or binding.grant_request_id != bound.grant_request_id
        or binding.execution_id != bound.execution_id
        or binding.action_hash != bound.action_hash
    ):
        raise ProtectedReplayDenied()
    return True
