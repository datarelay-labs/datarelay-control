"""Tests for M29.5A Marketplace Package Trust & Security Foundation."""

from __future__ import annotations

import base64
import io
import json
import tarfile
from pathlib import Path
from typing import Any

import pytest
import yaml
from alembic import command
from alembic.config import Config
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.auth.jwt_service import issue_access_token
from app.auth.role_guard import ROLE_ADMINISTRATOR, ROLE_OPERATOR, ROLE_VIEWER
from app.connectors_registry.lifecycle_archive import stage_archive_bytes
from app.connectors_registry.lifecycle_errors import LifecycleError
from app.connectors_registry.lifecycle_models import (
    LIFECYCLE_STATUS_INSTALLED,
    MarketplacePackageInstall,
)
from app.connectors_registry.lifecycle_service import (
    install_package,
    rollback_package,
    uninstall_package,
    upgrade_package,
)
from app.connectors_registry.package_digest import compute_canonical_package_digest
from app.connectors_registry.package_secret_scan import (
    assert_package_secrets_clean,
    scan_package_secrets,
)
from app.connectors_registry.package_signature import (
    SIGNATURE_STATUS_DISABLED_KEY,
    SIGNATURE_STATUS_INVALID_SIGNATURE,
    SIGNATURE_STATUS_UNKNOWN_KEY,
    SIGNATURE_STATUS_UNSIGNED,
    SIGNATURE_STATUS_VALID,
    decode_ed25519_public_key,
    encode_ed25519_public_key,
)
from app.connectors_registry.service import (
    clear_registry_cache,
    get_connector_manifest,
    reload_registry,
)
from app.connectors_registry.trusted_signing_keys_models import MarketplaceTrustedSigningKey
from app.connectors_registry.trusted_signing_keys_schemas import (
    TrustedSigningKeyCreate,
    TrustedSigningKeyUpdate,
)
from app.connectors_registry.trusted_signing_keys_service import (
    create_trusted_signing_key,
    delete_trusted_signing_key,
    update_trusted_signing_key,
)
from app.database import get_db
from app.main import app


def _base_source(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": "acme",
        "name": "Acme API",
        "vendor": "Acme",
        "version": "1.0.0",
        "source_type": "HTTP_API_POLLING",
        "auth": {"type": "bearer"},
        "streams": [{"id": "events", "name": "Events"}],
        "package_id": "acme",
        "package_kind": "source",
        "pack_version": "1.0.0",
    }
    payload.update(overrides)
    return payload


def _make_tar_gz(files: dict[str, str | bytes], *, mtime: int | None = None) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, content in files.items():
            data = content.encode("utf-8") if isinstance(content, str) else content
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            if mtime is not None:
                info.mtime = mtime
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def _package_files(
    manifest: dict[str, Any],
    *,
    root_dir: str = "acme",
    extra: dict[str, str] | None = None,
) -> dict[str, str]:
    files = {f"{root_dir}/manifest.yaml": yaml.safe_dump(manifest, sort_keys=False)}
    if extra:
        for rel, body in extra.items():
            files[f"{root_dir}/{rel}"] = body
    return files


def _package_archive(
    manifest: dict[str, Any],
    *,
    root_dir: str = "acme",
    extra: dict[str, str] | None = None,
    mtime: int | None = None,
) -> bytes:
    return _make_tar_gz(_package_files(manifest, root_dir=root_dir, extra=extra), mtime=mtime)


def _ed25519_keypair() -> tuple[Ed25519PrivateKey, str]:
    private = Ed25519PrivateKey.generate()
    public_b64 = encode_ed25519_public_key(private.public_key().public_bytes_raw())
    return private, public_b64


def _sign_digest(private: Ed25519PrivateKey, digest: str) -> str:
    sig = private.sign(digest.encode("ascii"))
    return base64.b64encode(sig).decode("ascii")


def _signed_package_archive(
    manifest: dict[str, Any],
    *,
    key_id: str,
    private: Ed25519PrivateKey,
    root_dir: str = "acme",
    extra: dict[str, str] | None = None,
    tamper_after_sign: bool = False,
    signature_suffix: str = "",
) -> bytes:
    """Build archive, compute digest from an unsigned tree, then attach signature.json."""

    files = _package_files(manifest, root_dir=root_dir, extra=extra)
    # Materialize tree to compute canonical digest excluding signature metadata.
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / root_dir
        root.mkdir(parents=True)
        for rel, body in list(files.items()):
            # files keys are like acme/manifest.yaml
            path = Path(tmp) / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(body, encoding="utf-8")
        digest = compute_canonical_package_digest(root)
        sig_meta = {
            "algorithm": "ed25519",
            "key_id": key_id,
            "digest": digest,
            "signature": _sign_digest(private, digest) + signature_suffix,
        }
        files[f"{root_dir}/signature.json"] = json.dumps(sig_meta, indent=2)
        if tamper_after_sign:
            # Change content without updating signature.
            files[f"{root_dir}/manifest.yaml"] = yaml.safe_dump(
                {**manifest, "name": "Tampered Name"},
                sort_keys=False,
            )
    return _make_tar_gz(files)


@pytest.fixture
def builtin_root(tmp_path: Path) -> Path:
    root = tmp_path / "connectors"
    root.mkdir(parents=True, exist_ok=True)
    return root


@pytest.fixture
def installed_root(tmp_path: Path) -> Path:
    root = tmp_path / "plugins"
    root.mkdir(parents=True, exist_ok=True)
    return root


@pytest.fixture
def client(
    db_session: Session, builtin_root: Path, installed_root: Path, monkeypatch: pytest.MonkeyPatch
) -> TestClient:
    monkeypatch.setattr("app.config.settings.GDC_PLUGINS_DIR", str(installed_root))
    monkeypatch.setattr(
        "app.connectors_registry.roots.builtin_connectors_root",
        lambda: builtin_root,
    )
    monkeypatch.setattr(
        "app.connectors_registry.loader.builtin_connectors_root",
        lambda: builtin_root,
    )
    monkeypatch.setattr(
        "app.connectors_registry.lifecycle_service.builtin_connectors_root",
        lambda: builtin_root,
    )
    monkeypatch.setattr(
        "app.connectors_registry.lifecycle_service.installed_plugins_root",
        lambda: installed_root,
    )
    monkeypatch.setattr(
        "app.connectors_registry.lifecycle_publish.installed_plugins_root",
        lambda: installed_root,
    )

    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    clear_registry_cache()
    reload_registry(root=builtin_root, installed_root=installed_root)
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)
        clear_registry_cache()


def _bearer(role: str) -> dict[str, str]:
    token, _ = issue_access_token(username="trust-t", user_id=42, role=role, token_version=1)
    return {"Authorization": f"Bearer {token}"}


def _register_key(db: Session, *, key_id: str, public_b64: str, enabled: bool = True) -> None:
    create_trusted_signing_key(
        db,
        TrustedSigningKeyCreate(
            key_id=key_id,
            name=f"Key {key_id}",
            public_key=public_b64,
            publisher="Acme",
            enabled=enabled,
        ),
    )


# --- Secret scan ---


def test_clean_package_secret_scan_pass(tmp_path: Path) -> None:
    root = tmp_path / "pkg"
    root.mkdir()
    (root / "manifest.yaml").write_text(
        yaml.safe_dump(_base_source()),
        encoding="utf-8",
    )
    assert scan_package_secrets(root) == []
    assert_package_secrets_clean(root)


def test_placeholder_secret_pass(tmp_path: Path) -> None:
    root = tmp_path / "pkg"
    root.mkdir()
    (root / "manifest.yaml").write_text(
        yaml.safe_dump(
            _base_source(
                auth={
                    "type": "api_key",
                    "api_key": "${API_KEY}",
                    "client_secret": "<required>",
                    "credential_ref": "cred://org/acme",
                }
            )
        ),
        encoding="utf-8",
    )
    (root / "docs").mkdir()
    (root / "docs" / "config.md").write_text(
        "Set api_key to ${API_KEY} and client_secret to <required>.\n",
        encoding="utf-8",
    )
    assert scan_package_secrets(root) == []


def test_secret_boolean_metadata_flag_pass(tmp_path: Path) -> None:
    root = tmp_path / "pkg"
    root.mkdir()
    (root / "auth.yaml").write_text(
        yaml.safe_dump(
            {
                "type": "api_key",
                "fields": [
                    {
                        "name": "api_key",
                        "required": True,
                        "secret": True,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    assert scan_package_secrets(root) == []


def test_authorization_env_reference_pass(tmp_path: Path) -> None:
    root = tmp_path / "pkg"
    root.mkdir()
    (root / "manifest.yaml").write_text(
        yaml.safe_dump(
            _base_source(
                headers={"Authorization": "Bearer ${API_TOKEN}"},
            )
        ),
        encoding="utf-8",
    )
    assert scan_package_secrets(root) == []


def test_short_secret_named_value_reject(tmp_path: Path) -> None:
    root = tmp_path / "pkg"
    root.mkdir()
    (root / "manifest.yaml").write_text(
        yaml.safe_dump(_base_source(auth={"type": "basic", "password": "s3cr3t"})),
        encoding="utf-8",
    )
    with pytest.raises(LifecycleError) as exc:
        assert_package_secrets_clean(root)
    assert exc.value.error_code == "PACKAGE_SECRET_DETECTED"
    assert "s3cr3t" not in json.dumps(exc.value.details)


def test_camel_case_secret_field_reject(tmp_path: Path) -> None:
    root = tmp_path / "pkg"
    root.mkdir()
    (root / "manifest.yaml").write_text(
        yaml.safe_dump(_base_source(auth={"type": "oauth2", "clientSecret": "abc123"})),
        encoding="utf-8",
    )
    with pytest.raises(LifecycleError) as exc:
        assert_package_secrets_clean(root)
    assert exc.value.error_code == "PACKAGE_SECRET_DETECTED"
    assert "abc123" not in json.dumps(exc.value.details)


def test_text_code_file_secret_reject(tmp_path: Path) -> None:
    root = tmp_path / "pkg"
    root.mkdir()
    (root / "manifest.yaml").write_text(yaml.safe_dump(_base_source()), encoding="utf-8")
    (root / "helper.py").write_text('api_key = "literal-short-key"\n', encoding="utf-8")
    with pytest.raises(LifecycleError) as exc:
        assert_package_secrets_clean(root)
    assert exc.value.error_code == "PACKAGE_SECRET_DETECTED"
    assert "literal-short-key" not in json.dumps(exc.value.details)


def test_literal_api_key_reject(tmp_path: Path) -> None:
    root = tmp_path / "pkg"
    root.mkdir()
    (root / "manifest.yaml").write_text(
        yaml.safe_dump(_base_source(auth={"type": "api_key", "api_key": "sk-live-abcdefghijklmnopqrstuvwxyz"})),
        encoding="utf-8",
    )
    findings = scan_package_secrets(root)
    assert findings
    assert all("sk-live" not in f.file and "sk-live" not in f.rule for f in findings)
    with pytest.raises(LifecycleError) as exc:
        assert_package_secrets_clean(root)
    assert exc.value.error_code == "PACKAGE_SECRET_DETECTED"
    dumped = json.dumps(exc.value.details)
    assert "sk-live" not in dumped


def test_literal_bearer_token_reject(tmp_path: Path) -> None:
    root = tmp_path / "pkg"
    root.mkdir()
    (root / "streams").mkdir()
    (root / "streams" / "events.yaml").write_text(
        "headers:\n  authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb\n",
        encoding="utf-8",
    )
    (root / "manifest.yaml").write_text(yaml.safe_dump(_base_source()), encoding="utf-8")
    with pytest.raises(LifecycleError) as exc:
        assert_package_secrets_clean(root)
    assert exc.value.error_code == "PACKAGE_SECRET_DETECTED"
    assert "eyJhbGciOi" not in json.dumps(exc.value.details)


def test_oauth_client_secret_reject(tmp_path: Path) -> None:
    root = tmp_path / "pkg"
    root.mkdir()
    (root / "manifest.yaml").write_text(
        yaml.safe_dump(
            _base_source(auth={"type": "oauth2", "client_secret": "super-secret-oauth-client-value"})
        ),
        encoding="utf-8",
    )
    with pytest.raises(LifecycleError) as exc:
        assert_package_secrets_clean(root)
    assert exc.value.error_code == "PACKAGE_SECRET_DETECTED"
    assert "super-secret-oauth" not in json.dumps(exc.value.details)


def test_private_key_material_reject(tmp_path: Path) -> None:
    root = tmp_path / "pkg"
    root.mkdir()
    (root / "manifest.yaml").write_text(yaml.safe_dump(_base_source()), encoding="utf-8")
    (root / "keys.pem").write_text(
        "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC0\n-----END PRIVATE KEY-----\n",
        encoding="utf-8",
    )
    with pytest.raises(LifecycleError) as exc:
        assert_package_secrets_clean(root)
    assert exc.value.error_code == "PACKAGE_SECRET_DETECTED"
    assert "MIIEvQIBADANBg" not in json.dumps(exc.value.details)


def test_secret_value_not_exposed_in_error(tmp_path: Path) -> None:
    secret = "n9f8a7e6d5c4b3a2s1d0f9e8d7c6b5a4"
    root = tmp_path / "pkg"
    root.mkdir()
    (root / "manifest.yaml").write_text(
        yaml.safe_dump(_base_source(auth={"type": "api_key", "api_key": secret})),
        encoding="utf-8",
    )
    with pytest.raises(LifecycleError) as exc:
        assert_package_secrets_clean(root)
    blob = json.dumps({"message": exc.value.message, "details": exc.value.details})
    assert secret not in blob
    for finding in exc.value.details["findings"]:
        assert set(finding.keys()) == {"file", "rule", "severity"}


def test_staging_rejects_literal_secret(tmp_path: Path) -> None:
    archive = _package_archive(
        _base_source(auth={"type": "api_key", "api_key": "literal-api-key-value-here"})
    )
    with pytest.raises(LifecycleError) as exc:
        stage_archive_bytes(archive, staging_parent=tmp_path)
    assert exc.value.error_code == "PACKAGE_SECRET_DETECTED"


# --- Canonical digest ---


def test_deterministic_digest(tmp_path: Path) -> None:
    root = tmp_path / "pkg"
    root.mkdir()
    (root / "manifest.yaml").write_text(yaml.safe_dump(_base_source()), encoding="utf-8")
    (root / "docs").mkdir()
    (root / "docs" / "readme.md").write_text("hello\n", encoding="utf-8")
    a = compute_canonical_package_digest(root)
    b = compute_canonical_package_digest(root)
    assert a == b
    assert len(a) == 64


def test_repack_same_content_same_digest(tmp_path: Path) -> None:
    manifest = _base_source()
    a = _package_archive(manifest, mtime=1_700_000_000)
    b = _package_archive(manifest, mtime=1_800_000_000)
    assert a != b  # archive bytes differ due to mtime
    staged_a = stage_archive_bytes(a, staging_parent=tmp_path / "a")
    staged_b = stage_archive_bytes(b, staging_parent=tmp_path / "b")
    assert staged_a.digest == staged_b.digest


def test_signature_metadata_excluded_from_digest(tmp_path: Path) -> None:
    root = tmp_path / "pkg"
    root.mkdir()
    (root / "manifest.yaml").write_text(yaml.safe_dump(_base_source()), encoding="utf-8")
    before = compute_canonical_package_digest(root)
    (root / "signature.json").write_text(
        json.dumps({"algorithm": "ed25519", "key_id": "k", "digest": before, "signature": "x"}),
        encoding="utf-8",
    )
    after = compute_canonical_package_digest(root)
    assert before == after


# --- Signature verification ---


def test_multiple_signature_metadata_files_reject(tmp_path: Path) -> None:
    archive = _package_archive(
        _base_source(),
        extra={
            "signature.json": "{}",
            "signature.yaml": "{}",
        },
    )
    with pytest.raises(LifecycleError) as exc:
        stage_archive_bytes(archive, staging_parent=tmp_path)
    assert exc.value.error_code == "SIGNATURE_INVALID"


def test_strict_base64_rejects_invalid_public_key_suffix() -> None:
    _private, public_b64 = _ed25519_keypair()
    with pytest.raises(ValueError):
        decode_ed25519_public_key(public_b64 + "!")


def test_invalid_base64_signature_reject(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    private, public_b64 = _ed25519_keypair()
    _register_key(db_session, key_id="acme-1", public_b64=public_b64)
    archive = _signed_package_archive(
        _base_source(),
        key_id="acme-1",
        private=private,
        signature_suffix="!",
    )
    with pytest.raises(LifecycleError) as exc:
        install_package(
            db_session,
            archive,
            builtin_root=builtin_root,
            installed_root=installed_root,
            actor_role=ROLE_ADMINISTRATOR,
        )
    assert exc.value.error_code == "PACKAGE_SIGNATURE_INVALID"


def test_signed_package_valid(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    private, public_b64 = _ed25519_keypair()
    _register_key(db_session, key_id="acme-1", public_b64=public_b64)
    archive = _signed_package_archive(_base_source(), key_id="acme-1", private=private)
    row = install_package(
        db_session,
        archive,
        builtin_root=builtin_root,
        installed_root=installed_root,
        actor_role=ROLE_OPERATOR,
    )
    assert row.signature_status == SIGNATURE_STATUS_VALID
    assert row.signing_key_id == "acme-1"


def test_tampered_package_invalid_signature(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    private, public_b64 = _ed25519_keypair()
    _register_key(db_session, key_id="acme-1", public_b64=public_b64)
    archive = _signed_package_archive(
        _base_source(),
        key_id="acme-1",
        private=private,
        tamper_after_sign=True,
    )
    with pytest.raises(LifecycleError) as exc:
        install_package(
            db_session,
            archive,
            builtin_root=builtin_root,
            installed_root=installed_root,
            actor_role=ROLE_ADMINISTRATOR,
        )
    assert exc.value.error_code == "PACKAGE_SIGNATURE_INVALID"
    assert exc.value.details["signature_status"] == SIGNATURE_STATUS_INVALID_SIGNATURE


def test_unknown_key_reject(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    private, _public = _ed25519_keypair()
    archive = _signed_package_archive(_base_source(), key_id="missing-key", private=private)
    with pytest.raises(LifecycleError) as exc:
        install_package(
            db_session,
            archive,
            builtin_root=builtin_root,
            installed_root=installed_root,
            actor_role=ROLE_ADMINISTRATOR,
        )
    assert exc.value.error_code == "PACKAGE_SIGNATURE_UNKNOWN_KEY"
    assert exc.value.details["signature_status"] == SIGNATURE_STATUS_UNKNOWN_KEY


def test_disabled_key_reject(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    private, public_b64 = _ed25519_keypair()
    _register_key(db_session, key_id="acme-1", public_b64=public_b64, enabled=False)
    archive = _signed_package_archive(_base_source(), key_id="acme-1", private=private)
    with pytest.raises(LifecycleError) as exc:
        install_package(
            db_session,
            archive,
            builtin_root=builtin_root,
            installed_root=installed_root,
            actor_role=ROLE_ADMINISTRATOR,
        )
    assert exc.value.error_code == "PACKAGE_SIGNATURE_DISABLED_KEY"
    assert exc.value.details["signature_status"] == SIGNATURE_STATUS_DISABLED_KEY


def test_unsigned_administrator_install_pass(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    row = install_package(
        db_session,
        _package_archive(_base_source()),
        builtin_root=builtin_root,
        installed_root=installed_root,
        actor_role=ROLE_ADMINISTRATOR,
    )
    assert row.signature_status == SIGNATURE_STATUS_UNSIGNED
    assert row.signing_key_id is None


def test_unsigned_operator_install_reject(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    with pytest.raises(LifecycleError) as exc:
        install_package(
            db_session,
            _package_archive(_base_source()),
            builtin_root=builtin_root,
            installed_root=installed_root,
            actor_role=ROLE_OPERATOR,
        )
    assert exc.value.error_code == "UNSIGNED_PACKAGE_FORBIDDEN"


def test_invalid_signature_administrator_reject(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    private, public_b64 = _ed25519_keypair()
    _register_key(db_session, key_id="acme-1", public_b64=public_b64)
    archive = _signed_package_archive(
        _base_source(),
        key_id="acme-1",
        private=private,
        tamper_after_sign=True,
    )
    with pytest.raises(LifecycleError) as exc:
        install_package(
            db_session,
            archive,
            builtin_root=builtin_root,
            installed_root=installed_root,
            actor_role=ROLE_ADMINISTRATOR,
        )
    assert exc.value.error_code == "PACKAGE_SIGNATURE_INVALID"


def test_signature_result_platform_derived_not_manifest(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    row = install_package(
        db_session,
        _package_archive(
            _base_source(
                signature_status="VALID",
                signing_key_id="spoofed",
                trust_tier="Official",
                digest="deadbeef",
            )
        ),
        builtin_root=builtin_root,
        installed_root=installed_root,
        actor_role=ROLE_ADMINISTRATOR,
    )
    assert row.signature_status == SIGNATURE_STATUS_UNSIGNED
    assert row.signing_key_id is None
    assert row.digest != "deadbeef"
    detail = get_connector_manifest("acme")
    assert detail is not None
    # Trust tier is not auto-promoted from signature or manifest spoof.
    assert getattr(detail.resolved, "trust_tier", None) in (None, "", "Local Draft", "Imported")


def test_manifest_signature_trust_spoof_ignored(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    private, public_b64 = _ed25519_keypair()
    _register_key(db_session, key_id="acme-1", public_b64=public_b64)
    archive = _signed_package_archive(
        _base_source(signature_status="INVALID_SIGNATURE", trust_tier="Official"),
        key_id="acme-1",
        private=private,
    )
    row = install_package(
        db_session,
        archive,
        builtin_root=builtin_root,
        installed_root=installed_root,
        actor_role=ROLE_OPERATOR,
    )
    assert row.signature_status == SIGNATURE_STATUS_VALID
    assert row.signing_key_id == "acme-1"


# --- Trusted key API / RBAC ---


def test_trusted_key_administrator_crud(client: TestClient, db_session: Session) -> None:
    _private, public_b64 = _ed25519_keypair()
    headers = _bearer(ROLE_ADMINISTRATOR)
    created = client.post(
        "/api/v1/connectors-registry/trusted-signing-keys",
        headers=headers,
        json={
            "key_id": "ops-1",
            "name": "Ops Key",
            "public_key": public_b64,
            "publisher": "Ops",
            "enabled": True,
        },
    )
    assert created.status_code == 201, created.text
    listed = client.get("/api/v1/connectors-registry/trusted-signing-keys", headers=headers)
    assert listed.status_code == 200
    assert listed.json()["count"] >= 1
    patched = client.patch(
        "/api/v1/connectors-registry/trusted-signing-keys/ops-1",
        headers=headers,
        json={"enabled": False},
    )
    assert patched.status_code == 200
    assert patched.json()["enabled"] is False
    deleted = client.delete(
        "/api/v1/connectors-registry/trusted-signing-keys/ops-1",
        headers=headers,
    )
    assert deleted.status_code == 200
    assert db_session.query(MarketplaceTrustedSigningKey).filter_by(key_id="ops-1").count() == 0


def test_operator_trusted_key_write_reject(client: TestClient) -> None:
    _private, public_b64 = _ed25519_keypair()
    r = client.post(
        "/api/v1/connectors-registry/trusted-signing-keys",
        headers=_bearer(ROLE_OPERATOR),
        json={"key_id": "x", "name": "X", "public_key": public_b64},
    )
    assert r.status_code == 403


def test_viewer_lifecycle_reject(client: TestClient) -> None:
    archive = _package_archive(_base_source())
    r = client.post(
        "/api/v1/connectors-registry/packages/install",
        headers=_bearer(ROLE_VIEWER),
        files={"file": ("acme.tar.gz", archive, "application/gzip")},
    )
    assert r.status_code == 403


def test_operator_signed_package_lifecycle(
    db_session: Session, builtin_root: Path, installed_root: Path, client: TestClient
) -> None:
    private, public_b64 = _ed25519_keypair()
    _register_key(db_session, key_id="acme-1", public_b64=public_b64)
    archive = _signed_package_archive(_base_source(), key_id="acme-1", private=private)
    r = client.post(
        "/api/v1/connectors-registry/packages/install",
        headers=_bearer(ROLE_OPERATOR),
        files={"file": ("acme.tar.gz", archive, "application/gzip")},
    )
    assert r.status_code == 201, r.text
    assert r.json()["signature_status"] == SIGNATURE_STATUS_VALID


def test_operator_unsigned_http_install_reject(client: TestClient) -> None:
    archive = _package_archive(_base_source())
    r = client.post(
        "/api/v1/connectors-registry/packages/install",
        headers=_bearer(ROLE_OPERATOR),
        files={"file": ("acme.tar.gz", archive, "application/gzip")},
    )
    assert r.status_code == 403
    assert r.json()["detail"]["error_code"] == "UNSIGNED_PACKAGE_FORBIDDEN"


def test_trusted_key_private_material_rejected(db_session: Session) -> None:
    with pytest.raises(LifecycleError) as exc:
        create_trusted_signing_key(
            db_session,
            TrustedSigningKeyCreate(
                key_id="bad",
                name="Bad",
                public_key="-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
            ),
        )
    assert exc.value.error_code == "TRUSTED_KEY_PRIVATE_FORBIDDEN"


# --- Lifecycle regressions with signature ---


def test_existing_install_regression_unsigned_admin(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    row = install_package(
        db_session,
        _package_archive(_base_source()),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    assert row.package_id == "acme"
    assert (installed_root / "acme" / "manifest.yaml").is_file()
    assert get_connector_manifest("acme") is not None


def test_upgrade_signature_validation(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    private, public_b64 = _ed25519_keypair()
    _register_key(db_session, key_id="acme-1", public_b64=public_b64)
    install_package(
        db_session,
        _signed_package_archive(_base_source(), key_id="acme-1", private=private),
        builtin_root=builtin_root,
        installed_root=installed_root,
        actor_role=ROLE_OPERATOR,
    )
    row = upgrade_package(
        db_session,
        "acme",
        _signed_package_archive(
            _base_source(version="1.1.0", pack_version="1.1.0", name="Acme v2"),
            key_id="acme-1",
            private=private,
        ),
        builtin_root=builtin_root,
        installed_root=installed_root,
        actor_role=ROLE_OPERATOR,
    )
    assert row.pack_version == "1.1.0"
    assert row.signature_status == SIGNATURE_STATUS_VALID
    assert row.previous_version == "1.0.0"


def test_failed_signature_upgrade_preserves_current(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    private, public_b64 = _ed25519_keypair()
    _register_key(db_session, key_id="acme-1", public_b64=public_b64)
    install_package(
        db_session,
        _signed_package_archive(_base_source(), key_id="acme-1", private=private),
        builtin_root=builtin_root,
        installed_root=installed_root,
        actor_role=ROLE_OPERATOR,
    )
    with pytest.raises(LifecycleError):
        upgrade_package(
            db_session,
            "acme",
            _signed_package_archive(
                _base_source(version="1.1.0", pack_version="1.1.0"),
                key_id="acme-1",
                private=private,
                tamper_after_sign=True,
            ),
            builtin_root=builtin_root,
            installed_root=installed_root,
            actor_role=ROLE_OPERATOR,
        )
    row = db_session.query(MarketplacePackageInstall).filter_by(package_id="acme").one()
    assert row.pack_version == "1.0.0"
    assert row.status == LIFECYCLE_STATUS_INSTALLED
    detail = get_connector_manifest("acme")
    assert detail is not None
    assert detail.resolved.pack_version == "1.0.0"


def test_rollback_and_uninstall_preserved(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    private, public_b64 = _ed25519_keypair()
    _register_key(db_session, key_id="acme-1", public_b64=public_b64)
    install_package(
        db_session,
        _signed_package_archive(_base_source(), key_id="acme-1", private=private),
        builtin_root=builtin_root,
        installed_root=installed_root,
        actor_role=ROLE_OPERATOR,
    )
    upgrade_package(
        db_session,
        "acme",
        _signed_package_archive(
            _base_source(version="1.1.0", pack_version="1.1.0"),
            key_id="acme-1",
            private=private,
        ),
        builtin_root=builtin_root,
        installed_root=installed_root,
        actor_role=ROLE_OPERATOR,
    )
    rolled = rollback_package(
        db_session,
        "acme",
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    assert rolled.pack_version == "1.0.0"
    removed = uninstall_package(
        db_session,
        "acme",
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    assert removed.status == "REMOVED"


def test_rollback_restores_previous_signature_evidence(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    private, public_b64 = _ed25519_keypair()
    _register_key(db_session, key_id="acme-1", public_b64=public_b64)
    installed = install_package(
        db_session,
        _signed_package_archive(_base_source(), key_id="acme-1", private=private),
        builtin_root=builtin_root,
        installed_root=installed_root,
        actor_role=ROLE_OPERATOR,
    )
    assert installed.signature_status == SIGNATURE_STATUS_VALID
    assert installed.signing_key_id == "acme-1"

    upgraded = upgrade_package(
        db_session,
        "acme",
        _package_archive(
            _base_source(version="1.1.0", pack_version="1.1.0", name="Acme unsigned")
        ),
        builtin_root=builtin_root,
        installed_root=installed_root,
        actor_role=ROLE_ADMINISTRATOR,
    )
    assert upgraded.signature_status == SIGNATURE_STATUS_UNSIGNED
    assert upgraded.signing_key_id is None

    rolled = rollback_package(
        db_session,
        "acme",
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    assert rolled.pack_version == "1.0.0"
    assert rolled.signature_status == SIGNATURE_STATUS_VALID
    assert rolled.signing_key_id == "acme-1"


def test_service_key_update_enable_disable(db_session: Session) -> None:
    _private, public_b64 = _ed25519_keypair()
    create_trusted_signing_key(
        db_session,
        TrustedSigningKeyCreate(key_id="k1", name="K1", public_key=public_b64),
    )
    updated = update_trusted_signing_key(
        db_session,
        "k1",
        TrustedSigningKeyUpdate(enabled=False, name="K1-disabled"),
    )
    assert updated.enabled is False
    assert updated.name == "K1-disabled"
    delete_trusted_signing_key(db_session, "k1")


def test_migration_upgrade_downgrade_pkg_trust(
    reset_db_schema: None, test_db_url: str, db_engine: Engine
) -> None:
    root = Path(__file__).resolve().parents[1]
    cfg = Config(str(root / "alembic.ini"))
    cfg.set_main_option("script_location", str(root / "alembic"))
    cfg.set_main_option("sqlalchemy.url", test_db_url)

    command.upgrade(cfg, "head")
    inspector = inspect(db_engine)
    tables = set(inspector.get_table_names())
    assert "marketplace_trusted_signing_keys" in tables
    cols = {c["name"] for c in inspector.get_columns("marketplace_package_installs")}
    assert "signature_status" in cols
    assert "signing_key_id" in cols
    assert "previous_signature_status" in cols
    assert "previous_signing_key_id" in cols
    with db_engine.connect() as conn:
        rev = conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
    assert rev == "20261001_0066"

    command.downgrade(cfg, "20261001_0065")
    inspector = inspect(db_engine)
    assert "marketplace_trusted_signing_keys" not in set(inspector.get_table_names())
    cols = {c["name"] for c in inspector.get_columns("marketplace_package_installs")}
    assert "signature_status" not in cols
    assert "signing_key_id" not in cols
    assert "previous_signature_status" not in cols
    assert "previous_signing_key_id" not in cols

    command.upgrade(cfg, "head")
    with db_engine.connect() as conn:
        rev = conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
    assert rev == "20261001_0066"
