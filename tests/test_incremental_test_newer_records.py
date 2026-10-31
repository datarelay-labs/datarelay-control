"""Incremental request Test must not report plain success when no returned record is newer than the checkpoint.

Old code: ``POST /runtime/streams/{id}/incremental-test`` returned ``ok=True`` with the generic success message and
had no ``status`` / ``warning_code`` / ``newer_record_count`` fields, so every assertion on those fields fails on the
old code (missing keys), and ``count_records_newer_than_checkpoint`` did not exist (ImportError).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.runtime.incremental_fetch import count_records_newer_than_checkpoint
from app.runtime.schemas import HttpApiTestAnalysis, HttpApiTestResponse, HttpApiTestResponseMeta
from app.streams.models import Stream
from tests.test_stream_runner_e2e import _seed_stream_runtime

_CHECKPOINT_TS = "2026-10-29T12:00:00Z"
_WATERMARK_CFG = {"incremental_fetch": {"strategy": "timestamp_watermark", "watermark_field": "$.timestamp"}}
# Explicit "custom" strategy disables the framework, so the legacy checkpoint cursor path is used.
_LEGACY_CFG = {"incremental_fetch": {"strategy": "custom"}, "checkpoint": {"cursor_path": "$.timestamp"}}


def _events(*timestamps: object) -> list[dict]:
    return [{"event_id": f"e{i}", "timestamp": ts} for i, ts in enumerate(timestamps)]


@pytest.mark.parametrize("cfg", [_WATERMARK_CFG, _LEGACY_CFG])
def test_count_records_newer_than_checkpoint_counts_strictly_newer(cfg: dict) -> None:
    events = _events("2026-10-29T11:59:00Z", _CHECKPOINT_TS, "2026-10-29T12:00:01Z")
    assert count_records_newer_than_checkpoint(events, checkpoint={"last_timestamp": _CHECKPOINT_TS}, stream_config=cfg) == 1


@pytest.mark.parametrize("cfg", [_WATERMARK_CFG, _LEGACY_CFG])
def test_count_records_newer_than_checkpoint_zero_when_all_old(cfg: dict) -> None:
    events = _events("2026-10-29T11:59:00Z", _CHECKPOINT_TS)
    assert count_records_newer_than_checkpoint(events, checkpoint={"last_timestamp": _CHECKPOINT_TS}, stream_config=cfg) == 0


def test_count_records_newer_than_checkpoint_compares_epoch_ms_with_iso() -> None:
    # 2026-10-29T12:00:01Z in epoch ms
    events = _events(1793275201000)
    assert (
        count_records_newer_than_checkpoint(events, checkpoint={"last_timestamp": _CHECKPOINT_TS}, stream_config=_WATERMARK_CFG)
        == 1
    )


def test_count_records_newer_than_checkpoint_unknown_without_comparable_values() -> None:
    events = _events("2026-10-29T12:00:01Z")
    assert count_records_newer_than_checkpoint(events, checkpoint=None, stream_config=_LEGACY_CFG) is None
    assert count_records_newer_than_checkpoint(events, checkpoint={"cursor": "opaque"}, stream_config=_LEGACY_CFG) is None
    no_field = [{"event_id": "x"}]
    assert (
        count_records_newer_than_checkpoint(no_field, checkpoint={"last_timestamp": _CHECKPOINT_TS}, stream_config=_LEGACY_CFG)
        is None
    )


def _configure_stream(db: Session, stream_id: int) -> None:
    row = db.query(Stream).filter(Stream.id == stream_id).one()
    row.config_json = {**dict(row.config_json or {}), **_WATERMARK_CFG}
    db.add(row)
    db.commit()


def _fake_api_test(records: list[dict]):
    def _fake(*_args, **_kwargs):
        return HttpApiTestResponse(
            ok=True,
            request={"method": "GET", "url": "http://example.test", "headers_masked": {}},
            response=HttpApiTestResponseMeta(
                status_code=200,
                latency_ms=1,
                headers={},
                raw_body="[]",
                parsed_json=records,
            ),
            analysis=HttpApiTestAnalysis(
                response_summary={"root_type": "array", "approx_size_bytes": 1, "top_level_keys": []},
                sample_event=records[0] if records else None,
            ),
        )

    return _fake


def test_incremental_test_warns_when_no_record_is_newer_than_checkpoint(
    runtime_api_client: TestClient,
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stream_id = int(_seed_stream_runtime(db_session)["stream_id"])
    _configure_stream(db_session, stream_id)
    monkeypatch.setattr(
        "app.runtime.stream_configuration_service.run_http_api_test",
        _fake_api_test(_events("2026-10-29T11:58:00Z", "2026-10-29T11:59:00Z")),
    )

    res = runtime_api_client.post(
        f"/api/v1/runtime/streams/{stream_id}/incremental-test",
        json={"checkpoint_override": {"last_timestamp": _CHECKPOINT_TS}},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    # Backward compatible: the HTTP request itself succeeded.
    assert body["ok"] is True
    assert body["fetched"] == 2
    # Honest verdict: records were returned but none is newer than the checkpoint.
    assert body["status"] == "warning"
    assert body["warning_code"] == "NO_NEWER_RECORDS"
    assert body["newer_record_count"] == 0
    assert "none is newer than the checkpoint" in body["message"]


def test_incremental_test_success_when_a_record_is_newer(
    runtime_api_client: TestClient,
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stream_id = int(_seed_stream_runtime(db_session)["stream_id"])
    _configure_stream(db_session, stream_id)
    monkeypatch.setattr(
        "app.runtime.stream_configuration_service.run_http_api_test",
        _fake_api_test(_events("2026-10-29T11:59:00Z", "2026-10-29T12:05:00Z")),
    )

    res = runtime_api_client.post(
        f"/api/v1/runtime/streams/{stream_id}/incremental-test",
        json={"checkpoint_override": {"last_timestamp": _CHECKPOINT_TS}},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["ok"] is True
    assert body["status"] == "success"
    assert body["warning_code"] is None
    assert body["newer_record_count"] == 1
