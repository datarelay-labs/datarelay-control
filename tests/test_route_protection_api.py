"""Route protection operator API (M13.3 P2)."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database import get_db, get_db_read_bounded
from app.main import app
from app.protection.models import PROTECTION_MODE_FULL_MASK, PROTECTION_MODE_PARTIAL_MASK, StreamProtectionRule
from app.route_protection.models import RouteProtectionRule
from app.sensitive_detection.models import SENSITIVITY_CLASS_PII, SENSITIVITY_CLASS_SECRET
from tests.test_runtime_logs_page_endpoint import _seed_stream_two_routes


@pytest.fixture
def route_protection_client(db_session: Session) -> TestClient:
    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_db_read_bounded] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_db_read_bounded, None)


def _seed_stream_protection(db: Session, stream_id: int) -> None:
    db.add(
        StreamProtectionRule(
            stream_id=stream_id,
            field_path="$.email",
            sensitivity_class=SENSITIVITY_CLASS_PII,
            protection_mode=PROTECTION_MODE_PARTIAL_MASK,
            enabled=True,
            created_by="test",
        )
    )
    db.commit()


def test_route_protection_rules_list_inherits_stream_when_no_route_rules(
    route_protection_client: TestClient,
    db_session: Session,
) -> None:
    h = _seed_stream_two_routes(db_session)
    _seed_stream_protection(db_session, h["stream_id"])
    route_id = h["route_a_id"]

    r = route_protection_client.get(f"/api/v1/runtime/routes/{route_id}/protection-rules")
    assert r.status_code == 200
    body = r.json()
    assert body["route_id"] == route_id
    assert body["stream_id"] == h["stream_id"]
    assert body["rule_count"] == 0
    assert body["rules"] == []


def test_route_protection_rules_create_patch_delete(
    route_protection_client: TestClient,
    db_session: Session,
) -> None:
    h = _seed_stream_two_routes(db_session)
    route_id = h["route_a_id"]

    created = route_protection_client.post(
        f"/api/v1/runtime/routes/{route_id}/protection-rules",
        json={
            "field_path": "$.secret",
            "sensitivity_class": "secret",
            "protection_mode": "full_mask",
            "enabled": True,
        },
    )
    assert created.status_code == 200
    rule_id = created.json()["rule"]["id"]

    listed = route_protection_client.get(f"/api/v1/runtime/routes/{route_id}/protection-rules")
    assert listed.json()["rule_count"] == 1
    assert listed.json()["rules"][0]["field_path"] == "$.secret"

    patched = route_protection_client.patch(
        f"/api/v1/runtime/routes/{route_id}/protection-rules/{rule_id}",
        json={"protection_mode": "tokenization"},
    )
    assert patched.status_code == 200
    assert patched.json()["rule"]["protection_mode"] == "tokenization"

    deleted = route_protection_client.delete(f"/api/v1/runtime/routes/{route_id}/protection-rules/{rule_id}")
    assert deleted.status_code == 204
    assert db_session.query(RouteProtectionRule).filter(RouteProtectionRule.route_id == route_id).count() == 0


def test_route_protection_rules_conflict(route_protection_client: TestClient, db_session: Session) -> None:
    h = _seed_stream_two_routes(db_session)
    route_id = h["route_a_id"]
    payload = {
        "field_path": "$.dup",
        "sensitivity_class": "pii",
        "protection_mode": "partial_mask",
        "enabled": True,
    }
    assert route_protection_client.post(f"/api/v1/runtime/routes/{route_id}/protection-rules", json=payload).status_code == 200
    conflict = route_protection_client.post(f"/api/v1/runtime/routes/{route_id}/protection-rules", json=payload)
    assert conflict.status_code == 409


def test_route_protection_rules_not_found(route_protection_client: TestClient) -> None:
    r = route_protection_client.get("/api/v1/runtime/routes/999999999/protection-rules")
    assert r.status_code == 404


def test_route_protection_rules_replace_all(
    route_protection_client: TestClient,
    db_session: Session,
) -> None:
    h = _seed_stream_two_routes(db_session)
    route_id = h["route_a_id"]
    created = route_protection_client.post(
        f"/api/v1/runtime/routes/{route_id}/protection-rules",
        json={
            "field_path": "$.email",
            "sensitivity_class": "pii",
            "protection_mode": "partial_mask",
            "enabled": True,
        },
    )
    assert created.status_code == 200

    replaced = route_protection_client.put(
        f"/api/v1/runtime/routes/{route_id}/protection-rules",
        json={
            "rules": [
                {
                    "field_path": "$.ssn",
                    "sensitivity_class": "secret",
                    "protection_mode": "full_mask",
                    "enabled": True,
                }
            ]
        },
    )
    assert replaced.status_code == 200
    body = replaced.json()
    assert body["rule_count"] == 1
    assert body["rules"][0]["field_path"] == "$.ssn"
    assert body["rules"][0]["protection_mode"] == "full_mask"
    listed = route_protection_client.get(f"/api/v1/runtime/routes/{route_id}/protection-rules")
    assert [rule["field_path"] for rule in listed.json()["rules"]] == ["$.ssn"]


def test_route_protection_replace_failure_keeps_original_rows(
    route_protection_client: TestClient,
    db_session: Session,
) -> None:
    h = _seed_stream_two_routes(db_session)
    route_id = h["route_a_id"]
    created = route_protection_client.post(
        f"/api/v1/runtime/routes/{route_id}/protection-rules",
        json={
            "field_path": "$.email",
            "sensitivity_class": "pii",
            "protection_mode": "partial_mask",
            "enabled": True,
        },
    )
    assert created.status_code == 200
    original_id = created.json()["rule"]["id"]

    failed = route_protection_client.put(
        f"/api/v1/runtime/routes/{route_id}/protection-rules",
        json={
            "rules": [
                {
                    "field_path": "$.email",
                    "sensitivity_class": "pii",
                    "protection_mode": "hash",
                    "enabled": True,
                },
                {
                    "field_path": "$.email",
                    "sensitivity_class": "secret",
                    "protection_mode": "full_mask",
                    "enabled": True,
                },
            ]
        },
    )
    assert failed.status_code == 409
    db_session.expire_all()
    rows = db_session.query(RouteProtectionRule).filter(RouteProtectionRule.route_id == route_id).all()
    assert len(rows) == 1
    assert rows[0].id == original_id
    assert rows[0].field_path == "$.email"
    assert rows[0].protection_mode == "partial_mask"
    effective = route_protection_client.get(f"/api/v1/runtime/routes/{route_id}/protection/effective")
    assert effective.status_code == 200
    assert effective.json()["processing_status"] == "Overridden"


def test_route_protection_replace_read_back_failure_rolls_back(
    route_protection_client: TestClient,
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    h = _seed_stream_two_routes(db_session)
    route_id = h["route_a_id"]
    created = route_protection_client.post(
        f"/api/v1/runtime/routes/{route_id}/protection-rules",
        json={
            "field_path": "$.email",
            "sensitivity_class": "pii",
            "protection_mode": "partial_mask",
            "enabled": True,
        },
    )
    assert created.status_code == 200
    original_id = created.json()["rule"]["id"]

    from app.protection.operator_workflow import ProtectionRuleValidationError
    from app.route_protection import operator_workflow

    def fail_read_back(*_args: object, **_kwargs: object) -> tuple[int, list[dict[str, object]]]:
        raise ProtectionRuleValidationError("protection replace read-back mismatch")

    monkeypatch.setattr(operator_workflow, "list_route_protection_rules", fail_read_back)
    failed = route_protection_client.put(
        f"/api/v1/runtime/routes/{route_id}/protection-rules",
        json={
            "rules": [
                {
                    "field_path": "$.ssn",
                    "sensitivity_class": "secret",
                    "protection_mode": "full_mask",
                    "enabled": True,
                }
            ]
        },
    )
    assert failed.status_code == 400
    monkeypatch.undo()
    db_session.expire_all()
    rows = db_session.query(RouteProtectionRule).filter(RouteProtectionRule.route_id == route_id).all()
    assert len(rows) == 1
    assert rows[0].id == original_id
    assert rows[0].protection_mode == "partial_mask"
