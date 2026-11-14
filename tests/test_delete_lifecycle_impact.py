"""E-129 / E-130: destination delete retention behaviour and truthful stream/destination delete impact.

E-129: deleting a Destination whose routes were removed must not fail with a bare HTTP 500 when
delivery logs or replay jobs still reference it. Delivery logs are kept (destination_id is set
to NULL, mirroring Route delete which nulls route_id); replay jobs for the destination can no
longer be delivered and are removed, which the impact summary and the audit row disclose.

E-130: the delete impact summaries must report everything the delete destroys or retains.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.audit.models import AuditLog
from app.backfill.models import BackfillJob
from app.connectors.models import Connector
from app.database import get_db
from app.destinations.models import Destination
from app.logs.models import DeliveryLog
from app.main import app
from app.protection.models import StreamProtectionRule
from app.quarantine.models import (
    QUARANTINE_SOURCE_POLICY,
    QUARANTINE_STATUS_DISCARDED,
    QUARANTINE_STATUS_QUARANTINED,
    QUARANTINE_STATUS_RELEASED,
    StreamQuarantineEvent,
)
from app.replay.models import (
    DELIVERY_KIND_BASE_ROUTE,
    REPLAY_STATUS_DISCARDED,
    REPLAY_STATUS_FAILED,
    REPLAY_STATUS_PENDING,
    REPLAY_STATUS_REPLAYED,
    StreamReplayEvent,
)
from app.routes.models import Route
from app.sources.models import Source
from app.streams.models import Stream


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app, raise_server_exceptions=False)
    finally:
        app.dependency_overrides.pop(get_db, None)


def _seed_stream(db: Session, name: str) -> Stream:
    connector = Connector(name=f"{name}-connector", description=None, status="STOPPED")
    db.add(connector)
    db.flush()
    source = Source(
        connector_id=connector.id, source_type="HTTP_API_POLLING", config_json={}, auth_json={}, enabled=True
    )
    db.add(source)
    db.flush()
    stream = Stream(
        name=name,
        connector_id=connector.id,
        source_id=source.id,
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=60,
        enabled=False,
        status="STOPPED",
        rate_limit_json={},
    )
    db.add(stream)
    db.flush()
    return stream


def _seed_destination(db: Session, name: str, *, enabled: bool = False) -> Destination:
    destination = Destination(
        name=name,
        destination_type="SYSLOG_UDP",
        config_json={"host": "127.0.0.1", "port": 5514},
        rate_limit_json={},
        enabled=enabled,
    )
    db.add(destination)
    db.flush()
    return destination


def _seed_route(db: Session, stream: Stream, destination: Destination) -> Route:
    route = Route(
        stream_id=stream.id,
        destination_id=destination.id,
        enabled=False,
        failure_policy="LOG_AND_CONTINUE",
        formatter_config_json={},
        rate_limit_json={},
        status="DISABLED",
    )
    db.add(route)
    db.flush()
    return route


def _log(db: Session, stream: Stream, route: Route | None, destination: Destination) -> None:
    db.add(
        DeliveryLog(
            stream_id=stream.id,
            route_id=route.id if route is not None else None,
            destination_id=destination.id,
            stage="route_send_success",
            level="INFO",
            message="delivered",
            payload_sample={},
        )
    )


def _quarantine(db: Session, stream: Stream, status: str) -> None:
    db.add(
        StreamQuarantineEvent(
            stream_id=stream.id,
            quarantine_reason="policy",
            quarantine_source=QUARANTINE_SOURCE_POLICY,
            status=status,
            protected_payload_json={"message": "x"},
            metadata_json={},
        )
    )


def _replay(db: Session, stream: Stream, destination: Destination, status: str) -> None:
    db.add(
        StreamReplayEvent(
            stream_id=stream.id,
            destination_id=destination.id,
            delivery_kind=DELIVERY_KIND_BASE_ROUTE,
            status=status,
            protected_payload_json={"message": "x"},
            delivery_context_json={},
            event_count=1,
        )
    )


# --------------------------------------------------------------------------------------
# E-129 destination delete
# --------------------------------------------------------------------------------------


def test_destination_delete_keeps_delivery_logs_and_nulls_reference(client: TestClient, db_session: Session) -> None:
    stream = _seed_stream(db_session, "e129-keep-logs")
    destination = _seed_destination(db_session, "e129-keep-logs-dest")
    for _ in range(3):
        _log(db_session, stream, None, destination)
    db_session.commit()
    destination_id = int(destination.id)
    stream_id = int(stream.id)

    res = client.delete(f"/api/v1/destinations/{destination_id}")

    assert res.status_code == 204, res.text
    assert db_session.query(Destination).filter(Destination.id == destination_id).first() is None
    kept = db_session.query(DeliveryLog).filter(DeliveryLog.stream_id == stream_id).all()
    assert len(kept) == 3
    assert all(row.destination_id is None for row in kept)


def test_destination_delete_removes_replay_jobs_and_records_counts_in_audit(
    client: TestClient, db_session: Session
) -> None:
    stream = _seed_stream(db_session, "e129-replay")
    other_stream = _seed_stream(db_session, "e129-replay-other")
    destination = _seed_destination(db_session, "e129-replay-dest")
    other_destination = _seed_destination(db_session, "e129-replay-other-dest")
    for status in (REPLAY_STATUS_PENDING, REPLAY_STATUS_FAILED, REPLAY_STATUS_REPLAYED, REPLAY_STATUS_DISCARDED):
        _replay(db_session, stream, destination, status)
    _replay(db_session, other_stream, other_destination, REPLAY_STATUS_PENDING)
    for _ in range(2):
        _log(db_session, stream, None, destination)
    db_session.commit()
    destination_id = int(destination.id)
    other_destination_id = int(other_destination.id)

    res = client.delete(f"/api/v1/destinations/{destination_id}")

    assert res.status_code == 204, res.text
    assert (
        db_session.query(StreamReplayEvent).filter(StreamReplayEvent.destination_id == destination_id).count() == 0
    )
    # Another destination's replay jobs are untouched.
    assert (
        db_session.query(StreamReplayEvent).filter(StreamReplayEvent.destination_id == other_destination_id).count()
        == 1
    )
    row = (
        db_session.query(AuditLog)
        .filter(AuditLog.action == "DESTINATION_DELETED", AuditLog.entity_id == destination_id)
        .one()
    )
    assert row.metadata_json["delivery_logs_retained"] == 2
    assert row.metadata_json["pending_replay_jobs_deleted"] == 2
    assert row.metadata_json["completed_replay_jobs_deleted"] == 2


def test_destination_delete_never_returns_bare_500_on_integrity_error(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    destination = _seed_destination(db_session, "e129-integrity")
    db_session.commit()
    destination_id = int(destination.id)

    def _boom(*_a: Any, **_k: Any) -> None:
        raise IntegrityError("DELETE", {}, Exception("fk violation"))

    monkeypatch.setattr(db_session, "commit", _boom)

    res = client.delete(f"/api/v1/destinations/{destination_id}")

    assert res.status_code == 409
    detail = res.json()["detail"]
    assert detail["error_code"] == "DESTINATION_DELETE_BLOCKED_DEPENDENCY"
    assert "Internal Server Error" not in detail["message"]
    assert len(detail["message"]) > 30


def test_destination_delete_impact_reports_retained_and_removed_data(client: TestClient, db_session: Session) -> None:
    stream = _seed_stream(db_session, "e129-impact")
    destination = _seed_destination(db_session, "e129-impact-dest")
    other_destination = _seed_destination(db_session, "e129-impact-other")
    for _ in range(4):
        _log(db_session, stream, None, destination)
    _log(db_session, stream, None, other_destination)
    for status in (REPLAY_STATUS_PENDING, REPLAY_STATUS_FAILED, REPLAY_STATUS_REPLAYED):
        _replay(db_session, stream, destination, status)
    _replay(db_session, stream, other_destination, REPLAY_STATUS_PENDING)
    db_session.commit()

    res = client.get(f"/api/v1/destinations/{destination.id}/delete-impact")

    assert res.status_code == 200
    assert res.json() == {
        "destination_id": destination.id,
        "routes": 0,
        "streams": 0,
        "delivery_logs_retained": 4,
        "pending_replay_jobs": 2,
        "completed_replay_jobs": 1,
    }


def test_destination_delete_impact_counts_routes_and_streams(client: TestClient, db_session: Session) -> None:
    stream_a = _seed_stream(db_session, "e129-impact-a")
    stream_b = _seed_stream(db_session, "e129-impact-b")
    destination = _seed_destination(db_session, "e129-impact-routed")
    _seed_route(db_session, stream_a, destination)
    _seed_route(db_session, stream_b, destination)
    db_session.commit()

    body = client.get(f"/api/v1/destinations/{destination.id}/delete-impact").json()
    assert body["routes"] == 2
    assert body["streams"] == 2


def test_destination_delete_impact_unknown_destination_is_404(client: TestClient) -> None:
    res = client.get("/api/v1/destinations/987654/delete-impact")
    assert res.status_code == 404
    assert res.json()["detail"]["error_code"] == "DESTINATION_NOT_FOUND"


# --------------------------------------------------------------------------------------
# E-130 stream delete impact
# --------------------------------------------------------------------------------------


def _seed_full_stream(db: Session, name: str) -> tuple[Stream, Destination]:
    stream = _seed_stream(db, name)
    destination = _seed_destination(db, f"{name}-dest")
    route = _seed_route(db, stream, destination)
    for status in (
        QUARANTINE_STATUS_QUARANTINED,
        QUARANTINE_STATUS_QUARANTINED,
        QUARANTINE_STATUS_RELEASED,
        QUARANTINE_STATUS_RELEASED,
        QUARANTINE_STATUS_DISCARDED,
    ):
        _quarantine(db, stream, status)
    for status in (
        REPLAY_STATUS_PENDING,
        REPLAY_STATUS_FAILED,
        REPLAY_STATUS_REPLAYED,
        REPLAY_STATUS_REPLAYED,
        REPLAY_STATUS_DISCARDED,
    ):
        _replay(db, stream, destination, status)
    for _ in range(4):
        _log(db, stream, route, destination)
    for _ in range(3):
        db.add(
            BackfillJob(
                stream_id=stream.id,
                source_type="HTTP_API_POLLING",
                status="COMPLETED",
                backfill_mode="TIME_RANGE",
                requested_by="tester",
            )
        )
    db.add(
        StreamProtectionRule(
            stream_id=stream.id,
            field_path="$.secret",
            sensitivity_class="credential",
            protection_mode="mask",
            created_by="tester",
        )
    )
    return stream, destination


def test_stream_delete_impact_discloses_all_destroyed_history(client: TestClient, db_session: Session) -> None:
    stream, _ = _seed_full_stream(db_session, "e130-impact")
    other, _ = _seed_full_stream(db_session, "e130-impact-other")
    db_session.commit()

    res = client.get(f"/api/v1/streams/{stream.id}/delete-impact")

    assert res.status_code == 200
    body = res.json()
    assert body == {
        "stream_id": stream.id,
        # held / not yet delivered (existing contract)
        "quarantined_events": 2,
        "pending_replay_jobs": 2,
        # E-130: history that is destroyed as well
        "resolved_quarantine_events": 3,
        "completed_replay_jobs": 3,
        "backfill_jobs": 3,
        "protection_rules": 1,
        "routes": 1,
        "delivery_logs": 4,
    }
    assert other.id != stream.id


def test_stream_delete_audit_records_full_history_counts(client: TestClient, db_session: Session) -> None:
    stream, destination = _seed_full_stream(db_session, "e130-audit")
    db_session.commit()
    stream_id = int(stream.id)
    destination_id = int(destination.id)

    res = client.delete(f"/api/v1/streams/{stream_id}")
    assert res.status_code == 204, res.text

    row = (
        db_session.query(AuditLog)
        .filter(AuditLog.action == "STREAM_DELETED", AuditLog.entity_id == stream_id)
        .one()
    )
    meta = row.metadata_json
    assert meta["quarantined_events_deleted"] == 2
    assert meta["pending_replay_jobs_deleted"] == 2
    assert meta["resolved_quarantine_events_deleted"] == 3
    assert meta["completed_replay_jobs_deleted"] == 3
    assert meta["backfill_jobs_deleted"] == 3
    assert meta["protection_rules_deleted"] == 1
    assert meta["routes_deleted"] == 1
    assert meta["delivery_logs_deleted"] == 4
    # The destination itself is kept.
    assert db_session.query(Destination).filter(Destination.id == destination_id).count() == 1


# --------------------------------------------------------------------------------------
# E-131 (cheap part): blocked connector delete gives an actionable, counted message
# --------------------------------------------------------------------------------------


def test_connector_delete_blocked_message_is_actionable(client: TestClient, db_session: Session) -> None:
    stream = _seed_stream(db_session, "e131-connector")
    db_session.commit()

    res = client.delete(f"/api/v1/connectors/{stream.connector_id}")

    assert res.status_code == 409
    detail = res.json()["detail"]
    assert detail["error_code"] == "CONNECTOR_HAS_STREAMS"
    message = detail["message"]
    assert message[0].isupper()
    assert "1 stream" in message
    # Reassigning a stream's connector is not possible from the browser: do not suggest it.
    assert "reassign" not in message.lower()
    assert detail["stream_count"] == 1
