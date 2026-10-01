"""Tests for M29.3 Marketplace local package lifecycle."""

from __future__ import annotations

import asyncio
import io
import tarfile
from pathlib import Path
from typing import Any

import pytest
import yaml
from alembic import command
from alembic.config import Config
from fastapi import Request
from fastapi.testclient import TestClient
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.connectors.models import Connector
from app.connectors_registry.lifecycle_archive import read_upload_bytes, stage_archive_bytes
from app.connectors_registry.lifecycle_errors import LifecycleError
from app.connectors_registry.lifecycle_router import post_install_package
from app.connectors_registry.lifecycle_models import (
    LIFECYCLE_ORIGIN_UPLOAD,
    LIFECYCLE_STATUS_INSTALLED,
    LIFECYCLE_STATUS_REMOVED,
    MarketplacePackageInstall,
)
from app.connectors_registry.lifecycle_service import (
    install_package,
    list_installed_packages,
    rollback_package,
    uninstall_package,
    upgrade_package,
)
from app.connectors_registry.service import (
    clear_registry_cache,
    get_connector_manifest,
    list_connector_summaries,
    reload_registry,
)
from app.database import get_db
from app.main import app
from app.sources.models import Source
from app.streams.models import Stream


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


def _make_tar_gz(files: dict[str, str | bytes]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, content in files.items():
            data = content.encode("utf-8") if isinstance(content, str) else content
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def _package_archive(manifest: dict[str, Any], *, root_dir: str = "acme") -> bytes:
    body = yaml.safe_dump(manifest, sort_keys=False)
    return _make_tar_gz({f"{root_dir}/manifest.yaml": body})


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
def client(db_session: Session, builtin_root: Path, installed_root: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
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


def test_valid_package_install(db_session: Session, builtin_root: Path, installed_root: Path) -> None:
    archive = _package_archive(_base_source())
    row = install_package(
        db_session,
        archive,
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    assert row.package_id == "acme"
    assert row.pack_version == "1.0.0"
    assert row.status == LIFECYCLE_STATUS_INSTALLED
    assert row.origin == LIFECYCLE_ORIGIN_UPLOAD
    assert (installed_root / "acme" / "manifest.yaml").is_file()


def test_installed_package_registry_discovery(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    install_package(
        db_session,
        _package_archive(_base_source()),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    detail = get_connector_manifest("acme")
    assert detail is not None
    assert detail.resolved.package_id == "acme"
    assert detail.resolved.installed_from == "installed"


def test_lifecycle_db_record(db_session: Session, builtin_root: Path, installed_root: Path) -> None:
    install_package(
        db_session,
        _package_archive(_base_source()),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    row = db_session.query(MarketplacePackageInstall).filter_by(package_id="acme").one()
    assert row.digest
    assert row.installed_path
    assert list_installed_packages(db_session).count == 1


def test_platform_derived_upload_origin(db_session: Session, builtin_root: Path, installed_root: Path) -> None:
    row = install_package(
        db_session,
        _package_archive(_base_source(installed_from="git", origin="registry")),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    assert row.origin == LIFECYCLE_ORIGIN_UPLOAD


def test_manifest_origin_spoof_ignored(db_session: Session, builtin_root: Path, installed_root: Path) -> None:
    row = install_package(
        db_session,
        _package_archive(_base_source(installed_from="builtin", origin="git", trust_tier="Official")),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    assert row.origin == LIFECYCLE_ORIGIN_UPLOAD
    detail = get_connector_manifest("acme")
    assert detail is not None
    assert detail.resolved.installed_from == "installed"


def test_malformed_archive_reject(tmp_path: Path) -> None:
    with pytest.raises(LifecycleError) as exc:
        stage_archive_bytes(b"not-a-tar-gz", staging_parent=tmp_path)
    assert exc.value.error_code == "ARCHIVE_MALFORMED"


def test_traversal_reject(tmp_path: Path) -> None:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        info = tarfile.TarInfo(name="../escape/manifest.yaml")
        data = b"id: x\n"
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    with pytest.raises(LifecycleError) as exc:
        stage_archive_bytes(buf.getvalue(), staging_parent=tmp_path)
    assert exc.value.error_code == "ARCHIVE_PATH_TRAVERSAL"


def test_absolute_path_reject(tmp_path: Path) -> None:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        info = tarfile.TarInfo(name="/tmp/evil/manifest.yaml")
        data = b"id: x\n"
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    with pytest.raises(LifecycleError) as exc:
        stage_archive_bytes(buf.getvalue(), staging_parent=tmp_path)
    assert exc.value.error_code == "ARCHIVE_ABSOLUTE_PATH"


def test_symlink_hardlink_escape_reject(tmp_path: Path) -> None:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        link = tarfile.TarInfo(name="link_out")
        link.type = tarfile.SYMTYPE
        link.linkname = "/etc/passwd"
        tar.addfile(link)
    with pytest.raises(LifecycleError) as exc:
        stage_archive_bytes(buf.getvalue(), staging_parent=tmp_path)
    assert exc.value.error_code == "ARCHIVE_LINK_ESCAPE"

    buf2 = io.BytesIO()
    with tarfile.open(fileobj=buf2, mode="w:gz") as tar:
        hard = tarfile.TarInfo(name="hard_out")
        hard.type = tarfile.LNKTYPE
        hard.linkname = "other"
        tar.addfile(hard)
    with pytest.raises(LifecycleError) as exc2:
        stage_archive_bytes(buf2.getvalue(), staging_parent=tmp_path)
    assert exc2.value.error_code == "ARCHIVE_LINK_ESCAPE"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("schema_ref", "../outside-auth.json"),
        ("template", "../outside-stream.yaml"),
        ("default_mapping", "../outside-mapping.json"),
        ("default_enrichment", "/tmp/outside-enrichment.json"),
    ],
)
def test_manifest_resource_escape_rejects_before_publish(
    tmp_path: Path, field: str, value: str
) -> None:
    manifest = _base_source()
    if field == "schema_ref":
        manifest["auth"] = {"type": "bearer", "schema_ref": value}
    else:
        manifest["streams"] = [{"id": "events", "name": "Events", field: value}]
    archive = _make_tar_gz(
        {
            "acme/manifest.yaml": yaml.safe_dump(manifest, sort_keys=False),
            "outside-auth.json": '{}',
            "outside-stream.yaml": "stream_id: events\nname: Outside\nsource_path: /events\n",
            "outside-mapping.json": '{}',
        }
    )
    with pytest.raises(LifecycleError) as exc:
        stage_archive_bytes(archive, staging_parent=tmp_path)
    assert exc.value.error_code == "MANIFEST_RESOURCE_ESCAPE"


def test_bounded_upload_reader_rejects_over_limit() -> None:
    with pytest.raises(LifecycleError) as exc:
        read_upload_bytes(io.BytesIO(b"12345"), max_bytes=4)
    assert exc.value.error_code == "ARCHIVE_TOO_LARGE"


def test_http_install_uses_spooled_file_not_unbounded_upload_read(
    client: TestClient, db_session: Session
) -> None:
    archive = _package_archive(
        _base_source(id="spooled", package_id="spooled"), root_dir="spooled"
    )

    class FakeUpload:
        filename = "spooled.tar.gz"

        def __init__(self) -> None:
            self.file = io.BytesIO(archive)

        async def seek(self, offset: int) -> None:
            self.file.seek(offset)

        async def read(self, *_args: Any, **_kwargs: Any) -> bytes:
            raise AssertionError("route must not call unbounded UploadFile.read()")

    request = Request({
        "type": "http",
        "method": "POST",
        "path": "/api/v1/connectors-registry/packages/install",
        "headers": [],
    })
    row = asyncio.run(
        post_install_package(request, FakeUpload(), db_session)  # type: ignore[arg-type]
    )
    assert row.package_id == "spooled"


def test_missing_manifest_reject(tmp_path: Path) -> None:
    archive = _make_tar_gz({"acme/readme.txt": "no manifest"})
    with pytest.raises(LifecycleError) as exc:
        stage_archive_bytes(archive, staging_parent=tmp_path)
    assert exc.value.error_code == "MANIFEST_MISSING"


def test_failed_install_leaves_no_partial(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    clear_registry_cache()
    reload_registry(root=builtin_root, installed_root=installed_root)
    with pytest.raises(LifecycleError):
        install_package(
            db_session,
            _make_tar_gz({"acme/readme.txt": "nope"}),
            builtin_root=builtin_root,
            installed_root=installed_root,
        )
    assert not (installed_root / "acme").exists()
    assert db_session.query(MarketplacePackageInstall).count() == 0
    clear_registry_cache()
    reload_registry(root=builtin_root, installed_root=installed_root)
    assert get_connector_manifest("acme") is None
    assert "acme" not in {s.id for s in list_connector_summaries()}


def test_duplicate_package_id_install_reject(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    install_package(
        db_session,
        _package_archive(_base_source()),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    with pytest.raises(LifecycleError) as exc:
        install_package(
            db_session,
            _package_archive(_base_source(version="1.0.1", pack_version="1.0.1")),
            builtin_root=builtin_root,
            installed_root=installed_root,
        )
    assert exc.value.error_code == "PACKAGE_ALREADY_INSTALLED"


def test_builtin_shadow_install_reject(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    (builtin_root / "crowdstrike").mkdir()
    (builtin_root / "crowdstrike" / "manifest.yaml").write_text(
        yaml.safe_dump(_base_source(id="crowdstrike", package_id="crowdstrike")),
        encoding="utf-8",
    )
    with pytest.raises(LifecycleError) as exc:
        install_package(
            db_session,
            _package_archive(_base_source(id="crowdstrike", package_id="crowdstrike"), root_dir="crowdstrike"),
            builtin_root=builtin_root,
            installed_root=installed_root,
        )
    assert exc.value.error_code == "BUILTIN_SHADOW_FORBIDDEN"


def test_connector_id_collision_rejects_unique_package_id(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    existing_dir = builtin_root / "builtin-pkg"
    existing_dir.mkdir()
    (existing_dir / "manifest.yaml").write_text(
        yaml.safe_dump(
            _base_source(id="shared-id", package_id="builtin-pkg"),
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    clear_registry_cache()
    reload_registry(root=builtin_root, installed_root=installed_root)

    with pytest.raises(LifecycleError) as exc:
        install_package(
            db_session,
            _package_archive(
                _base_source(id="shared-id", package_id="unique-package"),
                root_dir="unique-package",
            ),
            builtin_root=builtin_root,
            installed_root=installed_root,
        )
    assert exc.value.error_code == "CONNECTOR_ID_COLLISION"
    assert not (installed_root / "unique-package").exists()


def test_valid_upgrade(db_session: Session, builtin_root: Path, installed_root: Path) -> None:
    install_package(
        db_session,
        _package_archive(_base_source()),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    row = upgrade_package(
        db_session,
        "acme",
        _package_archive(_base_source(version="1.1.0", pack_version="1.1.0", name="Acme v2")),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    assert row.pack_version == "1.1.0"
    assert row.previous_version == "1.0.0"
    assert row.previous_digest
    detail = get_connector_manifest("acme")
    assert detail is not None
    assert detail.resolved.pack_version == "1.1.0"
    assert detail.resolved.name == "Acme v2"


def test_upgrade_rejects_reverse_dependency_version_break(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    install_package(
        db_session,
        _package_archive(_base_source()),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    install_package(
        db_session,
        _package_archive(
            _base_source(
                id="ext",
                package_id="ext",
                package_kind="stream_extension",
                requires={"package_id": "acme", "version": ">=1.0.0 <2.0.0"},
            ),
            root_dir="ext",
        ),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )

    with pytest.raises(LifecycleError) as exc:
        upgrade_package(
            db_session,
            "acme",
            _package_archive(_base_source(version="2.0.0", pack_version="2.0.0")),
            builtin_root=builtin_root,
            installed_root=installed_root,
        )
    assert exc.value.error_code == "DEPENDENCY_VERSION_MISMATCH"
    active = yaml.safe_load((installed_root / "acme" / "manifest.yaml").read_text(encoding="utf-8"))
    assert active["pack_version"] == "1.0.0"


def test_wrong_package_id_upgrade_reject(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    install_package(
        db_session,
        _package_archive(_base_source()),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    with pytest.raises(LifecycleError) as exc:
        upgrade_package(
            db_session,
            "acme",
            _package_archive(_base_source(id="other", package_id="other"), root_dir="other"),
            builtin_root=builtin_root,
            installed_root=installed_root,
        )
    assert exc.value.error_code == "PACKAGE_ID_MISMATCH"


def test_same_version_upgrade_reject(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    install_package(
        db_session,
        _package_archive(_base_source()),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    with pytest.raises(LifecycleError) as exc:
        upgrade_package(
            db_session,
            "acme",
            _package_archive(_base_source()),
            builtin_root=builtin_root,
            installed_root=installed_root,
        )
    assert exc.value.error_code == "SAME_VERSION"


def test_failed_upgrade_preserves_previous(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    install_package(
        db_session,
        _package_archive(_base_source()),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    with pytest.raises(LifecycleError):
        upgrade_package(
            db_session,
            "acme",
            _make_tar_gz({"acme/readme.txt": "broken"}),
            builtin_root=builtin_root,
            installed_root=installed_root,
        )
    row = db_session.query(MarketplacePackageInstall).filter_by(package_id="acme").one()
    assert row.pack_version == "1.0.0"
    assert row.status == LIFECYCLE_STATUS_INSTALLED
    detail = get_connector_manifest("acme")
    assert detail is not None
    assert detail.resolved.pack_version == "1.0.0"


def test_upgrade_commit_failure_restores_previous_filesystem(
    db_session: Session, builtin_root: Path, installed_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_package(
        db_session, _package_archive(_base_source()),
        builtin_root=builtin_root, installed_root=installed_root,
    )
    monkeypatch.setattr(db_session, "commit", lambda: (_ for _ in ()).throw(RuntimeError("commit failed")))
    with pytest.raises(LifecycleError) as exc:
        upgrade_package(
            db_session, "acme",
            _package_archive(_base_source(version="2.0.0", pack_version="2.0.0")),
            builtin_root=builtin_root, installed_root=installed_root,
        )
    assert exc.value.error_code == "UPGRADE_FAILED"
    active = yaml.safe_load((installed_root / "acme" / "manifest.yaml").read_text(encoding="utf-8"))
    assert active["pack_version"] == "1.0.0"


def test_rollback_restores_previous(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    install_package(
        db_session,
        _package_archive(_base_source()),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    upgrade_package(
        db_session,
        "acme",
        _package_archive(_base_source(version="2.0.0", pack_version="2.0.0", name="Acme Two")),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    row = rollback_package(
        db_session,
        "acme",
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    assert row.pack_version == "1.0.0"
    assert row.previous_version is None
    detail = get_connector_manifest("acme")
    assert detail is not None
    assert detail.resolved.pack_version == "1.0.0"
    assert detail.resolved.name == "Acme API"


def test_rollback_does_not_touch_checkpoint(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    install_package(
        db_session,
        _package_archive(_base_source()),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    connector = Connector(name="c1", status="STOPPED")
    db_session.add(connector)
    db_session.flush()
    source = Source(connector_id=connector.id, source_type="HTTP_API_POLLING", config_json={}, auth_json={})
    db_session.add(source)
    db_session.flush()
    stream = Stream(
        connector_id=connector.id,
        source_id=source.id,
        name="s1",
        stream_type="HTTP_API_POLLING",
        config_json={"cursor": "keep-me"},
        enabled=True,
        status="RUNNING",
    )
    db_session.add(stream)
    db_session.flush()
    checkpoint = Checkpoint(
        stream_id=stream.id,
        checkpoint_type="CUSTOM_FIELD",
        checkpoint_value_json={"value": "abc"},
    )
    db_session.add(checkpoint)
    db_session.commit()

    upgrade_package(
        db_session,
        "acme",
        _package_archive(_base_source(version="2.0.0", pack_version="2.0.0")),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    rollback_package(
        db_session,
        "acme",
        builtin_root=builtin_root,
        installed_root=installed_root,
    )

    db_session.refresh(checkpoint)
    db_session.refresh(stream)
    assert checkpoint.checkpoint_value_json == {"value": "abc"}
    assert stream.config_json == {"cursor": "keep-me"}
    assert stream.enabled is True
    assert stream.status == "RUNNING"


def test_rollback_commit_failure_restores_current_filesystem(
    db_session: Session, builtin_root: Path, installed_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_package(
        db_session, _package_archive(_base_source()),
        builtin_root=builtin_root, installed_root=installed_root,
    )
    upgrade_package(
        db_session, "acme",
        _package_archive(_base_source(version="2.0.0", pack_version="2.0.0")),
        builtin_root=builtin_root, installed_root=installed_root,
    )
    monkeypatch.setattr(db_session, "commit", lambda: (_ for _ in ()).throw(RuntimeError("commit failed")))
    with pytest.raises(LifecycleError) as exc:
        rollback_package(
            db_session, "acme", builtin_root=builtin_root, installed_root=installed_root
        )
    assert exc.value.error_code == "ROLLBACK_FAILED"
    active = yaml.safe_load((installed_root / "acme" / "manifest.yaml").read_text(encoding="utf-8"))
    assert active["pack_version"] == "2.0.0"


def test_rollback_without_previous_reject(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    install_package(
        db_session,
        _package_archive(_base_source()),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    with pytest.raises(LifecycleError) as exc:
        rollback_package(
            db_session,
            "acme",
            builtin_root=builtin_root,
            installed_root=installed_root,
        )
    assert exc.value.error_code == "ROLLBACK_UNAVAILABLE"


def test_uninstall_installed_package(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    install_package(
        db_session,
        _package_archive(_base_source()),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    row = uninstall_package(
        db_session,
        "acme",
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    assert row.status == LIFECYCLE_STATUS_REMOVED
    assert not (installed_root / "acme").exists()
    assert get_connector_manifest("acme") is None


def test_uninstall_commit_failure_restores_active_package(
    db_session: Session, builtin_root: Path, installed_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_package(
        db_session, _package_archive(_base_source()),
        builtin_root=builtin_root, installed_root=installed_root,
    )
    monkeypatch.setattr(db_session, "commit", lambda: (_ for _ in ()).throw(RuntimeError("commit failed")))
    with pytest.raises(LifecycleError) as exc:
        uninstall_package(
            db_session, "acme", builtin_root=builtin_root, installed_root=installed_root
        )
    assert exc.value.error_code == "UNINSTALL_FAILED"
    assert (installed_root / "acme" / "manifest.yaml").is_file()
    active = yaml.safe_load((installed_root / "acme" / "manifest.yaml").read_text(encoding="utf-8"))
    assert active["pack_version"] == "1.0.0"


def test_builtin_uninstall_reject(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    (builtin_root / "crowdstrike").mkdir()
    with pytest.raises(LifecycleError) as exc:
        uninstall_package(
            db_session,
            "crowdstrike",
            builtin_root=builtin_root,
            installed_root=installed_root,
        )
    assert exc.value.error_code == "BUILTIN_UNINSTALL_FORBIDDEN"


def test_dependency_protected_uninstall(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    install_package(
        db_session,
        _package_archive(_base_source()),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    connector = Connector(name="c1", status="STOPPED")
    db_session.add(connector)
    db_session.flush()
    source = Source(connector_id=connector.id, source_type="HTTP_API_POLLING", config_json={}, auth_json={})
    db_session.add(source)
    db_session.flush()
    stream = Stream(
        connector_id=connector.id,
        source_id=source.id,
        name="s1",
        stream_type="HTTP_API_POLLING",
        config_json={
            "marketplace_provenance": {"package_id": "acme", "pack_version": "1.0.0"},
        },
        enabled=False,
        status="STOPPED",
    )
    db_session.add(stream)
    db_session.commit()

    with pytest.raises(LifecycleError) as exc:
        uninstall_package(
            db_session,
            "acme",
            builtin_root=builtin_root,
            installed_root=installed_root,
        )
    assert exc.value.error_code == "DEPENDENCY_PROTECTED"


def test_stream_extension_valid_dependency(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    (builtin_root / "cybereason").mkdir()
    (builtin_root / "cybereason" / "manifest.yaml").write_text(
        yaml.safe_dump(_base_source(id="cybereason", package_id="cybereason", version="1.2.0", pack_version="1.2.0")),
        encoding="utf-8",
    )
    clear_registry_cache()
    reload_registry(root=builtin_root, installed_root=installed_root)

    row = install_package(
        db_session,
        _package_archive(
            _base_source(
                id="cybereason_hunting",
                package_id="cybereason_hunting",
                name="Hunting",
                package_kind="stream_extension",
                version="1.0.0",
                pack_version="1.0.0",
                requires={"package_id": "cybereason", "version": ">=1.0.0 <2.0.0"},
            ),
            root_dir="cybereason_hunting",
        ),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    assert row.package_kind == "stream_extension"
    assert row.status == LIFECYCLE_STATUS_INSTALLED


def test_stream_extension_missing_dependency_reject(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    with pytest.raises(LifecycleError) as exc:
        install_package(
            db_session,
            _package_archive(
                _base_source(
                    id="ext",
                    package_id="ext",
                    package_kind="stream_extension",
                    requires={"package_id": "missing_base", "version": ">=1.0.0"},
                ),
                root_dir="ext",
            ),
            builtin_root=builtin_root,
            installed_root=installed_root,
        )
    assert exc.value.error_code == "DEPENDENCY_MISSING"
    assert not (installed_root / "ext").exists()


def test_stream_extension_version_mismatch_reject(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    (builtin_root / "cybereason").mkdir()
    (builtin_root / "cybereason" / "manifest.yaml").write_text(
        yaml.safe_dump(_base_source(id="cybereason", package_id="cybereason", version="2.0.0", pack_version="2.0.0")),
        encoding="utf-8",
    )
    with pytest.raises(LifecycleError) as exc:
        install_package(
            db_session,
            _package_archive(
                _base_source(
                    id="ext",
                    package_id="ext",
                    package_kind="stream_extension",
                    requires={"package_id": "cybereason", "version": ">=1.0.0 <2.0.0"},
                ),
                root_dir="ext",
            ),
            builtin_root=builtin_root,
            installed_root=installed_root,
        )
    assert exc.value.error_code == "DEPENDENCY_VERSION_MISMATCH"


def test_install_does_not_create_or_enable_stream(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    before_streams = db_session.query(Stream).count()
    install_package(
        db_session,
        _package_archive(_base_source()),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    assert db_session.query(Stream).count() == before_streams


def test_registry_api_and_lifecycle_http(client: TestClient, db_session: Session) -> None:
    listed = client.get("/api/v1/connectors-registry/")
    assert listed.status_code == 200

    archive = _package_archive(_base_source(id="http_pkg", package_id="http_pkg"), root_dir="http_pkg")
    response = client.post(
        "/api/v1/connectors-registry/packages/install",
        files={"file": ("http_pkg.tar.gz", archive, "application/gzip")},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["package_id"] == "http_pkg"
    assert body["origin"] == "upload"

    packages = client.get("/api/v1/connectors-registry/packages")
    assert packages.status_code == 200
    assert packages.json()["count"] >= 1

    upgrade = client.post(
        "/api/v1/connectors-registry/packages/http_pkg/upgrade",
        files={
            "file": (
                "http_pkg.tar.gz",
                _package_archive(
                    _base_source(id="http_pkg", package_id="http_pkg", version="1.2.0", pack_version="1.2.0"),
                    root_dir="http_pkg",
                ),
                "application/gzip",
            )
        },
    )
    assert upgrade.status_code == 200, upgrade.text
    assert upgrade.json()["pack_version"] == "1.2.0"

    rolled = client.post("/api/v1/connectors-registry/packages/http_pkg/rollback")
    assert rolled.status_code == 200
    assert rolled.json()["pack_version"] == "1.0.0"

    deleted = client.delete("/api/v1/connectors-registry/packages/http_pkg")
    assert deleted.status_code == 200
    assert deleted.json()["status"] == "REMOVED"


def test_manifest_v2_and_multi_root_regression(
    db_session: Session, builtin_root: Path, installed_root: Path
) -> None:
    (builtin_root / "legacy").mkdir()
    legacy = _base_source(id="legacy", package_id=None)
    legacy.pop("package_id", None)
    legacy.pop("pack_version", None)
    legacy.pop("package_kind", None)
    (builtin_root / "legacy" / "manifest.yaml").write_text(
        yaml.safe_dump(legacy, sort_keys=False),
        encoding="utf-8",
    )
    install_package(
        db_session,
        _package_archive(_base_source(id="partner", package_id="partner"), root_dir="partner"),
        builtin_root=builtin_root,
        installed_root=installed_root,
    )
    summaries = {s.id: s for s in list_connector_summaries()}
    assert "legacy" in summaries
    assert summaries["legacy"].pack_version == "1.0.0"
    assert summaries["legacy"].installed_from == "builtin"
    assert "partner" in summaries
    assert summaries["partner"].installed_from == "installed"


def test_migration_upgrade_downgrade(reset_db_schema: None, test_db_url: str, db_engine: Engine) -> None:
    root = Path(__file__).resolve().parents[1]
    cfg = Config(str(root / "alembic.ini"))
    cfg.set_main_option("script_location", str(root / "alembic"))
    cfg.set_main_option("sqlalchemy.url", test_db_url)

    command.upgrade(cfg, "head")
    inspector = inspect(db_engine)
    tables = set(inspector.get_table_names())
    assert "marketplace_package_installs" in tables
    assert "connector_registry_version" in tables

    command.downgrade(cfg, "20260930_0063")
    inspector = inspect(db_engine)
    tables = set(inspector.get_table_names())
    assert "marketplace_package_installs" not in tables
    assert "connector_registry_version" not in tables

    command.upgrade(cfg, "head")
    with db_engine.connect() as conn:
        rev = conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
    assert rev == "20261001_0066"
