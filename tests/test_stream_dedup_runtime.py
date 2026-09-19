"""Runtime deduplication at queue insert."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.logs.models import DeliveryLog
from app.runners.stream_dedup import (
    DEDUP_REGISTRY_STAGE,
    DedupSummary,
    StreamDedupQueue,
    apply_stream_dedup,
    extract_dedup_key,
    parse_dedup_config,
    record_dedup_registry_after_delivery,
    StreamDedupConfig,
)
from app.runners.stream_runner import StreamRunner
from app.runners.stream_loader import load_stream_context
from app.streams.models import Stream
from tests.test_stream_runner_e2e import (
    _FakePoller,
    _FakeWebhookSender,
    _RetryAwareWebhookSender,
    _build_runner,
    _delivery_logs,
    _seed_stream_runtime,
)


def _enable_dedup(
    db: Session,
    stream_id: int,
    *,
    duplicate_handling: str = "skip_duplicate",
    scope: str = "current_run",
    key_field: str = "event_id",
    window_hours: int | None = None,
) -> None:
    row = db.query(Stream).filter(Stream.id == stream_id).one()
    cfg = dict(row.config_json or {})
    dedup_cfg: dict[str, object] = {
        "enabled": True,
        "key_field": key_field,
        "duplicate_handling": duplicate_handling,
        "scope": scope,
    }
    if window_hours is not None:
        dedup_cfg["window_hours"] = window_hours
    cfg["deduplication"] = dedup_cfg
    row.config_json = cfg
    db.add(row)
    db.commit()


def _registry_logs(db: Session, stream_id: int) -> list[DeliveryLog]:
    return [
        row
        for row in _delivery_logs(db, stream_id)
        if row.stage == DEDUP_REGISTRY_STAGE
    ]


def test_parse_dedup_config_disabled_by_default() -> None:
    cfg = parse_dedup_config({})
    assert cfg.enabled is False


def test_extract_dedup_key_event_id() -> None:
    config = StreamDedupConfig(enabled=True, key_field="event_id")
    key, source = extract_dedup_key({"event_id": "evt-1", "message": "x"}, config)
    assert key == "evt-1"
    assert source == "event_id"


def test_extract_dedup_key_stellar_uuid() -> None:
    config = StreamDedupConfig(enabled=True, key_field="stellar_uuid")
    key, source = extract_dedup_key({"stellar_uuid": "uuid-9"}, config)
    assert key == "uuid-9"
    assert source == "stellar_uuid"


def test_extract_dedup_key_custom_jsonpath() -> None:
    config = StreamDedupConfig(enabled=True, key_field="custom_jsonpath", custom_jsonpath="$.meta.id")
    key, source = extract_dedup_key({"meta": {"id": "abc"}}, config)
    assert key == "abc"
    assert source == "custom_jsonpath"


def test_skip_duplicate_in_current_run() -> None:
    config = StreamDedupConfig(enabled=True, key_field="event_id", duplicate_handling="skip_duplicate")
    queue = StreamDedupQueue(config=config)
    first = queue.ingest([{"event_id": "a"}, {"event_id": "b"}])
    assert len(first) == 2
    second = queue.ingest([{"event_id": "a"}, {"event_id": "c"}])
    assert len(second) == 3
    assert queue.summary.duplicate_events == 1


def test_keep_first_skips_later_duplicate() -> None:
    config = StreamDedupConfig(enabled=True, key_field="id", duplicate_handling="keep_first")
    queue = StreamDedupQueue(config=config)
    out = queue.ingest([{"id": "1", "v": 1}, {"id": "1", "v": 2}])
    assert len(out) == 1
    assert out[0]["v"] == 1


def test_keep_latest_replaces_in_run() -> None:
    config = StreamDedupConfig(enabled=True, key_field="id", duplicate_handling="keep_latest")
    queue = StreamDedupQueue(config=config)
    out = queue.ingest([{"id": "1", "v": 1}, {"id": "1", "v": 2}])
    assert len(out) == 1
    assert out[0]["v"] == 2
    assert queue.summary.current_run_duplicates == 1
    assert queue.summary.registry_seed_duplicates == 0


def test_keep_latest_skips_registry_seed_duplicate() -> None:
    config = StreamDedupConfig(
        enabled=True,
        key_field="event_id",
        duplicate_handling="keep_latest",
        scope="checkpoint_window",
    )
    queue = StreamDedupQueue(config=config, seed_keys={"seed-key"})
    out = queue.ingest([{"event_id": "seed-key", "v": 1}, {"event_id": "new-key", "v": 2}])
    assert len(out) == 1
    assert out[0]["event_id"] == "new-key"
    assert queue.summary.registry_seed_duplicates == 1
    assert queue.summary.duplicate_events == 1


def test_last_n_hours_registry_seed_is_skipped() -> None:
    config = StreamDedupConfig(
        enabled=True,
        key_field="event_id",
        duplicate_handling="skip_duplicate",
        scope="last_n_hours",
        window_hours=6,
    )
    queue = StreamDedupQueue(config=config, seed_keys={"seed-key"})
    out = queue.ingest([{"event_id": "seed-key"}, {"event_id": "fresh"}])
    assert len(out) == 1
    assert out[0]["event_id"] == "fresh"
    assert queue.summary.registry_seed_duplicates == 1


def test_record_dedup_registry_only_after_delivery_success() -> None:
    summary = DedupSummary(inserted_keys=["evt-1"], inserted=1)
    events = [{"__gdc_dedup_key": "evt-1", "__gdc_dedup_queue_id": 1, "event_id": "evt-1"}]
    recorded: list[dict] = []

    record_dedup_registry_after_delivery(
        stream_id=1,
        successful_events=events,
        summary=summary,
        destination="dest-a",
        dry_run=False,
        log_fn=lambda payload: recorded.append(payload),
    )
    assert summary.registry_recorded == 1
    assert summary.registry_record_stage == "delivery_success"
    assert any(row.get("stage") == DEDUP_REGISTRY_STAGE for row in recorded)

    failed_summary = DedupSummary(inserted_keys=["evt-2"], inserted=1)
    record_dedup_registry_after_delivery(
        stream_id=1,
        successful_events=[],
        summary=failed_summary,
        destination="dest-a",
        dry_run=False,
        log_fn=lambda payload: recorded.append(payload),
    )
    assert failed_summary.registry_recorded == 0
    assert failed_summary.registry_skipped == 1
    assert failed_summary.registry_record_stage is None


def test_apply_stream_dedup_replay_disabled_passthrough() -> None:
    events = [{"event_id": "seed-key"}, {"event_id": "seed-key"}]
    out, summary = apply_stream_dedup(
        events,
        stream_config={
            "deduplication": {
                "enabled": True,
                "key_field": "event_id",
                "scope": "checkpoint_window",
            }
        },
        stream_id=1,
        apply_dedup=False,
    )
    assert out == events
    assert summary is None


def test_apply_stream_dedup_replay_enabled_dedupes_registry_seed(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = int(fixture["stream_id"])
    db_session.add(
        DeliveryLog(
            stream_id=stream_id,
            stage=DEDUP_REGISTRY_STAGE,
            level="INFO",
            message="dedup registry",
            payload_sample={"dedup_keys": ["seed-key"]},
        )
    )
    db_session.commit()

    events = [{"event_id": "seed-key"}, {"event_id": "new-key"}]
    out, summary = apply_stream_dedup(
        events,
        stream_config={
            "deduplication": {
                "enabled": True,
                "key_field": "event_id",
                "scope": "checkpoint_window",
            }
        },
        stream_id=stream_id,
        db=db_session,
        apply_dedup=True,
    )
    assert len(out) == 1
    assert out[0]["event_id"] == "new-key"
    assert summary is not None
    assert summary.registry_seed_duplicates == 1


def test_delivery_success_records_registry(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = int(fixture["stream_id"])
    _enable_dedup(db_session, stream_id, key_field="id")

    context = load_stream_context(db_session, stream_id)
    poller = _FakePoller(
        response={"items": [{"id": "evt-delivered", "message": "hello", "vendor": "MappedVendor"}]}
    )
    runner = _build_runner(poller=poller, webhook_sender=_FakeWebhookSender())
    summary = runner.run(context, db=db_session)

    dedup = summary.get("dedup_summary") or {}
    assert dedup.get("registry_recorded") == 1
    assert dedup.get("registry_record_stage") == "delivery_success"
    registry_rows = _registry_logs(db_session, stream_id)
    assert len(registry_rows) == 1
    payload = registry_rows[0].payload_sample or {}
    assert payload.get("dedup_keys") == ["evt-delivered"]


def test_delivery_failure_does_not_record_registry(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session, failure_policies=["STOP_ON_FAILURE"])
    stream_id = int(fixture["stream_id"])
    _enable_dedup(db_session, stream_id, key_field="id")

    context = load_stream_context(db_session, stream_id)
    poller = _FakePoller(
        response={"items": [{"id": "evt-failed", "message": "hello", "vendor": "MappedVendor"}]}
    )
    sender = _FakeWebhookSender(fail_urls={"https://receiver-0.example.com/events"})
    runner = _build_runner(poller=poller, webhook_sender=sender)
    summary = runner.run(context, db=db_session)

    dedup = summary.get("dedup_summary") or {}
    assert dedup.get("registry_recorded") == 0
    assert dedup.get("registry_skipped") == 1
    assert _registry_logs(db_session, stream_id) == []


def test_retry_then_delivery_success_records_registry(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session, failure_policies=["RETRY_AND_BACKOFF"])
    stream_id = int(fixture["stream_id"])
    _enable_dedup(db_session, stream_id, key_field="id")

    context = load_stream_context(db_session, stream_id)
    context.routes[0]["retry_count"] = 2
    context.routes[0]["backoff_seconds"] = 0

    poller = _FakePoller(
        response={"items": [{"id": "evt-retry", "message": "hello", "vendor": "MappedVendor"}]}
    )
    sender = _RetryAwareWebhookSender(fail_count_by_url={"https://receiver-0.example.com/events": 1})
    runner = _build_runner(poller=poller, webhook_sender=sender)
    summary = runner.run(context, db=db_session)

    dedup = summary.get("dedup_summary") or {}
    assert dedup.get("registry_recorded") == 1
    registry_rows = _registry_logs(db_session, stream_id)
    assert len(registry_rows) == 1
    assert (registry_rows[0].payload_sample or {}).get("dedup_keys") == ["evt-retry"]


def test_apply_stream_dedup_disabled_passthrough() -> None:
    events = [{"event_id": "x"}, {"event_id": "x"}]
    out, summary = apply_stream_dedup(events, stream_config={"deduplication": {"enabled": False}}, stream_id=1)
    assert out == events
    assert summary is None


def test_checkpoint_window_uses_registry_seed(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = int(fixture["stream_id"])
    db_session.add(
        DeliveryLog(
            stream_id=stream_id,
            stage=DEDUP_REGISTRY_STAGE,
            level="INFO",
            message="dedup registry",
            payload_sample={"dedup_keys": ["seed-key"]},
        )
    )
    db_session.commit()

    config = StreamDedupConfig(
        enabled=True,
        key_field="event_id",
        duplicate_handling="skip_duplicate",
        scope="checkpoint_window",
    )
    queue = StreamDedupQueue(config=config, seed_keys={"seed-key"})
    out = queue.ingest([{"event_id": "seed-key"}, {"event_id": "new-key"}])
    assert len(out) == 1
    assert out[0]["event_id"] == "new-key"
    assert queue.summary.duplicate_events == 1


def test_stream_runner_applies_dedup_when_enabled(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = int(fixture["stream_id"])

    from app.streams.models import Stream

    row = db_session.query(Stream).filter(Stream.id == stream_id).one()
    cfg = dict(row.config_json or {})
    cfg["deduplication"] = {
        "enabled": True,
        "key_field": "event_id",
        "duplicate_handling": "skip_duplicate",
        "scope": "current_run",
    }
    row.config_json = cfg
    db_session.add(row)
    db_session.commit()

    class _FakeAdapter:
        @staticmethod
        def fetch(_source_config, _stream_config, _checkpoint):
            return {"items": [{"event_id": "dup"}, {"event_id": "dup"}, {"event_id": "unique"}]}

    monkeypatch.setattr(
        "app.runners.stream_runner.SourceAdapterRegistry.get",
        lambda self, _source_type: _FakeAdapter(),
    )
    ctx = load_stream_context(db_session, stream_id, require_enabled_stream=False)
    ctx.dry_run = True
    summary = StreamRunner().run(ctx, db=db_session)
    dedup = summary.get("dedup_summary") or {}
    assert int(dedup.get("duplicate_events") or 0) == 1
    assert int(dedup.get("inserted") or 0) == 2


def test_incremental_test_reports_dedup_counts(
    runtime_api_client: TestClient,
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = int(fixture["stream_id"])

    from app.streams.models import Stream

    row = db_session.query(Stream).filter(Stream.id == stream_id).one()
    cfg = dict(row.config_json or {})
    cfg["deduplication"] = {
        "enabled": True,
        "key_field": "event_id",
        "duplicate_handling": "skip_duplicate",
        "scope": "current_run",
    }
    row.config_json = cfg
    db_session.add(row)
    db_session.commit()

    from app.runtime.schemas import HttpApiTestAnalysis, HttpApiTestResponse, HttpApiTestResponseMeta

    def _fake_test(*_args, **_kwargs):
        return HttpApiTestResponse(
            ok=True,
            request={"method": "GET", "url": "http://example.test", "headers_masked": {}},
            response=HttpApiTestResponseMeta(
                status_code=200,
                latency_ms=1,
                headers={},
                raw_body="{}",
                parsed_json=[{"event_id": "a"}, {"event_id": "a"}],
            ),
            analysis=HttpApiTestAnalysis(
                response_summary={"root_type": "array", "approx_size_bytes": 1, "top_level_keys": []},
                sample_event={"event_id": "a"},
            ),
        )

    monkeypatch.setattr("app.runtime.stream_configuration_service.run_http_api_test", _fake_test)

    res = runtime_api_client.post(f"/api/v1/runtime/streams/{stream_id}/incremental-test", json={})
    assert res.status_code == 200
    body = res.json()
    assert body["fetched"] >= 2
    assert body["duplicates"] == 1
    assert body["inserted"] == 1


def test_last_dedup_runtime_stats_respects_created_at_lookback(db_session: Session) -> None:
    from datetime import datetime, timedelta, timezone

    from app.runners.stream_dedup import last_dedup_runtime_stats

    fixture = _seed_stream_runtime(db_session)
    stream_id = int(fixture["stream_id"])
    old = datetime.now(timezone.utc) - timedelta(hours=48)
    db_session.add(
        DeliveryLog(
            stream_id=stream_id,
            stage="dedup_queue_insert",
            level="INFO",
            message="old dedup",
            created_at=old,
            payload_sample={"duplicate_events": 9, "inserted": 1, "total_events": 10},
        )
    )
    db_session.commit()
    assert last_dedup_runtime_stats(db_session, stream_id) is None

    db_session.add(
        DeliveryLog(
            stream_id=stream_id,
            stage="dedup_queue_insert",
            level="INFO",
            message="fresh dedup",
            payload_sample={"duplicate_events": 2, "inserted": 3, "total_events": 5},
        )
    )
    db_session.commit()
    summary = last_dedup_runtime_stats(db_session, stream_id)
    assert summary is not None
    assert int(summary.get("duplicate_events") or 0) == 2
    assert int(summary.get("inserted") or 0) == 3
    assert summary.get("degraded") is False
    assert summary.get("recorded_at")


def test_last_dedup_runtime_stats_degraded_marker(monkeypatch: pytest.MonkeyPatch, db_session: Session) -> None:
    from sqlalchemy.exc import OperationalError

    from app.runners import stream_dedup as dedup_mod

    fixture = _seed_stream_runtime(db_session)
    stream_id = int(fixture["stream_id"])

    class _Boom:
        def filter(self, *args, **kwargs):
            raise OperationalError("statement timeout", {}, Exception("timeout"))

    monkeypatch.setattr(db_session, "query", lambda *args, **kwargs: _Boom())
    monkeypatch.setattr(db_session, "execute", lambda *args, **kwargs: None)
    monkeypatch.setattr(db_session, "rollback", lambda: None)

    out = dedup_mod.last_dedup_runtime_stats(db_session, stream_id)
    assert out == {"degraded": True}