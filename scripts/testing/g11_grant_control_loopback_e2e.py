"""Explicitly authorized G11 isolated backend E2E, never an ordinary suite.

Prerequisites: separately checked out immutable Grant repository, temporary
PostgreSQL container named/labeled as G11 isolated, private sandbox directory,
no inherited control/tenant credentials. All HTTP endpoints bind 127.0.0.1.
Executes one real native Control webhook POST to a private receiving server.
This DOES NOT change/guard Control's existing replay HTTP router, and does not
replace Grant two-mailbox browser E2E or full M3 production acceptance.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import httpx
import uvicorn
from cryptography.fernet import Fernet
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

EXPECTED_GRANT_SHA = "c3ad02571609f57b6ce7bbf05e4da2ccfe4ba5a4"


def must(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def available_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def git_sha(directory: Path) -> str:
    return subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=directory, text=True,
    ).strip()


def verify_isolated(root: Path) -> None:
    must(os.getenv("G11_APPROVED_DISPOSABLE_E2E") == "yes", "OWNER_E2E_FLAG_MISSING")
    must(root.is_dir() and root.name.startswith("g11-grant-control-e2e-"),
         "PRIVATE_TEST_DIRECTORY_REQUIRED")
    must((root / "pg_secret").stat().st_mode & 0o077 == 0, "DB_SECRET_PERMISSIONS")
    name = (root / "container_name").read_text().strip()
    result = subprocess.check_output([
        "docker", "inspect", "--format",
        "{{index .Config.Labels \"datarelay.e2e\"}}", name,
    ], text=True).strip()
    must(result == "grant-control-isolated", "WRONG_POSTGRES_CONTAINER")
    port = int((root / "pg_port").read_text().strip())
    must(32768 <= port < 65536, "DYNAMIC_TEST_PORT_REQUIRED")
    must(port not in (55432, 55433, 55440, 55441), "SHARED_DB_PORT")
    database_url = urlparse(os.environ["DATABASE_URL"])
    must(database_url.hostname == "127.0.0.1"
         and database_url.port == port
         and database_url.path == "/gdc_pytest",
         "ISOLATED_DATABASE_MISMATCH")
    grant = root / "grant"
    must(git_sha(grant) == EXPECTED_GRANT_SHA, "GRANT_SHA_DRIFT")
    # Source checkout is the test input, not an interactive user worktree.
    must(not subprocess.check_output(["git", "status", "--porcelain"],
                                     cwd=grant).strip(), "GRANT_TEST_SOURCE_DIRTY")


def receiver_service():
    records: list[bytes] = []
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            if self.path != "/g11":
                self.send_error(404)
                return
            length = int(self.headers.get("content-length", "0"))
            if length < 2 or length > 10240:
                self.send_error(413)
                return
            body = self.rfile.read(length)
            with lock:
                records.append(body)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"recorded":true}')

        def do_GET(self):
            if self.path != "/observations":
                self.send_error(404)
                return
            with lock:
                bodies = list(records)
            snapshot = json.dumps({
                "count": len(bodies),
                "body_sha256": [hashlib.sha256(b).hexdigest() for b in bodies],
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(snapshot)))
            self.end_headers()
            self.wfile.write(snapshot)

        def log_message(self, _fmt, *_args):
            pass  # Never log potentially sensitive payloads.

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def main() -> None:
    root = Path(os.environ["G11_E2E_PRIVATE_ROOT"]).resolve()
    verify_isolated(root)
    # The checked-out Grant modules are imported only after validating exact SHA.
    sys.path.insert(0, str(root / "grant"))
    from grant.app import create_app
    from grant.auth import Principal
    from grant.client import GrantClient
    from grant.config import Settings
    from grant.models import Action, Integration, Profile

    from app.destinations.adapters.registry import DestinationAdapterRegistry
    from app.destinations.models import Destination
    from app.runtime.grant_replay_claim import ACTION_KIND, canonical_action_hash
    from app.runtime.grant_replay_ledger import (
        GrantProtectedReplayLedger, ReplayBinding,
        confirm_delivered_after_product_readback, reserve,
    )
    from app.runtime.grant_replay_pilot import (
        IsolatedPilotError, run_isolated_approved_control_replay,
    )
    from app.runtime import replay_service
    from app.delivery.webhook_sender import WebhookSender
    from tests.test_delivery_log_replay import _insert_failed_log, _checkpoint_value
    from tests.test_stream_runner_e2e import _seed_stream_runtime

    engine = create_engine(os.environ["DATABASE_URL"], pool_pre_ping=True)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    db = factory()
    recv_server, receiver_origin = receiver_service()
    recv_http = httpx.Client(base_url=receiver_origin, trust_env=False, timeout=5)
    grant_port = available_port()
    origin = f"http://127.0.0.1:{grant_port}"
    settings = Settings(
        database=root / ("grant_test_" + uuid.uuid4().hex + ".sqlite"),
        encryption_key=Fernet.generate_key().decode(),
        public_url=origin,
        dev_mode=True, worker_enabled=False,
        callback_urls=(receiver_origin + "/callback",),
    )
    grant_app = create_app(settings)
    server = uvicorn.Server(uvicorn.Config(
        grant_app, host="127.0.0.1", port=grant_port,
        log_level="error", access_log=False,
    ))
    worker = threading.Thread(target=server.run, daemon=True)
    session = None
    transport = None
    producer = None

    def observation_count() -> int:
        response = recv_http.get("/observations")
        response.raise_for_status()
        return int(response.json()["count"])

    def create_request(profile_id: str, grant_action: dict, label: str) -> dict:
        body = {
            "external_id": f"g11-disposable-{secrets.token_hex(10)}",
            "profile_id": profile_id,
            "title": "G11 isolated " + label,
            "action": grant_action,
            "source": {"environment": "isolated-test-only"},
            "reason": "Approved local receiver integration test",
        }
        response = producer.post("/api/v1/requests", json=body)
        must(response.status_code == 202, f"GRANT_TEST_REQUEST_CREATE_{response.status_code}")
        return response.json()

    try:
        with engine.connect() as dbconn:
            rev = dbconn.execute(text("SELECT version_num FROM alembic_version")).scalar()
            must(rev == "20261009_0071_grant_replay", "POSTGRES_MIGRATION_MISSING")
        seeded = _seed_stream_runtime(db)
        log_row = _insert_failed_log(
            db, seeded=seeded,
            events=[{"event_id": "g11-event-1", "message": "synthetic isolated evidence"}],
        )
        from app.logs.models import DeliveryLog
        source_log_id = int(log_row.id)
        stream_id = int(seeded["stream_id"])
        route_id = int(seeded["route_ids"][0])
        destination_id = int(seeded["destination_ids"][0])
        target = db.get(Destination, destination_id)
        must(target is not None, "CONTROL_TARGET_NOT_FOUND")
        target.config_json = {
            "url": receiver_origin + "/g11",
            "timeout_seconds": 3, "retry_count": 0,
        }
        db.add(target)
        db.commit()
        checkpoint_before = _checkpoint_value(db, stream_id)
        must(observation_count() == 0, "PREEXISTING_RECEIVER_OBSERVATION")

        secret = secrets.token_urlsafe(26)  # Exists only in disposable process memory.
        grant_admin = grant_app.state.auth.create_user(
            "g11-admin", "g11-admin@example.invalid", secret, "admin",
        )
        approver = grant_app.state.auth.create_user(
            "g11-approver", "g11-approver@example.invalid", secret, "member",
        )
        admin_principal = Principal(grant_admin["id"], "human", "admin")
        integration = grant_app.state.core.create_integration(
            admin_principal,
            Integration(
                name="G11 disposable Control receiver",
                kind="datarelay", callback_url=settings.callback_urls[0],
            ),
        )
        policy = grant_app.state.core.create_profile(
            admin_principal,
            Profile(
                name="G11 isolated Control replay policy",
                integration_id=integration["id"],
                approver_id=approver["id"], action_kind=ACTION_KIND,
            ),
        )
        grant_app.state.core.transition_profile(
            admin_principal, policy["id"], "TESTING",
        )
        policy = grant_app.state.core.transition_profile(
            admin_principal, policy["id"], "ACTIVE",
        )
        producer_token = grant_app.state.auth.issue_token(
            admin_principal, integration["id"], ["request:create"],
        )["token"]
        consumer_token = grant_app.state.auth.issue_token(
            admin_principal, integration["id"],
            ["request:read", "grant:consume", "result:write"],
        )["token"]

        worker.start()
        for _ in range(100):
            if server.started:
                break
            time.sleep(0.05)
        must(server.started, "GRANT_LOOPBACK_SERVER_NOT_STARTED")

        producer = httpx.Client(base_url=origin, headers={
            "Authorization": "Bearer " + producer_token,
        }, trust_env=False, timeout=5)
        session = httpx.Client(base_url=origin, trust_env=False, timeout=5)
        transport = GrantClient(origin, consumer_token, dev_loopback=True)
        login = session.post("/api/v1/auth/login", json={
            "username": "g11-approver", "password": secret,
        })
        must(login.status_code == 200, f"GRANT_LOGIN_{login.status_code}")
        session.headers["X-CSRF-Token"] = login.json()["csrf"]
        # No token or password is printed/retained in receipt.

        action = {
            "kind": ACTION_KIND,
            "target": f"delivery-log/{source_log_id}",
            "parameters": {
                "log_id": source_log_id,
                "route_id": route_id,
                "destination_id": destination_id,
            },
        }
        request = create_request(policy["id"], action, "approved request")
        must(request["state"] == "AWAITING", "EXPECTED_PENDING_APPROVAL")
        binding = ReplayBinding(
            operation_key=f"g11-isolated-{uuid.uuid4()}",
            grant_request_id=request["id"],
            execution_id=f"g11-execution-{uuid.uuid4()}",
            action_hash=canonical_action_hash(action),
            delivery_log_id=source_log_id,
            route_id=route_id,
            destination_id=destination_id,
        )
        assert reserve(factory, binding) == "NEW_RESERVATION"
        registry = DestinationAdapterRegistry(webhook_sender=WebhookSender())
        expected_action = Action.model_validate(action)

        def attempt() -> object:
            return run_isolated_approved_control_replay(
                db=db, factory=factory, binding=binding,
                integration_id=integration["id"],
                grant_client=transport, expected_action=expected_action,
                receiver_url=receiver_origin + "/g11", registry=registry,
            )

        blocked_pending = False
        try:
            attempt()
        except IsolatedPilotError as exc:
            blocked_pending = str(exc) == "G11_APPROVAL_NOT_CURRENT"
        must(blocked_pending and observation_count() == 0, "UNAPPROVED_SEND_OCCURRED")
        wrong_action_blocked = False
        try:
            run_isolated_approved_control_replay(
                db=db, factory=factory, binding=binding,
                integration_id=integration["id"], grant_client=transport,
                expected_action=Action.model_validate({
                    **action, "target": "delivery-log/forged",
                }),
                receiver_url=receiver_origin + "/g11", registry=registry,
            )
        except IsolatedPilotError as exc:
            wrong_action_blocked = str(exc) == "G11_GRANT_ACTION_MISMATCH"
        must(wrong_action_blocked and observation_count() == 0,
             "MISMATCHED_ACTION_WAS_NOT_BLOCKED")
        initial = transport.read(request["id"])
        hold = session.post(f"/api/v1/requests/{request['id']}/decision", json={
            "decision": "HELD", "expected_revision": initial["revision"], "reason": "Need human review",
        })
        must(hold.status_code == 200, f"GRANT_HOLD_{hold.status_code}")
        blocked_hold = False
        try:
            attempt()
        except IsolatedPilotError as exc:
            blocked_hold = str(exc) == "G11_APPROVAL_NOT_CURRENT"
        must(blocked_hold and observation_count() == 0, "HELD_SEND_OCCURRED")

        next_revision = transport.read(request["id"])["revision"]
        approval = session.post(f"/api/v1/requests/{request['id']}/decision", json={
            "decision": "APPROVED", "expected_revision": next_revision,
            "reason": "Local isolated replay approved",
        })
        must(approval.status_code == 200, f"GRANT_APPROVAL_{approval.status_code}")
        must(transport.read(request["id"])["state"] == "APPROVED", "APPROVAL_NOT_PERSISTED")
        wrong_scope_blocked = False
        with GrantClient(origin, producer_token, dev_loopback=True) as insufficient:
            try:
                insufficient.claim(
                    binding.grant_request_id, binding.execution_id, expected_action,
                )
            except Exception:
                wrong_scope_blocked = True
        must(wrong_scope_blocked and observation_count() == 0,
             "INSUFFICIENT_SCOPE_GRANTED_EXECUTION")

        product = attempt()
        must(product.outcome == "delivered", "CONTROL_NATIVE_DELIVERY_FAILED")
        observation = recv_http.get("/observations").json()
        must(observation["count"] == 1, "RECEIVER_EFFECT_NOT_EXACTLY_ONE")
        checkpoint_after = _checkpoint_value(db, stream_id)
        must(checkpoint_before == checkpoint_after, "CONTROL_CHECKPOINT_CHANGED")
        # Independently read back native Control replay stages for the same run.
        stages = [
            row.stage for row in db.query(DeliveryLog).filter(
                DeliveryLog.run_id == product.replay_run_id,
            ).all()
        ]
        must(
            stages.count("replay_delivered") == 1 and "replay_started" in stages,
            "CONTROL_DELIVERY_AUDIT_NOT_PERSISTED",
        )
        with factory() as read_db:
            ledger = read_db.get(GrantProtectedReplayLedger, binding.operation_key)
            must(ledger.state == "UNKNOWN" and ledger.effect_attempts == 1,
                 "PRODUCT_UNKNOWN_FENCE_MISSING")
        must(
            confirm_delivered_after_product_readback(factory, binding),
            "LEDGER_READBACK_CONFIRM_FAILED",
        )
        # Terminal Grant result reported only AFTER independent receiver readback.
        reported = transport.report(
            request["id"], binding.execution_id, expected_action,
            "REPORTED_SUCCEEDED",
            evidence="isolated-loopback-receiver-observed",
        )
        must(reported["execution_state"] == "REPORTED_SUCCEEDED",
             "GRANT_RESULT_NOT_RECORDED")
        must(transport.read(request["id"])["execution_state"] == "REPORTED_SUCCEEDED",
             "GRANT_RESULT_READBACK_MISSING")
        replay_blocked = False
        try:
            attempt()
        except IsolatedPilotError as exc:
            replay_blocked = str(exc) == "G11_PRODUCT_LEDGER_NO_FRESH_RESERVATION"
        must(replay_blocked and observation_count() == 1, "REPLAY_DUPLICATE_SEND")
        duplicate_claim = transport.claim(
            binding.grant_request_id, binding.execution_id, expected_action,
        )
        must(duplicate_claim["replay"] is True, "GRANT_CONSUME_REPLAY_NOT_DETECTED")
        must(observation_count() == 1, "CLAIM_REPLAY_TRIGGERED_SEND")

        # Independent denied human decision on a second disposable source log:
        denied_log = _insert_failed_log(
            db, seeded=seeded,
            events=[{"event_id": "g11-denied-2", "message": "synthetic deny"}],
        )
        deny_id = int(denied_log.id)
        denied_action = {
            **action,
            "target": f"delivery-log/{deny_id}",
            "parameters": {
                **action["parameters"], "log_id": deny_id,
            },
        }
        denied_request = create_request(policy["id"], denied_action, "denied request")
        deny_current = transport.read(denied_request["id"])
        denied = session.post(
            f"/api/v1/requests/{denied_request['id']}/decision",
            json={
                "decision": "DENIED",
                "expected_revision": deny_current["revision"],
                "reason": "Denied in isolated E2E",
            },
        )
        must(denied.status_code == 200, f"GRANT_DENIAL_{denied.status_code}")
        denied_binding = ReplayBinding(
            operation_key=f"g11-isolated-denied-{uuid.uuid4()}",
            grant_request_id=denied_request["id"],
            execution_id=f"g11-denied-execution-{uuid.uuid4()}",
            action_hash=canonical_action_hash(denied_action),
            delivery_log_id=deny_id,
            route_id=route_id,
            destination_id=destination_id,
        )
        assert reserve(factory, denied_binding) == "NEW_RESERVATION"
        denied_blocked = False
        try:
            run_isolated_approved_control_replay(
                db=db, factory=factory, binding=denied_binding,
                integration_id=integration["id"], grant_client=transport,
                expected_action=Action.model_validate(denied_action),
                receiver_url=receiver_origin + "/g11", registry=registry,
            )
        except IsolatedPilotError as exc:
            denied_blocked = str(exc) == "G11_APPROVAL_NOT_CURRENT"
        must(denied_blocked and observation_count() == 1, "DENIED_SEND_OCCURRED")

        with factory() as read_db:
            row = read_db.get(GrantProtectedReplayLedger, binding.operation_key)
            denied_row = read_db.get(GrantProtectedReplayLedger, denied_binding.operation_key)
            must(row.state == "DELIVERED" and row.effect_attempts == 1,
                 "CONTROL_EFFECT_LEDGER_TERMINAL_INVALID")
            must(denied_row.state == "RESERVED" and denied_row.effect_attempts == 0,
                 "DENIED_LEDGER_CONSUMED")

        record = {
            "grant_head": EXPECTED_GRANT_SHA,
            "control_baseline": git_sha(Path(__file__).resolve().parents[2]),
            "grant_api_real_loopback_http": True,
            "grant_scoped_token": True,
            "grant_pending_blocked": blocked_pending,
            "grant_hold_blocked": blocked_hold,
            "grant_deny_blocked": denied_blocked,
            "wrong_action_blocked": wrong_action_blocked,
            "insufficient_scope_blocked": wrong_scope_blocked,
            "grant_current_approval_proven": True,
            "grant_consume_replay_blocked": duplicate_claim["replay"],
            "grant_result_readback": "REPORTED_SUCCEEDED",
            "control_native_replay_outcome": product.outcome,
            "control_replay_stage_readback": True,
            "control_effect_ledger": "DELIVERED_ONCE",
            "control_ledger_attempts": 1,
            "control_checkpoint_unchanged": True,
            "webhook_receiver_observed_count": observation["count"],
            "webhook_body_sha256": observation["body_sha256"][0],
            "live_control_http_endpoint_guarded": False,
            "live_control_runtime_changed": False,
            "independent_two_human_browser_e2e": False,
        }
        out = root / "g11_e2e_redacted_receipt.json"
        out.write_text(json.dumps(record, indent=2, sort_keys=True))
        os.chmod(out, 0o600)
        print("G11_ISOLATED_ACTUAL_API_AND_LOOPBACK_E2E=PASS")
        for key in (
            "grant_head", "control_baseline", "grant_pending_blocked",
            "grant_hold_blocked", "grant_deny_blocked",
            "wrong_action_blocked", "insufficient_scope_blocked",
            "grant_consume_replay_blocked", "grant_result_readback",
            "control_native_replay_outcome", "control_effect_ledger",
            "control_checkpoint_unchanged", "webhook_receiver_observed_count",
            "live_control_http_endpoint_guarded",
        ):
            print(key.upper() + "=" + str(record[key]))
        print("REDACTED_RECEIPT=" + str(out))
    finally:
        if transport is not None:
            transport.close()
        if session is not None:
            session.close()
        if producer is not None:
            producer.close()
        server.should_exit = True
        if worker.is_alive():
            worker.join(timeout=6)
        recv_http.close()
        recv_server.shutdown()
        recv_server.server_close()
        db.close()
        engine.dispose()


if __name__ == "__main__":
    main()
