"""Route classification operator API (M13.4 P2)."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.classification.models import StreamClassificationRule
from app.database import get_db, get_db_read_bounded
from app.main import app
from app.route_classification.models import RouteClassificationRule
from tests.test_runtime_logs_page_endpoint import _seed_stream_two_routes


@pytest.fixture
def route_classification_client(db_session: Session) -> TestClient:
    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_db_read_bounded] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_db_read_bounded, None)


def _seed_stream_classification(db: Session, stream_id: int) -> None:
    db.add(
        StreamClassificationRule(
            stream_id=stream_id,
            name="pii-internal",
            enabled=True,
            condition_json={"sensitivity_class": "pii"},
            classification_level="INTERNAL",
        )
    )
    db.commit()


def test_route_classification_rules_list_empty_when_no_route_rules(
    route_classification_client: TestClient,
    db_session: Session,
) -> None:
    h = _seed_stream_two_routes(db_session)
    _seed_stream_classification(db_session, h["stream_id"])
    route_id = h["route_a_id"]

    r = route_classification_client.get(f"/api/v1/runtime/routes/{route_id}/classification-rules")
    assert r.status_code == 200
    body = r.json()
    assert body["route_id"] == route_id
    assert body["stream_id"] == h["stream_id"]
    assert body["rule_count"] == 0
    assert body["rules"] == []


def test_route_classification_rules_create_patch_delete(
    route_classification_client: TestClient,
    db_session: Session,
) -> None:
    h = _seed_stream_two_routes(db_session)
    route_id = h["route_a_id"]

    created = route_classification_client.post(
        f"/api/v1/runtime/routes/{route_id}/classification-rules",
        json={
            "name": "secret-restricted",
            "enabled": True,
            "condition_json": {"sensitivity_class": "secret"},
            "classification_level": "RESTRICTED",
        },
    )
    assert created.status_code == 200
    rule_id = created.json()["rule"]["id"]

    listed = route_classification_client.get(f"/api/v1/runtime/routes/{route_id}/classification-rules")
    assert listed.json()["rule_count"] == 1
    assert listed.json()["rules"][0]["name"] == "secret-restricted"

    patched = route_classification_client.patch(
        f"/api/v1/runtime/routes/{route_id}/classification-rules/{rule_id}",
        json={"classification_level": "CONFIDENTIAL"},
    )
    assert patched.status_code == 200
    assert patched.json()["rule"]["classification_level"] == "CONFIDENTIAL"

    deleted = route_classification_client.delete(
        f"/api/v1/runtime/routes/{route_id}/classification-rules/{rule_id}"
    )
    assert deleted.status_code == 204
    assert (
        db_session.query(RouteClassificationRule).filter(RouteClassificationRule.route_id == route_id).count() == 0
    )


def test_route_classification_rules_invalid(route_classification_client: TestClient, db_session: Session) -> None:
    h = _seed_stream_two_routes(db_session)
    route_id = h["route_a_id"]
    r = route_classification_client.post(
        f"/api/v1/runtime/routes/{route_id}/classification-rules",
        json={
            "name": "bad",
            "enabled": True,
            "condition_json": {"sensitivity_class": "invalid"},
            "classification_level": "INTERNAL",
        },
    )
    assert r.status_code == 422


def test_route_classification_rules_not_found(route_classification_client: TestClient) -> None:
    r = route_classification_client.get("/api/v1/runtime/routes/999999999/classification-rules")
    assert r.status_code == 404


def test_route_classification_rules_replace_all(
    route_classification_client: TestClient,
    db_session: Session,
) -> None:
    h = _seed_stream_two_routes(db_session)
    route_id = h["route_a_id"]
    created = route_classification_client.post(
        f"/api/v1/runtime/routes/{route_id}/classification-rules",
        json={
            "name": "old",
            "enabled": True,
            "condition_json": {"sensitivity_class": "pii"},
            "classification_level": "INTERNAL",
        },
    )
    assert created.status_code == 200

    replaced = route_classification_client.put(
        f"/api/v1/runtime/routes/{route_id}/classification-rules",
        json={
            "rules": [
                {
                    "name": "Wizard route: secret classification",
                    "enabled": True,
                    "condition_json": {"sensitivity_class": "secret"},
                    "classification_level": "RESTRICTED",
                }
            ]
        },
    )
    assert replaced.status_code == 200
    assert replaced.json()["rule_count"] == 1
    assert replaced.json()["rules"][0]["classification_level"] == "RESTRICTED"
    listed = route_classification_client.get(f"/api/v1/runtime/routes/{route_id}/classification-rules")
    assert listed.json()["rules"][0]["name"] == "Wizard route: secret classification"


def test_route_classification_replace_failure_keeps_original_rows(
    route_classification_client: TestClient,
    db_session: Session,
) -> None:
    h = _seed_stream_two_routes(db_session)
    route_id = h["route_a_id"]
    created = route_classification_client.post(
        f"/api/v1/runtime/routes/{route_id}/classification-rules",
        json={
            "name": "keep-me",
            "enabled": True,
            "condition_json": {"sensitivity_class": "pii"},
            "classification_level": "CONFIDENTIAL",
        },
    )
    assert created.status_code == 200
    original_id = created.json()["rule"]["id"]

    failed = route_classification_client.put(
        f"/api/v1/runtime/routes/{route_id}/classification-rules",
        json={
            "rules": [
                {
                    "name": "bad",
                    "enabled": True,
                    "condition_json": {"sensitivity_class": "pii"},
                    "classification_level": "NOT_A_LEVEL",
                }
            ]
        },
    )
    assert failed.status_code == 422
    db_session.expire_all()
    rows = (
        db_session.query(RouteClassificationRule)
        .filter(RouteClassificationRule.route_id == route_id)
        .all()
    )
    assert len(rows) == 1
    assert rows[0].id == original_id
    assert rows[0].name == "keep-me"
    assert rows[0].classification_level == "CONFIDENTIAL"
    effective = route_classification_client.get(f"/api/v1/runtime/routes/{route_id}/classification/effective")
    assert effective.status_code == 200
    assert effective.json()["processing_status"] == "Overridden"


def test_route_classification_replace_read_back_failure_rolls_back(
    route_classification_client: TestClient,
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    h = _seed_stream_two_routes(db_session)
    route_id = h["route_a_id"]
    created = route_classification_client.post(
        f"/api/v1/runtime/routes/{route_id}/classification-rules",
        json={
            "name": "keep-me",
            "enabled": True,
            "condition_json": {"sensitivity_class": "pii"},
            "classification_level": "CONFIDENTIAL",
        },
    )
    assert created.status_code == 200
    original_id = created.json()["rule"]["id"]

    from app.classification.operator_workflow import ClassificationRuleValidationError
    from app.route_classification import operator_workflow

    def fail_read_back(*_args: object, **_kwargs: object) -> tuple[int, list[dict[str, object]]]:
        raise ClassificationRuleValidationError("classification replace read-back mismatch")

    monkeypatch.setattr(operator_workflow, "list_route_classification_rules", fail_read_back)
    failed = route_classification_client.put(
        f"/api/v1/runtime/routes/{route_id}/classification-rules",
        json={
            "rules": [
                {
                    "name": "replacement",
                    "enabled": True,
                    "condition_json": {"sensitivity_class": "secret"},
                    "classification_level": "RESTRICTED",
                }
            ]
        },
    )
    assert failed.status_code == 400
    monkeypatch.undo()
    db_session.expire_all()
    rows = (
        db_session.query(RouteClassificationRule)
        .filter(RouteClassificationRule.route_id == route_id)
        .all()
    )
    assert len(rows) == 1
    assert rows[0].id == original_id
    assert rows[0].classification_level == "CONFIDENTIAL"
