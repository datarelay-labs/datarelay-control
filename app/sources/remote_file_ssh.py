"""Shared SSH/SFTP connection helpers for REMOTE_FILE_POLLING (no secrets logged)."""

from __future__ import annotations

import fnmatch
import io
import logging
import tempfile
from datetime import datetime, timezone
from typing import Any, Callable

import paramiko

logger = logging.getLogger(__name__)


def _get(data: Any, key: str, default: Any = None) -> Any:
    if isinstance(data, dict):
        return data.get(key, default)
    return getattr(data, key, default)


def normalize_known_hosts_policy(raw: str | None) -> str:
    """Return canonical policy slug used in logs and probe responses."""

    s = str(raw or "strict").strip().upper().replace("-", "_")
    aliases = {
        "STRICT_FILE": "STRICT",
        "STRICT": "STRICT",
        "ACCEPT_NEW_FOR_DEV_ONLY": "ACCEPT_NEW_FOR_DEV_ONLY",
        "ACCEPT_NEW": "ACCEPT_NEW_FOR_DEV_ONLY",
        "INSECURE_DISABLE_VERIFICATION": "INSECURE_SKIP_VERIFY",
        "INSECURE_SKIP_VERIFY": "INSECURE_SKIP_VERIFY",
        "INSECURE": "INSECURE_SKIP_VERIFY",
        "DISABLE": "INSECURE_SKIP_VERIFY",
    }
    return aliases.get(s, "STRICT")


def _load_pkey(pk_raw: str, passphrase: str | None) -> paramiko.PKey | None:
    if not pk_raw.strip():
        return None
    pw = str(passphrase or "").encode() if passphrase else None
    loaders: list[Callable[..., paramiko.PKey]] = [
        lambda: paramiko.RSAKey.from_private_key(io.StringIO(pk_raw), password=pw),
        lambda: paramiko.Ed25519Key.from_private_key(io.StringIO(pk_raw), password=pw),
        lambda: paramiko.ECDSAKey.from_private_key(io.StringIO(pk_raw), password=pw),
    ]
    for loader in loaders:
        try:
            return loader()
        except Exception:
            continue
    return None


def _merge_host_keys_file(text: str | None) -> paramiko.HostKeys | None:
    if not text or not str(text).strip():
        return None
    hk = paramiko.HostKeys()
    try:
        with tempfile.NamedTemporaryFile("w+", suffix="_gdc_known_hosts", delete=True) as tf:
            tf.write(str(text))
            tf.flush()
            hk.load(tf.name)
    except OSError as exc:
        logger.info("%s", {"stage": "remote_file_known_hosts_text_load_failed", "error_type": type(exc).__name__})
        raise ValueError("invalid known_hosts_text") from exc
    return hk


def configure_ssh_client_host_keys(
    client: paramiko.SSHClient,
    *,
    policy_norm: str,
    known_hosts_text: str | None,
) -> str:
    """Apply host-key policy to ``client``. Returns a short status for probes."""

    if policy_norm == "INSECURE_SKIP_VERIFY":
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        return "insecure_skip_verify"

    if policy_norm == "ACCEPT_NEW_FOR_DEV_ONLY":

        class _AcceptNewPolicy(paramiko.MissingHostKeyPolicy):
            def missing_host_key(self, cli: paramiko.SSHClient, hostname: str, key: paramiko.PKey) -> None:  # noqa: ARG002
                h = cli.get_host_keys()
                h.add(hostname, key.get_name(), key)

        client.set_missing_host_key_policy(_AcceptNewPolicy())
        merged = _merge_host_keys_file(known_hosts_text)
        if merged is not None:
            client.get_host_keys().update(merged)
        else:
            try:
                client.load_system_host_keys()
            except OSError:
                pass
        return "accept_new_for_dev_only"

    # STRICT
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    merged = _merge_host_keys_file(known_hosts_text)
    if merged is not None:
        client.get_host_keys().update(merged)
    try:
        client.load_system_host_keys()
    except OSError:
        pass
    return "strict"


def open_ssh_client(source_config: dict[str, Any]) -> paramiko.SSHClient:
    """Connect and return a configured ``SSHClient`` (caller must close)."""

    host = str(_get(source_config, "host") or "").strip()
    port = int(_get(source_config, "port", 22) or 22)
    username = str(_get(source_config, "username") or "").strip()
    password = str(_get(source_config, "password") or "")
    pk_raw = str(_get(source_config, "private_key") or "").strip()
    passphrase = str(_get(source_config, "private_key_passphrase") or "") or None
    timeout = int(_get(source_config, "connection_timeout_seconds", 20) or 20)
    policy_raw = str(_get(source_config, "known_hosts_policy") or "strict")
    policy_norm = normalize_known_hosts_policy(policy_raw)
    known_hosts_text = str(_get(source_config, "known_hosts_text") or "").strip() or None

    if not host or not username:
        raise ValueError("host and username are required")
    if not password and not pk_raw:
        raise ValueError("password or private_key is required")

    pkey = _load_pkey(pk_raw, passphrase) if pk_raw else None
    if pk_raw and pkey is None:
        raise ValueError("private_key could not be parsed")

    client = paramiko.SSHClient()
    configure_ssh_client_host_keys(client, policy_norm=policy_norm, known_hosts_text=known_hosts_text)

    try:
        client.connect(
            hostname=host,
            port=port,
            username=username,
            password=password or None,
            pkey=pkey,
            timeout=max(1, min(timeout, 120)),
            allow_agent=False,
            look_for_keys=False,
        )
    except Exception as exc:
        logger.info("%s", {"stage": "remote_file_ssh_connect_failed", "host": host, "error_type": type(exc).__name__})
        raise

    return client


def _file_tuple(mtime: float, path: str) -> tuple[datetime, str]:
    dt = datetime.fromtimestamp(float(mtime), tz=timezone.utc)
    return dt, path


def iter_remote_file_candidates(
    sftp: paramiko.SFTPClient,
    *,
    base: str,
    pattern: str,
    recursive: bool,
) -> list[tuple[str, float, int]]:
    """Return (full_remote_path, mtime_epoch, size) sorted by (mtime, path)."""

    out: list[tuple[str, float, int]] = []
    base_dir = base.rstrip("/")

    # Exact non-recursive filenames do not need a full directory listing.
    # This matters for long-lived remote directories where unrelated fixture
    # files may accumulate; preserve the existing listing path for globs and
    # recursive traversal.
    literal_filename = (
        not recursive
        and "/" not in pattern
        and not any(ch in pattern for ch in "*?[")
    )
    if literal_filename:
        full = f"{base_dir}/{pattern}"
        try:
            attr = sftp.stat(full)
        except FileNotFoundError:
            return []
        except OSError as exc:
            if getattr(exc, "errno", None) == 2:
                return []
            logger.info(
                "%s",
                {
                    "stage": "remote_file_stat_failed",
                    "path": full,
                    "error_type": type(exc).__name__,
                },
            )
            raise
        mode = int(getattr(attr, "st_mode", 0) or 0)
        if (mode & 0o40000) == 0o40000:
            return []
        mtime = float(getattr(attr, "st_mtime", 0) or 0)
        size = int(getattr(attr, "st_size", 0) or 0)
        return [(full, mtime, size)]

    stack = [base_dir]

    while stack:
        cur = stack.pop()
        try:
            for attr in sftp.listdir_attr(cur):
                name = str(attr.filename or "")
                if not name or name in (".", ".."):
                    continue
                full = f"{cur.rstrip('/')}/{name}"
                mode = int(getattr(attr, "st_mode", 0) or 0)
                is_dir = (mode & 0o40000) == 0o40000
                if is_dir:
                    if recursive:
                        stack.append(full)
                    continue
                if not fnmatch.fnmatch(name, pattern):
                    continue
                mtime = float(getattr(attr, "st_mtime", 0) or 0)
                size = int(getattr(attr, "st_size", 0) or 0)
                out.append((full, mtime, size))
        except OSError as exc:
            logger.info(
                "%s",
                {"stage": "remote_file_listdir_failed", "path": cur, "error_type": type(exc).__name__},
            )
            raise

    out.sort(key=lambda t: _file_tuple(t[1], t[0]))
    return out
