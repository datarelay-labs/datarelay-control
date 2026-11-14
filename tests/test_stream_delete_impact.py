"""F-234: stream delete must surface and audit the quarantined events and replay jobs it destroys."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.audit.models import AuditLog
from app.connectors.models import Connector
from app.database import get_db
from app.destinations.models import Destination
from app.main import app
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


def _seed_stream(db: Session, name: str) -> tuple[Stream, Destination]:
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
    destination = Destination(
        name=f"{name}-dest",
        destination_type="SYSLOG_UDP",
        config_json={"host": "127.0.0.1", "port": 5514},
        rate_limit_json={},
        enabled=True,
    )
    db.add(destination)
    db.flush()
    return stream, destination


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


def _seed_held_data(db: Session, stream: Stream, destination: Destination) -> None:
    for status in (
        QUARANTINE_STATUS_QUARANTINED,
        QUARANTINE_STATUS_QUARANTINED,
        QUARANTINE_STATUS_QUARANTINED,
        QUARANTINE_STATUS_RELEASED,
        QUARANTINE_STATUS_DISCARDED,
    ):
        _quarantine(db, stream, status)
    for status in (
        REPLAY_STATUS_PENDING,
        REPLAY_STATUS_PENDING,
        REPLAY_STATUS_FAILED,
        REPLAY_STATUS_REPLAYED,
        REPLAY_STATUS_DISCARDED,
    ):
        _replay(db, stream, destination, status)


def test_delete_impact_counts_only_open_quarantine_and_non_terminal_replay(
    client: TestClient, db_session: Session
) -> None:
    stream, destination = _seed_stream(db_session, "impact-stream")
    other, other_dest = _seed_stream(db_session, "impact-other")
    _seed_held_data(db_session, stream, destination)
    _quarantine(db_session, other, QUARANTINE_STATUS_QUARANTINED)
    _replay(db_session, other, other_dest, REPLAY_STATUS_PENDING)
    db_session.commit()

    res = client.get(f"/api/v1/streams/{stream.id}/delete-impact")
    assert res.status_code == 200
    body = res.json()
    assert body["stream_id"] == stream.id
    assert body["quarantined_events"] == 3
    assert body["pending_replay_jobs"] == 3
    # E-130: already-resolved history is reported separately (full coverage in
    # tests/test_delete_lifecycle_impact.py).
    assert body["resolved_quarantine_events"] == 2
    assert body["completed_replay_jobs"] == 2


def test_delete_impact_is_zero_for_a_stream_without_held_data(client: TestClient, db_session: Session) -> None:
    stream, _ = _seed_stream(db_session, "impact-empty")
    db_session.commit()
    res = client.get(f"/api/v1/streams/{stream.id}/delete-impact")
    assert res.status_code == 200
    assert res.json()["quarantined_events"] == 0
    assert res.json()["pending_replay_jobs"] == 0


def test_delete_impact_unknown_stream_is_404(client: TestClient) -> None:
    res = client.get("/api/v1/streams/987654/delete-impact")
    assert res.status_code == 404
    assert res.json()["detail"]["error_code"] == "STREAM_NOT_FOUND"


def test_stream_delete_audit_records_destroyed_quarantine_and_replay_counts(
    client: TestClient, db_session: Session
) -> None:
    stream, destination = _seed_stream(db_session, "impact-delete")
    _seed_held_data(db_session, stream, destination)
    db_session.commit()
    stream_id = int(stream.id)

    res = client.delete(f"/api/v1/streams/{stream_id}")
    assert res.status_code == 204

    # The data is gone with the stream (semantics unchanged) ...
    assert db_session.query(StreamQuarantineEvent).filter(StreamQuarantineEvent.stream_id == stream_id).count() == 0
    assert db_session.query(StreamReplayEvent).filter(StreamReplayEvent.stream_id == stream_id).count() == 0
    # ... and the audit trail says exactly what was destroyed.
    row = (
        db_session.query(AuditLog)
        .filter(AuditLog.action == "STREAM_DELETED", AuditLog.entity_id == stream_id)
        .one()
    )
    assert row.metadata_json["quarantined_events_deleted"] == 3
    assert row.metadata_json["pending_replay_jobs_deleted"] == 3
    assert row.metadata_json["entity_name"] == "impact-delete"


def test_stream_delete_audit_records_zero_counts_when_nothing_was_held(
    client: TestClient, db_session: Session
) -> None:
    stream, _ = _seed_stream(db_session, "impact-delete-empty")
    db_session.commit()
    stream_id = int(stream.id)
    assert client.delete(f"/api/v1/streams/{stream_id}").status_code == 204
    row = db_session.query(AuditLog).filter(AuditLog.action == "STREAM_DELETED", AuditLog.entity_id == stream_id).one()
    assert row.metadata_json["quarantined_events_deleted"] == 0
    assert row.metadata_json["pending_replay_jobs_deleted"] == 0
