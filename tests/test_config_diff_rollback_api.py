from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.connectors.models import Connector
from app.database import get_db
from app.destinations.models import Destination
from app.main import app
from app.routes.models import Route
from app.sources.models import Source
from app.streams.models import Stream
from tests.config_mutation_test_helpers import put_stream


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def _seed_stream(db: Session) -> int:
    c = Connector(name="c1", description=None, status="RUNNING")
    db.add(c)
    db.flush()
    s = Source(
        connector_id=c.id,
        source_type="HTTP_API_POLLING",
        config_json={"base_url": "https://example.com"},
        auth_json={},
        enabled=True,
    )
    db.add(s)
    db.flush()
    st = Stream(
        connector_id=c.id,
        source_id=s.id,
        name="s1",
        stream_type="HTTP_API_POLLING",
        config_json={"endpoint": "/e"},
        polling_interval=60,
        enabled=True,
        status="STOPPED",
        rate_limit_json={},
    )
    db.add(st)
    db.flush()
    d = Destination(
        name="d1",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://hook.example.com/h"},
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
        formatter_config_json={"k": "v"},
        rate_limit_json={},
        status="ENABLED",
    )
    db.add(r)
    db.commit()
    return int(st.id)


def _stream_token(client: TestClient, stream_id: int) -> str:
    return client.get(f"/api/v1/streams/{stream_id}").json()["updated_at"]


def _dest_token(client: TestClient, destination_id: int) -> str:
    return client.get(f"/api/v1/destinations/{destination_id}").json()["updated_at"]


def test_config_version_detail_and_compare(client: TestClient, db_session: Session) -> None:
    sid = _seed_stream(db_session)
    r1 = put_stream(client, sid, {"name": "s1", "polling_interval": 120, "config_json": {"endpoint": "/e2"}, "rate_limit_json": {}})
    assert r1.status_code == 200, r1.text
    r2 = put_stream(client, sid, {"name": "s1", "polling_interval": 300, "config_json": {"endpoint": "/e3"}, "rate_limit_json": {}})
    assert r2.status_code == 200, r2.text

    lst = client.get(f"/api/v1/admin/config-versions?entity_type=STREAM_CONFIG&entity_id={sid}&limit=5")
    assert lst.status_code == 200
    items = lst.json()["items"]
    assert len(items) >= 2
    row_newer = items[0]
    row_older = items[1]

    det = client.get(f"/api/v1/admin/config-versions/{row_newer['id']}")
    assert det.status_code == 200
    body = det.json()
    assert body["snapshots_available"] is True
    assert body["snapshot_after"]["polling_interval"] == 300
    assert any(x["path"] == "polling_interval" for x in body["diff_inline"])

    cmp = client.get(
        "/api/v1/admin/config-versions/compare",
        params={"left_id": row_older["id"], "right_id": row_newer["id"]},
    )
    assert cmp.status_code == 200
    assert cmp.json()["entity_type"] == "STREAM_CONFIG"
    assert cmp.json()["entity_id"] == sid
    assert len(cmp.json()["diff"]) >= 1


def test_apply_snapshot_rollback_restores_values(client: TestClient, db_session: Session) -> None:
    sid = _seed_stream(db_session)
    r1 = put_stream(client, sid, {"name": "s1", "polling_interval": 999, "config_json": {"endpoint": "/bad"}, "rate_limit_json": {}})
    assert r1.status_code == 200
    lst = client.get(f"/api/v1/admin/config-versions?entity_type=STREAM_CONFIG&entity_id={sid}&limit=1")
    tip = lst.json()["items"][0]
    row_id = tip["id"]
    expected_version = tip["version"]

    ap = client.post(
        f"/api/v1/admin/config-versions/{row_id}/apply-snapshot",
        json={"target": "before", "expected_version": expected_version},
    )
    assert ap.status_code == 200, ap.text
    assert ap.json()["applied_target"] == "before"

    cur = client.get(f"/api/v1/streams/{sid}")
    assert cur.status_code == 200
    assert cur.json()["polling_interval"] == 60
    assert cur.json()["config_json"]["endpoint"] == "/e"


def test_apply_snapshot_blocked_when_stream_running(client: TestClient, db_session: Session) -> None:
    sid = _seed_stream(db_session)
    put_stream(client, sid, {"name": "s1", "polling_interval": 77, "config_json": {"endpoint": "/x"}, "rate_limit_json": {}})
    lst = client.get(f"/api/v1/admin/config-versions?entity_type=STREAM_CONFIG&entity_id={sid}&limit=1")
    tip = lst.json()["items"][0]
    row_id = tip["id"]
    expected_version = tip["version"]

    db_session.query(Stream).filter(Stream.id == sid).update({"status": "RUNNING"})
    db_session.commit()

    ap = client.post(
        f"/api/v1/admin/config-versions/{row_id}/apply-snapshot",
        json={"target": "before", "expected_version": expected_version},
    )
    assert ap.status_code == 409
    assert ap.json()["detail"]["error_code"] == "CONFIG_APPLY_BLOCKED_STREAM_RUNNING"


def test_apply_snapshot_rejects_stale_expected_version(client: TestClient, db_session: Session) -> None:
    """Stale restore must be side-effect free when the live target tip advanced after preview."""
    from app.platform_admin.models import PlatformAuditEvent, PlatformConfigVersion

    sid = _seed_stream(db_session)
    first = put_stream(client, sid, {"name": "s1", "polling_interval": 111, "config_json": {"endpoint": "/v1"}, "rate_limit_json": {}})
    assert first.status_code == 200

    lst_n = client.get(f"/api/v1/admin/config-versions?entity_type=STREAM_CONFIG&entity_id={sid}&limit=1")
    tip_n = lst_n.json()["items"][0]
    historical_row_id = tip_n["id"]
    version_n = int(tip_n["version"])

    # Concurrent actor advances the target tip to N+1 after preview captured N.
    second = put_stream(client, sid, {"name": "s1", "polling_interval": 222, "config_json": {"endpoint": "/v2"}, "rate_limit_json": {}})
    assert second.status_code == 200
    lst_n1 = client.get(f"/api/v1/admin/config-versions?entity_type=STREAM_CONFIG&entity_id={sid}&limit=1")
    version_n1 = int(lst_n1.json()["items"][0]["version"])
    assert version_n1 > version_n

    versions_before = (
        db_session.query(PlatformConfigVersion)
        .filter(
            PlatformConfigVersion.entity_type == "STREAM_CONFIG",
            PlatformConfigVersion.entity_id == sid,
        )
        .count()
    )
    audits_before = (
        db_session.query(PlatformAuditEvent)
        .filter(PlatformAuditEvent.action == "CONFIG_SNAPSHOT_APPLIED")
        .count()
    )

    stale = client.post(
        f"/api/v1/admin/config-versions/{historical_row_id}/apply-snapshot",
        json={"target": "before", "expected_version": version_n},
    )
    assert stale.status_code == 409, stale.text
    detail = stale.json()["detail"]
    assert detail["error_code"] == "CONFIG_APPLY_STALE_VERSION"
    assert detail["expected_version"] == version_n
    assert detail["current_version"] == version_n1

    cur = client.get(f"/api/v1/streams/{sid}")
    assert cur.status_code == 200
    assert cur.json()["polling_interval"] == 222
    assert cur.json()["config_json"]["endpoint"] == "/v2"

    versions_after = (
        db_session.query(PlatformConfigVersion)
        .filter(
            PlatformConfigVersion.entity_type == "STREAM_CONFIG",
            PlatformConfigVersion.entity_id == sid,
        )
        .count()
    )
    audits_after = (
        db_session.query(PlatformAuditEvent)
        .filter(PlatformAuditEvent.action == "CONFIG_SNAPSHOT_APPLIED")
        .count()
    )
    assert versions_after == versions_before
    assert audits_after == audits_before

    fresh = client.post(
        f"/api/v1/admin/config-versions/{historical_row_id}/apply-snapshot",
        json={"target": "before", "expected_version": version_n1},
    )
    assert fresh.status_code == 200, fresh.text
    restored = client.get(f"/api/v1/streams/{sid}")
    assert restored.status_code == 200
    assert restored.json()["polling_interval"] == 60
    assert restored.json()["config_json"]["endpoint"] == "/e"


def test_config_versions_entity_id_without_type_is_400(client: TestClient) -> None:
    r = client.get("/api/v1/admin/config-versions?entity_id=1")
    assert r.status_code == 400


def test_config_version_history_masks_stream_and_destination_secrets(
    client: TestClient, db_session: Session
) -> None:
    sid = _seed_stream(db_session)
    stream = db_session.get(Stream, sid)
    assert stream is not None
    dest = db_session.query(Destination).filter(Destination.name == "d1").one()

    r_stream = client.put(
        f"/api/v1/streams/{sid}",
        json={
            "name": "s1",
            "polling_interval": 90,
            "config_json": {
                "endpoint": "/secure",
                "api_key": "stream-history-secret-xyz",
                "headers": {"Authorization": "Bearer hist-token"},
            },
            "rate_limit_json": {},
            "expected_updated_at": _stream_token(client, sid),
        },
    )
    assert r_stream.status_code == 200, r_stream.text

    r_dest = client.put(
        f"/api/v1/destinations/{dest.id}",
        json={
            "name": "d1",
            "destination_type": "WEBHOOK_POST",
            "enabled": True,
            "config_json": {
                "url": "https://hook.example.com/h",
                "api_key": "dest-history-secret-xyz",
                "headers": {"Authorization": "Bearer dest-hist-auth", "X-Api-Key": "dest-hist-key"},
            },
            "rate_limit_json": {},
            "expected_updated_at": _dest_token(client, int(dest.id)),
        },
    )
    assert r_dest.status_code == 200, r_dest.text
    assert "dest-history-secret-xyz" not in r_dest.text
    assert "dest-hist-auth" not in r_dest.text

    stream_tip = client.get(
        f"/api/v1/admin/config-versions?entity_type=STREAM_CONFIG&entity_id={sid}&limit=1"
    ).json()["items"][0]
    stream_det = client.get(f"/api/v1/admin/config-versions/{stream_tip['id']}")
    assert stream_det.status_code == 200
    assert "stream-history-secret-xyz" not in stream_det.text
    assert "hist-token" not in stream_det.text
    assert stream_det.json()["snapshot_after"]["config_json"]["api_key"] == "********"

    dest_tip = client.get(
        f"/api/v1/admin/config-versions?entity_type=DESTINATION_CONFIG&entity_id={dest.id}&limit=1"
    ).json()["items"][0]
    dest_det = client.get(f"/api/v1/admin/config-versions/{dest_tip['id']}")
    assert dest_det.status_code == 200
    assert "dest-history-secret-xyz" not in dest_det.text
    assert "dest-hist-auth" not in dest_det.text
    assert "dest-hist-key" not in dest_det.text
    cfg = dest_det.json()["snapshot_after"]["config_json"]
    assert cfg["api_key"] == "********"
    assert cfg["headers"]["Authorization"] == "********"
    assert cfg["headers"]["X-Api-Key"] == "********"

    # Live destination row still holds the real secret for runtime delivery.
    db_session.refresh(dest)
    assert dest.config_json["api_key"] == "dest-history-secret-xyz"
