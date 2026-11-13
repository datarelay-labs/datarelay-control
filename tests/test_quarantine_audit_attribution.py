"""F-174: quarantine release/discard are attributed to the acting operator and audited once."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.audit.models import AuditLog
from app.auth.login_throttle import reset_login_throttle_for_tests
from app.auth.security import get_password_hash
from app.database import get_db, get_db_read_bounded
from app.governance_audit.service import get_governance_audit_detail, list_governance_audit_events
from app.main import app
from app.platform_admin.models import PlatformUser
from app.quarantine.models import (
    QUARANTINE_SOURCE_POLICY,
    QUARANTINE_STATUS_QUARANTINED,
    StreamQuarantineEvent,
)
from tests.test_stream_runner_e2e import _seed_stream_runtime

PASSWORD = "ExamplePassword9!"
OPERATOR = "quarantine-operator"


@pytest.fixture
def operator_client(db_session: Session):
    reset_login_throttle_for_tests()

    def override():
        yield db_session

    app.dependency_overrides[get_db] = override
    app.dependency_overrides[get_db_read_bounded] = override
    db_session.add(
        PlatformUser(
            username=OPERATOR,
            password_hash=get_password_hash(PASSWORD),
            role="ADMINISTRATOR",
            status="ACTIVE",
            token_version=1,
        )
    )
    db_session.commit()
    with TestClient(app) as client:
        login = client.post("/api/v1/auth/login", json={"username": OPERATOR, "password": PASSWORD})
        assert login.status_code == 200, login.text
        client.headers.update({"Authorization": "Bearer " + login.json()["access_token"]})
        yield client
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_db_read_bounded, None)
    reset_login_throttle_for_tests()


def _quarantine(db: Session, stream_id: int) -> StreamQuarantineEvent:
    now = datetime.now(timezone.utc)
    row = StreamQuarantineEvent(
        stream_id=int(stream_id),
        quarantine_reason="policy:Customer PII Policy",
        quarantine_source=QUARANTINE_SOURCE_POLICY,
        status=QUARANTINE_STATUS_QUARANTINED,
        protected_payload_json={"events": [{"classification_level": "RESTRICTED", "user": {"email": "tok_abc"}}]},
        metadata_json={"event_count": 1, "policy_names": ["Customer PII Policy"]},
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.commit()
    return row


def test_bulk_discard_is_attributed_audited_and_listed_once(
    operator_client: TestClient, db_session: Session
) -> None:
    stream_id = int(_seed_stream_runtime(db_session)["stream_id"])
    row = _quarantine(db_session, stream_id)

    resp = operator_client.post("/api/v1/governance/quarantine/discard", json={"ids": [row.id]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["succeeded"] == 1

    db_session.expire_all()
    refreshed = db_session.get(StreamQuarantineEvent, row.id)
    assert refreshed.status == "discarded"
    assert refreshed.released_by == OPERATOR

    audit = (
        db_session.query(AuditLog).filter(AuditLog.action == "QUARANTINE_EVENT_DISCARD").all()
    )
    assert len(audit) == 1
    assert audit[0].actor_username == OPERATOR
    assert audit[0].entity_id == row.id

    api_rows = operator_client.get("/api/v1/audit-logs", params={"action": "QUARANTINE_EVENT_DISCARD"})
    assert api_rows.status_code == 200, api_rows.text
    listed = api_rows.json()
    items = listed["items"] if isinstance(listed, dict) and "items" in listed else listed
    assert [i["actor_username"] for i in items] == [OPERATOR]

    entries = [
        e
        for e in list_governance_audit_events(db_session, window="24h")
        if e.event_type == "QUARANTINE_DISCARDED"
        and e.correlation_id.endswith(str(row.id))
    ]
    assert len(entries) == 1, [e.model_dump() for e in entries]

    detail = get_governance_audit_detail(db_session, entries[0].correlation_id, window="24h")
    discarded_steps = [step for step in detail.timeline if step.event_type == "QUARANTINE_DISCARDED"]
    assert len(discarded_steps) == 1
    assert discarded_steps[0].actor == OPERATOR


def test_single_discard_endpoint_records_the_operator(operator_client: TestClient, db_session: Session) -> None:
    stream_id = int(_seed_stream_runtime(db_session)["stream_id"])
    row = _quarantine(db_session, stream_id)

    resp = operator_client.post(f"/api/v1/runtime/quarantine-events/{row.id}/discard")
    assert resp.status_code == 200, resp.text
    db_session.expire_all()
    assert db_session.get(StreamQuarantineEvent, row.id).released_by == OPERATOR
