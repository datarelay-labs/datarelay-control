#!/usr/bin/env python3
"""Fixture helpers for Real Browser Operator E2E (disposable fixtures only)."""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT.parent))  # repo root = e2e/../
REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO))
os.chdir(REPO)


def cmd_seed_http(args: argparse.Namespace) -> int:
    import urllib.request

    wm = os.environ.get("WIREMOCK_BASE_URL", "http://127.0.0.1:28080").rstrip("/")
    run_id = args.run_id
    token = args.token or f"FAKE_TOKEN_{run_id}"

    def stub(
        path: str,
        body,
        status=200,
        bearer=None,
        *,
        method="GET",
        request_extra: dict | None = None,
        response_headers: dict | None = None,
    ):
        req = {"method": method, "urlPath": path}
        if bearer:
            req["headers"] = {"Authorization": {"equalTo": f"Bearer {bearer}"}}
        if request_extra:
            for key, value in request_extra.items():
                if key == "headers" and "headers" in req:
                    req["headers"] = {**req["headers"], **value}
                else:
                    req[key] = value
        payload = {
            "request": req,
            "response": {
                "status": status,
                "headers": {"Content-Type": "application/json", **(response_headers or {})},
                "jsonBody": body,
            },
        }
        data = json.dumps(payload).encode()
        r = urllib.request.Request(f"{wm}/__admin/mappings", data=data, method="POST", headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(r, timeout=15) as resp:
            resp.read()

    # root 403 (auth-check must use stream endpoint)
    stub("/", {"error": "forbidden"}, status=403)
    def items(stream: str, n: int = 12, extra: dict | None = None):
        rows = []
        for i in range(1, n + 1):
            row = {
                "id": i,
                "run_id": run_id,
                "stream": stream,
                "seq": i,
                "sequence": i,
                "message": f"marker-{run_id}-{stream.lower()}-{i}",
                "timestamp": f"2026-10-02T10:{i:02d}:00Z",
                "email": "test@example.invalid",
                "api_key": f"FAKE_API_KEY_{run_id}",
            }
            if extra:
                row.update(extra)
            rows.append(row)
        return rows

    # Exhaustive browser-auth fixtures. Values are disposable, deterministic, and scoped to this run.
    auth_prefix = f"/ulc/{run_id}/auth"
    basic_user = f"ulc-basic-{run_id}"
    basic_password = f"FAKE_BASIC_{run_id}"
    bearer_token = f"FAKE_BEARER_{run_id}"
    api_header_value = f"FAKE_HEADER_{run_id}"
    api_query_value = f"FAKE_QUERY_{run_id}"
    oauth_client = f"ulc-oauth-{run_id}"
    oauth_secret = f"FAKE_OAUTH_SECRET_{run_id}"
    oauth_access = f"FAKE_OAUTH_ACCESS_{run_id}"
    session_user = f"ulc-session-{run_id}"
    session_password = f"FAKE_SESSION_{run_id}"
    session_cookie = f"ULCSESS={run_id}"
    refresh_token = f"FAKE_REFRESH_{run_id}"
    refresh_access = f"FAKE_REFRESH_ACCESS_{run_id}"
    vendor_user = f"ulc-vendor-{run_id}"
    vendor_key = f"FAKE_VENDOR_KEY_{run_id}"
    vendor_access = f"FAKE_VENDOR_ACCESS_{run_id}"

    stub(f"{auth_prefix}/no-auth", {"data": items("AUTH_NO_AUTH", 1)})
    stub(
        f"{auth_prefix}/basic",
        {"data": items("AUTH_BASIC", 1)},
        request_extra={"basicAuthCredentials": {"username": basic_user, "password": basic_password}},
    )
    stub(f"{auth_prefix}/bearer", {"data": items("AUTH_BEARER", 1)}, bearer=bearer_token)
    stub(
        f"{auth_prefix}/api-key-header",
        {"data": items("AUTH_API_HEADER", 1)},
        request_extra={"headers": {"X-ULC-Key": {"equalTo": api_header_value}}},
    )
    stub(
        f"{auth_prefix}/api-key-query",
        {"data": items("AUTH_API_QUERY", 1)},
        request_extra={"queryParameters": {"api_token": {"equalTo": api_query_value}}},
    )

    stub(
        f"{auth_prefix}/oauth-token",
        {"access_token": oauth_access, "token_type": "Bearer"},
        method="POST",
        request_extra={"basicAuthCredentials": {"username": oauth_client, "password": oauth_secret}},
    )
    stub(f"{auth_prefix}/oauth-events", {"data": items("AUTH_OAUTH", 1)}, bearer=oauth_access)
    stub(
        f"{auth_prefix}/session-login",
        {"authenticated": True},
        method="POST",
        request_extra={
            "bodyPatterns": [
                {
                    "equalToJson": json.dumps({"username": session_user, "password": session_password}),
                    "ignoreArrayOrder": True,
                    "ignoreExtraElements": True,
                }
            ]
        },
        response_headers={"Set-Cookie": f"{session_cookie}; Path=/; HttpOnly"},
    )
    stub(
        f"{auth_prefix}/session-events",
        {"data": items("AUTH_SESSION", 1)},
        request_extra={"headers": {"Cookie": {"contains": session_cookie}}},
    )
    stub(
        f"{auth_prefix}/refresh-token",
        {"access_token": refresh_access},
        method="POST",
        bearer=refresh_token,
    )
    stub(f"{auth_prefix}/refresh-events", {"data": items("AUTH_REFRESH", 1)}, bearer=refresh_access)
    stub(
        f"{auth_prefix}/vendor-token",
        {"access_token": vendor_access, "token_type": "Bearer"},
        method="POST",
        request_extra={"basicAuthCredentials": {"username": vendor_user, "password": vendor_key}},
    )
    stub(f"{auth_prefix}/vendor-events", {"data": items("AUTH_VENDOR", 1)}, bearer=vendor_access)

    h1_items = items("H1")
    h1_items[0]["rare_field"] = f"rare-{run_id}"
    stub(
        f"/ulc/{run_id}/h1",
        {"items": h1_items},
        bearer=token,
    )
    stub(
        f"/ulc/{run_id}/h2",
        {"data": {"records": items("H2")}},
        bearer=token,
    )
    stub(
        f"/ulc/{run_id}/h3",
        {"items": items("H3", extra={"checkpoint": "cp-1"})},
        bearer=token,
    )
    stub(
        f"/ulc/{run_id}/h4",
        {"items": items("H4")},
        bearer=token,
    )
    stub(
        f"/ulc/{run_id}/h5",
        {"items": items("H5")},
        bearer=token,
    )
    print(
        json.dumps(
            {
                "ok": True,
                "paths": [
                    f"/ulc/{run_id}/h1",
                    f"/ulc/{run_id}/h2",
                    f"/ulc/{run_id}/h3",
                    f"/ulc/{run_id}/h4",
                    f"/ulc/{run_id}/h5",
                ],
                "auth_prefix": auth_prefix,
                "auth_variants": [
                    "no_auth",
                    "basic",
                    "bearer",
                    "api_key_header",
                    "api_key_query",
                    "oauth2_client_credentials",
                    "session_login",
                    "jwt_refresh_token",
                    "vendor_jwt_exchange",
                ],
            }
        )
    )
    return 0


def cmd_seed_s3(args: argparse.Namespace) -> int:
    from tests.e2e_runtime_helpers import put_minio_object

    run_id = args.run_id
    for folder, name in [("a", "a1.ndjson"), ("b", "b1.ndjson")]:
        key = f"{run_id}/{folder}/{name}"
        body = (json.dumps({"run_id": run_id, "folder": folder, "seq": 1}) + "\n").encode()
        put_minio_object(key, body)
        print(json.dumps({"put": key}))
    return 0


def cmd_seed_sftp(args: argparse.Namespace) -> int:
    import subprocess

    from tests.e2e_runtime_helpers import upload_sftp_file

    run_id = args.run_id
    container = os.environ.get("SOURCE_E2E_SFTP_CONTAINER", "gdc-sftp-test")
    for folder in ("a", "b"):
        subprocess.check_call(
            ["docker", "exec", container, "mkdir", "-p", f"/home/gdc/upload/{run_id}/{folder}"],
            timeout=20,
        )
        remote = f"{run_id}/{folder}/file1.ndjson"
        body = (json.dumps({"run_id": run_id, "folder": folder, "seq": 1, "message": f"marker-{run_id}-sftp-{folder}"}) + "\n").encode()
        upload_sftp_file(remote, body)
        print(json.dumps({"put": f"/home/gdc/upload/{remote}"}))
    return 0


def cmd_seed_sftp_event(args: argparse.Namespace) -> int:
    import subprocess

    from tests.e2e_runtime_helpers import upload_sftp_file

    run_id = args.run_id
    folder = args.folder
    marker = args.marker
    filename = args.filename or f"delivery-{marker}.ndjson"
    container = os.environ.get("SOURCE_E2E_SFTP_CONTAINER", "gdc-sftp-test")
    subprocess.check_call(
        ["docker", "exec", container, "mkdir", "-p", f"/home/gdc/upload/{run_id}/{folder}"],
        timeout=20,
    )
    remote = f"{run_id}/{folder}/{filename}"
    body = (json.dumps({"id": int(time.time()), "run_id": run_id, "folder": folder, "message": marker}) + "\n").encode()
    upload_sftp_file(remote, body)
    print(json.dumps({"put": f"/home/gdc/upload/{remote}", "marker": marker}))
    return 0


def cmd_seed_db(args: argparse.Namespace) -> int:
    import subprocess

    run_id = args.run_id
    sql = f"""
CREATE TABLE IF NOT EXISTS source_e2e_orders (
  id SERIAL PRIMARY KEY,
  event_id TEXT NOT NULL,
  message TEXT NOT NULL,
  email TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_e2e_users (
  id SERIAL PRIMARY KEY,
  event_id TEXT NOT NULL,
  message TEXT NOT NULL,
  email TEXT NOT NULL
);
INSERT INTO source_e2e_orders (event_id, message, email) VALUES
 ('{run_id}-ord-1', 'marker-{run_id}-db-orders', 'test@example.invalid');
INSERT INTO source_e2e_users (event_id, message, email) VALUES
 ('{run_id}-usr-1', 'marker-{run_id}-db-users', 'test@example.invalid');
"""
    container = os.environ.get("SOURCE_E2E_PG_FIXTURE_CONTAINER", "gdc-postgres-query-test")
    try:
        subprocess.check_call(
            ["docker", "exec", "-i", container, "psql", "-U", "gdc_fixture", "-d", "gdc_query_fixture", "-v", "ON_ERROR_STOP=1", "-c", sql],
            timeout=20,
        )
        print(json.dumps({"ok": True, "tables": ["source_e2e_orders", "source_e2e_users"]}))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1


def cmd_seed_db_event(args: argparse.Namespace) -> int:
    import subprocess

    table = args.table
    if table not in {"source_e2e_orders", "source_e2e_users"}:
        print(json.dumps({"ok": False, "error": "invalid table"}))
        return 1
    sql = (
        f"INSERT INTO {table} (event_id, message, email) VALUES "
        f"('{args.event_id}', '{args.marker}', 'test@example.invalid');"
    )
    container = os.environ.get("SOURCE_E2E_PG_FIXTURE_CONTAINER", "gdc-postgres-query-test")
    try:
        subprocess.check_call(
            [
                "docker",
                "exec",
                "-i",
                container,
                "psql",
                "-U",
                "gdc_fixture",
                "-d",
                "gdc_query_fixture",
                "-v",
                "ON_ERROR_STOP=1",
                "-c",
                sql,
            ],
            timeout=20,
        )
        print(json.dumps({"ok": True, "table": table, "marker": args.marker}))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1


def cmd_echo_has(args: argparse.Namespace) -> int:
    import subprocess
    import re

    logs = subprocess.check_output(
        ["docker", "logs", "--tail", "8000", "gdc-webhook-receiver-test"],
        stderr=subprocess.STDOUT,
        text=True,
        timeout=20,
    )
    found = args.marker in logs and args.path in logs
    # tighter: same block
    if found:
        key = f'"path": "{args.path}"'
        ok = False
        for m in re.finditer(re.escape(key), logs):
            end = logs.find('\n{\n    "path": ', m.end())
            block = logs[m.start() : end if end >= 0 else len(logs)]
            if args.marker in block:
                ok = True
                break
        found = ok
    print(json.dumps({"found": found}))
    return 0 if found else 1


def cmd_mark_password_change(args: argparse.Namespace) -> int:
    from app.database import SessionLocal
    from app.platform_admin.models import PlatformUser

    db = SessionLocal()
    try:
        row = db.query(PlatformUser).filter(PlatformUser.username == args.username).one_or_none()
        if row is None:
            raise RuntimeError("fixture user not found")
        row.must_change_password = True
        row.token_version = int(row.token_version or 1) + 1
        db.commit()
        print(json.dumps({"ok": True, "username": row.username, "must_change_password": True}))
        return 0
    finally:
        db.close()



def cmd_seed_governance_ops(args: argparse.Namespace) -> int:
    """Seed deterministic Governance operation rows in the disposable platform DB."""
    from datetime import datetime, timedelta, timezone

    from app.database import SessionLocal
    from app.db.orm_bootstrap import ensure_orm_models_registered

    # Standalone fixture processes do not load the FastAPI routers that normally
    # register relationship-linked models before mapper configuration.
    ensure_orm_models_registered()
    from app.governance_policies.models import (
        POLICY_STATUS_ACTIVE,
        POLICY_STATUS_DRAFT,
        GovernancePolicy,
        StreamPolicyAssignment,
    )
    from app.governance_approval.models import (
        APPROVAL_EVENT_REJECTED,
        APPROVAL_EVENT_SUBMITTED,
        GovernancePolicyApprovalEvent,
    )
    from app.quarantine.models import (
        QUARANTINE_SOURCE_POLICY,
        QUARANTINE_STATUS_QUARANTINED,
        StreamQuarantineEvent,
    )
    from app.replay.models import REPLAY_STATUS_PENDING, StreamReplayEvent

    db = SessionLocal()
    try:
        now = datetime.now(timezone.utc)
        policy_name = f"E2E Governance Ops {args.run_id}"
        policy = GovernancePolicy(
            name=policy_name,
            description="Disposable browser governance operations fixture",
            category="DATA_PROTECTION",
            status=POLICY_STATUS_ACTIVE,
            policy_json={
                "conditions": [{"field": "classification", "operator": "equals", "value": "RESTRICTED"}],
                "actions": [{"type": "quarantine"}],
            },
            version=1,
            activated_at=now,
            created_at=now,
            updated_at=now,
        )
        db.add(policy)
        db.flush()
        db.add(StreamPolicyAssignment(stream_id=args.stream_id, policy_id=policy.id, enabled=True))

        def draft_policy(label: str, created_at: datetime) -> GovernancePolicy:
            row = GovernancePolicy(
                name=f"E2E Governance {label} {args.run_id}",
                description=f"Disposable browser approval {label.lower()} fixture",
                category="DATA_PROTECTION",
                status=POLICY_STATUS_DRAFT,
                policy_json={
                    "conditions": [{"field": "classification", "operator": "equals", "value": "RESTRICTED"}],
                    "actions": [{"type": "audit_only"}],
                },
                version=1,
                created_at=created_at,
                updated_at=created_at,
            )
            db.add(row)
            db.flush()
            # A prior submit/reject cycle keeps the policy in DRAFT while making it
            # visible in the Approval queue, so the browser still exercises Submit.
            db.add_all([
                GovernancePolicyApprovalEvent(
                    policy_id=row.id,
                    event_type=APPROVAL_EVENT_SUBMITTED,
                    actor="E2E Fixture",
                    comment="Prior disposable review cycle",
                    created_at=created_at,
                ),
                GovernancePolicyApprovalEvent(
                    policy_id=row.id,
                    event_type=APPROVAL_EVENT_REJECTED,
                    actor="E2E Fixture",
                    comment="Prior disposable review cycle",
                    created_at=created_at + timedelta(seconds=1),
                ),
            ])
            return row

        activate_policy = draft_policy("Activate", now - timedelta(minutes=8))
        reject_policy = draft_policy("Reject", now - timedelta(minutes=7))

        def quarantine(label: str, created_at: datetime) -> StreamQuarantineEvent:
            row = StreamQuarantineEvent(
                stream_id=args.stream_id,
                quarantine_reason=f"policy:{policy_name}:{label}",
                quarantine_source=QUARANTINE_SOURCE_POLICY,
                status=QUARANTINE_STATUS_QUARANTINED,
                protected_payload_json={
                    "events": [{
                        "id": f"{args.run_id}-{label}",
                        "classification_level": "RESTRICTED",
                        "message": f"marker-{args.run_id}-{label}",
                    }]
                },
                metadata_json={
                    "event_count": 1,
                    "policy_names": [policy_name],
                    "fixture_label": label,
                },
                created_at=created_at,
                updated_at=created_at,
            )
            db.add(row)
            db.flush()
            return row

        release_row = quarantine("release", now - timedelta(minutes=4))
        replay_source = quarantine("replay", now - timedelta(minutes=3))
        quarantine_replay = StreamReplayEvent(
            stream_id=args.stream_id,
            destination_id=args.destination_id,
            route_id=args.route_id,
            delivery_kind="base_route",
            status=REPLAY_STATUS_PENDING,
            protected_payload_json={
                "events": [{
                    "id": f"{args.run_id}-quarantine-replay",
                    "classification_level": "RESTRICTED",
                    "message": f"marker-{args.run_id}-quarantine-replay",
                }]
            },
            delivery_context_json={"fixture": "browser-governance-quarantine-replay"},
            event_count=1,
            created_at=now - timedelta(minutes=2),
            updated_at=now - timedelta(minutes=2),
        )
        standalone_replay = StreamReplayEvent(
            stream_id=args.stream_id,
            destination_id=args.destination_id,
            route_id=args.route_id,
            delivery_kind="base_route",
            status=REPLAY_STATUS_PENDING,
            protected_payload_json={
                "events": [{
                    "id": f"{args.run_id}-standalone-replay",
                    "classification_level": "RESTRICTED",
                    "message": f"marker-{args.run_id}-governance-standalone-replay",
                }]
            },
            delivery_context_json={"fixture": "browser-governance-standalone-replay"},
            event_count=1,
            created_at=now - timedelta(minutes=1),
            updated_at=now - timedelta(minutes=1),
        )
        db.add_all([quarantine_replay, standalone_replay])
        db.commit()
        print(json.dumps({
            "ok": True,
            "policy_id": int(policy.id),
            "policy_name": policy_name,
            "activate_policy_id": int(activate_policy.id),
            "reject_policy_id": int(reject_policy.id),
            "release_quarantine_id": int(release_row.id),
            "replay_quarantine_id": int(replay_source.id),
            "quarantine_replay_id": int(quarantine_replay.id),
            "standalone_replay_id": int(standalone_replay.id),
        }))
        return 0
    finally:
        db.close()


def cmd_cleanup_governance_ops(args: argparse.Namespace) -> int:
    from app.database import SessionLocal
    from app.db.orm_bootstrap import ensure_orm_models_registered

    ensure_orm_models_registered()
    from app.governance_policies.models import GovernancePolicy

    db = SessionLocal()
    try:
        marker = str(args.run_id).strip()
        rows = (
            db.query(GovernancePolicy)
            .filter(GovernancePolicy.name.contains(marker))
            .all()
        )
        deleted_ids = [int(row.id) for row in rows]
        for row in rows:
            db.delete(row)
        db.commit()
        remaining = (
            db.query(GovernancePolicy)
            .filter(GovernancePolicy.name.contains(marker))
            .count()
        )
        print(json.dumps({
            "ok": remaining == 0,
            "deleted_policy_ids": deleted_ids,
            "remaining_policies": int(remaining),
        }))
        return 0 if remaining == 0 else 1
    finally:
        db.close()


def main() -> int:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("seed-http")
    s.add_argument("--run-id", required=True)
    s.add_argument("--token", default="")
    s.set_defaults(func=cmd_seed_http)
    s = sub.add_parser("seed-s3")
    s.add_argument("--run-id", required=True)
    s.set_defaults(func=cmd_seed_s3)
    s = sub.add_parser("seed-sftp")
    s.add_argument("--run-id", required=True)
    s.set_defaults(func=cmd_seed_sftp)
    s = sub.add_parser("seed-sftp-event")
    s.add_argument("--run-id", required=True)
    s.add_argument("--folder", default="a")
    s.add_argument("--marker", required=True)
    s.add_argument("--filename", default="")
    s.set_defaults(func=cmd_seed_sftp_event)
    s = sub.add_parser("seed-db")
    s.add_argument("--run-id", required=True)
    s.set_defaults(func=cmd_seed_db)
    s = sub.add_parser("seed-db-event")
    s.add_argument("--table", default="source_e2e_orders")
    s.add_argument("--event-id", required=True)
    s.add_argument("--marker", required=True)
    s.set_defaults(func=cmd_seed_db_event)
    s = sub.add_parser("echo-has")
    s.add_argument("--marker", required=True)
    s.add_argument("--path", required=True)
    s.set_defaults(func=cmd_echo_has)
    s = sub.add_parser("mark-password-change")
    s.add_argument("--username", required=True)
    s.set_defaults(func=cmd_mark_password_change)
    s = sub.add_parser("seed-governance-ops")
    s.add_argument("--run-id", required=True)
    s.add_argument("--stream-id", required=True, type=int)
    s.add_argument("--destination-id", required=True, type=int)
    s.add_argument("--route-id", required=True, type=int)
    s.set_defaults(func=cmd_seed_governance_ops)
    s = sub.add_parser("cleanup-governance-ops")
    s.add_argument("--run-id", required=True)
    s.set_defaults(func=cmd_cleanup_governance_ops)
    args = p.parse_args()
    return int(args.func(args) or 0)


if __name__ == "__main__":
    raise SystemExit(main())
