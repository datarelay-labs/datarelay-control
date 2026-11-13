"""F-199: alert webhook URLs and the notification e-mail are not readable by non-administrators.

Who may call the endpoint is unchanged (every role can still GET); only the sensitive values are
redacted for roles that may not manage alert settings.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.auth.jwt_service import issue_access_token
from app.database import get_db
from app.main import app
from app.platform_admin.models import PlatformAuditEvent

WEBHOOK_URL = "https://hooks.example.test/services/T000/B000/ALERTPATHTOKEN9f8e7d6c"
SLACK_URL = "https://hooks.slack.example.test/services/SLACKPATHTOKEN1a2b3c4d"
EMAIL = "oncall-team@example.test"


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
    token, _ = issue_access_token(username=f"{role.lower()}-alert", user_id=1, role=role, token_version=1)
    return {"Authorization": f"Bearer {token}"}


def _configure(client: TestClient) -> None:
    res = client.put(
        "/api/v1/admin/alert-settings",
        headers=_bearer("ADMINISTRATOR"),
        json={"webhook_url": WEBHOOK_URL, "slack_webhook_url": SLACK_URL, "email_to": EMAIL},
    )
    assert res.status_code == 200, res.text


def test_administrator_still_reads_alert_settings_in_clear(client: TestClient) -> None:
    _configure(client)
    res = client.get("/api/v1/admin/alert-settings", headers=_bearer("ADMINISTRATOR"))
    assert res.status_code == 200
    body = res.json()
    assert body["webhook_url"] == WEBHOOK_URL
    assert body["slack_webhook_url"] == SLACK_URL
    assert body["email_to"] == EMAIL


@pytest.mark.parametrize(
    "role",
    ["VIEWER", "OPERATOR", "GOVERNANCE_AUDITOR", "CONNECTOR_OPERATOR"],
)
def test_non_administrators_get_redacted_alert_settings(client: TestClient, role: str) -> None:
    _configure(client)
    res = client.get("/api/v1/admin/alert-settings", headers=_bearer(role))
    # Access rules are unchanged: roles that could read before still can (200); only values differ.
    assert res.status_code == 200, (role, res.text)
    text = res.text
    for secret in ("ALERTPATHTOKEN9f8e7d6c", "SLACKPATHTOKEN1a2b3c4d", "oncall-team"):
        assert secret not in text, (role, secret)
    body = res.json()
    assert body["webhook_url"].startswith("https://hooks.example.test")
    assert body["channel_status"]["webhook"] == "configured"
    assert body["channel_status"]["email"] == "configured"
    assert body["email_to"].endswith("@example.test")


def test_alert_settings_audit_event_does_not_store_urls(client: TestClient, db_session: Session) -> None:
    _configure(client)
    rows = db_session.query(PlatformAuditEvent).filter(PlatformAuditEvent.action == "ALERT_RULE_UPDATED").all()
    assert rows
    blob = str([r.details_json for r in rows])
    assert "ALERTPATHTOKEN9f8e7d6c" not in blob
    assert "SLACKPATHTOKEN1a2b3c4d" not in blob
    assert "oncall-team" not in blob
