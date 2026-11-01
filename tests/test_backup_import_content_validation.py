"""F-211 / F-212 / F-221: import content is validated like the normal forms, and raw SQL is never shown."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.connectors.models import Connector
from app.database import get_db
from app.main import app
from app.mappings.models import Mapping
from app.sources.models import Source
from app.streams.models import Stream


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def _bundle(client: TestClient, db: Session) -> dict[str, Any]:
    c = Connector(name="cv-connector", description=None, status="STOPPED")
    db.add(c)
    db.flush()
    s = Source(connector_id=c.id, source_type="HTTP_API_POLLING", config_json={"base_url": "https://v.example"}, auth_json={"auth_type": "no_auth"}, enabled=True)
    db.add(s)
    db.flush()
    st = Stream(connector_id=c.id, source_id=s.id, name="cv-stream", stream_type="HTTP_API_POLLING", config_json={}, polling_interval=60, enabled=False, status="STOPPED", rate_limit_json={})
    db.add(st)
    db.flush()
    db.add(Mapping(stream_id=st.id, event_array_path="$.items", event_root_path=None, field_mappings_json={}, raw_payload_mode=None))
    db.commit()
    return client.get(f"/api/v1/backup/connectors/{c.id}/export").json()


def _codes(prev: dict[str, Any], key: str = "conflicts") -> list[str]:
    return [x["code"] for x in prev[key]]


def _preview(client: TestClient, bundle: dict[str, Any]) -> dict[str, Any]:
    res = client.post("/api/v1/backup/import/preview", json={"bundle": bundle, "mode": "additive"})
    assert res.status_code == 200, res.text
    return res.json()


def test_unmodified_bundle_still_previews_ok(client: TestClient, db_session: Session) -> None:
    assert _preview(client, _bundle(client, db_session))["ok"] is True


def test_overlong_stream_name_is_blocked_at_preview_without_echoing_the_value(client: TestClient, db_session: Session) -> None:
    bundle = _bundle(client, db_session)
    bundle["streams"][0]["name"] = "x" * 3000
    prev = _preview(client, bundle)
    assert prev["ok"] is False
    assert "FIELD_TOO_LONG" in _codes(prev)
    text = str(prev)
    assert "x" * 100 not in text
    assert "3000" in text and "255" in text


def test_overlong_connector_name_is_blocked_at_preview(client: TestClient, db_session: Session) -> None:
    bundle = _bundle(client, db_session)
    bundle["connectors"][0]["name"] = "c" * 300
    prev = _preview(client, bundle)
    assert prev["ok"] is False and "FIELD_TOO_LONG" in _codes(prev)


@pytest.mark.parametrize("bad", [-5, 0, "60", 1.5, True])
def test_invalid_polling_interval_is_blocked(client: TestClient, db_session: Session, bad: Any) -> None:
    bundle = _bundle(client, db_session)
    bundle["streams"][0]["polling_interval"] = bad
    prev = _preview(client, bundle)
    assert prev["ok"] is False
    assert "INVALID_POLLING_INTERVAL" in _codes(prev)


def test_empty_stream_and_connector_names_are_blocked(client: TestClient, db_session: Session) -> None:
    bundle = _bundle(client, db_session)
    bundle["streams"][0]["name"] = "  "
    bundle["connectors"][0]["name"] = ""
    prev = _preview(client, bundle)
    assert prev["ok"] is False
    assert {"STREAM_NAME_REQUIRED", "CONNECTOR_NAME_REQUIRED"} <= set(_codes(prev))


def test_unknown_stream_status_warns_that_streams_import_stopped(client: TestClient, db_session: Session) -> None:
    bundle = _bundle(client, db_session)
    bundle["streams"][0]["status"] = "EXPLODING"
    prev = _preview(client, bundle)
    assert prev["ok"] is True
    warning = next(w for w in prev["warnings"] if w["code"] == "UNKNOWN_STREAM_STATUS")
    assert "STOPPED" in warning["message"]


def test_apply_failure_never_returns_sql_or_bound_values(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.backup.router as backup_router

    def _boom(*_a: Any, **_k: Any) -> Any:
        raise RuntimeError(
            "(psycopg2.errors.StringDataRightTruncation) value too long [SQL: INSERT INTO streams (name) VALUES (%(name)s)] "
            "[parameters: {'name': 'SECRET-BOUND-VALUE'}]"
        )

    monkeypatch.setattr(backup_router, "apply_import", _boom)
    res = client.post(
        "/api/v1/backup/import/apply",
        json={"bundle": {"version": 2, "connectors": []}, "mode": "additive", "confirm": True, "preview_token": "x"},
    )
    assert res.status_code == 500
    detail = res.json()["detail"]
    assert detail["error_code"] == "IMPORT_APPLY_FAILED"
    for forbidden in ("INSERT", "SQL", "psycopg2", "SECRET-BOUND-VALUE", "parameters"):
        assert forbidden not in res.text
    assert "nothing was saved" in detail["message"]


def test_connector_name_over_255_characters_is_rejected_with_a_validation_error(client: TestClient) -> None:
    res = client.post(
        "/api/v1/connectors/",
        json={"name": "n" * 300, "auth_type": "no_auth", "base_url": "https://vendor.example.test"},
    )
    assert res.status_code == 422, res.text
    assert "255" in res.text
    assert "INSERT" not in res.text
