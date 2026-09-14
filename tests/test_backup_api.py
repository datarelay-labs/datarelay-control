from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.connectors.models import Connector
from app.database import get_db
from app.destinations.models import Destination
from app.enrichments.models import Enrichment
from app.main import app
from app.mappings.models import Mapping
from app.routes.models import Route
from app.sources.models import Source
from app.streams.models import Stream


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def _seed_connector_graph(db: Session) -> dict[str, int]:
    c = Connector(name="backup-seed-connector", description=None, status="STOPPED")
    db.add(c)
    db.flush()
    s = Source(
        connector_id=c.id,
        source_type="HTTP_API_POLLING",
        config_json={"base_url": "https://vendor.example"},
        auth_json={"auth_type": "bearer", "bearer_token": "super-secret-token-xyz"},
        enabled=True,
    )
    db.add(s)
    db.flush()
    st = Stream(
        connector_id=c.id,
        source_id=s.id,
        name="backup-seed-stream",
        stream_type="HTTP_API_POLLING",
        config_json={"path": "/events"},
        polling_interval=120,
        enabled=True,
        status="RUNNING",
        rate_limit_json={},
    )
    db.add(st)
    db.flush()
    m = Mapping(
        stream_id=st.id,
        event_array_path="$.items",
        event_root_path=None,
        field_mappings_json={"a": {"source_json_path": "$.x", "output_field": "x"}},
        raw_payload_mode=None,
    )
    db.add(m)
    e = Enrichment(stream_id=st.id, enrichment_json={"vendor": "acme"}, override_policy="KEEP_EXISTING", enabled=True)
    db.add(e)
    cp = Checkpoint(stream_id=st.id, checkpoint_type="CUSTOM_FIELD", checkpoint_value_json={"cursor": "1"})
    db.add(cp)
    d = Destination(
        name="backup-seed-dest",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://receiver.example/hook", "headers": {"X-Key": "dest-secret"}},
        rate_limit_json={},
        enabled=True,
    )
    db.add(d)
    db.flush()
    r = Route(
        stream_id=st.id,
        destination_id=d.id,
        enabled=True,
        failure_policy="LOG_AND_CONTINUE",
        formatter_config_json={"message_format": "json"},
        rate_limit_json={},
        status="ENABLED",
    )
    db.add(r)
    db.commit()
    db.refresh(c)
    db.refresh(st)
    db.refresh(d)
    return {"connector_id": int(c.id), "stream_id": int(st.id), "destination_id": int(d.id)}


def test_workspace_export_contains_entities(client: TestClient, db_session: Session) -> None:
    _seed_connector_graph(db_session)
    res = client.get("/api/v1/backup/workspace/export")
    assert res.status_code == 200
    data = res.json()
    assert data.get("version") == 2
    assert data.get("export_kind") == "workspace"
    assert len(data.get("connectors") or []) >= 1
    assert len(data.get("routes") or []) >= 1


def test_export_masks_secrets(client: TestClient, db_session: Session) -> None:
    ids = _seed_connector_graph(db_session)
    res = client.get(f"/api/v1/backup/streams/{ids['stream_id']}/export?include_destinations=true")
    assert res.status_code == 200
    raw = res.text
    assert "super-secret-token-xyz" not in raw
    assert "dest-secret" not in raw
    data = res.json()
    auth = (data.get("sources") or [{}])[0].get("auth_json") or {}
    assert auth.get("bearer_token") in (None, "", "********")


def test_export_route_includes_destination_ref(client: TestClient, db_session: Session) -> None:
    ids = _seed_connector_graph(db_session)
    data = client.get(
        f"/api/v1/backup/connectors/{ids['connector_id']}/export?include_destinations=true",
    ).json()
    routes = data.get("routes") or []
    assert routes
    row = routes[0]
    assert row.get("destination_id") == ids["destination_id"]
    assert row.get("destination_name") == "backup-seed-dest"
    ref = row.get("destination_ref") or {}
    assert ref.get("id") == ids["destination_id"]
    assert ref.get("name") == "backup-seed-dest"


def test_import_preview_and_additive_apply(client: TestClient, db_session: Session) -> None:
    ids = _seed_connector_graph(db_session)
    bundle = client.get(f"/api/v1/backup/connectors/{ids['connector_id']}/export").json()
    prev = client.post("/api/v1/backup/import/preview", json={"bundle": bundle, "mode": "additive"})
    assert prev.status_code == 200
    body = prev.json()
    assert body.get("ok") is True
    token = body.get("preview_token")
    assert token

    apply_res = client.post(
        "/api/v1/backup/import/apply",
        json={"bundle": bundle, "mode": "additive", "confirm": True, "preview_token": token},
    )
    assert apply_res.status_code == 200
    created = apply_res.json().get("created") or {}
    new_cids = created.get("connector_ids") or []
    assert len(new_cids) == 1
    new_connector = db_session.get(Connector, new_cids[0])
    assert new_connector is not None
    assert new_connector.name == "backup-seed-connector"
    assert new_connector.status == "STOPPED"
    new_sids = created.get("stream_ids") or []
    assert new_sids
    new_stream = db_session.get(Stream, new_sids[0])
    assert new_stream is not None
    assert new_stream.enabled is False
    assert new_stream.status == "STOPPED"
    new_src_ids = created.get("source_ids") or []
    if new_src_ids:
        src = db_session.get(Source, new_src_ids[0])
        assert src is not None
        assert src.enabled is False


def test_import_preview_fails_on_missing_destination(client: TestClient, db_session: Session) -> None:
    ids = _seed_connector_graph(db_session)
    bundle = client.get(f"/api/v1/backup/connectors/{ids['connector_id']}/export").json()
    for r in bundle.get("routes") or []:
        if isinstance(r, dict):
            r["destination_id"] = 999999
    prev = client.post("/api/v1/backup/import/preview", json={"bundle": bundle, "mode": "additive"})
    assert prev.status_code == 200
    assert prev.json().get("ok") is False


def test_clone_connector_duplicates_graph(client: TestClient, db_session: Session) -> None:
    ids = _seed_connector_graph(db_session)
    res = client.post(f"/api/v1/backup/connectors/{ids['connector_id']}/clone", json={"name_suffix": " (clone)"})
    assert res.status_code == 200
    data = res.json()
    new_id = data["connector_id"]
    assert new_id != ids["connector_id"]
    row = db_session.get(Connector, new_id)
    assert row is not None
    assert row.name.endswith("(clone)")
    streams = db_session.query(Stream).filter(Stream.connector_id == new_id).all()
    assert len(streams) == 1
    assert streams[0].enabled is False
    assert streams[0].status == "STOPPED"


def test_clone_stream_copies_routes(client: TestClient, db_session: Session) -> None:
    ids = _seed_connector_graph(db_session)
    res = client.post(f"/api/v1/backup/streams/{ids['stream_id']}/clone", json={})
    assert res.status_code == 200
    new_sid = res.json()["stream_ids"][0]
    assert new_sid != ids["stream_id"]
    routes = db_session.query(Route).filter(Route.stream_id == new_sid).all()
    assert len(routes) == 1
    assert int(routes[0].destination_id) == ids["destination_id"]


def test_import_apply_requires_confirm_and_token(client: TestClient, db_session: Session) -> None:
    ids = _seed_connector_graph(db_session)
    bundle = client.get(f"/api/v1/backup/connectors/{ids['connector_id']}/export").json()
    token = client.post("/api/v1/backup/import/preview", json={"bundle": bundle, "mode": "additive"}).json()["preview_token"]
    bad = client.post(
        "/api/v1/backup/import/apply",
        json={"bundle": bundle, "mode": "additive", "confirm": True, "preview_token": "wrong"},
    )
    assert bad.status_code == 400
    no_confirm = client.post(
        "/api/v1/backup/import/apply",
        json={"bundle": bundle, "mode": "additive", "confirm": False, "preview_token": token},
    )
    assert no_confirm.status_code == 400


def test_export_integrity_reports_masking_ok(client: TestClient, db_session: Session) -> None:
    ids = _seed_connector_graph(db_session)
    data = client.get(f"/api/v1/backup/streams/{ids['stream_id']}/export?include_destinations=true").json()
    integrity = data.get("export_integrity") or {}
    assert integrity.get("secrets_masked") is True
    assert integrity.get("webhook_headers_masked") is True
    assert integrity.get("deterministic_ordering_ok") is True
    assert integrity.get("issues") == []


def test_export_masks_preflight_authorization_header(client: TestClient, db_session: Session) -> None:
    ids = _seed_connector_graph(db_session)
    src = db_session.query(Source).filter(Source.connector_id == ids["connector_id"]).one()
    merged = dict(src.auth_json or {})
    merged["preflight_headers"] = {"Authorization": "Bearer preflight-leaked-secret"}
    src.auth_json = merged
    db_session.commit()
    res = client.get(f"/api/v1/backup/streams/{ids['stream_id']}/export?include_destinations=true")
    raw = res.text
    assert "preflight-leaked-secret" not in raw
    data = res.json()
    hdrs = ((data.get("sources") or [{}])[0].get("auth_json") or {}).get("preflight_headers") or {}
    assert hdrs.get("Authorization") == "********"


def test_import_preview_dry_run_performs_no_writes(client: TestClient, db_session: Session) -> None:
    ids = _seed_connector_graph(db_session)
    n_connectors = db_session.query(Connector).count()
    bundle = client.get(f"/api/v1/backup/connectors/{ids['connector_id']}/export").json()
    res = client.post(
        "/api/v1/backup/import/preview",
        json={"bundle": bundle, "mode": "additive", "dry_run": True},
    )
    assert res.status_code == 200
    assert db_session.query(Connector).count() == n_connectors


def test_import_preview_destination_name_collision_finding(client: TestClient, db_session: Session) -> None:
    ids = _seed_connector_graph(db_session)
    bundle = client.get(
        f"/api/v1/backup/streams/{ids['stream_id']}/export?include_destinations=true",
    ).json()
    prev = client.post("/api/v1/backup/import/preview", json={"bundle": bundle, "mode": "additive"})
    assert prev.status_code == 200
    body = prev.json()
    assert body.get("ok") is True
    codes = {f.get("code") for f in body.get("findings") or []}
    assert "DESTINATION_NAME_EXISTS" in codes
    assert body.get("classification_summary", {}).get("overwrite_candidate", 0) >= 1


def test_import_preview_blocked_duplicate_connector_names_in_bundle(client: TestClient, db_session: Session) -> None:
    ids = _seed_connector_graph(db_session)
    bundle = client.get(f"/api/v1/backup/connectors/{ids['connector_id']}/export").json()
    first = bundle["connectors"][0]
    dup = dict(first)
    dup["id"] = int(first["id"]) + 100_000
    bundle["connectors"].append(dup)
    prev = client.post("/api/v1/backup/import/preview", json={"bundle": bundle, "mode": "additive"}).json()
    assert prev.get("ok") is False
    assert any(c.get("code") == "DUPLICATE_CONNECTOR_NAME_IN_BUNDLE" for c in prev.get("conflicts") or [])


def test_import_preview_blocked_duplicate_stream_names_in_bundle(client: TestClient, db_session: Session) -> None:
    ids = _seed_connector_graph(db_session)
    bundle = client.get(f"/api/v1/backup/connectors/{ids['connector_id']}/export").json()
    st0 = bundle["streams"][0]
    twin = dict(st0)
    twin["id"] = int(st0["id"]) + 100_000
    bundle["streams"].append(twin)
    prev = client.post("/api/v1/backup/import/preview", json={"bundle": bundle, "mode": "additive"}).json()
    assert prev.get("ok") is False
    assert any(c.get("code") == "DUPLICATE_STREAM_NAME_IN_BUNDLE" for c in prev.get("conflicts") or [])


def test_import_preview_blocked_routes_without_mappings(client: TestClient, db_session: Session) -> None:
    ids = _seed_connector_graph(db_session)
    bundle = client.get(f"/api/v1/backup/connectors/{ids['connector_id']}/export").json()
    bundle["mappings"] = []
    prev = client.post("/api/v1/backup/import/preview", json={"bundle": bundle, "mode": "additive"}).json()
    assert prev.get("ok") is False
    assert any(c.get("code") == "ROUTES_WITHOUT_MAPPINGS" for c in prev.get("conflicts") or [])


def test_import_preview_invalid_route_failure_policy(client: TestClient, db_session: Session) -> None:
    ids = _seed_connector_graph(db_session)
    bundle = client.get(f"/api/v1/backup/connectors/{ids['connector_id']}/export").json()
    for r in bundle.get("routes") or []:
        if isinstance(r, dict):
            r["failure_policy"] = "NOT_A_REAL_POLICY"
    prev = client.post("/api/v1/backup/import/preview", json={"bundle": bundle, "mode": "additive"}).json()
    assert prev.get("ok") is False
    assert any(c.get("code") == "INVALID_ROUTE_FAILURE_POLICY" for c in prev.get("conflicts") or [])


def test_clone_stream_does_not_copy_checkpoint(client: TestClient, db_session: Session) -> None:
    ids = _seed_connector_graph(db_session)
    assert db_session.query(Checkpoint).filter(Checkpoint.stream_id == ids["stream_id"]).count() == 1
    res = client.post(f"/api/v1/backup/streams/{ids['stream_id']}/clone", json={})
    new_sid = res.json()["stream_ids"][0]
    assert db_session.query(Checkpoint).filter(Checkpoint.stream_id == new_sid).count() == 0


def test_clone_connector_streams_have_no_checkpoints(client: TestClient, db_session: Session) -> None:
    ids = _seed_connector_graph(db_session)
    res = client.post(f"/api/v1/backup/connectors/{ids['connector_id']}/clone", json={"name_suffix": " (clone)"})
    new_cid = res.json()["connector_id"]
    for st in db_session.query(Stream).filter(Stream.connector_id == new_cid).all():
        assert db_session.query(Checkpoint).filter(Checkpoint.stream_id == st.id).count() == 0


def test_full_restore_replaces_operational_state(client: TestClient, db_session: Session) -> None:
    ids = _seed_connector_graph(db_session)
    bundle = client.get("/api/v1/backup/workspace/export?include_destinations=true").json()

    extra = Connector(name="extra-before-restore", description=None, status="STOPPED")
    db_session.add(extra)
    # Stop running streams before full restore (authoritative backend guard).
    for st in db_session.query(Stream).filter(Stream.status == "RUNNING").all():
        st.enabled = False
        st.status = "STOPPED"
    db_session.commit()
    assert db_session.query(Connector).count() == 2

    prev = client.post("/api/v1/backup/import/preview", json={"bundle": bundle, "mode": "full_restore"})
    assert prev.status_code == 200
    body = prev.json()
    assert body.get("ok") is True
    assert body.get("full_restore_purge", {}).get("connectors") == 2
    token = body["preview_token"]
    assert any(w.get("code") == "FULL_RESTORE_DESTRUCTIVE" for w in body.get("warnings") or [])

    apply_res = client.post(
        "/api/v1/backup/import/apply",
        json={
            "bundle": bundle,
            "mode": "full_restore",
            "confirm": True,
            "confirm_destructive": True,
            "preview_token": token,
        },
    )
    assert apply_res.status_code == 200
    data = apply_res.json()
    assert data.get("replaced", {}).get("connectors") == 2

    connectors = db_session.query(Connector).all()
    assert len(connectors) == 1
    assert connectors[0].name == "backup-seed-connector"
    assert db_session.get(Connector, ids["connector_id"]) is None
    assert db_session.query(Stream).count() == 1
    assert db_session.query(Route).count() == 1
    assert db_session.query(Destination).count() == 1
    restored_stream = db_session.query(Stream).one()
    assert restored_stream.name == "backup-seed-stream"
    assert restored_stream.enabled is True
    assert restored_stream.status == "RUNNING"


def test_full_restore_blocked_while_stream_running(client: TestClient, db_session: Session) -> None:
    _seed_connector_graph(db_session)
    bundle = client.get("/api/v1/backup/workspace/export?include_destinations=true").json()
    prev = client.post("/api/v1/backup/import/preview", json={"bundle": bundle, "mode": "full_restore"})
    assert prev.status_code == 200
    token = prev.json()["preview_token"]

    apply_res = client.post(
        "/api/v1/backup/import/apply",
        json={
            "bundle": bundle,
            "mode": "full_restore",
            "confirm": True,
            "confirm_destructive": True,
            "preview_token": token,
        },
    )
    assert apply_res.status_code == 409
    detail = apply_res.json().get("detail") or {}
    assert detail.get("error_code") == "FULL_RESTORE_BLOCKED_STREAM_ACTIVE"
    assert db_session.query(Stream).filter(Stream.status == "RUNNING").count() == 1


def test_full_restore_blocked_for_enabled_stopped_inconsistent(client: TestClient, db_session: Session) -> None:
    _seed_connector_graph(db_session)
    for st in db_session.query(Stream).all():
        st.enabled = True
        st.status = "STOPPED"
    db_session.commit()
    bundle = client.get("/api/v1/backup/workspace/export?include_destinations=true").json()
    token = client.post("/api/v1/backup/import/preview", json={"bundle": bundle, "mode": "full_restore"}).json()[
        "preview_token"
    ]
    apply_res = client.post(
        "/api/v1/backup/import/apply",
        json={
            "bundle": bundle,
            "mode": "full_restore",
            "confirm": True,
            "confirm_destructive": True,
            "preview_token": token,
        },
    )
    assert apply_res.status_code == 409
    assert apply_res.json()["detail"]["error_code"] == "FULL_RESTORE_BLOCKED_STREAM_ACTIVE"


def test_full_restore_allowed_when_disabled_stopped_no_owner(client: TestClient, db_session: Session) -> None:
    _seed_connector_graph(db_session)
    for st in db_session.query(Stream).all():
        st.enabled = False
        st.status = "STOPPED"
    db_session.commit()
    bundle = client.get("/api/v1/backup/workspace/export?include_destinations=true").json()
    token = client.post("/api/v1/backup/import/preview", json={"bundle": bundle, "mode": "full_restore"}).json()[
        "preview_token"
    ]
    apply_res = client.post(
        "/api/v1/backup/import/apply",
        json={
            "bundle": bundle,
            "mode": "full_restore",
            "confirm": True,
            "confirm_destructive": True,
            "preview_token": token,
        },
    )
    assert apply_res.status_code == 200, apply_res.text


def test_full_restore_blocked_while_stopping_with_worker_alive(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_connector_graph(db_session)
    for st in db_session.query(Stream).all():
        st.enabled = False
        st.status = "STOPPING"
    db_session.commit()
    monkeypatch.setattr(
        "app.streams.runtime_eligibility.stream_has_local_runtime_owner",
        lambda _sid: True,
    )
    bundle = client.get("/api/v1/backup/workspace/export?include_destinations=true").json()
    token = client.post("/api/v1/backup/import/preview", json={"bundle": bundle, "mode": "full_restore"}).json()[
        "preview_token"
    ]
    apply_res = client.post(
        "/api/v1/backup/import/apply",
        json={
            "bundle": bundle,
            "mode": "full_restore",
            "confirm": True,
            "confirm_destructive": True,
            "preview_token": token,
        },
    )
    assert apply_res.status_code == 409
    assert apply_res.json()["detail"]["error_code"] == "FULL_RESTORE_BLOCKED_STREAM_ACTIVE"


def test_full_restore_reconciles_stale_stopping_without_owner(client: TestClient, db_session: Session) -> None:
    _seed_connector_graph(db_session)
    for st in db_session.query(Stream).all():
        st.enabled = False
        st.status = "STOPPING"
    db_session.commit()
    bundle = client.get("/api/v1/backup/workspace/export?include_destinations=true").json()
    token = client.post("/api/v1/backup/import/preview", json={"bundle": bundle, "mode": "full_restore"}).json()[
        "preview_token"
    ]
    apply_res = client.post(
        "/api/v1/backup/import/apply",
        json={
            "bundle": bundle,
            "mode": "full_restore",
            "confirm": True,
            "confirm_destructive": True,
            "preview_token": token,
        },
    )
    assert apply_res.status_code == 200, apply_res.text


def test_full_restore_requires_destructive_confirm(client: TestClient, db_session: Session) -> None:
    ids = _seed_connector_graph(db_session)
    bundle = client.get(f"/api/v1/backup/connectors/{ids['connector_id']}/export").json()
    token = client.post("/api/v1/backup/import/preview", json={"bundle": bundle, "mode": "full_restore"}).json()[
        "preview_token"
    ]
    bad = client.post(
        "/api/v1/backup/import/apply",
        json={
            "bundle": bundle,
            "mode": "full_restore",
            "confirm": True,
            "confirm_destructive": False,
            "preview_token": token,
        },
    )
    assert bad.status_code == 400
    assert bad.json()["detail"]["error_code"] == "IMPORT_DESTRUCTIVE_CONFIRM_REQUIRED"


def test_additive_import_still_duplicates_when_entities_exist(client: TestClient, db_session: Session) -> None:
    ids = _seed_connector_graph(db_session)
    bundle = client.get(f"/api/v1/backup/connectors/{ids['connector_id']}/export").json()
    token = client.post("/api/v1/backup/import/preview", json={"bundle": bundle, "mode": "additive"}).json()[
        "preview_token"
    ]
    apply_res = client.post(
        "/api/v1/backup/import/apply",
        json={"bundle": bundle, "mode": "additive", "confirm": True, "preview_token": token},
    )
    assert apply_res.status_code == 200
    assert db_session.query(Connector).count() == 2


def test_clone_stream_preserves_route_formatter_and_rate_limits(client: TestClient, db_session: Session) -> None:
    ids = _seed_connector_graph(db_session)
    orig = db_session.query(Route).filter(Route.stream_id == ids["stream_id"]).one()
    res = client.post(f"/api/v1/backup/streams/{ids['stream_id']}/clone", json={})
    new_sid = res.json()["stream_ids"][0]
    cloned = db_session.query(Route).filter(Route.stream_id == new_sid).one()
    assert cloned.formatter_config_json == orig.formatter_config_json
    assert cloned.rate_limit_json == orig.rate_limit_json
    assert cloned.failure_policy == orig.failure_policy


def test_import_apply_never_binds_foreign_destination_ids(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Defense in depth: unresolved route destination IDs must not fall back to local numeric IDs."""

    from app.backup import import_validator, service as backup_service
    from app.backup.schemas import ImportApplyRequest

    # Local destination that must never be silently selected by foreign export id 7.
    local = Destination(
        name="local-siem-b",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://local.example/hook"},
        rate_limit_json={},
        enabled=True,
    )
    db_session.add(local)
    db_session.flush()
    # Force known local id collision surface when possible.
    assert int(local.id) >= 1

    c = Connector(name="import-dest-safe-conn", description=None, status="STOPPED")
    db_session.add(c)
    db_session.flush()
    s = Source(
        connector_id=c.id,
        source_type="HTTP_API_POLLING",
        config_json={},
        auth_json={},
        enabled=True,
    )
    db_session.add(s)
    db_session.flush()
    st = Stream(
        connector_id=c.id,
        source_id=s.id,
        name="import-dest-safe-stream",
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=60,
        enabled=False,
        status="STOPPED",
        rate_limit_json={},
    )
    db_session.add(st)
    db_session.commit()

    bundle = {
        "schema_version": 1,
        "connectors": [
            {"id": 101, "name": "bundle-conn", "description": None, "status": "STOPPED", "product_group": None}
        ],
        "sources": [
            {
                "id": 201,
                "connector_id": 101,
                "source_type": "HTTP_API_POLLING",
                "config_json": {},
                "auth_json": {},
                "enabled": True,
            }
        ],
        "streams": [
            {
                "id": 301,
                "connector_id": 101,
                "source_id": 201,
                "name": "bundle-stream",
                "stream_type": "HTTP_API_POLLING",
                "config_json": {},
                "polling_interval": 60,
                "enabled": False,
                "status": "STOPPED",
                "rate_limit_json": {},
            }
        ],
        "mappings": [
            {
                "stream_id": 301,
                "event_array_path": "$.items",
                "event_root_path": None,
                "field_mappings_json": {},
                "raw_payload_mode": None,
            }
        ],
        "enrichments": [],
        "destinations": [],
        "routes": [
            {
                "id": 401,
                "stream_id": 301,
                "destination_id": int(local.id),
                "enabled": True,
                "failure_policy": "LOG_AND_CONTINUE",
                "formatter_config_json": {},
                "rate_limit_json": {},
                "status": "ENABLED",
            }
        ],
        "checkpoints": [],
    }

    class _Ok:
        ok = True
        conflicts: list = []
        warnings: list = []
        unsupported: list = []
        findings: list = []
        classification_summary = None
        dry_run = None
        full_restore_purge = None

    monkeypatch.setattr(import_validator, "validate_import_bundle", lambda *a, **k: _Ok())
    monkeypatch.setattr(backup_service, "validate_import_bundle", lambda *a, **k: _Ok())
    token = backup_service.preview_token_for(bundle, "additive")
    body = ImportApplyRequest(
        bundle=bundle,
        mode="additive",
        confirm=True,
        preview_token=token,
    )
    with pytest.raises(Exception) as exc:
        backup_service.apply_import(db_session, body)
    detail = getattr(exc.value, "detail", None) or {}
    if isinstance(detail, dict):
        assert detail.get("error_code") == "IMPORT_ROUTE_DESTINATION_UNMAPPED"
    else:
        assert "IMPORT_ROUTE_DESTINATION_UNMAPPED" in str(exc.value)
    # Local destination must remain unbound by the foreign route.
    assert db_session.query(Route).filter(Route.destination_id == int(local.id)).count() == 0
