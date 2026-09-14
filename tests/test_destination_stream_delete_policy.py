"""Destination delete rules and stream delete cascade — isolated DB only."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.connectors.models import Connector
from app.database import get_db
from app.destinations.models import Destination
from app.main import app
from app.routes.models import Route
from app.sources.models import Source
from app.streams.models import Stream


def _seed_connector_source(db: Session) -> tuple[Connector, Source]:
    connector = Connector(name="del-pol-connector", description=None, status="RUNNING")
    db.add(connector)
    db.flush()
    source = Source(
        connector_id=connector.id,
        source_type="HTTP_API_POLLING",
        config_json={},
        auth_json={},
        enabled=True,
    )
    db.add(source)
    db.commit()
    db.refresh(connector)
    db.refresh(source)
    return connector, source


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def test_destination_delete_blocked_when_enabled(client: TestClient, db_session: Session) -> None:
    dest = Destination(
        name="enabled-dest",
        destination_type="SYSLOG_UDP",
        config_json={"host": "127.0.0.1", "port": 5514},
        rate_limit_json={},
        enabled=True,
    )
    db_session.add(dest)
    db_session.commit()
    db_session.refresh(dest)

    res = client.delete(f"/api/v1/destinations/{dest.id}")
    assert res.status_code == 409
    body = res.json()
    assert body["detail"]["error_code"] == "DESTINATION_DELETE_BLOCKED_ENABLED"


def test_destination_delete_blocked_when_route_exists(client: TestClient, db_session: Session) -> None:
    connector, source = _seed_connector_source(db_session)
    stream = Stream(
        name="route-holder",
        connector_id=connector.id,
        source_id=source.id,
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=60,
        enabled=True,
        status="STOPPED",
        rate_limit_json={},
    )
    db_session.add(stream)
    db_session.flush()
    dest = Destination(
        name="routed-dest",
        destination_type="SYSLOG_UDP",
        config_json={"host": "127.0.0.1", "port": 5514},
        rate_limit_json={},
        enabled=False,
    )
    db_session.add(dest)
    db_session.flush()
    route = Route(
        stream_id=stream.id,
        destination_id=dest.id,
        enabled=True,
        failure_policy="LOG_AND_CONTINUE",
        formatter_config_json={},
        rate_limit_json={},
        status="ENABLED",
    )
    db_session.add(route)
    db_session.commit()

    res = client.delete(f"/api/v1/destinations/{dest.id}")
    assert res.status_code == 409
    body = res.json()
    assert body["detail"]["error_code"] == "DESTINATION_DELETE_BLOCKED_IN_USE"


def test_destination_delete_ok_when_disabled_and_no_routes(client: TestClient, db_session: Session) -> None:
    dest = Destination(
        name="delete-me",
        destination_type="SYSLOG_UDP",
        config_json={"host": "127.0.0.1", "port": 5514},
        rate_limit_json={},
        enabled=False,
    )
    db_session.add(dest)
    db_session.commit()
    db_session.refresh(dest)

    res = client.delete(f"/api/v1/destinations/{dest.id}")
    assert res.status_code == 204
    assert db_session.query(Destination).filter(Destination.id == dest.id).first() is None


def test_stream_delete_blocked_when_running(client: TestClient, db_session: Session) -> None:
    connector, source = _seed_connector_source(db_session)
    stream = Stream(
        name="running-stream",
        connector_id=connector.id,
        source_id=source.id,
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=60,
        enabled=True,
        status="RUNNING",
        rate_limit_json={},
    )
    db_session.add(stream)
    db_session.commit()
    db_session.refresh(stream)

    res = client.delete(f"/api/v1/streams/{stream.id}")
    assert res.status_code == 409
    assert res.json()["detail"]["error_code"] == "STREAM_DELETE_BLOCKED_RUNNING"


def test_stream_delete_removes_stream_and_routes_only(client: TestClient, db_session: Session) -> None:
    connector, source = _seed_connector_source(db_session)
    stream = Stream(
        name="to-delete",
        connector_id=connector.id,
        source_id=source.id,
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=60,
        enabled=True,
        status="STOPPED",
        rate_limit_json={},
    )
    db_session.add(stream)
    db_session.flush()
    dest = Destination(
        name="kept-dest",
        destination_type="SYSLOG_UDP",
        config_json={"host": "127.0.0.1", "port": 5514},
        rate_limit_json={},
        enabled=True,
    )
    db_session.add(dest)
    db_session.flush()
    route = Route(
        stream_id=stream.id,
        destination_id=dest.id,
        enabled=True,
        failure_policy="LOG_AND_CONTINUE",
        formatter_config_json={},
        rate_limit_json={},
        status="ENABLED",
    )
    db_session.add(route)
    db_session.commit()
    sid = int(stream.id)
    did = int(dest.id)

    res = client.delete(f"/api/v1/streams/{sid}")
    assert res.status_code == 204

    assert db_session.query(Stream).filter(Stream.id == sid).first() is None
    assert db_session.query(Route).filter(Route.stream_id == sid).first() is None
    dest_after = db_session.query(Destination).filter(Destination.id == did).first()
    assert dest_after is not None
    assert dest_after.name == "kept-dest"


def test_destination_delete_blocked_when_failover_exists(client: TestClient, db_session: Session) -> None:
    from app.failover_routing.models import StreamFailoverRoute

    connector, source = _seed_connector_source(db_session)
    stream = Stream(
        name="failover-holder",
        connector_id=connector.id,
        source_id=source.id,
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=60,
        enabled=True,
        status="STOPPED",
        rate_limit_json={},
    )
    db_session.add(stream)
    db_session.flush()
    primary = Destination(
        name="failover-primary",
        destination_type="SYSLOG_UDP",
        config_json={"host": "127.0.0.1", "port": 5514},
        rate_limit_json={},
        enabled=False,
    )
    secondary = Destination(
        name="failover-secondary",
        destination_type="SYSLOG_UDP",
        config_json={"host": "127.0.0.1", "port": 5515},
        rate_limit_json={},
        enabled=False,
    )
    db_session.add_all([primary, secondary])
    db_session.flush()
    db_session.add(
        Route(
            stream_id=stream.id,
            destination_id=primary.id,
            enabled=True,
            failure_policy="LOG_AND_CONTINUE",
            formatter_config_json={},
            rate_limit_json={},
            status="ENABLED",
        )
    )
    db_session.add(
        StreamFailoverRoute(
            stream_id=stream.id,
            primary_destination_id=primary.id,
            secondary_destination_id=secondary.id,
            enabled=True,
        )
    )
    db_session.commit()

    # Primary still has a route — blocked as IN_USE first.
    res_primary = client.delete(f"/api/v1/destinations/{primary.id}")
    assert res_primary.status_code == 409

    # Secondary only referenced by failover.
    res = client.delete(f"/api/v1/destinations/{secondary.id}")
    assert res.status_code == 409
    body = res.json()
    assert body["detail"]["error_code"] == "DESTINATION_DELETE_BLOCKED_FAILOVER"
