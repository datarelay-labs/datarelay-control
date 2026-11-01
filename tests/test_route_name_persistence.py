"""F-145: the Route name and description the editor collects are persisted and read back."""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from tests.test_routes_crud_endpoints import (  # noqa: F401  (fixture re-exported for pytest)
    _put_route,
    _seed_stream_destination,
    client,
)


def test_route_name_and_description_round_trip(client: TestClient, db_session: Session) -> None:
    stream, destination = _seed_stream_destination(db_session)
    created = client.post(
        "/api/v1/routes/",
        json={
            "stream_id": stream.id,
            "destination_id": destination.id,
            "name": "  Primary delivery  ",
            "description": "Sends everything to the SIEM",
        },
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["name"] == "Primary delivery"
    assert body["description"] == "Sends everything to the SIEM"

    fetched = client.get(f"/api/v1/routes/{body['id']}").json()
    assert fetched["name"] == "Primary delivery"

    renamed = _put_route(client, body["id"], {"name": "Renamed route"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "Renamed route"
    assert renamed.json()["description"] == "Sends everything to the SIEM"

    cleared = _put_route(client, body["id"], {"name": "   "})
    assert cleared.status_code == 200
    assert cleared.json()["name"] is None


def test_route_name_is_optional_for_api_compatibility(client: TestClient, db_session: Session) -> None:
    stream, destination = _seed_stream_destination(db_session)
    created = client.post("/api/v1/routes/", json={"stream_id": stream.id, "destination_id": destination.id})
    assert created.status_code == 201, created.text
    assert created.json()["name"] is None


def test_route_name_over_255_chars_is_a_field_error(client: TestClient, db_session: Session) -> None:
    stream, destination = _seed_stream_destination(db_session)
    response = client.post(
        "/api/v1/routes/",
        json={"stream_id": stream.id, "destination_id": destination.id, "name": "R" * 300},
    )
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "name"]
