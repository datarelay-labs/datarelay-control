"""Isolated validation of partial-month delivery_logs retention (row DELETE vs DROP).

Uses the disposable pytest catalog only. Never touches live August/September data.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import settings
from app.connectors.models import Connector
from app.db.delivery_log_partitions import (
    calculate_delivery_log_partition_drop_targets,
    ensure_delivery_log_partitions,
)
from app.destinations.models import Destination
from app.logs.models import DeliveryLog
from app.platform_admin.repository import get_retention_policy_row
from app.retention import batch as retention_batch
from app.retention import service as retention_service
from app.retention.batch import _MAX_BATCH_ITERATIONS, batch_delete_by_time_before
from app.retention.service import preview_retention, run_operational_retention
from app.routes.models import Route
from app.sources.models import Source
from app.streams.models import Stream

UTC = timezone.utc

# Fixed clock for deterministic mixed-month math:
# retention_days=30 → cutoff = 2026-08-14T12:00:00Z → cutoff_month = 2026-08-01
# August month_end 2026-09-01 > cutoff_month → NOT drop-eligible (partial month)
# July month_end 2026-08-01 <= cutoff_month → drop-eligible (fully expired month)
FIXED_NOW = datetime(2026, 9, 13, 12, 0, 0, tzinfo=UTC)
FIXED_CUTOFF = FIXED_NOW - timedelta(days=30)
assert FIXED_CUTOFF == datetime(2026, 8, 14, 12, 0, 0, tzinfo=UTC)

FIXTURE_OLD_ROWS = 12_000
FIXTURE_RECENT_ROWS = 12_000
FIXTURE_TOTAL_ROWS = FIXTURE_OLD_ROWS + FIXTURE_RECENT_ROWS

OLD_TS = datetime(2026, 8, 5, 10, 0, 0, tzinfo=UTC)  # < cutoff
RECENT_TS = datetime(2026, 8, 20, 10, 0, 0, tzinfo=UTC)  # >= cutoff
FULLY_EXPIRED_TS = datetime(2026, 7, 15, 10, 0, 0, tzinfo=UTC)


def _seed_stream(db: Session) -> dict[str, int]:
    connector = Connector(name="partial-ret", description=None, status="RUNNING")
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
        name="partial-ret-stream",
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
        name="partial-ret-d",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://example.invalid/h"},
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
    db.commit()
    return {
        "stream_id": stream.id,
        "route_id": route.id,
        "dest_id": dest.id,
        "connector_id": connector.id,
    }


def _log_mapping(ids: dict[str, int], *, created_at: datetime, message: str) -> dict[str, Any]:
    return {
        "connector_id": ids["connector_id"],
        "stream_id": ids["stream_id"],
        "route_id": ids["route_id"],
        "destination_id": ids["dest_id"],
        "stage": "run_complete",
        "level": "INFO",
        "status": "OK",
        "message": message,
        "payload_sample": {"input_events": 1, "event_count": 1},
        "retry_count": 0,
        "http_status": None,
        "latency_ms": None,
        "error_code": None,
        "created_at": created_at,
    }


def _ensure_months(db: Session) -> None:
    ensure_delivery_log_partitions(db, start_month=datetime(2026, 7, 1, tzinfo=UTC), months_ahead=2)
    db.commit()


def _partition_exists(db: Session, name: str) -> bool:
    return bool(
        db.execute(
            text(
                """
                SELECT 1
                FROM pg_inherits
                JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
                JOIN pg_class child ON child.oid = pg_inherits.inhrelid
                WHERE parent.relname = 'delivery_logs' AND child.relname = :name
                """
            ),
            {"name": name},
        ).scalar()
    )


def _count_in_partition(db: Session, name: str) -> int:
    return int(db.execute(text(f'SELECT count(*) FROM "{name}"')).scalar() or 0)


def _relation_stats(db: Session, name: str) -> dict[str, int | None]:
    row = db.execute(
        text(
            """
            SELECT
              pg_relation_size(c.oid) AS table_bytes,
              pg_indexes_size(c.oid) AS index_bytes,
              COALESCE(s.n_live_tup, 0) AS n_live_tup,
              COALESCE(s.n_dead_tup, 0) AS n_dead_tup
            FROM pg_class c
            LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
            WHERE c.relname = :name
            """
        ),
        {"name": name},
    ).mappings().one()
    return {
        "table_bytes": int(row["table_bytes"]),
        "index_bytes": int(row["index_bytes"]),
        "n_live_tup": int(row["n_live_tup"]),
        "n_dead_tup": int(row["n_dead_tup"]),
    }


def _pin_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(retention_service, "_now", lambda: FIXED_NOW)


def test_retention_cutoff_boundary_strict_before(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    """created_at < cutoff expires; created_at == cutoff and later are retained."""

    monkeypatch.setattr(settings, "GDC_RETENTION_DESTRUCTIVE_ACTIONS_ENABLED", True)
    monkeypatch.setattr(settings, "GDC_RETENTION_DELIVERY_LOG_PARTITION_DROP_ENABLED", False)
    _pin_clock(monkeypatch)
    ids = _seed_stream(db_session)
    _ensure_months(db_session)

    just_before = FIXED_CUTOFF - timedelta(microseconds=1)
    at_cutoff = FIXED_CUTOFF
    just_after = FIXED_CUTOFF + timedelta(microseconds=1)
    db_session.bulk_insert_mappings(
        DeliveryLog,
        [
            _log_mapping(ids, created_at=just_before, message="boundary-before"),
            _log_mapping(ids, created_at=at_cutoff, message="boundary-at"),
            _log_mapping(ids, created_at=just_after, message="boundary-after"),
        ],
    )
    db_session.commit()

    row = get_retention_policy_row(db_session)
    row.logs_enabled = True
    row.logs_retention_days = 30
    row.cleanup_batch_size = 500
    db_session.commit()

    out = run_operational_retention(
        db_session,
        row,
        dry_run=False,
        actor_username="pytest",
        trigger="test",
        tables={"delivery_logs"},
    )
    dl = next(o for o in out if o.table == "delivery_logs")
    assert dl.cutoff_utc == FIXED_CUTOFF
    assert dl.matched_count == 1
    assert dl.deleted_count == 1

    remaining = {
        str(m): ts
        for m, ts in db_session.query(DeliveryLog.message, DeliveryLog.created_at).all()
    }
    assert "boundary-before" not in remaining
    assert remaining["boundary-at"] == at_cutoff
    assert remaining["boundary-after"] == just_after


def test_mixed_partition_dry_run_counts_old_only(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    _pin_clock(monkeypatch)
    monkeypatch.setattr(settings, "GDC_RETENTION_DELIVERY_LOG_PARTITION_DROP_ENABLED", False)
    ids = _seed_stream(db_session)
    _ensure_months(db_session)

    old_maps = [_log_mapping(ids, created_at=OLD_TS, message="old") for _ in range(FIXTURE_OLD_ROWS)]
    recent_maps = [_log_mapping(ids, created_at=RECENT_TS, message="recent") for _ in range(FIXTURE_RECENT_ROWS)]
    db_session.bulk_insert_mappings(DeliveryLog, old_maps + recent_maps)
    db_session.commit()

    assert _count_in_partition(db_session, "delivery_logs_2026_08") == FIXTURE_TOTAL_ROWS

    row = get_retention_policy_row(db_session)
    row.logs_enabled = True
    row.logs_retention_days = 30
    db_session.commit()

    drop_targets = calculate_delivery_log_partition_drop_targets(
        db_session,
        retention_days=30,
        now=FIXED_NOW,
    )
    drop_names = {t.partition_name for t in drop_targets}
    assert "delivery_logs_2026_08" not in drop_names
    assert len(drop_names) == 0 or "delivery_logs_2026_08" not in drop_names

    prev = preview_retention(db_session, row)
    dl = next(p for p in prev if p.table == "delivery_logs")
    assert dl.cutoff_utc == FIXED_CUTOFF
    assert dl.rows_eligible == FIXTURE_OLD_ROWS
    assert "delivery_logs_2026_08" not in {
        t["partition_name"] for t in dl.notes.get("partition_drop_targets", [])
    }

    out = run_operational_retention(
        db_session,
        row,
        dry_run=True,
        actor_username="pytest",
        trigger="test",
        tables={"delivery_logs"},
    )
    run_dl = next(o for o in out if o.table == "delivery_logs")
    assert run_dl.matched_count == FIXTURE_OLD_ROWS
    assert run_dl.deleted_count == 0
    assert _count_in_partition(db_session, "delivery_logs_2026_08") == FIXTURE_TOTAL_ROWS


def test_mixed_partition_controlled_row_delete_and_idempotency(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "GDC_RETENTION_DESTRUCTIVE_ACTIONS_ENABLED", True)
    monkeypatch.setattr(settings, "GDC_RETENTION_DELIVERY_LOG_PARTITION_DROP_ENABLED", False)
    _pin_clock(monkeypatch)
    ids = _seed_stream(db_session)
    _ensure_months(db_session)

    old_maps = [_log_mapping(ids, created_at=OLD_TS, message="old") for _ in range(FIXTURE_OLD_ROWS)]
    recent_maps = [_log_mapping(ids, created_at=RECENT_TS, message="recent") for _ in range(FIXTURE_RECENT_ROWS)]
    db_session.bulk_insert_mappings(DeliveryLog, old_maps + recent_maps)
    db_session.commit()

    row = get_retention_policy_row(db_session)
    row.logs_enabled = True
    row.logs_retention_days = 30
    row.cleanup_batch_size = 2500  # multiple batches for 12k old rows
    db_session.commit()

    before_stats = _relation_stats(db_session, "delivery_logs_2026_08")
    rows_before = _count_in_partition(db_session, "delivery_logs_2026_08")
    old_before = int(
        db_session.execute(
            text("SELECT count(*) FROM delivery_logs_2026_08 WHERE created_at < :c"),
            {"c": FIXED_CUTOFF},
        ).scalar()
        or 0
    )
    recent_before = rows_before - old_before
    assert rows_before == FIXTURE_TOTAL_ROWS
    assert old_before == FIXTURE_OLD_ROWS
    assert recent_before == FIXTURE_RECENT_ROWS

    out = run_operational_retention(
        db_session,
        row,
        dry_run=False,
        actor_username="pytest",
        trigger="test",
        tables={"delivery_logs"},
    )
    dl = next(o for o in out if o.table == "delivery_logs")
    assert dl.matched_count == FIXTURE_OLD_ROWS
    assert dl.deleted_count == FIXTURE_OLD_ROWS
    assert dl.notes.get("partition_dropped_rows") == 0

    rows_after = _count_in_partition(db_session, "delivery_logs_2026_08")
    old_after = int(
        db_session.execute(
            text("SELECT count(*) FROM delivery_logs_2026_08 WHERE created_at < :c"),
            {"c": FIXED_CUTOFF},
        ).scalar()
        or 0
    )
    recent_after = int(
        db_session.execute(
            text("SELECT count(*) FROM delivery_logs_2026_08 WHERE created_at >= :c"),
            {"c": FIXED_CUTOFF},
        ).scalar()
        or 0
    )
    assert old_after == 0
    assert recent_after == recent_before
    assert rows_after == recent_before
    assert _partition_exists(db_session, "delivery_logs_2026_08")

    after_stats = _relation_stats(db_session, "delivery_logs_2026_08")
    # Dead tuples are expected after DELETE; size reclaim is vacuum's job.
    assert after_stats["n_dead_tup"] >= FIXTURE_OLD_ROWS or after_stats["n_dead_tup"] > before_stats["n_dead_tup"]

    # Idempotency
    out2 = run_operational_retention(
        db_session,
        row,
        dry_run=False,
        actor_username="pytest",
        trigger="test",
        tables={"delivery_logs"},
    )
    dl2 = next(o for o in out2 if o.table == "delivery_logs")
    assert dl2.matched_count == 0
    assert dl2.deleted_count == 0
    assert _count_in_partition(db_session, "delivery_logs_2026_08") == recent_before


def test_batching_larger_than_single_batch(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "GDC_RETENTION_DESTRUCTIVE_ACTIONS_ENABLED", True)
    _pin_clock(monkeypatch)
    ids = _seed_stream(db_session)
    _ensure_months(db_session)

    n_old = 3_250
    n_recent = 1_000
    batch_size = 1_000
    db_session.bulk_insert_mappings(
        DeliveryLog,
        [_log_mapping(ids, created_at=OLD_TS, message="old") for _ in range(n_old)]
        + [_log_mapping(ids, created_at=RECENT_TS, message="recent") for _ in range(n_recent)],
    )
    db_session.commit()

    commits: list[int] = []
    original_commit = db_session.commit

    def _counting_commit() -> None:
        commits.append(1)
        original_commit()

    monkeypatch.setattr(db_session, "commit", _counting_commit)

    matched, deleted = batch_delete_by_time_before(
        db_session,
        model=DeliveryLog,
        time_column=DeliveryLog.created_at,
        cutoff=FIXED_CUTOFF,
        batch_size=batch_size,
        dry_run=False,
    )
    assert matched == n_old
    assert deleted == n_old
    # At least 4 delete batches (3250 / 1000) plus possibly outer retention commits — count delete commits.
    assert len(commits) >= 4
    assert db_session.query(DeliveryLog).filter(DeliveryLog.message == "recent").count() == n_recent
    assert db_session.query(DeliveryLog).filter(DeliveryLog.message == "old").count() == 0


def test_interrupt_between_batches_resumes_safely(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "GDC_RETENTION_DESTRUCTIVE_ACTIONS_ENABLED", True)
    _pin_clock(monkeypatch)
    ids = _seed_stream(db_session)
    _ensure_months(db_session)

    n_old = 2_500
    n_recent = 500
    batch_size = 1_000
    db_session.bulk_insert_mappings(
        DeliveryLog,
        [_log_mapping(ids, created_at=OLD_TS, message="old") for _ in range(n_old)]
        + [_log_mapping(ids, created_at=RECENT_TS, message="recent") for _ in range(n_recent)],
    )
    db_session.commit()

    class _Boom(Exception):
        pass

    original_batch = retention_batch.batch_delete_by_time_before

    def _fail_after_first_batch(*args: Any, **kwargs: Any) -> tuple[int, int]:
        # Commit one batch, then raise so the outer retention path rolls back uncommitted work.
        from sqlalchemy import select as sa_select

        db = args[0] if args else kwargs["db"]
        model = kwargs["model"]
        time_column = kwargs["time_column"]
        cutoff = kwargs["cutoff"]
        bs = kwargs["batch_size"]
        dry_run = kwargs["dry_run"]
        extra = kwargs.get("extra")
        flt = time_column < cutoff
        if extra is not None:
            flt = flt & extra
        matched_count = int(db.query(model).filter(flt).count())
        if dry_run or matched_count == 0:
            return matched_count, 0
        pk = getattr(model, "id")
        ids_subq = (
            sa_select(pk)
            .where(flt)
            .order_by(time_column.asc(), pk.asc())
            .limit(max(1, int(bs)))
            .scalar_subquery()
        )
        db.query(model).filter(pk.in_(ids_subq)).delete(synchronize_session=False)
        db.commit()
        raise _Boom("controlled failure after first committed batch")

    monkeypatch.setattr(retention_batch, "batch_delete_by_time_before", _fail_after_first_batch)
    monkeypatch.setattr(retention_service, "batch_delete_by_time_before", _fail_after_first_batch)

    row = get_retention_policy_row(db_session)
    row.logs_enabled = True
    row.logs_retention_days = 30
    row.cleanup_batch_size = batch_size
    db_session.commit()

    out = run_operational_retention(
        db_session,
        row,
        dry_run=False,
        actor_username="pytest",
        trigger="test",
        tables={"delivery_logs"},
    )
    assert out[0].status == "error"
    remaining_old = db_session.query(DeliveryLog).filter(DeliveryLog.message == "old").count()
    remaining_recent = db_session.query(DeliveryLog).filter(DeliveryLog.message == "recent").count()
    assert remaining_recent == n_recent
    assert remaining_old == n_old - batch_size  # first batch committed

    # Resume with real implementation
    monkeypatch.setattr(retention_batch, "batch_delete_by_time_before", original_batch)
    monkeypatch.setattr(retention_service, "batch_delete_by_time_before", original_batch)
    out2 = run_operational_retention(
        db_session,
        row,
        dry_run=False,
        actor_username="pytest",
        trigger="test",
        tables={"delivery_logs"},
    )
    assert out2[0].status == "ok"
    assert out2[0].deleted_count == remaining_old
    assert db_session.query(DeliveryLog).filter(DeliveryLog.message == "old").count() == 0
    assert db_session.query(DeliveryLog).filter(DeliveryLog.message == "recent").count() == n_recent


def test_fully_expired_partition_drop_before_row_delete(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fully expired month is DROP-eligible; mixed month is not. DROP runs before row DELETE."""

    monkeypatch.setattr(settings, "GDC_RETENTION_DESTRUCTIVE_ACTIONS_ENABLED", True)
    monkeypatch.setattr(settings, "GDC_RETENTION_DELIVERY_LOG_PARTITION_DROP_ENABLED", True)
    _pin_clock(monkeypatch)
    ids = _seed_stream(db_session)
    _ensure_months(db_session)

    # Fully expired July rows + mixed August rows
    db_session.bulk_insert_mappings(
        DeliveryLog,
        [_log_mapping(ids, created_at=FULLY_EXPIRED_TS, message="july") for _ in range(500)]
        + [_log_mapping(ids, created_at=OLD_TS, message="aug-old") for _ in range(800)]
        + [_log_mapping(ids, created_at=RECENT_TS, message="aug-recent") for _ in range(700)],
    )
    db_session.commit()
    assert _partition_exists(db_session, "delivery_logs_2026_07")
    assert _count_in_partition(db_session, "delivery_logs_2026_07") == 500

    targets = calculate_delivery_log_partition_drop_targets(
        db_session, retention_days=30, now=FIXED_NOW
    )
    names = {t.partition_name for t in targets}
    assert "delivery_logs_2026_07" in names
    assert "delivery_logs_2026_08" not in names

    row = get_retention_policy_row(db_session)
    row.logs_enabled = True
    row.logs_retention_days = 30
    row.cleanup_batch_size = 500
    db_session.commit()

    out = run_operational_retention(
        db_session,
        row,
        dry_run=False,
        actor_username="pytest",
        trigger="test",
        tables={"delivery_logs"},
    )
    dl = next(o for o in out if o.table == "delivery_logs")
    assert not _partition_exists(db_session, "delivery_logs_2026_07")
    assert _partition_exists(db_session, "delivery_logs_2026_08")
    # July rows removed via DROP (counted in partition_dropped_rows); August old via DELETE.
    assert dl.notes.get("partition_dropped_rows") == 500
    assert db_session.query(DeliveryLog).filter(DeliveryLog.message == "july").count() == 0
    assert db_session.query(DeliveryLog).filter(DeliveryLog.message == "aug-old").count() == 0
    assert db_session.query(DeliveryLog).filter(DeliveryLog.message == "aug-recent").count() == 700


def test_fully_expired_without_drop_flag_uses_row_delete_efficiency_gap(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When partition DROP is disabled, fully expired rows are still removed via row DELETE.

    Classification: RETENTION_EFFICIENCY_GAP for storage reclaim (empty partition remains).
    """

    monkeypatch.setattr(settings, "GDC_RETENTION_DESTRUCTIVE_ACTIONS_ENABLED", True)
    monkeypatch.setattr(settings, "GDC_RETENTION_DELIVERY_LOG_PARTITION_DROP_ENABLED", False)
    _pin_clock(monkeypatch)
    ids = _seed_stream(db_session)
    _ensure_months(db_session)

    db_session.bulk_insert_mappings(
        DeliveryLog,
        [_log_mapping(ids, created_at=FULLY_EXPIRED_TS, message="july") for _ in range(1_200)],
    )
    db_session.commit()

    targets = calculate_delivery_log_partition_drop_targets(
        db_session, retention_days=30, now=FIXED_NOW
    )
    assert any(t.partition_name == "delivery_logs_2026_07" for t in targets)

    row = get_retention_policy_row(db_session)
    row.logs_enabled = True
    row.logs_retention_days = 30
    row.cleanup_batch_size = 400
    db_session.commit()

    out = run_operational_retention(
        db_session,
        row,
        dry_run=False,
        actor_username="pytest",
        trigger="test",
        tables={"delivery_logs"},
    )
    dl = next(o for o in out if o.table == "delivery_logs")
    assert dl.deleted_count == 1_200
    assert dl.notes.get("partition_dropped_rows") == 0
    assert _partition_exists(db_session, "delivery_logs_2026_07")
    assert _count_in_partition(db_session, "delivery_logs_2026_07") == 0


def test_max_batch_iterations_caps_single_pass(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    """A single pass stops at _MAX_BATCH_ITERATIONS; next run resumes remaining rows."""

    monkeypatch.setattr(settings, "GDC_RETENTION_DESTRUCTIVE_ACTIONS_ENABLED", True)
    _pin_clock(monkeypatch)
    ids = _seed_stream(db_session)
    _ensure_months(db_session)

    monkeypatch.setattr(retention_batch, "_MAX_BATCH_ITERATIONS", 2)
    monkeypatch.setattr(retention_service, "batch_delete_by_time_before", retention_batch.batch_delete_by_time_before)

    n_old = 500
    batch_size = 100  # 2 iterations → 200 deleted max
    db_session.bulk_insert_mappings(
        DeliveryLog,
        [_log_mapping(ids, created_at=OLD_TS, message="old") for _ in range(n_old)]
        + [_log_mapping(ids, created_at=RECENT_TS, message="recent") for _ in range(50)],
    )
    db_session.commit()

    matched, deleted = batch_delete_by_time_before(
        db_session,
        model=DeliveryLog,
        time_column=DeliveryLog.created_at,
        cutoff=FIXED_CUTOFF,
        batch_size=batch_size,
        dry_run=False,
    )
    assert matched == n_old
    assert deleted == 200  # 2 * 100
    assert db_session.query(DeliveryLog).filter(DeliveryLog.message == "old").count() == 300
    assert db_session.query(DeliveryLog).filter(DeliveryLog.message == "recent").count() == 50

    # Resume
    monkeypatch.setattr(retention_batch, "_MAX_BATCH_ITERATIONS", _MAX_BATCH_ITERATIONS)
    matched2, deleted2 = batch_delete_by_time_before(
        db_session,
        model=DeliveryLog,
        time_column=DeliveryLog.created_at,
        cutoff=FIXED_CUTOFF,
        batch_size=batch_size,
        dry_run=False,
    )
    assert matched2 == 300
    assert deleted2 == 300
    assert db_session.query(DeliveryLog).filter(DeliveryLog.message == "old").count() == 0
    assert db_session.query(DeliveryLog).filter(DeliveryLog.message == "recent").count() == 50


def test_protected_current_future_default_never_drop_targets(db_session: Session) -> None:
    ensure_delivery_log_partitions(db_session, start_month=FIXED_NOW, months_ahead=2)
    db_session.commit()
    targets = calculate_delivery_log_partition_drop_targets(
        db_session, retention_days=30, now=FIXED_NOW
    )
    names = {t.partition_name for t in targets}
    assert "delivery_logs_2026_09" not in names
    assert "delivery_logs_2026_10" not in names
    assert "delivery_logs_default" not in names
