"""REMOTE_FILE_POLLING connectivity probe (no passwords, keys, passphrases, or file bodies in output)."""

from __future__ import annotations

import socket
import time
from typing import Any

import paramiko

from app.sources.remote_file_ssh import iter_remote_file_candidates, normalize_known_hosts_policy, open_ssh_client

logger = __import__("logging").getLogger(__name__)


def _get(data: Any, key: str, default: Any = None) -> Any:
    if isinstance(data, dict):
        return data.get(key, default)
    return getattr(data, key, default)


_PRIVATE_KEY_UNREADABLE = (
    "The Private key could not be read. Paste the whole key including the BEGIN/END lines and, "
    "if the key is encrypted, enter its passphrase."
)


def describe_ssh_connect_failure(exc: BaseException, *, host: str, port: int) -> dict[str, Any]:
    """Turn a paramiko/socket failure into an operator-facing message that names the input to fix.

    Returns ``error_type``, ``message``, ``ssh_reachable`` and ``ssh_auth_ok`` (``None`` when
    authentication was never attempted). Only the exception class and fixed text are used, never
    raw exception strings, so no credential or key material can leak.
    """

    if isinstance(exc, paramiko.BadHostKeyException):
        return {
            "error_type": "host_key_mismatch",
            "message": (
                "The server's host key does not match the Known hosts entry. Replace the entry with the "
                "server's current key if the change is expected; otherwise do not connect."
            ),
            "ssh_reachable": True,
            "ssh_auth_ok": None,
        }
    if isinstance(exc, paramiko.AuthenticationException):
        return {
            "error_type": "authentication_failed",
            "message": "The server rejected the credentials. Check the Username and the Password or Private key.",
            "ssh_reachable": True,
            "ssh_auth_ok": False,
        }
    if isinstance(exc, paramiko.SSHException) and "known_hosts" in str(exc).lower():
        return {
            "error_type": "host_key_unknown",
            "message": (
                "The server's host key is not in Known hosts and the policy is strict. Paste the server's "
                "host key into Known hosts, or choose a less strict policy for a trusted network."
            ),
            "ssh_reachable": True,
            "ssh_auth_ok": None,
        }
    if isinstance(exc, socket.gaierror):
        return {
            "error_type": "host_unresolved",
            "message": f"The host name {host!r} could not be resolved. Check the Host.",
            "ssh_reachable": False,
            "ssh_auth_ok": None,
        }
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return {
            "error_type": "connect_timeout",
            "message": f"Timed out connecting to {host}:{port}. Check the Host, Port and firewall.",
            "ssh_reachable": False,
            "ssh_auth_ok": None,
        }
    if isinstance(exc, OSError):
        return {
            "error_type": "connect_failed",
            "message": f"Could not connect to {host}:{port}. Check the Host and Port, and that the SSH service is running.",
            "ssh_reachable": False,
            "ssh_auth_ok": None,
        }
    return {
        "error_type": "ssh_protocol_error",
        "message": (
            f"SSH negotiation with {host}:{port} failed ({type(exc).__name__}). "
            "The server may not offer a compatible key exchange, cipher or key type."
        ),
        "ssh_reachable": True,
        "ssh_auth_ok": None,
    }


def probe_remote_file_source(
    source_config: dict[str, Any],
    stream_config: dict[str, Any],
    *,
    sample_path_limit: int = 12,
) -> dict[str, Any]:
    """Return structured probe fields for connector-auth test."""

    started = time.perf_counter()
    policy_raw = str(_get(source_config, "known_hosts_policy") or "strict")
    policy_norm = normalize_known_hosts_policy(policy_raw)
    remote_dir = str(_get(stream_config, "remote_directory") or "").strip()
    pattern = str(_get(stream_config, "file_pattern") or "*").strip() or "*"
    recursive = bool(_get(stream_config, "recursive", False))

    out: dict[str, Any] = {
        "ok": False,
        "ssh_reachable": False,
        "ssh_auth_ok": False,
        "sftp_available": False,
        "remote_directory_accessible": False,
        "matched_file_count": 0,
        "sample_remote_paths": [],
        "host_key_policy": policy_norm,
        "host_key_status": policy_norm,
        "latency_ms": 0,
        "message": "",
        "error_type": None,
    }

    if not remote_dir:
        out["message"] = "stream_config.remote_directory is required for REMOTE_FILE_POLLING probe"
        out["error_type"] = "remote_file_probe_invalid_config"
        return out

    try:
        client = open_ssh_client(source_config)
    except ValueError as exc:
        text = str(exc)
        out["message"] = _PRIVATE_KEY_UNREADABLE if text == "private_key could not be parsed" else text
        out["error_type"] = "remote_file_probe_invalid_config"
        out["ssh_auth_ok"] = None
        out["sftp_available"] = None
        out["latency_ms"] = int((time.perf_counter() - started) * 1000)
        return out
    except Exception as exc:
        host = str(_get(source_config, "host") or "").strip()
        try:
            port = int(_get(source_config, "port", 22) or 22)
        except (TypeError, ValueError):
            port = 22
        info = describe_ssh_connect_failure(exc, host=host, port=port)
        out["message"] = info["message"]
        out["error_type"] = info["error_type"]
        out["ssh_reachable"] = info["ssh_reachable"]
        out["ssh_auth_ok"] = info["ssh_auth_ok"]
        out["sftp_available"] = None
        out["latency_ms"] = int((time.perf_counter() - started) * 1000)
        logger.info("%s", {"stage": "remote_file_probe_connect_failed", "error_type": type(exc).__name__})
        return out

    out["ssh_reachable"] = True
    out["ssh_auth_ok"] = True

    sftp: paramiko.SFTPClient | None = None
    try:
        try:
            sftp = client.open_sftp()
            out["sftp_available"] = True
        except Exception as exc:
            out["message"] = f"SFTP subsystem unavailable: {type(exc).__name__}"
            out["error_type"] = "sftp_unavailable"
            out["latency_ms"] = int((time.perf_counter() - started) * 1000)
            return out

        try:
            sftp.listdir_attr(remote_dir)
        except OSError as exc:
            out["message"] = f"remote_directory not accessible: {type(exc).__name__}"
            out["error_type"] = "remote_directory_denied"
            out["latency_ms"] = int((time.perf_counter() - started) * 1000)
            return out

        out["remote_directory_accessible"] = True
        candidates = iter_remote_file_candidates(sftp, base=remote_dir, pattern=pattern, recursive=recursive)
        paths = [p for p, _m, _s in candidates]
        out["matched_file_count"] = len(paths)
        out["sample_remote_paths"] = paths[:sample_path_limit]
        out["ok"] = True
        out["message"] = "REMOTE_FILE_POLLING probe succeeded"
    finally:
        try:
            if sftp is not None:
                sftp.close()
        except Exception:
            pass
        try:
            client.close()
        except Exception:
            pass

    out["latency_ms"] = int((time.perf_counter() - started) * 1000)
    return out
