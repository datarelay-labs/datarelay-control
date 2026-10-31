"""F-191 / F-198: secrets must never leave the API through any list/detail/export/bundle serializer.

The tests deliberately use secret fields that the old key-name list did not know about
(``shared_secret``, ``private_key_passphrase``, ``vendor_signing_key`` ...) and scan the complete
response/zip text for the literal values.
"""

from __future__ import annotations

import io
import json
import zipfile
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.auth.jwt_service import issue_access_token
from app.database import get_db
from app.main import app
from app.security.secrets import (
    SOURCE_SECRET_FIELDS,
    collect_secret_literals,
    is_sensitive_field_name,
    mask_secrets,
    mask_source_auth_json,
    mask_source_config_json,
)
from app.sources.models import Source

WEBHOOK_SECRET = "WHSEC-literal-7f3a9c1d2e4b5a60"
WEBHOOK_BEARER = "WHBEARER-literal-0a1b2c3d4e5f6071"
SFTP_PASSPHRASE = "SFTPPASS-literal-9e8d7c6b5a403122"
SFTP_PASSWORD = "SFTPPW-literal-1234567890abcdef"
SFTP_KEY = "SFTPKEYMATERIAL-literal-aabbccddeeff"
S3_SECRET = "S3SECRET-literal-00112233445566778899"
S3_ACCESS_KEY = "AKIAWPA20261101EXAMPLE"
DB_PASSWORD = "DBPW-literal-abcdef0123456789"
HTTP_BEARER = "HTTPBEARER-literal-fedcba9876543210"
UNKNOWN_KEY_SECRET = "VENDORSIGN-literal-5566778899aabbcc"

ALL_LITERALS = (
    WEBHOOK_SECRET,
    WEBHOOK_BEARER,
    SFTP_PASSPHRASE,
    SFTP_PASSWORD,
    SFTP_KEY,
    S3_SECRET,
    DB_PASSWORD,
    HTTP_BEARER,
    UNKNOWN_KEY_SECRET,
)


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def _bearer(role: str) -> dict[str, str]:
    token, _ = issue_access_token(username=f"{role.lower()}-wpa", user_id=1, role=role, token_version=1)
    return {"Authorization": f"Bearer {token}"}


def _create(client: TestClient, body: dict[str, Any]) -> dict[str, Any]:
    res = client.post("/api/v1/connectors/", json=body)
    assert res.status_code == 201, res.text
    return res.json()


def _seed_all_connector_types(client: TestClient) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    out["webhook_secret"] = _create(
        client,
        {
            "name": "wpa-webhook-shared",
            "auth_type": "no_auth",
            "connector_type": "webhook_receiver",
            "source_type": "WEBHOOK_RECEIVER",
            "webhook_auth_mode": "shared_secret_header",
            "webhook_shared_secret": WEBHOOK_SECRET,
        },
    )
    out["webhook_bearer"] = _create(
        client,
        {
            "name": "wpa-webhook-bearer",
            "auth_type": "no_auth",
            "connector_type": "webhook_receiver",
            "source_type": "WEBHOOK_RECEIVER",
            "webhook_auth_mode": "bearer_token",
            "webhook_bearer_token": WEBHOOK_BEARER,
        },
    )
    out["sftp"] = _create(
        client,
        {
            "name": "wpa-sftp",
            "auth_type": "no_auth",
            "connector_type": "remote_file",
            "source_type": "REMOTE_FILE_POLLING",
            "host": "sftp.example.test",
            "remote_username": "svc",
            "remote_password": SFTP_PASSWORD,
            "remote_private_key": SFTP_KEY,
            "remote_private_key_passphrase": SFTP_PASSPHRASE,
        },
    )
    out["s3"] = _create(
        client,
        {
            "name": "wpa-s3",
            "auth_type": "no_auth",
            "connector_type": "s3_compatible",
            "source_type": "S3_OBJECT_POLLING",
            "endpoint_url": "http://minio.example.test:9000",
            "bucket": "logs",
            "access_key": S3_ACCESS_KEY,
            "secret_key": S3_SECRET,
        },
    )
    out["db"] = _create(
        client,
        {
            "name": "wpa-db",
            "auth_type": "no_auth",
            "connector_type": "relational_database",
            "source_type": "DATABASE_QUERY",
            "host": "db.example.test",
            "db_type": "POSTGRESQL",
            "database": "app",
            "db_username": "reader",
            "db_password": DB_PASSWORD,
        },
    )
    out["http"] = _create(
        client,
        {
            "name": "wpa-http",
            "auth_type": "bearer",
            "base_url": "https://vendor.example.test",
            "bearer_token": HTTP_BEARER,
        },
    )
    return out


def _add_unknown_key_secret(db_session: Session, connector_id: int) -> None:
    """A secret stored under a key name that no declaration lists (future connector field)."""

    src = db_session.query(Source).filter(Source.connector_id == connector_id).one()
    src.auth_json = {**dict(src.auth_json or {}), "vendor_signing_key": UNKNOWN_KEY_SECRET}
    src.config_json = {**dict(src.config_json or {}), "x_custom_credential": UNKNOWN_KEY_SECRET}
    db_session.commit()


def _assert_no_literals(text: str, where: str) -> None:
    for lit in ALL_LITERALS:
        assert lit not in text, f"{where} leaked a secret literal ({lit[:6]}...)"


def test_masking_policy_declares_and_detects_secret_fields() -> None:
    for name in (
        "shared_secret",
        "private_key_passphrase",
        "vendor_signing_key",
        "x_custom_credential",
        "clientSecret",
        "db_passwd",
        "Authorization",
        "x-api-key",
        "session_token",
    ):
        assert is_sensitive_field_name(name), name
    for name in (
        "auth_type",
        "token_url",
        "oauth2_token_url",
        "api_key_name",
        "api_key_location",
        "access_token_json_path",
        "next_page_token",
        "page_token",
        "receiver_key",
        "object_key_pattern",
        "primary_key",
        "username",
        "bearer_token_configured",
        "secret_key_configured",
        "token_ttl_seconds",
        "refresh_token_header_name",
    ):
        assert not is_sensitive_field_name(name), name


def test_mask_secrets_keeps_empty_and_boolean_markers() -> None:
    out = mask_secrets({"shared_secret": "", "other_credential": None, "has_secret": True, "tokens": ["a", "b"]})
    assert out["shared_secret"] == ""
    assert out["other_credential"] is None
    assert out["has_secret"] is True
    assert out["tokens"] == ["********", "********"]


def test_source_secret_registry_covers_every_connector_builder_field() -> None:
    cfg = mask_source_config_json(
        "REMOTE_FILE_POLLING",
        {"password": "a", "private_key": "b", "private_key_passphrase": "c", "host": "h"},
    )
    assert cfg == {"password": "********", "private_key": "********", "private_key_passphrase": "********", "host": "h"}
    auth = mask_source_auth_json("WEBHOOK_RECEIVER", {"auth_mode": "bearer_token", "shared_secret": "s", "bearer_token": "t"})
    assert auth == {"auth_mode": "bearer_token", "shared_secret": "********", "bearer_token": "********"}
    assert set(SOURCE_SECRET_FIELDS) >= {
        "HTTP_API_POLLING",
        "S3_OBJECT_POLLING",
        "DATABASE_QUERY",
        "REMOTE_FILE_POLLING",
        "WEBHOOK_RECEIVER",
    }
    assert collect_secret_literals({"auth": {"shared_secret": "abc", "header_name": "X"}}) == ["abc"]


@pytest.mark.parametrize("role", ["VIEWER", "OPERATOR"])
def test_lists_details_and_exports_do_not_leak_secrets_for_any_role(
    client: TestClient, db_session: Session, role: str
) -> None:
    created = _seed_all_connector_types(client)
    _add_unknown_key_secret(db_session, int(created["webhook_secret"]["id"]))
    _add_unknown_key_secret(db_session, int(created["sftp"]["id"]))
    headers = _bearer(role)

    paths = ["/api/v1/connectors/", "/api/v1/sources/", "/api/v1/backup/workspace/export"]
    for c in created.values():
        paths.append(f"/api/v1/connectors/{c['id']}")
        paths.append(f"/api/v1/backup/connectors/{c['id']}/export?include_destinations=true")
        paths.append(f"/api/v1/sources/{c['source_id']}")
    for path in paths:
        res = client.get(path, headers=headers)
        assert res.status_code == 200, (path, res.status_code, res.text[:200])
        _assert_no_literals(res.text, f"{role} GET {path}")


def test_connector_read_keeps_a_secret_is_set_marker(client: TestClient) -> None:
    created = _seed_all_connector_types(client)
    wh = client.get(f"/api/v1/connectors/{created['webhook_secret']['id']}").json()
    assert wh["webhook_shared_secret_configured"] is True
    assert wh["auth"]["shared_secret"] == "********"
    assert wh["auth"]["shared_secret_configured"] is True
    sftp = client.get(f"/api/v1/connectors/{created['sftp']['id']}").json()
    assert sftp["remote_private_key_passphrase_configured"] is True
    src = client.get(f"/api/v1/sources/{created['sftp']['source_id']}").json()
    assert src["config_json"]["private_key_passphrase"] == "********"
    assert src["config_json"]["host"] == "sftp.example.test"


def test_export_integrity_only_claims_masked_when_no_secret_literal_is_present(
    client: TestClient, db_session: Session
) -> None:
    created = _seed_all_connector_types(client)
    _add_unknown_key_secret(db_session, int(created["webhook_secret"]["id"]))
    data = client.get("/api/v1/backup/workspace/export").json()
    assert data["export_integrity"]["secrets_masked"] is True
    assert data["export_integrity"]["issues"] == []

    from app.backup.export_validation import build_export_integrity_report

    leaky = json.loads(json.dumps(data))
    leaky["sources"][0]["auth_json"]["shared_secret"] = WEBHOOK_SECRET
    report = build_export_integrity_report(leaky, known_secret_literals=[WEBHOOK_SECRET])
    assert report["secrets_masked"] is False
    assert any("secret" in issue.lower() for issue in report["issues"])
    # A secret under a key no list declares is also caught by the value scan.
    leaky2 = json.loads(json.dumps(data))
    leaky2["streams"] = [{"id": 1, "config_json": {"note": f"copy of {UNKNOWN_KEY_SECRET}"}}]
    report2 = build_export_integrity_report(leaky2, known_secret_literals=[UNKNOWN_KEY_SECRET])
    assert report2["secrets_masked"] is False


def test_support_bundle_members_never_contain_secret_literals(client: TestClient, db_session: Session) -> None:
    created = _seed_all_connector_types(client)
    _add_unknown_key_secret(db_session, int(created["webhook_secret"]["id"]))
    _add_unknown_key_secret(db_session, int(created["sftp"]["id"]))
    res = client.get("/api/v1/admin/support-bundle", headers=_bearer("ADMINISTRATOR"))
    assert res.status_code == 200, res.text[:300]
    with zipfile.ZipFile(io.BytesIO(res.content)) as zf:
        names = zf.namelist()
        assert "sources.json" in names
        for name in names:
            text = zf.read(name).decode("utf-8", errors="replace")
            _assert_no_literals(text, f"support bundle member {name}")
        sources = json.loads(zf.read("sources.json"))
    wh = next(s for s in sources if s["source_type"] == "WEBHOOK_RECEIVER" and s["auth_json"].get("shared_secret"))
    assert wh["auth_json"]["shared_secret"] == "********"


# --- edit keeps the stored secret unless a new one is supplied ----------------------------------


def _update(client: TestClient, created: dict[str, Any], **fields: Any) -> Any:
    current = client.get(f"/api/v1/connectors/{created['id']}").json()
    body = {
        "expected_updated_at": current["updated_at"],
        "expected_source_updated_at": current["source_updated_at"],
        "source_type": created["source_type"],
        **fields,
    }
    return client.put(f"/api/v1/connectors/{created['id']}", json=body)


def _stored(db_session: Session, connector_id: int) -> Source:
    db_session.expire_all()
    return db_session.query(Source).filter(Source.connector_id == connector_id).one()


@pytest.mark.parametrize("send_mask", [False, True])
def test_editing_webhook_receiver_keeps_stored_secret_unless_replaced(
    client: TestClient, db_session: Session, send_mask: bool
) -> None:
    created = _seed_all_connector_types(client)["webhook_secret"]
    extra: dict[str, Any] = {"webhook_auth_mode": "shared_secret_header", "max_request_bytes": 4096}
    if send_mask:
        extra["webhook_shared_secret"] = "********"
    res = _update(client, created, **extra)
    assert res.status_code == 200, res.text
    assert _stored(db_session, int(created["id"])).auth_json["shared_secret"] == WEBHOOK_SECRET
    _assert_no_literals(res.text, "PUT webhook response")

    res = _update(client, created, webhook_shared_secret="rotated-new-secret-value-1")
    assert res.status_code == 200, res.text
    assert _stored(db_session, int(created["id"])).auth_json["shared_secret"] == "rotated-new-secret-value-1"


@pytest.mark.parametrize("send_mask", [False, True])
def test_editing_remote_file_connector_keeps_stored_secrets_unless_replaced(
    client: TestClient, db_session: Session, send_mask: bool
) -> None:
    created = _seed_all_connector_types(client)["sftp"]
    extra: dict[str, Any] = {"connection_timeout_seconds": 31}
    if send_mask:
        extra.update(
            remote_password="********",
            remote_private_key="********",
            remote_private_key_passphrase="********",
        )
    res = _update(client, created, **extra)
    assert res.status_code == 200, res.text
    cfg = _stored(db_session, int(created["id"])).config_json
    assert cfg["password"] == SFTP_PASSWORD
    assert cfg["private_key"] == SFTP_KEY
    assert cfg["private_key_passphrase"] == SFTP_PASSPHRASE
    assert cfg["connection_timeout_seconds"] == 31
    _assert_no_literals(res.text, "PUT sftp response")

    res = _update(client, created, remote_private_key_passphrase="new-passphrase-value-2")
    assert res.status_code == 200, res.text
    assert _stored(db_session, int(created["id"])).config_json["private_key_passphrase"] == "new-passphrase-value-2"


@pytest.mark.parametrize("key", ["s3", "db", "http"])
def test_editing_other_connectors_keeps_stored_secret(client: TestClient, db_session: Session, key: str) -> None:
    created = _seed_all_connector_types(client)[key]
    res = _update(client, created, description="edited without touching the secret")
    assert res.status_code == 200, res.text
    stored = _stored(db_session, int(created["id"]))
    blob = json.dumps({"c": stored.config_json, "a": stored.auth_json})
    expected = {"s3": S3_SECRET, "db": DB_PASSWORD, "http": HTTP_BEARER}[key]
    assert expected in blob
    _assert_no_literals(res.text, f"PUT {key} response")


def test_http_connector_header_maps_round_trip_without_clobbering_masked_values(
    client: TestClient, db_session: Session
) -> None:
    created = _create(
        client,
        {
            "name": "wpa-http-headers",
            "auth_type": "no_auth",
            "base_url": "https://vendor.example.test",
            "common_headers": {"Accept": "application/json", "X-Vendor-Auth-Token": UNKNOWN_KEY_SECRET},
        },
    )
    read = client.get(f"/api/v1/connectors/{created['id']}").json()
    assert UNKNOWN_KEY_SECRET not in json.dumps(read)
    assert read["common_headers"]["X-Vendor-Auth-Token"] == "********"
    assert read["common_headers"]["Accept"] == "application/json"
    res = _update(client, created, common_headers=read["common_headers"], description="round trip")
    assert res.status_code == 200, res.text
    stored = _stored(db_session, int(created["id"]))
    assert stored.config_json["common_headers"]["X-Vendor-Auth-Token"] == UNKNOWN_KEY_SECRET


def test_clone_connector_keeps_secrets_server_side(client: TestClient, db_session: Session) -> None:
    created = _seed_all_connector_types(client)["webhook_secret"]
    res = client.post(f"/api/v1/backup/connectors/{created['id']}/clone", json={"name_suffix": " (wpa copy)"})
    assert res.status_code in (200, 201), res.text
    new_id = res.json()["connector_id"]
    assert new_id != created["id"]
    assert _stored(db_session, int(new_id)).auth_json["shared_secret"] == WEBHOOK_SECRET
    _assert_no_literals(res.text, "clone response")
