"""Route transform operator API (M13.2 P1)."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database import get_db, get_db_read_bounded
from app.enrichments.models import Enrichment
from app.main import app
from app.mappings.models import Mapping
from app.route_transform.models import RouteEnrichment, RouteMapping
from app.routes.models import Route
from tests.test_runtime_logs_page_endpoint import _seed_stream_two_routes


@pytest.fixture
def route_transform_client(db_session: Session) -> TestClient:
    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_db_read_bounded] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_db_read_bounded, None)


def _seed_stream_mapping(db: Session, stream_id: int) -> None:
    mapping = db.query(Mapping).filter(Mapping.stream_id == stream_id).first()
    if mapping is None:
        db.add(
            Mapping(
                stream_id=stream_id,
                event_array_path="$.items",
                event_root_path="$.event",
                field_mappings_json={"stream_field": "$.id"},
            )
        )
    else:
        mapping.event_array_path = "$.items"
        mapping.event_root_path = "$.event"
        mapping.field_mappings_json = {"stream_field": "$.id"}
    enrichment = db.query(Enrichment).filter(Enrichment.stream_id == stream_id).first()
    if enrichment is None:
        db.add(
            Enrichment(
                stream_id=stream_id,
                enrichment_json={"vendor": "stream"},
                override_policy="KEEP_EXISTING",
                enabled=True,
            )
        )
    else:
        enrichment.enrichment_json = {"vendor": "stream"}
        enrichment.override_policy = "KEEP_EXISTING"
        enrichment.enabled = True
    db.commit()


def test_route_mapping_ui_inherit_by_default(route_transform_client: TestClient, db_session: Session) -> None:
    h = _seed_stream_two_routes(db_session)
    _seed_stream_mapping(db_session, h["stream_id"])
    route_id = h["route_a_id"]

    r = route_transform_client.get(f"/api/v1/runtime/routes/{route_id}/mapping-ui/config")
    assert r.status_code == 200
    body = r.json()
    assert body["route_id"] == route_id
    assert body["stream_id"] == h["stream_id"]
    assert body["inherit_stream_mapping"] is True
    assert body["mapping"]["field_mappings"] == {"stream_field": "$.id"}
    assert body["stream_mapping"]["field_mappings"] == {"stream_field": "$.id"}


def test_route_mapping_ui_save_override(route_transform_client: TestClient, db_session: Session) -> None:
    h = _seed_stream_two_routes(db_session)
    _seed_stream_mapping(db_session, h["stream_id"])
    route_id = h["route_a_id"]

    save = route_transform_client.post(
        f"/api/v1/runtime/routes/{route_id}/mapping-ui/save",
        json={
            "inherit": False,
            "mapping": {"field_mappings": {"route_field": "$.route_id"}},
        },
    )
    assert save.status_code == 200
    assert save.json()["inherit_stream_mapping"] is False

    row = db_session.query(RouteMapping).filter(RouteMapping.route_id == route_id).one()
    assert row.field_mappings_json == {"route_field": "$.route_id"}

    cfg = route_transform_client.get(f"/api/v1/runtime/routes/{route_id}/mapping-ui/config")
    assert cfg.json()["inherit_stream_mapping"] is False
    assert cfg.json()["mapping"]["field_mappings"] == {"route_field": "$.route_id"}


def test_route_mapping_ui_save_empty_field_mappings_raw_payload_only(
    route_transform_client: TestClient,
    db_session: Session,
) -> None:
    """Route mapping override may persist empty field_mappings (raw-payload-only / empty row).

    Stream MappingUISaveMappingPayload still requires non-empty field_mappings; this
    contract is route-specific so empty route mapping rows are not forced to inherit.
    """
    h = _seed_stream_two_routes(db_session)
    _seed_stream_mapping(db_session, h["stream_id"])
    route_id = h["route_a_id"]

    save = route_transform_client.post(
        f"/api/v1/runtime/routes/{route_id}/mapping-ui/save",
        json={
            "inherit": False,
            "mapping": {
                "field_mappings": {},
                "raw_payload_mode": "include_raw",
            },
        },
    )
    assert save.status_code == 200, save.text
    assert save.json()["inherit_stream_mapping"] is False

    row = db_session.query(RouteMapping).filter(RouteMapping.route_id == route_id).one()
    assert row.field_mappings_json == {}
    assert row.raw_payload_mode == "include_raw"

    cfg = route_transform_client.get(f"/api/v1/runtime/routes/{route_id}/mapping-ui/config")
    body = cfg.json()
    assert body["inherit_stream_mapping"] is False
    assert body["mapping"]["field_mappings"] == {}
    assert body["mapping"]["raw_payload_mode"] == "include_raw"

    # Empty mapping row with null raw_payload_mode is also a valid persisted override.
    save_empty = route_transform_client.post(
        f"/api/v1/runtime/routes/{route_id}/mapping-ui/save",
        json={"inherit": False, "mapping": {"field_mappings": {}}},
    )
    assert save_empty.status_code == 200, save_empty.text
    row2 = db_session.query(RouteMapping).filter(RouteMapping.route_id == route_id).one()
    assert row2.field_mappings_json == {}
    assert row2.raw_payload_mode is None


def test_route_mapping_ui_save_inherit_clears_override(
    route_transform_client: TestClient,
    db_session: Session,
) -> None:
    h = _seed_stream_two_routes(db_session)
    _seed_stream_mapping(db_session, h["stream_id"])
    route_id = h["route_a_id"]

    route_transform_client.post(
        f"/api/v1/runtime/routes/{route_id}/mapping-ui/save",
        json={"inherit": False, "mapping": {"field_mappings": {"route_field": "$.x"}}},
    )
    clear = route_transform_client.post(
        f"/api/v1/runtime/routes/{route_id}/mapping-ui/save",
        json={"inherit": True},
    )
    assert clear.status_code == 200
    assert clear.json()["inherit_stream_mapping"] is True
    assert db_session.query(RouteMapping).filter(RouteMapping.route_id == route_id).first() is None


def test_route_enrichment_ui_save_override(route_transform_client: TestClient, db_session: Session) -> None:
    h = _seed_stream_two_routes(db_session)
    _seed_stream_mapping(db_session, h["stream_id"])
    route_id = h["route_a_id"]

    r = route_transform_client.get(f"/api/v1/runtime/routes/{route_id}/enrichment-ui/config")
    assert r.status_code == 200
    assert r.json()["inherit_stream_enrichment"] is True

    save = route_transform_client.post(
        f"/api/v1/runtime/routes/{route_id}/enrichment-ui/save",
        json={
            "inherit": False,
            "enrichment": {
                "enabled": True,
                "enrichment": {"vendor": "route"},
                "override_policy": "KEEP_EXISTING",
            },
        },
    )
    assert save.status_code == 200
    row = db_session.query(RouteEnrichment).filter(RouteEnrichment.route_id == route_id).one()
    assert row.enrichment_json == {"vendor": "route"}


def test_route_mapping_ui_not_found(route_transform_client: TestClient) -> None:
    r = route_transform_client.get("/api/v1/runtime/routes/999999999/mapping-ui/config")
    assert r.status_code == 404
