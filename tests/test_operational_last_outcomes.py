"""Last-outcome bulk loader hardening (24h window, scoped IDs, degraded on timeout)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import patch

import pytest
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.connectors.models import Connector
from app.destinations.models import Destination
from app.logs.models import DeliveryLog
from app.routes.models import Route
from app.runtime.operational_snapshot_repository import (
    _fetch_last_outcomes,
    fetch_route_last_outcomes,
    fetch_stream_last_outcomes,
)
from app.sources.models import Source
from app.streams.models import Stream

UTC = timezone.utc


def _mk_hierarchy(db: Session, *, stream_name: str = "lo-stream") -> dict[str, Any]:
    connector = Connector(name=f"conn-{stream_name}", description=None, status="RUNNING")
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
        name=stream_name,
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=60,
        enabled=True,
        status="RUNNING",
        rate_limit_json={},
    )
    db.add(stream)
    db.flush()
    destination = Destination(
        name=f"dest-{stream_name}",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://example.test/hook"},
        rate_limit_json={},
        enabled=True,
    )
    db.add(destination)
    db.flush()
    route = Route(
        stream_id=stream.id,
        destination_id=destination.id,
        enabled=True,
        failure_policy="LOG_AND_CONTINUE",
        formatter_config_json={},
        rate_limit_json={},
        status="ENABLED",
    )
    db.add(route)
    db.commit()
    return {
        "connector_id": connector.id,
        "stream_id": stream.id,
        "route_id": route.id,
        "destination_id": destination.id,
    }


def _log(
    db: Session,
    *,
    connector_id: int,
    stream_id: int,
    route_id: int,
    destination_id: int,
    stage: str,
    created_at: datetime,
    message: str = "delivery",
) -> None:
    db.add(
        DeliveryLog(
            connector_id=connector_id,
            stream_id=stream_id,
            route_id=route_id,
            destination_id=destination_id,
            stage=stage,
            level="INFO",
            status="OK",
            message=message,
            payload_sample={"event_count": 1},
            retry_count=0,
            created_at=created_at,
        )
    )


def test_fetch_last_outcomes_returns_recent_success_and_failure(db_session: Session) -> None:
    h = _mk_hierarchy(db_session)
    now = datetime.now(UTC)
    success_at = now - timedelta(minutes=10)
    failure_at = now - timedelta(minutes=5)
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_id"],
        destination_id=h["destination_id"],
        stage="route_send_success",
        created_at=success_at,
    )
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_id"],
        destination_id=h["destination_id"],
        stage="route_send_failed",
        created_at=failure_at,
        message="boom",
    )
    db_session.commit()

    stream_last = fetch_stream_last_outcomes(db_session, group_ids=[h["stream_id"]])
    route_last = fetch_route_last_outcomes(db_session, group_ids=[h["route_id"]])

    assert stream_last[h["stream_id"]].last_success_at == success_at
    assert stream_last[h["stream_id"]].last_failure_at == failure_at
    assert stream_last[h["stream_id"]].last_error_message == "boom"
    assert route_last[h["route_id"]].last_failure_at == failure_at


def test_fetch_last_outcomes_excludes_logs_older_than_24h(db_session: Session) -> None:
    h = _mk_hierarchy(db_session, stream_name="old-log-stream")
    now = datetime.now(UTC)
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_id"],
        destination_id=h["destination_id"],
        stage="route_send_success",
        created_at=now - timedelta(hours=30),
    )
    db_session.commit()

    stream_last = fetch_stream_last_outcomes(db_session, group_ids=[h["stream_id"]])
    assert h["stream_id"] not in stream_last


def test_fetch_last_outcomes_requires_group_ids(db_session: Session) -> None:
    assert _fetch_last_outcomes(
        db_session,
        group_column="stream_id",
        group_ids=[],
        failure_stages=("route_send_failed",),
    ) == {}


def test_fetch_last_outcomes_degraded_on_operational_error(db_session: Session) -> None:
    h = _mk_hierarchy(db_session, stream_name="degraded-stream")
    with patch.object(
        db_session,
        "execute",
        side_effect=OperationalError("statement", {}, Exception("timeout")),
    ):
        result = fetch_stream_last_outcomes(db_session, group_ids=[h["stream_id"]])
    assert result == {}


def test_fetch_stream_last_outcomes_includes_run_failed(db_session: Session) -> None:
    """Source outage stage run_failed must update stream last_failure (not route)."""

    h = _mk_hierarchy(db_session, stream_name="source-outage-stream")
    now = datetime.now(UTC)
    success_at = now - timedelta(minutes=20)
    failure_at = now - timedelta(minutes=2)
    _log(
        db_session,
        connector_id=h["connector_id"],
        stream_id=h["stream_id"],
        route_id=h["route_id"],
        destination_id=h["destination_id"],
        stage="route_send_success",
        created_at=success_at,
    )
    db_session.add(
        DeliveryLog(
            connector_id=h["connector_id"],
            stream_id=h["stream_id"],
            route_id=None,
            destination_id=None,
            stage="run_failed",
            level="ERROR",
            status="ERROR",
            message="HTTP polling failed after retries",
            payload_sample={},
            retry_count=0,
            created_at=failure_at,
        )
    )
    db_session.commit()

    stream_last = fetch_stream_last_outcomes(db_session, group_ids=[h["stream_id"]])
    route_last = fetch_route_last_outcomes(db_session, group_ids=[h["route_id"]])

    assert stream_last[h["stream_id"]].last_success_at == success_at
    assert stream_last[h["stream_id"]].last_failure_at == failure_at
    assert "HTTP polling failed" in (stream_last[h["stream_id"]].last_error_message or "")
    # Route posture remains delivery-only — source outage must not mark the route failed.
    assert route_last[h["route_id"]].last_success_at == success_at
    assert route_last[h["route_id"]].last_failure_at is None


def test_fetch_stream_window_aggregates_count_run_failed(db_session: Session) -> None:
    from app.runtime.operational_snapshot_repository import fetch_stream_window_aggregates

    h = _mk_hierarchy(db_session, stream_name="source-window-stream")
    now = datetime.now(UTC)
    db_session.add(
        DeliveryLog(
            connector_id=h["connector_id"],
            stream_id=h["stream_id"],
            route_id=None,
            destination_id=None,
            stage="run_failed",
            level="ERROR",
            status="ERROR",
            message="source down",
            payload_sample={},
            retry_count=0,
            created_at=now - timedelta(minutes=1),
        )
    )
    db_session.commit()
    agg = fetch_stream_window_aggregates(
        db_session, since=now - timedelta(minutes=5), until=now + timedelta(seconds=1)
    )
    assert h["stream_id"] in agg
    assert agg[h["stream_id"]].failure_count >= 1
    assert agg[h["stream_id"]].success_count == 0
