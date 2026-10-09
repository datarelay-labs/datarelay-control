"""Isolated G11 backend integration PILOT, not a Control API product feature.

Cannot run on the production/shared DB: requires an explicit disposable Test
PostgreSQL connection plus an independently listening loopback webhook. It
leaves the old Control API replay route unchanged and therefore CANNOT be used
to claim a production-enforced or non-bypassable Grant approval feature.

Calls the current native Control replay_service only after:
(1) current product-derived log/route/destination check,
(2) exact authenticated Grant read/consume through the injected test client,
(3) durable Control effect arm. A positive *pure* JSON contract alone does
not authorize a send. No client credentials are held or logged here.
"""
from __future__ import annotations

import os
from typing import Any
from urllib.parse import urlparse

from sqlalchemy.orm import Session, sessionmaker

from app.destinations.adapters.registry import DestinationAdapterRegistry
from app.destinations.models import Destination
from app.logs.models import DeliveryLog
from app.routes.models import Route
from app.runtime import replay_service
from app.runtime.grant_replay_claim import (
    _expected_action, canonical_action_hash, inspect_exact_grant_consume,
)
from app.runtime.grant_replay_ledger import (
    RESERVED, GrantProtectedReplayLedger, ReplayBinding,
    arm_after_external_grant_verification,
)


class IsolatedPilotError(RuntimeError):
    """Sanitized failure; do not return secrets, payload or HTTP bodies."""


def _only_ephemeral(factory: sessionmaker, db: Session, receiver_url: str) -> None:
    if os.environ.get("G11_APPROVED_DISPOSABLE_E2E") != "yes":
        raise IsolatedPilotError("G11_E2E_NOT_EXPLICITLY_ENABLED")
    bound = db.get_bind()
    url = bound.url
    expected = os.environ.get("G11_DISPOSABLE_PG_PORT")
    if (
        url.get_backend_name() != "postgresql"
        or url.host not in ("127.0.0.1", "localhost")
        or url.database != "gdc_pytest"
        or not expected or not expected.isdigit()
        or url.port != int(expected)
        or url.port in (55432, 55433, 55440, 55441)
        or factory.kw.get("bind") is not bound
    ):
        raise IsolatedPilotError("G11_TEST_POSTGRES_NOT_ISOLATED")
    receiver = urlparse(receiver_url)
    if (
        receiver.scheme != "http"
        or receiver.hostname != "127.0.0.1"
        or receiver.port is None
        or receiver.path != "/g11"
        or receiver.query or receiver.fragment
        or receiver.username or receiver.password
    ):
        raise IsolatedPilotError("G11_TEST_RECEIVER_NOT_LOOPBACK")


def _product_authority(db: Session, binding: ReplayBinding, receiver_url: str) -> None:
    log = db.get(DeliveryLog, binding.delivery_log_id)
    if (
        log is None
        or int(log.route_id or 0) != binding.route_id
        or int(log.destination_id or 0) != binding.destination_id
        or log.stage != "route_send_failed"
        or log.status != "FAILED"
    ):
        raise IsolatedPilotError("G11_CONTROL_LOG_NOT_ELIGIBLE")
    route = db.get(Route, binding.route_id)
    destination = db.get(Destination, binding.destination_id)
    if (
        route is None or destination is None
        or not route.enabled
        or int(route.destination_id) != binding.destination_id
        or not destination.enabled
        or destination.destination_type != "WEBHOOK_POST"
        or not isinstance(destination.config_json, dict)
        or destination.config_json.get("url") != receiver_url
        or destination.config_json.get("retry_count") != 0
    ):
        raise IsolatedPilotError("G11_CONTROL_DESTINATION_MISMATCH")


def _reservation(factory: sessionmaker, binding: ReplayBinding) -> None:
    with factory() as scoped:
        row = scoped.get(GrantProtectedReplayLedger, binding.operation_key)
        if (
            row is None
            or row.grant_request_id != binding.grant_request_id
            or row.execution_id != binding.execution_id
            or row.action_hash != binding.action_hash
            or row.delivery_log_id != binding.delivery_log_id
            or row.route_id != binding.route_id
            or row.destination_id != binding.destination_id
            or row.state != RESERVED
            or row.effect_attempts != 0
        ):
            raise IsolatedPilotError("G11_PRODUCT_LEDGER_NO_FRESH_RESERVATION")


def run_isolated_approved_control_replay(
    *,
    db: Session,
    factory: sessionmaker,
    binding: ReplayBinding,
    integration_id: str,
    grant_client: Any,
    expected_action: Any,
    receiver_url: str,
    registry: DestinationAdapterRegistry,
) -> Any:
    """Execute one existing Control replay with a real Grant test claim.

    Test-only API/service path. Never retry after an ambiguous transport/claim,
    and never take an untrusted / external request flag as verification.
    """
    _only_ephemeral(factory, db, receiver_url)
    _product_authority(db, binding, receiver_url)
    _reservation(factory, binding)
    action = _expected_action(binding)
    if (
        not hasattr(expected_action, "model_dump")
        or expected_action.model_dump() != action
        or canonical_action_hash(action) != binding.action_hash
    ):
        raise IsolatedPilotError("G11_GRANT_ACTION_MISMATCH")
    try:
        current = grant_client.read(binding.grant_request_id)
    except Exception:
        raise IsolatedPilotError("G11_GRANT_READ_UNAVAILABLE") from None
    if (
        current.get("state") != "APPROVED"
        or current.get("id") != binding.grant_request_id
        or current.get("integration_id") != integration_id
        or current.get("action_hash") != binding.action_hash
        or canonical_action_hash(current.get("action")) != binding.action_hash
    ):
        raise IsolatedPilotError("G11_APPROVAL_NOT_CURRENT")
    try:
        claim = grant_client.claim(
            binding.grant_request_id, binding.execution_id, expected_action,
        )
    except Exception:
        # Grant consume may already be committed after an ambiguous timeout.
        raise IsolatedPilotError("G11_GRANT_CLAIM_UNKNOWN_NO_RETRY") from None
    try:
        match = inspect_exact_grant_consume(
            binding=binding, grant_integration_id=integration_id,
            request=current, claim=claim,
        )
    except Exception:
        raise IsolatedPilotError("G11_GRANT_CLAIM_NOT_FRESH") from None
    if not match.claim_is_fresh:
        raise IsolatedPilotError("G11_GRANT_CLAIM_NOT_FRESH")
    if arm_after_external_grant_verification(factory, binding) != "ONE_EFFECT_ATTEMPT_ARMED":
        raise IsolatedPilotError("G11_PRODUCT_EFFECT_ALREADY_ARMED")
    # Native Control sends a real HTTP POST to the validated loopback receiver.
    # The arm is committed *before* invoking the outbound destination.
    try:
        result = replay_service.replay_delivery_log(
            db, binding.delivery_log_id,
            dry_run=False, destination_registry=registry,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise IsolatedPilotError("G11_CONTROL_EFFECT_AMBIGUOUS_NO_RETRY") from None
    if result.outcome != "delivered":
        raise IsolatedPilotError("G11_CONTROL_DELIVERY_NOT_CONFIRMED")
    if (
        result.log_id != binding.delivery_log_id
        or result.route_id != binding.route_id
        or result.destination_id != binding.destination_id
    ):
        raise IsolatedPilotError("G11_CONTROL_EFFECT_RESULT_MISMATCH")
    # Caller must obtain independent receiver observation before marking
    # delivered and reporting success to Grant. UNKNOWN until then.
    return result
