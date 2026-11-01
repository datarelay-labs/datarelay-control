"""F-112: SFTP connectivity failures must name the input to correct, not just an exception class."""

from __future__ import annotations

import socket

import paramiko
import pytest

from app.sources import remote_file_probe as probe_mod
from app.sources.remote_file_probe import probe_remote_file_source

_SOURCE = {"host": "sftp.example.test", "port": 2222, "username": "svc", "password": "not-a-real-secret"}
_STREAM = {"remote_directory": "/in", "file_pattern": "*.json"}


def _probe_failing_with(monkeypatch: pytest.MonkeyPatch, exc: BaseException) -> dict[str, object]:
    def _boom(_cfg: dict[str, object]) -> None:
        raise exc

    monkeypatch.setattr(probe_mod, "open_ssh_client", _boom)
    return probe_remote_file_source(dict(_SOURCE), dict(_STREAM))


@pytest.mark.parametrize(
    ("exc", "error_type", "mention", "auth_ok", "reachable"),
    [
        (paramiko.AuthenticationException("Authentication failed."), "authentication_failed", "Username", False, True),
        (
            paramiko.BadHostKeyException("h", paramiko.RSAKey.generate(1024), paramiko.RSAKey.generate(1024)),
            "host_key_mismatch",
            "Known hosts",
            None,
            True,
        ),
        (
            paramiko.SSHException("Server 'sftp.example.test' not found in known_hosts"),
            "host_key_unknown",
            "Known hosts",
            None,
            True,
        ),
        (socket.gaierror(-2, "Name or service not known"), "host_unresolved", "Host", None, False),
        (socket.timeout("timed out"), "connect_timeout", "sftp.example.test:2222", None, False),
        (ConnectionRefusedError(111, "refused"), "connect_failed", "sftp.example.test:2222", None, False),
        (paramiko.SSHException("Incompatible ssh peer"), "ssh_protocol_error", "key exchange", None, True),
    ],
)
def test_connect_failures_name_the_input_to_fix(
    monkeypatch: pytest.MonkeyPatch,
    exc: BaseException,
    error_type: str,
    mention: str,
    auth_ok: bool | None,
    reachable: bool,
) -> None:
    out = _probe_failing_with(monkeypatch, exc)
    assert out["ok"] is False
    assert out["error_type"] == error_type
    assert mention in str(out["message"])
    if error_type != "ssh_protocol_error":
        # A bare exception class name is exactly what the audit complained about. Only the generic
        # negotiation fallback keeps it, as a detail next to the guidance.
        assert type(exc).__name__ not in str(out["message"])
    assert out["ssh_auth_ok"] is auth_ok
    assert out["ssh_reachable"] is reachable
    assert out["sftp_available"] is None
    assert "not-a-real-secret" not in repr(out)


def test_unparseable_private_key_explains_how_to_fix_it(monkeypatch: pytest.MonkeyPatch) -> None:
    out = _probe_failing_with(monkeypatch, ValueError("private_key could not be parsed"))
    assert out["error_type"] == "remote_file_probe_invalid_config"
    assert "BEGIN/END" in str(out["message"])
    assert "passphrase" in str(out["message"])
    assert out["ssh_auth_ok"] is None
