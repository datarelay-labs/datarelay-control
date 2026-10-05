"""OSS v1.0.1 Sprint 8 — replay list N+1 removal and index migration."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from sqlalchemy import event, inspect, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.governance_replay.service import list_governance_replay_events
from app.quarantine.models import (
    QUARANTINE_SOURCE_POLICY,
    QUARANTINE_STATUS_QUARANTINED,
    StreamQuarantineEvent,
)
from app.replay.models import (
    REPLAY_CONTEXT_ORIGIN_KEY,
    REPLAY_CONTEXT_ORIGIN_QUARANTINE,
    REPLAY_CONTEXT_QUARANTINE_EVENT_ID_KEY,
    REPLAY_STATUS_PENDING,
    StreamReplayEvent,
)
from tests.test_stream_runner_e2e import _seed_stream_runtime


def _count_db_queries(db_session: Session, fn: Any) -> tuple[Any, int]:
    engine = db_session.get_bind()
    count = {"n": 0}

    def _before(_conn: object, _cursor: object, _statement: str, _parameters: object, _context: object, _executemany: bool) -> None:
        count["n"] += 1

    event.listen(engine, "before_cursor_execute", _before)
    try:
        result = fn()
        return result, int(count["n"])
    finally:
        event.remove(engine, "before_cursor_execute", _before)


def _seed_many_replays(
    db_session: Session,
    *,
    count: int,
    with_quarantine: bool = False,
) -> dict[str, int]:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    destination_id = int(seeded["destination_ids"][0])
    route_id = int(seeded["route_ids"][0])
    now = datetime.now(timezone.utc)

    quarantine_id: int | None = None
    if with_quarantine:
        quarantine = StreamQuarantineEvent(
            stream_id=stream_id,
            quarantine_reason="policy_match",
            quarantine_source=QUARANTINE_SOURCE_POLICY,
            status=QUARANTINE_STATUS_QUARANTINED,
            protected_payload_json={"events": []},
            metadata_json={},
            created_at=now - timedelta(hours=2),
            updated_at=now - timedelta(hours=2),
        )
        db_session.add(quarantine)
        db_session.flush()
        quarantine_id = int(quarantine.id)

    for idx in range(count):
        created_at = now - timedelta(minutes=count - idx)
        db_session.add(
            StreamReplayEvent(
                stream_id=stream_id,
                destination_id=destination_id,
                route_id=route_id,
                delivery_kind="base_route",
                status=REPLAY_STATUS_PENDING,
                protected_payload_json={"events": [{"id": idx}]},
                delivery_context_json=(
                    {
                        "destination_type": "WEBHOOK",
                        REPLAY_CONTEXT_ORIGIN_KEY: REPLAY_CONTEXT_ORIGIN_QUARANTINE,
                        REPLAY_CONTEXT_QUARANTINE_EVENT_ID_KEY: quarantine_id,
                    }
                    if quarantine_id is not None
                    else {"destination_type": "WEBHOOK"}
                ),
                event_count=1,
                created_at=created_at,
                updated_at=created_at,
            )
        )
    db_session.commit()
    return {
        "stream_id": stream_id,
        "destination_id": destination_id,
        "route_id": route_id,
    }


def test_replay_list_query_count_does_not_scale_with_quarantine_lookups(db_session: Session) -> None:
    _seed_many_replays(db_session, count=100, with_quarantine=True)

    _, query_count = _count_db_queries(
        db_session,
        lambda: list_governance_replay_events(db_session, window="30d", limit=100),
    )

    # Without batching this would be ~100+ quarantine SELECTs on top of base queries.
    assert query_count <= 12


def test_replay_list_explicit_quarantine_correlation_preserved_with_batch_lookup(db_session: Session) -> None:
    ids = _seed_many_replays(db_session, count=3, with_quarantine=True)
    stream_id = ids["stream_id"]

    quarantine = db_session.execute(
        select(StreamQuarantineEvent).where(StreamQuarantineEvent.stream_id == stream_id)
    ).scalar_one()

    entries, _, _, _ = list_governance_replay_events(db_session, window="30d", limit=10)
    assert entries
    assert all(entry.correlation_id is not None for entry in entries)
    assert all(f"q-{quarantine.id}" in str(entry.correlation_id) for entry in entries)


def test_replay_index_migration_creates_expected_indexes(db_session: Session) -> None:
    bind = db_session.get_bind()
    inspector = inspect(bind)
    index_names = {idx["name"] for idx in inspector.get_indexes("stream_replay_events")}

    # Alembic test DB is stamped to head; indexes from Sprint 8 migration must exist.
    assert "idx_stream_replay_events_created_at_id" in index_names
    assert "idx_stream_replay_events_status_created_at_id" in index_names

    cols_created = db_session.execute(
        text(
            """
            SELECT indexdef
            FROM pg_indexes
            WHERE tablename = 'stream_replay_events'
              AND indexname = 'idx_stream_replay_events_created_at_id'
            """
        )
    ).scalar_one()
    assert "created_at" in cols_created
