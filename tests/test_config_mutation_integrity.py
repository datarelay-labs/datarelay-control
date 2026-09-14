"""Post-P0 Track A: configuration mutation integrity regressions."""

from __future__ import annotations

import threading
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.connectors.models import Connector
from app.database import get_db
from app.destinations.models import Destination
from app.main import app
from app.platform_admin import journal
from app.platform_admin.models import PlatformAuditEvent, PlatformConfigVersion
from app.sources.models import Source
from app.streams.models import Stream


def _seed_connector_source(db: Session, *, name: str = "integrity-connector") -> tuple[Connector, Source]:
    connector = Connector(name=name, description=None, status="STOPPED")
    db.add(connector)
    db.flush()
    source = Source(
        connector_id=connector.id,
        source_type="HTTP_API_POLLING",
        config_json={"base_url": "https://example.test", "token": "ActualSecret"},
        auth_json={"auth_type": "bearer", "bearer_token": "ActualBearer"},
        enabled=True,
    )
    db.add(source)
    db.commit()
    db.refresh(connector)
    db.refresh(source)
    return connector, source


def _seed_stream(db: Session, connector: Connector, source: Source, *, name: str = "integrity-stream") -> Stream:
    stream = Stream(
        connector_id=connector.id,
        source_id=source.id,
        name=name,
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=60,
        enabled=True,
        status="STOPPED",
    )
    db.add(stream)
    db.commit()
    db.refresh(stream)
    return stream


def _seed_destination(db: Session, *, name: str = "integrity-destination") -> Destination:
    destination = Destination(
        name=name,
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://receiver.example.com/integrity"},
        rate_limit_json={},
        enabled=True,
    )
    db.add(destination)
    db.commit()
    db.refresh(destination)
    return destination


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def test_stream_update_rejects_source_type_without_500(client: TestClient, db_session: Session) -> None:
    connector, source = _seed_connector_source(db_session)
    stream = _seed_stream(db_session, connector, source)
    token = client.get(f"/api/v1/streams/{stream.id}").json()["updated_at"]
    res = client.put(
        f"/api/v1/streams/{stream.id}",
        json={"source_type": "DATABASE_QUERY", "expected_updated_at": token},
    )
    assert res.status_code == 422
    assert res.status_code != 500


def test_stream_update_cannot_forge_runtime_status(client: TestClient, db_session: Session) -> None:
    connector, source = _seed_connector_source(db_session)
    stream = _seed_stream(db_session, connector, source)
    token = client.get(f"/api/v1/streams/{stream.id}").json()["updated_at"]
    res = client.put(
        f"/api/v1/streams/{stream.id}",
        json={"status": "RUNNING", "expected_updated_at": token, "name": "renamed-integrity-stream"},
    )
    # status is not part of StreamUpdate schema → 422 validation
    assert res.status_code == 422
    db_session.refresh(stream)
    assert stream.status == "STOPPED"


def test_stream_stale_write_is_side_effect_free(client: TestClient, db_session: Session) -> None:
    connector, source = _seed_connector_source(db_session)
    stream = _seed_stream(db_session, connector, source)
    stale = client.get(f"/api/v1/streams/{stream.id}").json()["updated_at"]
    fresh = client.put(
        f"/api/v1/streams/{stream.id}",
        json={"name": "stream-first-writer", "expected_updated_at": stale},
    )
    assert fresh.status_code == 200
    before_versions = db_session.query(PlatformConfigVersion).count()
    before_audits = db_session.query(PlatformAuditEvent).filter(PlatformAuditEvent.action == "STREAM_UPDATED").count()
    second = client.put(
        f"/api/v1/streams/{stream.id}",
        json={"name": "stream-second-writer", "expected_updated_at": stale},
    )
    assert second.status_code == 409
    assert second.json()["detail"]["error_code"] == "STREAM_STALE_WRITE"
    db_session.refresh(stream)
    assert stream.name == "stream-first-writer"
    assert db_session.query(PlatformConfigVersion).count() == before_versions
    assert (
        db_session.query(PlatformAuditEvent).filter(PlatformAuditEvent.action == "STREAM_UPDATED").count()
        == before_audits
    )


def test_destination_stale_write_and_fresh_save(client: TestClient, db_session: Session) -> None:
    destination = _seed_destination(db_session)
    token = client.get(f"/api/v1/destinations/{destination.id}").json()["updated_at"]
    ok = client.put(
        f"/api/v1/destinations/{destination.id}",
        json={"name": "dest-v2", "expected_updated_at": token},
    )
    assert ok.status_code == 200
    assert ok.json()["name"] == "dest-v2"
    stale = client.put(
        f"/api/v1/destinations/{destination.id}",
        json={"name": "dest-stale", "expected_updated_at": token},
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["error_code"] == "DESTINATION_STALE_WRITE"
    db_session.refresh(destination)
    assert destination.name == "dest-v2"


def test_connector_compound_source_concurrency(client: TestClient, db_session: Session) -> None:
    created = client.post(
        "/api/v1/connectors/",
        json={
            "name": "compound-connector",
            "auth_type": "bearer",
            "bearer_token": "tok-1",
            "base_url": "https://api.example.com",
        },
    )
    assert created.status_code == 201
    body = created.json()
    cid = int(body["id"])
    connector_token = body["updated_at"]
    source_token = body["source_updated_at"]
    assert connector_token and source_token

    # Independent Source mutation advances source token and parent connector token.
    source_id = int(body["source_id"])
    source_get = client.get(f"/api/v1/sources/{source_id}").json()
    source_put = client.put(
        f"/api/v1/sources/{source_id}",
        json={"enabled": False, "expected_updated_at": source_get["updated_at"]},
    )
    assert source_put.status_code == 200

    stale_connector = client.put(
        f"/api/v1/connectors/{cid}",
        json={
            "name": "should-fail",
            "expected_updated_at": connector_token,
            "expected_source_updated_at": source_token,
        },
    )
    assert stale_connector.status_code == 409
    assert stale_connector.json()["detail"]["error_code"] in {
        "CONNECTOR_STALE_WRITE",
        "CONNECTOR_SOURCE_STALE_WRITE",
    }

    fresh = client.get(f"/api/v1/connectors/{cid}").json()
    ok = client.put(
        f"/api/v1/connectors/{cid}",
        json={
            "name": "compound-renamed",
            "expected_updated_at": fresh["updated_at"],
            "expected_source_updated_at": fresh["source_updated_at"],
        },
    )
    assert ok.status_code == 200
    assert ok.json()["name"] == "compound-renamed"


def test_source_reassign_blocked_when_in_use(client: TestClient, db_session: Session) -> None:
    connector_a, source = _seed_connector_source(db_session, name="src-a")
    connector_b, _ = _seed_connector_source(db_session, name="src-b")
    _seed_stream(db_session, connector_a, source)
    token = client.get(f"/api/v1/sources/{source.id}").json()["updated_at"]
    res = client.put(
        f"/api/v1/sources/{source.id}",
        json={"connector_id": connector_b.id, "expected_updated_at": token},
    )
    assert res.status_code == 409
    assert res.json()["detail"]["error_code"] == "SOURCE_REASSIGN_BLOCKED_IN_USE"
    db_session.refresh(source)
    assert int(source.connector_id) == int(connector_a.id)


def test_source_delete_blocked_when_in_use(client: TestClient, db_session: Session) -> None:
    connector, source = _seed_connector_source(db_session)
    _seed_stream(db_session, connector, source)
    res = client.delete(f"/api/v1/sources/{source.id}")
    assert res.status_code == 409
    assert res.json()["detail"]["error_code"] == "SOURCE_DELETE_BLOCKED_IN_USE"
    assert client.get(f"/api/v1/sources/{source.id}").status_code == 200


def test_source_masked_secret_roundtrip_preserves_values(client: TestClient, db_session: Session) -> None:
    _, source = _seed_connector_source(db_session)
    got = client.get(f"/api/v1/sources/{source.id}").json()
    assert got["config_json"]["token"] == "********"
    assert got["auth_json"]["bearer_token"] == "********"
    put = client.put(
        f"/api/v1/sources/{source.id}",
        json={
            "enabled": False,
            "config_json": got["config_json"],
            "auth_json": got["auth_json"],
            "expected_updated_at": got["updated_at"],
        },
    )
    assert put.status_code == 200
    db_session.refresh(source)
    assert source.config_json["token"] == "ActualSecret"
    assert source.auth_json["bearer_token"] == "ActualBearer"
    assert source.enabled is False


def test_source_mutations_emit_audit_events(client: TestClient, db_session: Session) -> None:
    connector, _ = _seed_connector_source(db_session)
    created = client.post(
        "/api/v1/sources/",
        json={
            "connector_id": connector.id,
            "source_type": "HTTP_API_POLLING",
            "config_json": {},
            "auth_json": {},
        },
    )
    assert created.status_code == 201
    source_id = int(created.json()["id"])
    token = created.json()["updated_at"]
    assert client.put(
        f"/api/v1/sources/{source_id}",
        json={"enabled": False, "expected_updated_at": token},
    ).status_code == 200
    assert client.delete(f"/api/v1/sources/{source_id}").status_code == 204
    actions = {
        row.action
        for row in db_session.query(PlatformAuditEvent)
        .filter(PlatformAuditEvent.entity_type == "SOURCE", PlatformAuditEvent.entity_id == source_id)
        .all()
    }
    assert "SOURCE_CREATED" in actions
    assert "SOURCE_UPDATED" in actions
    assert "SOURCE_DELETED" in actions


def test_config_version_allocator_is_concurrency_safe(db_session: Session, db_engine) -> None:
    SessionLocal = sessionmaker(bind=db_engine, autoflush=False, autocommit=False)
    results: list[int] = []
    errors: list[BaseException] = []
    barrier = threading.Barrier(2)

    def worker() -> None:
        session = SessionLocal()
        try:
            barrier.wait(timeout=10)
            version = journal.record_config_version(
                session,
                entity_type="STREAM_CONFIG",
                entity_id=999001,
                entity_name="concurrency-allocator",
                summary="concurrent allocate",
                snapshot_before=None,
                snapshot_after={"ok": True},
            )
            session.commit()
            results.append(version)
        except BaseException as exc:  # noqa: BLE001 — capture for assertion
            errors.append(exc)
            session.rollback()
        finally:
            session.close()

    t1 = threading.Thread(target=worker)
    t2 = threading.Thread(target=worker)
    t1.start()
    t2.start()
    t1.join(timeout=30)
    t2.join(timeout=30)
    assert not errors, f"allocator raised: {errors}"
    assert len(results) == 2
    assert results[0] != results[1]
    assert len(set(results)) == 2


def test_production_route_delivery_always_injects_send_fn() -> None:
    """Regression: StreamRunner must not call delivery with events and send_fn=None."""

    import inspect

    from app.runners import stream_runner

    src = inspect.getsource(stream_runner.StreamRunner)
    assert "_make_route_delivery_send_fn" in src
    assert "process_route_pipeline" in src or "route_delivery_stage" in src


def test_unused_source_reassign_allowed(client: TestClient, db_session: Session) -> None:
    connector_a, source = _seed_connector_source(db_session, name="unused-a")
    connector_b, _ = _seed_connector_source(db_session, name="unused-b")
    token = client.get(f"/api/v1/sources/{source.id}").json()["updated_at"]
    res = client.put(
        f"/api/v1/sources/{source.id}",
        json={"connector_id": connector_b.id, "expected_updated_at": token},
    )
    assert res.status_code == 200
    assert int(res.json()["connector_id"]) == int(connector_b.id)
    # silence unused
    assert connector_a.id != connector_b.id
