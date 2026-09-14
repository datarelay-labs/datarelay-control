"""DATABASE_QUERY connector config_json build (secret merge from stored password key)."""

from __future__ import annotations

from fastapi import HTTPException

from app.connectors.router import _MASK, _build_database_query_config_json
from datetime import datetime, timezone

from app.connectors.schemas import ConnectorUpdate

_TOKEN = datetime(2026, 1, 1, tzinfo=timezone.utc)


def test_database_query_partial_update_preserves_password_when_omitted() -> None:
    existing = {
        "connector_type": "relational_database",
        "db_type": "POSTGRESQL",
        "host": "db.example",
        "port": 5432,
        "database": "app",
        "username": "reader",
        "password": "stored-secret",
        "ssl_mode": "PREFER",
        "connection_timeout_seconds": 20,
    }
    payload = ConnectorUpdate(name="renamed", expected_updated_at=_TOKEN)
    out = _build_database_query_config_json(payload, existing=existing, partial=True)
    assert out["password"] == "stored-secret"
    assert out["host"] == "db.example"
    assert out["database"] == "app"


def test_database_query_mask_password_reuses_stored() -> None:
    existing = {
        "connector_type": "relational_database",
        "db_type": "POSTGRESQL",
        "host": "127.0.0.1",
        "port": 5432,
        "database": "logs",
        "username": "u",
        "password": "real",
        "ssl_mode": "DISABLE",
        "connection_timeout_seconds": 15,
    }
    payload = ConnectorUpdate(db_password=_MASK, expected_updated_at=_TOKEN)
    out = _build_database_query_config_json(payload, existing=existing, partial=True)
    assert out["password"] == "real"


def test_database_query_rejects_non_postgresql() -> None:
    payload = ConnectorUpdate(
        host="127.0.0.1",
        db_type="MYSQL",
        database="logs",
        db_username="u",
        db_password="real",
        expected_updated_at=_TOKEN,
    )
    try:
        _build_database_query_config_json(payload, partial=False)
    except HTTPException as exc:
        assert exc.status_code == 422
        assert exc.detail["message"] == "db_type must be POSTGRESQL"
    else:  # pragma: no cover
        raise AssertionError("expected HTTPException")
