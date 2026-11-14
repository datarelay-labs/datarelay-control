"""E-009: Test on a saved connector must test what is visible on screen (unsaved draft overlay).

The HTTP overlay already existed; DATABASE_QUERY, S3_OBJECT_POLLING and REMOTE_FILE_POLLING saved connectors
silently tested the saved configuration, so an edited host/password/secret reported success against the
*saved* values. Masked or blank secret fields are resolved server-side from the saved row only while every
outbound destination (host/port, endpoint, token/login URL, proxy) is unchanged; otherwise the saved secret is
never forwarded to the new destination (SSRF / secret-exfiltration guard).
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest

from app.runtime.preview_service import (
    PreviewRequestError,
    _overlay_connector_auth_test_draft,
    run_connector_auth_test,
)
from app.runtime.schemas import ConnectorAuthTestRequest

_MASK = "********"


def _saved(monkeypatch: pytest.MonkeyPatch, cfg: dict[str, Any]) -> None:
    monkeypatch.setattr("app.runtime.preview_service._load_source_config_for_connector", lambda db, cid: dict(cfg))


# --- DATABASE_QUERY ------------------------------------------------------------------------------------

_SAVED_DB = {
    "source_type": "DATABASE_QUERY",
    "connector_type": "relational_database",
    "db_type": "POSTGRESQL",
    "host": "db.saved.example",
    "port": 5432,
    "database": "audit",
    "username": "bfs_reader",
    "password": "saved-db-password",
    "ssl_mode": "PREFER",
    "connection_timeout_seconds": 15,
    "auth_type": "no_auth",
}


def _db_draft(**over: Any) -> dict[str, Any]:
    d = {
        "source_type": "DATABASE_QUERY",
        "db_type": "POSTGRESQL",
        "host": "db.saved.example",
        "port": 5432,
        "database": "audit",
        "username": "bfs_reader",
        "password": _MASK,
        "ssl_mode": "PREFER",
        "connection_timeout_seconds": 15,
        "auth_type": "no_auth",
    }
    d.update(over)
    return d


def _capture_db(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    seen: list[dict[str, Any]] = []

    def fake_probe(flat: dict[str, Any]) -> dict[str, Any]:
        seen.append(dict(flat))
        return {"ok": True, "message": "SELECT 1 succeeded", "db_reachable": True, "db_auth_ok": True}

    monkeypatch.setattr("app.runtime.preview_service.probe_database_connection", fake_probe)
    return seen


def _run_db(draft: dict[str, Any]):
    return run_connector_auth_test(ConnectorAuthTestRequest(connector_id=10, inline_flat_source=draft), MagicMock())


def test_db_saved_connector_tests_the_visible_unsaved_password(monkeypatch: pytest.MonkeyPatch) -> None:
    _saved(monkeypatch, _SAVED_DB)
    seen = _capture_db(monkeypatch)

    _run_db(_db_draft(password="typed-wrong-password"))

    assert seen[0]["password"] == "typed-wrong-password"
    assert seen[0]["host"] == "db.saved.example"


def test_db_saved_connector_tests_the_visible_unsaved_host_and_user(monkeypatch: pytest.MonkeyPatch) -> None:
    _saved(monkeypatch, _SAVED_DB)
    seen = _capture_db(monkeypatch)

    _run_db(_db_draft(host="203.0.113.9", username="someone_else", password="typed-pw"))

    assert seen[0]["host"] == "203.0.113.9"
    assert seen[0]["username"] == "someone_else"
    assert seen[0]["password"] == "typed-pw"


def test_db_masked_password_resolves_saved_secret_for_same_host_and_port(monkeypatch: pytest.MonkeyPatch) -> None:
    _saved(monkeypatch, _SAVED_DB)
    seen = _capture_db(monkeypatch)

    _run_db(_db_draft(database="other_db", username="other_user"))

    assert seen[0]["password"] == "saved-db-password"
    assert seen[0]["database"] == "other_db"
    assert seen[0]["username"] == "other_user"


@pytest.mark.parametrize("over", [{"host": "203.0.113.9"}, {"port": 5433}, {"host": "DB.SAVED.EXAMPLE", "port": 6543}])
def test_db_saved_password_is_never_sent_to_a_different_host_or_port(monkeypatch: pytest.MonkeyPatch, over: dict[str, Any]) -> None:
    _saved(monkeypatch, _SAVED_DB)
    seen = _capture_db(monkeypatch)

    _run_db(_db_draft(**over))

    assert seen[0]["password"] == ""
    assert "saved-db-password" not in repr(seen)


def test_db_blank_password_is_treated_like_masked(monkeypatch: pytest.MonkeyPatch) -> None:
    _saved(monkeypatch, _SAVED_DB)
    seen = _capture_db(monkeypatch)

    _run_db(_db_draft(password=""))
    _run_db(_db_draft(password="", host="203.0.113.9"))

    assert seen[0]["password"] == "saved-db-password"
    assert seen[1]["password"] == ""


# --- S3_OBJECT_POLLING ---------------------------------------------------------------------------------

_SAVED_S3 = {
    "source_type": "S3_OBJECT_POLLING",
    "connector_type": "s3_compatible",
    "endpoint_url": "http://s3.saved.example:9000",
    "bucket": "audit-bucket",
    "region": "us-east-1",
    "access_key": "AKSAVED",
    "secret_key": "saved-s3-secret",
    "prefix": "",
    "path_style_access": True,
    "use_ssl": False,
    "auth_type": "no_auth",
}


def _s3_draft(**over: Any) -> dict[str, Any]:
    d = {
        "source_type": "S3_OBJECT_POLLING",
        "endpoint_url": "http://s3.saved.example:9000",
        "bucket": "audit-bucket",
        "region": "us-east-1",
        "access_key": "AKSAVED",
        "secret_key": _MASK,
        "prefix": "",
        "object_key_pattern": "",
        "path_style_access": True,
        "use_ssl": False,
        "auth_type": "no_auth",
    }
    d.update(over)
    return d


def _capture_s3(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    seen: list[dict[str, Any]] = []

    def fake_probe(cfg: dict[str, Any]) -> dict[str, Any]:
        seen.append(dict(cfg))
        return {
            "s3_endpoint_reachable": True,
            "s3_auth_ok": True,
            "s3_bucket_exists": True,
            "s3_error_type": None,
            "s3_message": "ok",
        }

    monkeypatch.setattr("app.runtime.preview_service.probe_s3_source", fake_probe)
    return seen


def _run_s3(draft: dict[str, Any]):
    return run_connector_auth_test(ConnectorAuthTestRequest(connector_id=11, inline_flat_source=draft), MagicMock())


def test_s3_saved_connector_tests_visible_secret_region_and_bucket(monkeypatch: pytest.MonkeyPatch) -> None:
    _saved(monkeypatch, _SAVED_S3)
    seen = _capture_s3(monkeypatch)

    _run_s3(_s3_draft(secret_key="typed-wrong-secret", region="eu-west-9", bucket="other-bucket"))

    assert seen[0]["secret_key"] == "typed-wrong-secret"
    assert seen[0]["region"] == "eu-west-9"
    assert seen[0]["bucket"] == "other-bucket"


def test_s3_masked_secret_resolves_saved_value_for_same_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    _saved(monkeypatch, _SAVED_S3)
    seen = _capture_s3(monkeypatch)

    _run_s3(_s3_draft(region="eu-west-9"))

    assert seen[0]["secret_key"] == "saved-s3-secret"
    assert seen[0]["region"] == "eu-west-9"


@pytest.mark.parametrize(
    "endpoint",
    ["http://attacker.example:9000", "https://s3.saved.example:9000", "http://s3.saved.example:9001"],
)
def test_s3_saved_secret_is_never_sent_to_a_different_endpoint(monkeypatch: pytest.MonkeyPatch, endpoint: str) -> None:
    _saved(monkeypatch, _SAVED_S3)
    seen = _capture_s3(monkeypatch)

    _run_s3(_s3_draft(endpoint_url=endpoint))

    assert seen[0]["secret_key"] == ""
    assert "saved-s3-secret" not in repr(seen)


# --- REMOTE_FILE_POLLING -------------------------------------------------------------------------------

_SAVED_RF = {
    "source_type": "REMOTE_FILE_POLLING",
    "connector_type": "remote_file",
    "protocol": "sftp",
    "host": "sftp.saved.example",
    "port": 22,
    "username": "bfs",
    "password": "saved-sftp-password",
    "private_key": "-----BEGIN KEY-----saved-----END KEY-----",
    "known_hosts_policy": "strict",
    "known_hosts_text": "sftp.saved.example ssh-ed25519 AAAAsaved",
    "connection_timeout_seconds": 20,
    "auth_type": "no_auth",
}


def _rf_draft(**over: Any) -> dict[str, Any]:
    d = {
        "source_type": "REMOTE_FILE_POLLING",
        "connector_type": "remote_file",
        "host": "sftp.saved.example",
        "port": 22,
        "remote_username": "bfs",
        "remote_password": _MASK,
        "remote_file_protocol": "sftp",
        "remote_private_key": _MASK,
        "remote_private_key_passphrase": "",
        "known_hosts_policy": "strict",
        "known_hosts_text": "",
        "connection_timeout_seconds": 20,
        "auth_type": "no_auth",
    }
    d.update(over)
    return d


def _capture_rf(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    seen: list[dict[str, Any]] = []

    def fake_probe(cfg: dict[str, Any], stream_cfg: dict[str, Any]) -> dict[str, Any]:
        seen.append(dict(cfg))
        return {"ok": True, "message": "probe succeeded", "ssh_reachable": True, "ssh_auth_ok": True}

    monkeypatch.setattr("app.runtime.preview_service.probe_remote_file_source", fake_probe)
    return seen


def _run_rf(draft: dict[str, Any]):
    return run_connector_auth_test(
        ConnectorAuthTestRequest(
            connector_id=12,
            inline_flat_source=draft,
            remote_file_stream_config={"remote_directory": "/incoming", "file_pattern": "*"},
        ),
        MagicMock(),
    )


def test_remote_file_saved_connector_tests_visible_unsaved_password(monkeypatch: pytest.MonkeyPatch) -> None:
    _saved(monkeypatch, _SAVED_RF)
    seen = _capture_rf(monkeypatch)

    _run_rf(_rf_draft(remote_password="typed-wrong-password"))

    # The runtime normalizer prefers canonical keys; the draft must not lose to the saved password.
    assert seen[0]["password"] == "typed-wrong-password"
    assert seen[0]["username"] == "bfs"
    assert "remote_password" not in seen[0] or seen[0]["remote_password"] != "saved-sftp-password"


def test_remote_file_masked_secrets_resolve_saved_values_for_same_host(monkeypatch: pytest.MonkeyPatch) -> None:
    _saved(monkeypatch, _SAVED_RF)
    seen = _capture_rf(monkeypatch)

    _run_rf(_rf_draft(remote_username="other_user"))

    assert seen[0]["username"] == "other_user"
    assert seen[0]["password"] == "saved-sftp-password"
    assert seen[0]["private_key"].startswith("-----BEGIN KEY-----")
    # blank known_hosts_text on the form means "unchanged"
    assert seen[0]["known_hosts_text"].startswith("sftp.saved.example")


@pytest.mark.parametrize("over", [{"host": "203.0.113.9"}, {"port": 2222}])
def test_remote_file_saved_secrets_are_never_sent_to_a_different_host_or_port(
    monkeypatch: pytest.MonkeyPatch, over: dict[str, Any]
) -> None:
    _saved(monkeypatch, _SAVED_RF)
    seen = _capture_rf(monkeypatch)

    _run_rf(_rf_draft(**over))

    blob = repr(seen)
    assert "saved-sftp-password" not in blob
    assert "saved-----END KEY" not in blob
    assert "AAAAsaved" not in blob


# --- family mismatch / HTTP hardening ------------------------------------------------------------------


@pytest.mark.parametrize(
    "saved,draft",
    [
        (_SAVED_DB, _s3_draft()),
        (_SAVED_S3, _db_draft()),
        (_SAVED_RF, _db_draft()),
        (_SAVED_DB, {"base_url": "https://x.example", "auth_type": "no_auth"}),
    ],
)
def test_overlay_across_connector_families_is_rejected(
    monkeypatch: pytest.MonkeyPatch, saved: dict[str, Any], draft: dict[str, Any]
) -> None:
    _saved(monkeypatch, saved)

    with pytest.raises(PreviewRequestError) as exc:
        run_connector_auth_test(ConnectorAuthTestRequest(connector_id=1, inline_flat_source=draft), MagicMock())

    assert exc.value.status_code == 400
    assert exc.value.detail["error_type"] == "inline_draft_overlay_not_supported"


_SAVED_HTTP = {
    "base_url": "https://api.saved.example",
    "verify_ssl": True,
    "http_proxy": None,
    "headers": {},
    "auth_type": "oauth2_client_credentials",
    "oauth2_client_id": "cid",
    "oauth2_client_secret": "saved-client-secret",
    "oauth2_token_url": "https://auth.saved.example/token",
    "bearer_token": "saved-bearer",
    "api_key_value": "saved-api-key",
    "login_password": "saved-login-password",
}


def _http_draft(**over: Any) -> dict[str, Any]:
    d = {
        "base_url": "https://api.saved.example",
        "verify_ssl": True,
        "http_proxy": None,
        "headers": {},
        "auth_type": "oauth2_client_credentials",
        "oauth2_client_id": "cid",
        "oauth2_client_secret": _MASK,
        "oauth2_token_url": "https://auth.saved.example/token",
        "bearer_token": "",
        "api_key_value": "",
        "login_password": "",
    }
    d.update(over)
    return d


def test_http_overlay_same_destinations_reuses_masked_secrets() -> None:
    out = _overlay_connector_auth_test_draft(_SAVED_HTTP, _http_draft())
    assert out["oauth2_client_secret"] == "saved-client-secret"
    assert out["bearer_token"] == "saved-bearer"


@pytest.mark.parametrize(
    "over",
    [
        {"oauth2_token_url": "https://evil.example/token"},
        {"login_url": "https://evil.example/login"},
        {"preflight_url": "https://evil.example/pre"},
        {"token_url": "http://evil.example:81/t"},
        {"http_proxy": "http://evil.example:3128"},
        {"base_url": "https://api.saved.example:8443"},
    ],
)
def test_http_overlay_never_reuses_saved_secrets_when_any_destination_changes(over: dict[str, Any]) -> None:
    out = _overlay_connector_auth_test_draft(_SAVED_HTTP, _http_draft(**over))
    for key in ("oauth2_client_secret", "bearer_token", "api_key_value", "login_password"):
        assert out[key] == "", key


def test_http_overlay_applies_changed_base_url_path_and_typed_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[tuple[str, dict[str, str]]] = []

    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def request(self, method: str, url: str, **kwargs: Any):
            seen.append((url, dict(kwargs.get("headers") or {})))
            return httpx.Response(401, request=httpx.Request(method, url), text="Unauthorized")

    monkeypatch.setattr("app.runtime.preview_service.httpx.Client", lambda *a, **k: _Client())
    _saved(
        monkeypatch,
        {
            "base_url": "https://api.saved.example/v1",
            "verify_ssl": True,
            "headers": {},
            "auth_type": "bearer",
            "bearer_token": "saved-bearer",
        },
    )

    res = run_connector_auth_test(
        ConnectorAuthTestRequest(
            connector_id=4,
            inline_flat_source={
                "base_url": "https://api.saved.example/v2",
                "verify_ssl": True,
                "headers": {},
                "auth_type": "bearer",
                "bearer_token": "typed-wrong-token",
            },
            method="GET",
            test_path="/edited/path",
        ),
        MagicMock(),
    )

    assert seen == [("https://api.saved.example/v2/edited/path", {"Authorization": "Bearer typed-wrong-token"})]
    assert res.ok is False


# --- fail closed: omitted / null / blank / masked secrets never follow a changed destination -----------

_ABSENT = object()


def _without_absent(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v is not _ABSENT}


@pytest.mark.parametrize("secret", [_ABSENT, None, "", "   ", _MASK], ids=["omitted", "null", "blank", "spaces", "masked"])
@pytest.mark.parametrize("over", [{"host": "attacker.example"}, {"port": 6543}], ids=["host", "port"])
def test_db_changed_destination_never_inherits_saved_password(
    monkeypatch: pytest.MonkeyPatch, secret: Any, over: dict[str, Any]
) -> None:
    _saved(monkeypatch, _SAVED_DB)
    seen = _capture_db(monkeypatch)
    draft = _without_absent({"source_type": "DATABASE_QUERY", "host": "db.saved.example", "database": "audit", **over, "password": secret})

    _run_db(draft)

    assert seen[0]["password"] == ""
    assert "saved-db-password" not in repr(seen)


def test_db_minimal_attacker_draft_from_the_review_finding(monkeypatch: pytest.MonkeyPatch) -> None:
    _saved(monkeypatch, _SAVED_DB)
    seen = _capture_db(monkeypatch)

    _run_db({"source_type": "DATABASE_QUERY", "host": "attacker.example", "database": "audit"})

    assert seen[0]["host"] == "attacker.example"
    assert seen[0]["password"] == ""


@pytest.mark.parametrize("secret", [_ABSENT, None, "", _MASK], ids=["omitted", "null", "blank", "masked"])
def test_db_unchanged_destination_still_resolves_saved_password(monkeypatch: pytest.MonkeyPatch, secret: Any) -> None:
    _saved(monkeypatch, _SAVED_DB)
    seen = _capture_db(monkeypatch)

    _run_db(_without_absent({"source_type": "DATABASE_QUERY", "host": "db.saved.example", "database": "audit", "password": secret}))

    assert seen[0]["password"] == "saved-db-password"


def test_db_explicit_replacement_is_used_even_when_destination_changes(monkeypatch: pytest.MonkeyPatch) -> None:
    _saved(monkeypatch, _SAVED_DB)
    seen = _capture_db(monkeypatch)

    _run_db(_db_draft(host="203.0.113.9", password="typed-new-password"))

    assert seen[0]["password"] == "typed-new-password"


@pytest.mark.parametrize("secret", [_ABSENT, None, "", _MASK], ids=["omitted", "null", "blank", "masked"])
@pytest.mark.parametrize(
    "over",
    [{"endpoint_url": "http://attacker.example:9000"}, {"endpoint_url": "http://s3.saved.example:9001"}],
    ids=["endpoint-host", "endpoint-port"],
)
def test_s3_changed_endpoint_never_inherits_saved_secret_or_access_key(
    monkeypatch: pytest.MonkeyPatch, secret: Any, over: dict[str, Any]
) -> None:
    _saved(monkeypatch, _SAVED_S3)
    seen = _capture_s3(monkeypatch)

    _run_s3(_without_absent({"source_type": "S3_OBJECT_POLLING", "bucket": "audit-bucket", **over, "secret_key": secret}))

    assert seen[0]["secret_key"] == ""
    assert seen[0].get("access_key", "") == ""
    assert "saved-s3-secret" not in repr(seen)


def test_s3_omitted_secret_with_unchanged_endpoint_resolves_saved(monkeypatch: pytest.MonkeyPatch) -> None:
    _saved(monkeypatch, _SAVED_S3)
    seen = _capture_s3(monkeypatch)

    _run_s3({"source_type": "S3_OBJECT_POLLING", "endpoint_url": "http://s3.saved.example:9000", "bucket": "other"})

    assert seen[0]["secret_key"] == "saved-s3-secret"
    assert seen[0]["bucket"] == "other"


@pytest.mark.parametrize("secret", [_ABSENT, None, "", _MASK], ids=["omitted", "null", "blank", "masked"])
@pytest.mark.parametrize("over", [{"host": "attacker.example"}, {"port": 2222}], ids=["host", "port"])
def test_remote_file_changed_destination_never_inherits_any_saved_secret(
    monkeypatch: pytest.MonkeyPatch, secret: Any, over: dict[str, Any]
) -> None:
    _saved(monkeypatch, _SAVED_RF)
    seen = _capture_rf(monkeypatch)
    draft = _without_absent(
        {
            "source_type": "REMOTE_FILE_POLLING",
            "host": "sftp.saved.example",
            **over,
            "remote_password": secret,
            "remote_private_key": secret,
            "remote_private_key_passphrase": secret,
        }
    )

    _run_rf(draft)

    blob = repr(seen)
    assert "saved-sftp-password" not in blob and "saved-----END KEY" not in blob and "AAAAsaved" not in blob
    assert seen[0]["password"] == ""


def test_remote_file_omitted_secrets_with_unchanged_destination_resolve_saved(monkeypatch: pytest.MonkeyPatch) -> None:
    _saved(monkeypatch, _SAVED_RF)
    seen = _capture_rf(monkeypatch)

    _run_rf({"source_type": "REMOTE_FILE_POLLING", "host": "sftp.saved.example", "remote_username": "bfs"})

    assert seen[0]["password"] == "saved-sftp-password"


@pytest.mark.parametrize("secret", [_ABSENT, None, "", _MASK], ids=["omitted", "null", "blank", "masked"])
@pytest.mark.parametrize(
    "over",
    [
        {"base_url": "https://attacker.example"},
        {"oauth2_token_url": "https://attacker.example/token"},
        {"login_url": "https://attacker.example/login"},
        {"http_proxy": "http://attacker.example:3128"},
    ],
)
def test_http_changed_destination_never_inherits_any_saved_secret(secret: Any, over: dict[str, Any]) -> None:
    saved = {
        **_SAVED_HTTP,
        "api_key": "saved-vendor-key",
        "refresh_token": "saved-refresh",
        "token_body": '{"vendor_key": "saved-body-secret"}',
        "headers": {"Authorization": "Bearer saved-header-token", "Accept": "application/json"},
    }
    secret_keys = ["oauth2_client_secret", "bearer_token", "api_key_value", "login_password", "api_key", "refresh_token"]
    draft = {"base_url": "https://api.saved.example", "auth_type": "oauth2_client_credentials", **over}
    for key in secret_keys:
        if secret is not _ABSENT:
            draft[key] = secret

    out = _overlay_connector_auth_test_draft(saved, draft)

    for key in secret_keys + ["token_body"]:
        assert out[key] in ("", None), key
    assert "saved-header-token" not in repr(out)
    assert out["headers"].get("Accept") == "application/json"


def test_http_omitted_secrets_with_unchanged_destination_resolve_saved() -> None:
    out = _overlay_connector_auth_test_draft(_SAVED_HTTP, {"base_url": "https://api.saved.example"})
    assert out["oauth2_client_secret"] == "saved-client-secret"
    assert out["bearer_token"] == "saved-bearer"


def test_http_masked_header_value_resolves_only_for_unchanged_destination() -> None:
    saved = {**_SAVED_HTTP, "headers": {"Authorization": "Bearer saved-header-token"}}
    same = _overlay_connector_auth_test_draft(saved, {"base_url": "https://api.saved.example", "headers": {"Authorization": _MASK}})
    moved = _overlay_connector_auth_test_draft(saved, {"base_url": "https://attacker.example", "headers": {"Authorization": _MASK}})
    assert same["headers"]["Authorization"] == "Bearer saved-header-token"
    assert "Authorization" not in moved["headers"]


def test_http_unknown_new_secret_field_is_not_silently_inherited() -> None:
    """Secret-looking saved keys outside the explicit list are covered by the name heuristic."""

    saved = {**_SAVED_HTTP, "vendor_signing_secret": "saved-signing-secret", "future_access_key": "saved-future-key"}
    out = _overlay_connector_auth_test_draft(saved, {"base_url": "https://attacker.example"})
    assert out["vendor_signing_secret"] == ""
    assert out["future_access_key"] == ""


def test_webhook_receiver_overlay_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    _saved(
        monkeypatch,
        {"source_type": "WEBHOOK_RECEIVER", "connector_type": "webhook_receiver", "webhook_shared_secret": "saved-hook-secret"},
    )

    with pytest.raises(PreviewRequestError) as exc:
        run_connector_auth_test(
            ConnectorAuthTestRequest(connector_id=1, inline_flat_source={"base_url": "https://attacker.example", "auth_type": "no_auth"}),
            MagicMock(),
        )

    assert exc.value.detail["error_type"] == "inline_draft_overlay_not_supported"
