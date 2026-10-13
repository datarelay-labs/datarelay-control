"""Offline exact-binding validation for a future authenticated Grant consumer.

This module does not contact Grant, accept credentials, or authorize Control
destination sends. Dict payloads from an unauthenticated caller are NOT proof
of approval; the eventual product-owned executor must obtain them through an
authenticated, current-authority Grant API channel, then independently enforce
Control's policy and the durable effect ledger before any send.
"""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from dataclasses import dataclass
from typing import Any, Mapping

from app.runtime.grant_replay_ledger import ReplayBinding, ReplayLedgerBindingError

ACTION_KIND = "datarelay.control.delivery_log.replay"
_FORBIDDEN_KEYS = frozenset({
    "password", "secret", "token", "access_token", "api_key",
    "authorization", "private_key",
})


class GrantClaimContractError(ValueError):
    """Sanitized contract mismatch, not a transport or authorization result."""


@dataclass(frozen=True, slots=True)
class ClaimContractMatch:
    """Proof only that supplied dictionaries match expected product bindings.

    This does NOT provide permission to dispatch a destination send.
    """
    grant_request_id: str
    execution_id: str
    operation_key: str
    action_hash: str
    claim_is_fresh: bool
    independently_authenticated: bool = False
    permits_effect: bool = False


def _bad() -> None:
    raise GrantClaimContractError("GRANT_CONTROL_CLAIM_CONTRACT_INVALID")


def _safe_object(value: Any, depth: int = 0) -> None:
    """Mirror Grant bounded_json restrictions on expected product action."""
    if depth > 8:
        _bad()
    if value is None or type(value) is bool:
        return
    if type(value) is str and len(value) <= 4000:
        return
    if type(value) is int and -(2**53) < value < 2**53:
        return
    if type(value) is list and len(value) <= 100:
        for child in value:
            _safe_object(child, depth + 1)
        return
    if type(value) is dict and len(value) <= 100:
        for key, child in value.items():
            if type(key) is not str or len(key) > 100 or (
                key.lower().replace("-", "_") in _FORBIDDEN_KEYS
            ):
                _bad()
            _safe_object(child, depth + 1)
        return
    _bad()


def canonical_action_hash(action: dict) -> str:
    """Exact Grant fingerprint: UTF-8 SHA-256 of stable sorted JSON."""
    if type(action) is not dict or set(action) != {"kind", "target", "parameters"}:
        _bad()
    kind, target, params = action["kind"], action["target"], action["parameters"]
    if (
        type(kind) is not str or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,100}", kind)
        or type(target) is not str or not 1 <= len(target) <= 500
        or type(params) is not dict
    ):
        _bad()
    _safe_object(action)
    try:
        serialized = json.dumps(
            action, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
            allow_nan=False,
        )
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()
    except (TypeError, ValueError, UnicodeError):
        _bad()


def _uuid(value: Any) -> str:
    if type(value) is not str:
        _bad()
    try:
        normalized = str(uuid.UUID(value))
    except (ValueError, AttributeError):
        _bad()
    if value != normalized:
        _bad()
    return normalized


def _expected_action(binding: ReplayBinding) -> dict:
    if not isinstance(binding, ReplayBinding):
        _bad()
    if any(
        type(n) is not int or n <= 0
        for n in (binding.delivery_log_id, binding.route_id, binding.destination_id)
    ):
        _bad()
    return {
        "kind": ACTION_KIND,
        "target": f"delivery-log/{binding.delivery_log_id}",
        "parameters": {
            "log_id": binding.delivery_log_id,
            "route_id": binding.route_id,
            "destination_id": binding.destination_id,
        },
    }


def inspect_exact_grant_consume(
    *,
    binding: ReplayBinding,
    grant_integration_id: str,
    request: Mapping[str, Any],
    claim: Mapping[str, Any],
) -> ClaimContractMatch:
    """Compare separately fetched Grant read/consume against product-derived IDs.

    Authenticated GET and POST are future caller obligations. The return type
    deliberately has permits_effect=False even for matching dictionaries.
    A Grant replay claim is always reconciliation-only, never a second send.
    """
    try:
        action = _expected_action(binding)
        digest = canonical_action_hash(action)
        if (
            type(grant_integration_id) is not str
            or not grant_integration_id
            or len(grant_integration_id) > 100
            or type(binding.operation_key) is not str
            or not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", binding.operation_key)
            or type(binding.execution_id) is not str
            or not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", binding.execution_id)
            or _uuid(binding.grant_request_id) != binding.grant_request_id
            or binding.action_hash != digest
            or not isinstance(request, Mapping)
            or request.get("id") != binding.grant_request_id
            or request.get("state") != "APPROVED"
            or request.get("integration_id") != grant_integration_id
            or request.get("action_hash") != digest
            # Python mapping equality treats True == 1; Grant's canonical
            # JSON fingerprint does not. Rehash untrusted response values.
            or canonical_action_hash(request.get("action")) != digest
            or not isinstance(claim, Mapping)
            or claim.get("request_id") != binding.grant_request_id
            or claim.get("execution_id") != binding.execution_id
            or claim.get("action_hash") != digest
            or claim.get("committed") is not True
            or claim.get("replay") is not False
        ):
            _bad()
    except (ReplayLedgerBindingError, KeyError, TypeError, ValueError, AttributeError):
        _bad()
    return ClaimContractMatch(
        grant_request_id=binding.grant_request_id,
        execution_id=binding.execution_id,
        operation_key=binding.operation_key,
        action_hash=digest,
        claim_is_fresh=True,
    )
