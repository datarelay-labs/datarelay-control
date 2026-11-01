"""Stream runtime snapshot/bucket read path — no delivery_logs COUNT/GROUP BY."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.connectors.models import Connector
from app.destinations.models import Destination
from app.routes.models import Route
from app.runtime.models import RuntimeDestinationSnapshot, RuntimeRouteSnapshot, RuntimeStreamSnapshot
from app.runtime.stream_runtime_snapshot_read import (
    build_stream_stats_health_from_snapshot,
    try_build_stream_runtime_metrics,
)
from app.sources.models import Source
from app.streams.models import Stream

UTC = timezone.utc

pytestmark = pytest.mark.usefixtures("runtime_analytics_bucket_disabled")


def _seed_stream_with_snapshot(db: Session) -> int:
    connector = Connector(name="snap-read-conn", description=None, status="RUNNING")
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
    stream = Stream(
        connector_id=connector.id,
        source_id=source.id,
        name="snap-read-stream",
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=60,
        enabled=True,
        status="RUNNING",
        rate_limit_json={},
    )
    db.add(stream)
    db.flush()
    dest = Destination(
        name="snap-read-dest",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://example.test/hook"},
        rate_limit_json={},
        enabled=True,
    )
    db.add(dest)
    db.flush()
    route = Route(
        stream_id=stream.id,
        destination_id=dest.id,
        enabled=True,
        failure_policy="LOG_AND_CONTINUE",
        formatter_config_json={},
        rate_limit_json={},
        status="ENABLED",
    )
    db.add(route)
    db.flush()
    db.add(
        Checkpoint(
            stream_id=stream.id,
            checkpoint_type="CUSTOM",
            checkpoint_value_json={"cursor": "1"},
        )
    )
    now = datetime.now(UTC)
    db.add(
        RuntimeStreamSnapshot(
            stream_id=int(stream.id),
            enabled=True,
            health_status="HEALTHY",
            eps_1m=1.0,
            eps_5m=5.0,
            success_rate_5m=100.0,
            failure_rate_5m=0.0,
            retry_rate_5m=0.0,
            avg_latency_ms=42.0,
            route_count=1,
            healthy_route_count=1,
            failed_route_count=0,
            last_success_at=now,
            updated_at=now,
        )
    )
    db.add(
        RuntimeRouteSnapshot(
            route_id=int(route.id),
            stream_id=int(stream.id),
            destination_id=int(dest.id),
            enabled=True,
            health_status="HEALTHY",
            delivered_eps_1m=1.0,
            failed_eps_1m=0.0,
            success_rate_5m=100.0,
            retry_rate_5m=0.0,
            avg_latency_ms=42.0,
            last_success_at=now,
            updated_at=now,
        )
    )
    db.add(
        RuntimeDestinationSnapshot(
            destination_id=int(dest.id),
            enabled=True,
            health_status="HEALTHY",
            inbound_eps_1m=1.0,
            failed_eps_1m=0.0,
            avg_latency_ms=42.0,
            route_count=1,
            last_success_at=now,
            updated_at=now,
        )
    )
    db.commit()
    return int(stream.id)


def test_stats_health_from_snapshot_without_delivery_logs(
    db_session: Session,
    runtime_snapshot_read_enabled: None,
) -> None:
    stream_id = _seed_stream_with_snapshot(db_session)

    bundle = build_stream_stats_health_from_snapshot(
        db_session,
        stream_id,
        limit=20,
        window="1h",
    )
    assert bundle is not None
    assert bundle.stats.stream_id == stream_id
    assert bundle.stats.summary.route_send_success >= 0
    assert bundle.health.health == "HEALTHY"
    assert len(bundle.stats.routes) == 1


def test_metrics_from_operational_snapshot(
    db_session: Session,
    runtime_snapshot_read_enabled: None,
) -> None:
    stream_id = _seed_stream_with_snapshot(db_session)

    metrics = try_build_stream_runtime_metrics(db_session, stream_id, window="1h")
    assert metrics is not None
    assert metrics.stream.id == stream_id
    assert metrics.stream.name == "snap-read-stream"
    assert metrics.kpis.delivered_last_hour >= 0
    assert len(metrics.route_runtime) == 1
