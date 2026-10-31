"""F-188: the Governance Audit trail must render once the approval workflow produced events."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database import get_db, get_db_read_bounded
from app.governance_audit.models import AUDIT_EVENT_TYPES
from app.governance_audit.schemas import AuditEventType


@pytest.fixture
def governance_client(db_session: Session) -> TestClient:
    from app.governance.router import router

    app = FastAPI()
    app.include_router(router, prefix="/api/v1/governance")

    def _override_db():
        yield db_session

    app.dependency_overrides[get_db_read_bounded] = _override_db
    app.dependency_overrides[get_db] = _override_db
    return TestClient(app)


def _create_policy(client: TestClient, name: str) -> int:
    response = client.post(
        "/api/v1/governance/policies",
        json={
            "name": name,
            "description": "F-188",
            "category": "DATA_PROTECTION",
            "status": "DRAFT",
            "policy_json": {
                "conditions": [{"field": "classification", "operator": "equals", "value": "RESTRICTED"}],
                "actions": [{"type": "quarantine"}],
            },
        },
    )
    assert response.status_code == 201, response.text
    return int(response.json()["policy"]["id"])


def _post(client: TestClient, policy_id: int, action: str, **body: object) -> None:
    response = client.post(f"/api/v1/governance/approvals/{policy_id}/{action}", json=body)
    assert response.status_code == 200, response.text


def test_schema_literal_covers_every_audit_event_type() -> None:
    from typing import get_args

    assert set(get_args(AuditEventType)) == set(AUDIT_EVENT_TYPES)


def test_audit_lists_events_after_submit_reject_approve_activate(governance_client: TestClient) -> None:
    rejected = _create_policy(governance_client, "F188 rejected")
    _post(governance_client, rejected, "submit")
    _post(governance_client, rejected, "reject", comment="not yet")

    activated = _create_policy(governance_client, "F188 activated")
    _post(governance_client, activated, "submit")
    _post(governance_client, activated, "approve")
    _post(governance_client, activated, "activate")

    listed = governance_client.get("/api/v1/governance/audit?window=24h")
    assert listed.status_code == 200, listed.text
    body = listed.json()
    seen = {event["event_type"] for event in body["events"]}
    assert {"SUBMITTED_FOR_REVIEW", "REJECTED", "APPROVED", "APPROVAL_ACTIVATED"} <= seen

    for event_type in ("SUBMITTED_FOR_REVIEW", "REJECTED", "APPROVED", "APPROVAL_ACTIVATED"):
        filtered = governance_client.get(f"/api/v1/governance/audit?window=24h&event_type={event_type}")
        assert filtered.status_code == 200, filtered.text
        assert filtered.json()["total"] >= 1

    approval_entry = next(e for e in body["events"] if e["event_type"] == "APPROVAL_ACTIVATED")
    detail = governance_client.get(f"/api/v1/governance/audit/{approval_entry['correlation_id']}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["timeline"], "approval correlation detail must render a timeline"
