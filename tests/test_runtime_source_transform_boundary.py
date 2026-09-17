"""P1 responsibility boundary: Stream source fetch vs stream/global transform.

Locks ownership so Route Processing ON/OFF share one Stream-owned source acquisition
and OFF-only stream transform without changing checkpoint or transaction semantics.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy.orm import Session

from app.config import settings
from app.runners.stream_loader import load_stream_context
from app.runners.stream_runner import StreamRunner, StreamRunOptions
from tests.test_stream_runner_e2e import (
    _FakePoller,
    _FakeWebhookSender,
    _build_runner,
    _seed_stream_runtime,
)


def _runtime_stream(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": 42,
        "source_type": "HTTP_API_POLLING",
        "source_config": {"url": "http://example.invalid/source"},
        "stream_config": {"event_array_path": "$.items"},
        "event_array_path": "$.items",
        "field_mappings": {"message": "$.message", "vendor": "$.vendor"},
        "enrichment": {"product": "GDC"},
        "override_policy": "KEEP_EXISTING",
        "routes": [
            {
                "id": 1,
                "enabled": True,
                "failure_policy": "LOG_AND_CONTINUE",
                "destination": {
                    "id": 10,
                    "enabled": True,
                    "destination_type": "WEBHOOK_POST",
                    "config": {"url": "http://example.invalid/a"},
                },
            },
            {
                "id": 2,
                "enabled": True,
                "failure_policy": "LOG_AND_CONTINUE",
                "destination": {
                    "id": 11,
                    "enabled": True,
                    "destination_type": "WEBHOOK_POST",
                    "config": {"url": "http://example.invalid/b"},
                },
            },
        ],
    }
    base.update(overrides)
    return base


@pytest.fixture
def runner() -> StreamRunner:
    poller = _FakePoller(response={"items": [{"message": "hello", "vendor": "acme"}]})
    r = StreamRunner(
        poller=poller,
        webhook_sender=MagicMock(),
        syslog_sender=MagicMock(),
    )
    r._flush_db = None
    r._db_read = MagicMock(return_value=None)  # type: ignore[method-assign]
    r._db_write = MagicMock()  # type: ignore[method-assign]
    r._log = MagicMock()  # type: ignore[method-assign]
    r._emit_obs = MagicMock()  # type: ignore[method-assign]
    r._observe_extracted_event_schema = MagicMock()  # type: ignore[method-assign]
    r._detect_sensitive_fields = MagicMock()  # type: ignore[method-assign]
    r._classify_events = MagicMock()  # type: ignore[method-assign]
    r._apply_schema_drift_policy = MagicMock(return_value=None)  # type: ignore[method-assign]
    return r


def test_collect_source_events_fetches_once_and_skips_stream_transform(runner: StreamRunner) -> None:
    """Source acquisition owns fetch/parse/dedup — not stream mapping/enrichment."""

    with (
        patch("app.runners.stream_runner.apply_mappings_with_results") as map_mock,
        patch("app.runners.stream_runner.apply_enrichments_batch") as enrich_mock,
    ):
        events = runner._collect_source_events(
            runtime_stream=_runtime_stream(),
            checkpoint=None,
            stream_id=42,
            run_opts=StreamRunOptions(),
        )

    assert len(events) == 1
    assert runner.poller.calls  # type: ignore[attr-defined]
    assert len(runner.poller.calls) == 1  # type: ignore[attr-defined]
    map_mock.assert_not_called()
    enrich_mock.assert_not_called()
    runner._classify_events.assert_not_called()
    runner._apply_schema_drift_policy.assert_not_called()

def test_collect_and_transform_orchestrates_on_path_skips_stream_transform(
    runner: StreamRunner, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", True)
    with (
        patch("app.runners.stream_runner.apply_mappings_with_results") as map_mock,
        patch("app.runners.stream_runner.apply_enrichments_batch") as enrich_mock,
    ):
        events, enriched, stats = runner._collect_and_transform_events(
            runtime_stream=_runtime_stream(),
            checkpoint=None,
            stream_id=42,
            run_opts=StreamRunOptions(),
        )

    assert len(runner.poller.calls) == 1  # type: ignore[attr-defined]
    assert stats["mapped_count"] == 0
    assert stats["enriched_count"] == 0
    assert enriched == events or enriched == list(events)
    map_mock.assert_not_called()
    enrich_mock.assert_not_called()
    runner._classify_events.assert_not_called()
    runner._detect_sensitive_fields.assert_called_once()


def test_multi_route_run_fetches_source_once(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """SOURCE_FETCH_COUNT_MULTI_ROUTE=1 on canonical Route Processing path."""

    db = db_session
    fixture = _seed_stream_runtime(db, failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE"])
    stream_id = fixture["stream_id"]
    payload = {"items": [{"id": "e1", "message": "hello", "vendor": "acme"}]}

    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", True)
    ctx = load_stream_context(db, stream_id)
    poller = _FakePoller(response=payload)
    webhook = _FakeWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=webhook)
    summary = runner.run(ctx, db=db)
    assert summary.get("outcome") == "completed"
    assert len(poller.calls) == 1
    assert len(webhook.calls) == 2


def test_persist_checkpoint_false_still_fetches_once_without_checkpoint_advance(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", True)
    db = db_session
    fixture = _seed_stream_runtime(db, failure_policies=["LOG_AND_CONTINUE"])
    stream_id = fixture["stream_id"]
    ctx = load_stream_context(db, stream_id)
    ctx.persist_checkpoint = False
    poller = _FakePoller(response={"items": [{"id": "e1", "message": "hello", "vendor": "acme"}]})
    webhook = _FakeWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=webhook)
    summary = runner.run(ctx, db=db)
    assert len(poller.calls) == 1
    assert summary.get("checkpoint_updated") is False
    assert len(webhook.calls) == 1
