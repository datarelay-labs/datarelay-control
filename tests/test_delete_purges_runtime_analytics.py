"""F-229: deleting a stream, route or destination must not leave analytics rows that keep reporting it."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.connectors.models import Connector
from app.database import get_db
from app.destinations.models import Destination
from app.main import app
from app.platform_admin.models import PlatformAlertHistory
from app.routes.models import Route
from app.runtime.models import RuntimeAnalyticsBucket1m, RuntimeAnalyticsBucket5m
from app.sources.models import Source
from app.streams.models import Stream

_T0 = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def _seed(db: Session, name: str, *, route_enabled: bool = False, dest_enabled: bool = False):
    connector = Connector(name=f"{name}-connector", description=None, status="STOPPED")
    db.add(connector)
    db.flush()
    source = Source(
        connector_id=connector.id, source_type="HTTP_API_POLLING", config_json={}, auth_json={}, enabled=True
    )
    db.add(source)
    db.flush()
    stream = Stream(
        name=name,
        connector_id=connector.id,
        source_id=source.id,
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=60,
        enabled=False,
        status="STOPPED",
        rate_limit_json={},
    )
    db.add(stream)
    destination = Destination(
        name=f"{name}-dest",
        destination_type="SYSLOG_UDP",
        config_json={"host": "127.0.0.1", "port": 5514},
        rate_limit_json={},
        enabled=dest_enabled,
    )
    db.add(destination)
    db.flush()
    route = Route(
        stream_id=stream.id,
        destination_id=destination.id,
        enabled=route_enabled,
        failure_policy="LOG_AND_CONTINUE",
        status="DISABLED",
        formatter_config_json={},
        rate_limit_json={},
    )
    db.add(route)
    db.flush()
    return stream, route, destination


def _bucket_rows(db: Session, stream_id: int, route_id: int, destination_id: int) -> None:
    for model in (RuntimeAnalyticsBucket1m, RuntimeAnalyticsBucket5m):
        db.add(
            model(
                bucket_start=_T0,
                stream_id=stream_id,
                route_id=route_id,
                destination_id=destination_id,
                event_count=3,
                success_count=3,
            )
        )


def _alert(db: Session, stream_id: int, route_id: int, destination_id: int) -> None:
    db.add(
        PlatformAlertHistory(
            alert_type="STREAM_FAILING",
            severity="ERROR",
            stream_id=stream_id,
            route_id=route_id,
            destination_id=destination_id,
            message="delivery failing",
            fingerprint=f"fp-{stream_id}",
            delivery_status="SENT",
            payload_json={},
        )
    )


def _counts(db: Session, stream_id: int) -> tuple[int, int, int]:
    return (
        db.query(RuntimeAnalyticsBucket1m).filter(RuntimeAnalyticsBucket1m.stream_id == stream_id).count(),
        db.query(RuntimeAnalyticsBucket5m).filter(RuntimeAnalyticsBucket5m.stream_id == stream_id).count(),
        db.query(PlatformAlertHistory).filter(PlatformAlertHistory.stream_id == stream_id).count(),
    )


def test_stream_delete_purges_its_analytics_and_alert_history_only(client: TestClient, db_session: Session) -> None:
    doomed, doomed_route, doomed_dest = _seed(db_session, "wpc-purge-doomed")
    kept, kept_route, kept_dest = _seed(db_session, "wpc-purge-kept")
    for s, r, d in ((doomed, doomed_route, doomed_dest), (kept, kept_route, kept_dest)):
        _bucket_rows(db_session, s.id, r.id, d.id)
        _alert(db_session, s.id, r.id, d.id)
    db_session.commit()
    doomed_id, kept_id = doomed.id, kept.id
    assert _counts(db_session, doomed_id) == (1, 1, 1)

    assert client.delete(f"/api/v1/streams/{doomed_id}").status_code == 204

    assert _counts(db_session, doomed_id) == (0, 0, 0)
    assert _counts(db_session, kept_id) == (1, 1, 1)


def test_route_delete_purges_route_buckets_but_keeps_stream_alert_history(
    client: TestClient, db_session: Session
) -> None:
    stream, route, dest = _seed(db_session, "wpc-purge-route")
    other_stream, other_route, other_dest = _seed(db_session, "wpc-purge-route-other")
    _bucket_rows(db_session, stream.id, route.id, dest.id)
    _bucket_rows(db_session, other_stream.id, other_route.id, other_dest.id)
    _alert(db_session, stream.id, route.id, dest.id)
    db_session.commit()
    stream_id, route_id, other_id = stream.id, route.id, other_stream.id

    assert client.delete(f"/api/v1/routes/{route_id}").status_code == 204

    assert _counts(db_session, stream_id) == (0, 0, 1)
    assert _counts(db_session, other_id) == (1, 1, 0)


def test_destination_delete_purges_buckets_keyed_to_it(client: TestClient, db_session: Session) -> None:
    stream, route, dest = _seed(db_session, "wpc-purge-dest")
    _bucket_rows(db_session, stream.id, route.id, dest.id)
    db_session.commit()
    stream_id, route_id, dest_id = stream.id, route.id, dest.id
    db_session.query(Route).filter(Route.id == route_id).delete()
    db_session.commit()

    assert client.delete(f"/api/v1/destinations/{dest_id}").status_code == 204

    assert (
        db_session.query(RuntimeAnalyticsBucket1m)
        .filter(RuntimeAnalyticsBucket1m.destination_id == dest_id)
        .count()
        == 0
    )
    assert (
        db_session.query(RuntimeAnalyticsBucket5m)
        .filter(RuntimeAnalyticsBucket5m.destination_id == dest_id)
        .count()
        == 0
    )
    assert stream_id  # stream itself is untouched by a destination delete
