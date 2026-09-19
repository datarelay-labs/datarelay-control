from __future__ import annotations

from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.connectors.models import Connector
from app.destinations.models import Destination
from app.enrichments.models import Enrichment
from app.mappings.models import Mapping
from app.routes.models import Route
from app.routes.repository import get_enabled_routes_by_stream_id
from app.runners.stream_loader import load_stream_context
from app.sources.models import Source
from app.streams.models import Stream

def test_get_enabled_routes_by_stream_id_filters_enabled_and_stream_id(db_session: Session) -> None:
    db = db_session
    connector = Connector(name="c1", description=None, status="RUNNING")
    db.add(connector)
    db.flush()
    source = Source(connector_id=connector.id, source_type="HTTP_API_POLLING", config_json={}, auth_json={}, enabled=True)
    db.add(source)
    db.flush()
    stream1 = Stream(
        connector_id=connector.id,
        source_id=source.id,
        name="s1",
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=60,
        enabled=True,
        status="RUNNING",
        rate_limit_json={},
    )
    stream2 = Stream(
        connector_id=connector.id,
        source_id=source.id,
        name="s2",
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=60,
        enabled=True,
        status="RUNNING",
        rate_limit_json={},
    )
    db.add_all([stream1, stream2])
    db.flush()
    dst = Destination(name="d1", destination_type="WEBHOOK_POST", config_json={"url": "https://x"}, rate_limit_json={}, enabled=True)
    db.add(dst)
    db.flush()
    dst2 = Destination(name="d2", destination_type="WEBHOOK_POST", config_json={"url": "https://y"}, rate_limit_json={}, enabled=True)
    db.add(dst2)
    db.flush()
    db.add_all(
        [
            Route(stream_id=stream1.id, destination_id=dst.id, enabled=True, failure_policy="LOG_AND_CONTINUE", formatter_config_json={}, rate_limit_json={}, status="ENABLED"),
            Route(stream_id=stream1.id, destination_id=dst2.id, enabled=False, failure_policy="LOG_AND_CONTINUE", formatter_config_json={}, rate_limit_json={}, status="DISABLED"),
            Route(stream_id=stream2.id, destination_id=dst.id, enabled=True, failure_policy="LOG_AND_CONTINUE", formatter_config_json={}, rate_limit_json={}, status="ENABLED"),
        ]
    )
    db.commit()

    routes = get_enabled_routes_by_stream_id(db, stream1.id)
    assert len(routes) == 1
    assert routes[0].stream_id == stream1.id
    assert routes[0].enabled is True


def test_load_stream_context_success(db_session: Session) -> None:
    db = db_session
    connector = Connector(name="c1", description=None, status="RUNNING")
    db.add(connector)
    db.flush()
    source = Source(
        connector_id=connector.id,
        source_type="HTTP_API_POLLING",
        config_json={"base_url": "https://api.example.com"},
        auth_json={"token": "abc"},
        enabled=True,
    )
    db.add(source)
    db.flush()
    stream = Stream(
        connector_id=connector.id,
        source_id=source.id,
        name="alerts",
        stream_type="HTTP_API_POLLING",
        config_json={"endpoint": "/events"},
        polling_interval=60,
        enabled=True,
        status="RUNNING",
        rate_limit_json={},
    )
    db.add(stream)
    db.flush()
    db.add(Mapping(stream_id=stream.id, event_array_path="$.items", field_mappings_json={"event_id": "$.id"}, raw_payload_mode="JSON"))
    db.add(Enrichment(stream_id=stream.id, enrichment_json={"vendor": "Acme"}, override_policy="KEEP_EXISTING", enabled=True))
    dst = Destination(name="webhook-a", destination_type="WEBHOOK_POST", config_json={"url": "https://dest"}, rate_limit_json={}, enabled=True)
    db.add(dst)
    db.flush()
    route = Route(
        stream_id=stream.id,
        destination_id=dst.id,
        enabled=True,
        failure_policy="LOG_AND_CONTINUE",
        formatter_config_json={},
        rate_limit_json={},
        status="ENABLED",
    )
    db.add(route)
    db.add(Checkpoint(stream_id=stream.id, checkpoint_type="EVENT_ID", checkpoint_value_json={"last_id": "42"}))
    db.commit()

    context = load_stream_context(db, stream.id)
    assert context.stream["id"] == stream.id
    assert context.stream["field_mappings"] == {"event_id": "$.id"}
    assert context.routes[0]["rate_limit_json"] == {}
    assert context.routes[0]["destination"]["rate_limit_json"] == {}
    assert context.checkpoint == {"type": "EVENT_ID", "value": {"last_id": "42"}}
    assert route.id in context.destinations_by_route
    assert context.destinations_by_route[route.id].id == dst.id


def test_load_stream_context_protection_rules_survive_session_expire(db_session: Session) -> None:
    """Scheduler closes the load session; protection rules must not be live ORM rows."""

    from types import SimpleNamespace

    from app.protection.models import PROTECTION_MODE_PARTIAL_MASK, StreamProtectionRule
    from app.route_protection.resolver import resolve_route_protection_config
    from app.sensitive_detection.models import SENSITIVITY_CLASS_PII

    db = db_session
    connector = Connector(name="c-prot", description=None, status="RUNNING")
    db.add(connector)
    db.flush()
    source = Source(
        connector_id=connector.id,
        source_type="HTTP_API_POLLING",
        config_json={"base_url": "https://api.example.com"},
        auth_json={},
        enabled=True,
    )
    db.add(source)
    db.flush()
    stream = Stream(
        connector_id=connector.id,
        source_id=source.id,
        name="protected",
        stream_type="HTTP_API_POLLING",
        config_json={"endpoint": "/events"},
        polling_interval=15,
        enabled=True,
        status="RUNNING",
        rate_limit_json={},
    )
    db.add(stream)
    db.flush()
    dst = Destination(
        name="webhook-prot",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://dest"},
        rate_limit_json={},
        enabled=True,
    )
    db.add(dst)
    db.flush()
    route = Route(
        stream_id=stream.id,
        destination_id=dst.id,
        enabled=True,
        failure_policy="LOG_AND_CONTINUE",
        formatter_config_json={},
        rate_limit_json={},
        status="ENABLED",
    )
    db.add(route)
    db.add(
        StreamProtectionRule(
            stream_id=stream.id,
            field_path="$.email",
            sensitivity_class=SENSITIVITY_CLASS_PII,
            protection_mode=PROTECTION_MODE_PARTIAL_MASK,
            enabled=True,
            created_by="test",
        )
    )
    db.commit()

    context = load_stream_context(db, stream.id)
    db.expire_all()
    rules = context.stream["stream_protection_rules"]
    assert len(rules) == 1
    assert isinstance(rules[0], SimpleNamespace)
    assert rules[0].field_path == "$.email"
    assert rules[0].protection_mode == PROTECTION_MODE_PARTIAL_MASK
    cfg = resolve_route_protection_config(
        route_id=int(route.id),
        stream_id=int(stream.id),
        stream_protection_rules=rules,
    )
    assert cfg.rules
    assert cfg.rules[0].field_path == "$.email"


def test_load_stream_context_requires_enabled_routes(db_session: Session) -> None:
    db = db_session
    connector = Connector(name="c1", description=None, status="RUNNING")
    db.add(connector)
    db.flush()
    source = Source(connector_id=connector.id, source_type="HTTP_API_POLLING", config_json={}, auth_json={}, enabled=True)
    db.add(source)
    db.flush()
    stream = Stream(
        connector_id=connector.id,
        source_id=source.id,
        name="alerts",
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=60,
        enabled=True,
        status="RUNNING",
        rate_limit_json={},
    )
    db.add(stream)
    db.commit()

    import pytest

    with pytest.raises(ValueError, match="no enabled routes"):
        load_stream_context(db, stream.id)
