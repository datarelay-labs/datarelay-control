"""Blast-radius truth for Route and Stream deletes. Isolated test database only."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.connectors.models import Connector
from app.database import get_db
from app.destinations.models import Destination
from app.enrichments.models import Enrichment
from app.logs.models import DeliveryLog
from app.main import app
from app.mappings.models import Mapping
from app.route_classification.models import RouteClassificationRule
from app.route_policy.models import RoutePolicyRule
from app.route_protection.models import RouteProtectionRule
from app.route_transform.models import RouteEnrichment, RouteMapping
from app.routes.models import Route
from app.runtime.models import RuntimeRouteSnapshot, RuntimeStreamSnapshot
from app.sensitive_detection.models import SENSITIVITY_CLASS_PII
from app.sources.models import Source
from app.streams.models import Stream


def _seed_connector_source(db: Session, name: str) -> tuple[Connector, Source]:
    connector = Connector(name=name, description=None, status="STOPPED")
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
    db.flush()
    return connector, source


def _seed_stream(
    db: Session,
    *,
    connector: Connector,
    source: Source,
    name: str,
    status: str = "STOPPED",
) -> Stream:
    stream = Stream(
        name=name,
        connector_id=connector.id,
        source_id=source.id,
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=60,
        enabled=True,
        status=status,
        rate_limit_json={},
    )
    db.add(stream)
    db.flush()
    return stream


def _seed_destination(db: Session, name: str) -> Destination:
    dest = Destination(
        name=name,
        destination_type="SYSLOG_UDP",
        config_json={"host": "127.0.0.1", "port": 5514},
        rate_limit_json={},
        enabled=True,
    )
    db.add(dest)
    db.flush()
    return dest


def _seed_route(db: Session, *, stream: Stream, destination: Destination, enabled: bool) -> Route:
    route = Route(
        stream_id=stream.id,
        destination_id=destination.id,
        enabled=enabled,
        failure_policy="LOG_AND_CONTINUE",
        formatter_config_json={},
        rate_limit_json={},
        status="ENABLED" if enabled else "DISABLED",
    )
    db.add(route)
    db.flush()
    return route


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def test_route_delete_blocked_while_enabled(client: TestClient, db_session: Session) -> None:
    connector, source = _seed_connector_source(db_session, "route-blast-connector")
    stream = _seed_stream(db_session, connector=connector, source=source, name="route-blast-stream")
    destination = _seed_destination(db_session, "route-blast-dest")
    route = _seed_route(db_session, stream=stream, destination=destination, enabled=True)
    db_session.commit()

    res = client.delete(f"/api/v1/routes/{route.id}")
    assert res.status_code == 409
    assert res.json()["detail"]["error_code"] == "ROUTE_DELETE_WHILE_ENABLED"
    assert db_session.query(Route).filter(Route.id == route.id).first() is not None


def test_route_delete_removes_scoped_state_and_detaches_delivery_history(
    client: TestClient, db_session: Session
) -> None:
    connector, source = _seed_connector_source(db_session, "route-delete-connector")
    stream = _seed_stream(db_session, connector=connector, source=source, name="route-delete-stream")
    destination = _seed_destination(db_session, "route-delete-dest")
    route = _seed_route(db_session, stream=stream, destination=destination, enabled=False)
    db_session.add(RouteMapping(route_id=route.id, field_mappings_json={"message": "$.message"}))
    db_session.add(
        RouteEnrichment(route_id=route.id, enrichment_json={"site": "lab"}, override_policy="KEEP_EXISTING")
    )
    db_session.add(
        RouteProtectionRule(
            route_id=route.id,
            field_path="$.email",
            sensitivity_class=SENSITIVITY_CLASS_PII,
            protection_mode="MASK",
            enabled=True,
            created_by="test",
        )
    )
    db_session.add(
        RouteClassificationRule(
            route_id=route.id,
            name="route-class",
            enabled=True,
            condition_json={"sensitivity_class": SENSITIVITY_CLASS_PII},
            classification_level="CONFIDENTIAL",
        )
    )
    db_session.add(
        RoutePolicyRule(
            route_id=route.id,
            name="route-policy",
            enabled=True,
            condition_json={"sensitivity_class": SENSITIVITY_CLASS_PII},
            action_type="QUARANTINE",
        )
    )
    db_session.add(
        RuntimeRouteSnapshot(route_id=route.id, stream_id=stream.id, destination_id=destination.id)
    )
    log = DeliveryLog(
        connector_id=connector.id,
        stream_id=stream.id,
        route_id=route.id,
        destination_id=destination.id,
        stage="route_send_success",
        level="INFO",
        message="kept-history",
    )
    db_session.add(log)
    db_session.commit()
    route_id = int(route.id)
    log_id = int(log.id)
    stream_id = int(stream.id)
    destination_id = int(destination.id)

    res = client.delete(f"/api/v1/routes/{route_id}")
    assert res.status_code == 204
    db_session.expire_all()

    assert db_session.query(Route).filter(Route.id == route_id).first() is None
    assert db_session.query(RouteMapping).filter(RouteMapping.route_id == route_id).first() is None
    assert db_session.query(RouteEnrichment).filter(RouteEnrichment.route_id == route_id).first() is None
    assert db_session.query(RouteProtectionRule).filter(RouteProtectionRule.route_id == route_id).first() is None
    assert (
        db_session.query(RouteClassificationRule).filter(RouteClassificationRule.route_id == route_id).first()
        is None
    )
    assert db_session.query(RoutePolicyRule).filter(RoutePolicyRule.route_id == route_id).first() is None
    assert db_session.query(RuntimeRouteSnapshot).filter(RuntimeRouteSnapshot.route_id == route_id).first() is None
    kept = db_session.query(DeliveryLog).filter(DeliveryLog.id == log_id).first()
    assert kept is not None
    assert kept.route_id is None
    assert kept.stream_id == stream_id
    assert db_session.query(Stream).filter(Stream.id == stream_id).first() is not None
    assert db_session.query(Destination).filter(Destination.id == destination_id).first() is not None


def test_stream_delete_blocked_while_running(client: TestClient, db_session: Session) -> None:
    connector, source = _seed_connector_source(db_session, "stream-running-connector")
    stream = _seed_stream(
        db_session, connector=connector, source=source, name="stream-running", status="RUNNING"
    )
    db_session.commit()

    res = client.delete(f"/api/v1/streams/{stream.id}")
    assert res.status_code == 409
    assert res.json()["detail"]["error_code"] == "STREAM_DELETE_BLOCKED_RUNNING"
    assert db_session.query(Stream).filter(Stream.id == stream.id).first() is not None


def test_stream_delete_removes_dependents_and_preserves_connector_source_destination(
    client: TestClient, db_session: Session
) -> None:
    connector, source = _seed_connector_source(db_session, "stream-delete-connector")
    stream = _seed_stream(db_session, connector=connector, source=source, name="stream-to-delete")
    other = _seed_stream(db_session, connector=connector, source=source, name="stream-kept")
    destination = _seed_destination(db_session, "stream-delete-dest")
    route = _seed_route(db_session, stream=stream, destination=destination, enabled=True)
    other_route = _seed_route(db_session, stream=other, destination=destination, enabled=True)
    db_session.add(Mapping(stream_id=stream.id, field_mappings_json={"message": "$.message"}))
    db_session.add(Enrichment(stream_id=stream.id, enrichment_json={"site": "lab"}))
    db_session.add(Checkpoint(stream_id=stream.id, checkpoint_type="CUSTOM_FIELD", checkpoint_value_json={"cursor": "1"}))
    db_session.add(RouteMapping(route_id=route.id, field_mappings_json={"message": "$.message"}))
    db_session.add(RouteEnrichment(route_id=route.id, enrichment_json={"site": "lab"}))
    db_session.add(
        RouteProtectionRule(
            route_id=route.id,
            field_path="$.email",
            sensitivity_class=SENSITIVITY_CLASS_PII,
            protection_mode="MASK",
            enabled=True,
            created_by="test",
        )
    )
    db_session.add(
        RouteClassificationRule(
            route_id=route.id,
            name="stream-route-class",
            enabled=True,
            condition_json={"sensitivity_class": SENSITIVITY_CLASS_PII},
            classification_level="CONFIDENTIAL",
        )
    )
    db_session.add(
        RoutePolicyRule(
            route_id=route.id,
            name="stream-route-policy",
            enabled=True,
            condition_json={"sensitivity_class": SENSITIVITY_CLASS_PII},
            action_type="QUARANTINE",
        )
    )
    db_session.add(RuntimeStreamSnapshot(stream_id=stream.id))
    db_session.add(RuntimeRouteSnapshot(route_id=route.id, stream_id=stream.id, destination_id=destination.id))
    doomed_route_log = DeliveryLog(
        connector_id=connector.id,
        stream_id=stream.id,
        route_id=route.id,
        destination_id=destination.id,
        stage="route_send_success",
        level="INFO",
        message="doomed-route-history",
    )
    doomed_stream_log = DeliveryLog(
        connector_id=connector.id,
        stream_id=stream.id,
        route_id=None,
        destination_id=None,
        stage="run_started",
        level="INFO",
        message="doomed-stream-history",
    )
    kept_log = DeliveryLog(
        connector_id=connector.id,
        stream_id=other.id,
        route_id=other_route.id,
        destination_id=destination.id,
        stage="route_send_success",
        level="INFO",
        message="kept-history",
    )
    db_session.add_all([doomed_route_log, doomed_stream_log, kept_log])
    db_session.commit()

    stream_id = int(stream.id)
    other_id = int(other.id)
    route_id = int(route.id)
    other_route_id = int(other_route.id)
    destination_id = int(destination.id)
    connector_id = int(connector.id)
    source_id = int(source.id)
    kept_log_id = int(kept_log.id)

    res = client.delete(f"/api/v1/streams/{stream_id}")
    assert res.status_code == 204
    db_session.expire_all()

    assert db_session.query(Stream).filter(Stream.id == stream_id).first() is None
    assert db_session.query(Route).filter(Route.id == route_id).first() is None
    assert db_session.query(Mapping).filter(Mapping.stream_id == stream_id).first() is None
    assert db_session.query(Enrichment).filter(Enrichment.stream_id == stream_id).first() is None
    assert db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).first() is None
    assert db_session.query(RouteMapping).filter(RouteMapping.route_id == route_id).first() is None
    assert db_session.query(RouteEnrichment).filter(RouteEnrichment.route_id == route_id).first() is None
    assert db_session.query(RouteProtectionRule).filter(RouteProtectionRule.route_id == route_id).first() is None
    assert (
        db_session.query(RouteClassificationRule).filter(RouteClassificationRule.route_id == route_id).first()
        is None
    )
    assert db_session.query(RoutePolicyRule).filter(RoutePolicyRule.route_id == route_id).first() is None
    assert db_session.query(RuntimeStreamSnapshot).filter(RuntimeStreamSnapshot.stream_id == stream_id).first() is None
    assert db_session.query(RuntimeRouteSnapshot).filter(RuntimeRouteSnapshot.route_id == route_id).first() is None
    assert db_session.query(DeliveryLog).filter(DeliveryLog.stream_id == stream_id).first() is None
    assert db_session.query(DeliveryLog).filter(DeliveryLog.route_id == route_id).first() is None

    assert db_session.query(Connector).filter(Connector.id == connector_id).first() is not None
    assert db_session.query(Source).filter(Source.id == source_id).first() is not None
    assert db_session.query(Destination).filter(Destination.id == destination_id).first() is not None
    assert db_session.query(Stream).filter(Stream.id == other_id).first() is not None
    assert db_session.query(Route).filter(Route.id == other_route_id).first() is not None
    kept = db_session.query(DeliveryLog).filter(DeliveryLog.id == kept_log_id).first()
    assert kept is not None
    assert kept.route_id == other_route_id
