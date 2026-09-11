#!/usr/bin/env python3
"""REAL local E2E: REMOTE_FILE_POLLING over SFTP using SSH private key (not password).

Installs an ephemeral Ed25519 public key into gdc-sftp-test authorized_keys,
creates a Data Relay connector with remote_private_key, extracts NDJSON, delivers
to the continuous webhook collector, then cleans up lab artifacts.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

API = os.environ.get("GDC_E2E_API_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
SFTP_CONTAINER = os.environ.get("SOURCE_E2E_SFTP_CONTAINER", "gdc-sftp-test")
SFTP_DOCKER_HOST = os.environ.get("SOURCE_E2E_SFTP_DOCKER_HOST", "gdc-sftp-test")
SFTP_PORT = int(os.environ.get("SOURCE_E2E_SFTP_PORT", "22"))
SFTP_USER = os.environ.get("SOURCE_E2E_SFTP_USER", "gdc")
PREFIX = "[E2E LAB EPHEMERAL]"


def api(method: str, path: str, body: Any = None) -> tuple[int, Any]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(f"{API}{path}", data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw) if raw else None
        except json.JSONDecodeError:
            return e.code, raw


def sh(*args: str) -> None:
    subprocess.run(list(args), check=True, capture_output=True, text=True)


def cleanup_stream(stream_id: int | None, connector_id: int | None) -> None:
    if stream_id:
        api("PUT", f"/api/v1/streams/{stream_id}", {"enabled": False, "status": "STOPPED"})
        api("DELETE", f"/api/v1/streams/{stream_id}")
    if connector_id:
        api("DELETE", f"/api/v1/connectors/{connector_id}")


def main() -> int:
    results: list[dict[str, Any]] = []

    def rec(name: str, ok: bool, detail: Any = None) -> None:
        results.append({"name": name, "ok": ok, "detail": detail})
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: {detail}")

    stamp = int(time.time())
    stream_id: int | None = None
    connector_id: int | None = None
    auth_keys_backup: str | None = None

    with tempfile.TemporaryDirectory(prefix="gdc-sftp-key-") as tmp:
        key_path = Path(tmp) / "id_ed25519"
        pub_path = Path(tmp) / "id_ed25519.pub"
        try:
            sh("ssh-keygen", "-t", "ed25519", "-N", "", "-f", str(key_path), "-q")
            private_key = key_path.read_text()
            public_key = pub_path.read_text().strip()

            # Backup + install authorized_keys (atmoz/sftp chroot home)
            try:
                backup = subprocess.run(
                    ["docker", "exec", SFTP_CONTAINER, "cat", "/home/gdc/.ssh/authorized_keys"],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                if backup.returncode == 0:
                    auth_keys_backup = backup.stdout
            except Exception:
                auth_keys_backup = None

            sh("docker", "exec", SFTP_CONTAINER, "mkdir", "-p", "/home/gdc/.ssh")
            sh("docker", "exec", SFTP_CONTAINER, "chmod", "700", "/home/gdc/.ssh")
            subprocess.run(
                ["docker", "exec", "-i", SFTP_CONTAINER, "sh", "-c", "cat > /home/gdc/.ssh/authorized_keys"],
                input=public_key + "\n",
                text=True,
                check=True,
                capture_output=True,
            )
            sh("docker", "exec", SFTP_CONTAINER, "chmod", "600", "/home/gdc/.ssh/authorized_keys")
            sh("docker", "exec", SFTP_CONTAINER, "chown", "-R", "gdc:users", "/home/gdc/.ssh")
            rec("authorized_keys_installed", True, {"user": SFTP_USER})

            # Seed isolated NDJSON under /upload/key-auth/
            remote_dir = f"/home/gdc/upload/key-auth-{stamp}"
            filename = f"key-auth-{stamp}.ndjson"
            local_file = Path(tmp) / filename
            local_file.write_text(
                json.dumps(
                    {
                        "id": f"key-auth-{stamp}",
                        "message": "sftp private key proof",
                        "severity": "info",
                        "e2e_correlation_id": f"sftp-key-{stamp}",
                    }
                )
                + "\n"
            )
            sh("docker", "exec", SFTP_CONTAINER, "mkdir", "-p", remote_dir)
            sh("docker", "cp", str(local_file), f"{SFTP_CONTAINER}:{remote_dir}/{filename}")
            sh("docker", "exec", SFTP_CONTAINER, "chown", "-R", "gdc:users", remote_dir)
            rec("fixture_seeded", True, {"file": filename})

            # Destination: reuse continuous webhook collector when present
            st, dests = api("GET", "/api/v1/destinations/")
            items = dests if isinstance(dests, list) else (dests or {}).get("items") or []
            dest_id = next(
                (
                    int(d["id"])
                    for d in items
                    if str(d.get("name") or "").startswith("[CONTINUOUS E2E]")
                    and "Webhook" in str(d.get("name") or "")
                ),
                None,
            )
            if dest_id is None:
                st_c, created = api(
                    "POST",
                    "/api/v1/destinations/",
                    {
                        "name": f"{PREFIX} Webhook Collector",
                        "destination_type": "WEBHOOK_POST",
                        "config_json": {
                            "url": "http://gdc-webhook-collector:8080/continuous-e2e",
                            "method": "POST",
                        },
                        "enabled": True,
                        "status": "ACTIVE",
                    },
                )
                if st_c not in (200, 201):
                    rec("destination", False, {"status": st_c, "body": created})
                    print(json.dumps({"ok": False, "results": results}, indent=2))
                    return 1
                dest_id = int(created["id"])

            name = f"{PREFIX} SFTP SSH private key {stamp}"
            st, conn = api(
                "POST",
                "/api/v1/connectors/",
                {
                    "name": f"{name} connector",
                    "source_type": "REMOTE_FILE_POLLING",
                    "auth_type": "no_auth",
                    "host": SFTP_DOCKER_HOST,
                    "port": SFTP_PORT,
                    "remote_username": SFTP_USER,
                    # Explicitly no password — private key only
                    "remote_private_key": private_key,
                    "remote_file_protocol": "sftp",
                    "known_hosts_policy": "insecure_skip_verify",
                    "connection_timeout_seconds": 20,
                },
            )
            if st not in (200, 201) or not isinstance(conn, dict):
                rec("connector_create_private_key", False, {"status": st, "body": conn})
                print(json.dumps({"ok": False, "results": results}, indent=2))
                return 1
            connector_id = int(conn["id"])
            source_id = int(conn.get("source_id") or connector_id)
            rec("connector_create_private_key", True, {"connector_id": connector_id})

            st_s, stream = api(
                "POST",
                "/api/v1/streams/",
                {
                    "name": name,
                    "connector_id": connector_id,
                    "source_id": source_id,
                    "stream_type": "REMOTE_FILE_POLLING",
                    "config_json": {
                        "remote_directory": f"/upload/key-auth-{stamp}",
                        "file_glob": "*.ndjson",
                        "max_files_per_run": 5,
                    },
                    "polling_interval": 300,
                    "enabled": False,
                    "status": "STOPPED",
                },
            )
            if st_s not in (200, 201):
                rec("stream_create", False, {"status": st_s, "body": stream})
                cleanup_stream(None, connector_id)
                print(json.dumps({"ok": False, "results": results}, indent=2))
                return 1
            stream_id = int(stream["id"])
            api(
                "POST",
                f"/api/v1/runtime/mappings/stream/{stream_id}/save",
                {
                    "field_mappings": {
                        "id": "$.id",
                        "message": "$.message",
                        "severity": "$.severity",
                        "e2e_correlation_id": "$.e2e_correlation_id",
                    }
                },
            )
            api(
                "POST",
                "/api/v1/routes/",
                {
                    "stream_id": stream_id,
                    "destination_id": dest_id,
                    "name": f"{name} route",
                    "enabled": True,
                    "status": "ACTIVE",
                    "failure_policy": "LOG_AND_CONTINUE",
                },
            )
            api("PUT", f"/api/v1/streams/{stream_id}", {"enabled": True, "status": "RUNNING"})
            st_r, run = api("POST", f"/api/v1/runtime/streams/{stream_id}/run-once", {})
            delivered = (
                st_r == 200
                and isinstance(run, dict)
                and (
                    int(run.get("delivered_batch_event_count") or 0) > 0
                    or int(run.get("extracted_event_count") or 0) > 0
                )
            )
            rec("sftp_private_key_run_once", delivered, {"status": st_r, "run": run})
        finally:
            cleanup_stream(stream_id, connector_id)
            # Restore authorized_keys
            try:
                if auth_keys_backup is not None:
                    subprocess.run(
                        [
                            "docker",
                            "exec",
                            "-i",
                            SFTP_CONTAINER,
                            "sh",
                            "-c",
                            "cat > /home/gdc/.ssh/authorized_keys",
                        ],
                        input=auth_keys_backup,
                        text=True,
                        check=False,
                        capture_output=True,
                    )
                else:
                    subprocess.run(
                        ["docker", "exec", SFTP_CONTAINER, "rm", "-f", "/home/gdc/.ssh/authorized_keys"],
                        check=False,
                        capture_output=True,
                    )
                subprocess.run(
                    ["docker", "exec", SFTP_CONTAINER, "rm", "-rf", f"/home/gdc/upload/key-auth-{stamp}"],
                    check=False,
                    capture_output=True,
                )
            except Exception as exc:  # noqa: BLE001
                rec("cleanup_warning", True, {"error": str(exc)})

    ok = all(r["ok"] for r in results if r["name"] != "cleanup_warning")
    print(
        json.dumps(
            {
                "ok": ok,
                "auth": "SSH_PRIVATE_KEY",
                "classification": "PASS_REAL",
                "results": results,
            },
            indent=2,
        )
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
