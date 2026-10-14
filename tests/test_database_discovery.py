"""M6-01 saved DATABASE_QUERY metadata discovery contract."""

from __future__ import annotations

import pytest

from app.runtime.errors import PreviewRequestError, SourceFetchError
from app.runtime.preview_service import run_database_discovery
from app.runtime.schemas import DatabaseDiscoveryRequest


def test_database_discovery_requires_saved_connector_source(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.runtime.preview_service._load_source_config_for_connector",
        lambda _db, _connector_id: None,
    )

    with pytest.raises(PreviewRequestError) as exc:
        run_database_discovery(DatabaseDiscoveryRequest(connector_id=17), object())

    assert exc.value.status_code == 404
    assert exc.value.detail["error_type"] == "connector_source_not_found"


def test_database_discovery_rejects_non_database_connector(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.runtime.preview_service._load_source_config_for_connector",
        lambda _db, _connector_id: {
            "source_type": "HTTP_API_POLLING",
            "base_url": "https://example.invalid",
        },
    )

    with pytest.raises(PreviewRequestError) as exc:
        run_database_discovery(DatabaseDiscoveryRequest(connector_id=17), object())

    assert exc.value.status_code == 400
    assert exc.value.detail["error_type"] == "not_database_query"


def test_database_discovery_returns_only_bounded_metadata(monkeypatch: pytest.MonkeyPatch) -> None:
    saved = {
        "source_type": "DATABASE_QUERY",
        "db_type": "POSTGRESQL",
        "host": "127.0.0.1",
        "port": 5432,
        "database": "events",
        "username": "reader",
        "password": "stored-secret",
    }
    monkeypatch.setattr(
        "app.runtime.preview_service._load_source_config_for_connector",
        lambda _db, _connector_id: saved,
    )

    def _discover(config: dict[str, object]) -> dict[str, object]:
        assert config["password"] == "stored-secret"
        return {
            "db_type": "POSTGRESQL",
            "database": "events",
            "schemas": ["public"],
            "tables": [
                {
                    "schema_name": "public",
                    "table_name": "security_events",
                    "table_type": "BASE TABLE",
                    "columns": [
                        {
                            "name": "event_id",
                            "data_type": "text",
                            "nullable": False,
                            "ordinal_position": 1,
                        }
                    ],
                }
            ],
            "truncated": False,
        }

    monkeypatch.setattr("app.runtime.preview_service.discover_postgres_catalog", _discover)

    response = run_database_discovery(DatabaseDiscoveryRequest(connector_id=17), object())

    assert response.ok is True
    assert response.schemas == ["public"]
    assert response.tables[0].table_name == "security_events"
    assert response.tables[0].columns[0].name == "event_id"
    assert "stored-secret" not in response.model_dump_json()


def test_database_discovery_surfaces_connection_or_permission_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.runtime.preview_service._load_source_config_for_connector",
        lambda _db, _connector_id: {
            "source_type": "DATABASE_QUERY",
            "db_type": "POSTGRESQL",
            "host": "db.example",
            "port": 5432,
            "database": "events",
            "username": "reader",
            "password": "stored-secret",
        },
    )
    monkeypatch.setattr(
        "app.runtime.preview_service.discover_postgres_catalog",
        lambda _config: (_ for _ in ()).throw(SourceFetchError("PostgreSQL metadata discovery failed: permission denied")),
    )

    with pytest.raises(PreviewRequestError) as exc:
        run_database_discovery(DatabaseDiscoveryRequest(connector_id=17), object())

    assert exc.value.status_code == 400
    assert exc.value.detail["error_type"] == "database_discovery_failed"
    assert "permission denied" in exc.value.detail["message"]
