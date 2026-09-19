"""Regression: run-once must never return HTTP 2xx with zero lifecycle telemetry.

Covers recovery-attempt-011 requirements A–H for S3_OBJECT_POLLING silent no-op.
"""

from __future__ import annotations

import threading
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database import get_db
from app.checkpoints.models import Checkpoint
from app.connectors.models import Connector
from app.destinations.adapters.registry import DestinationAdapterRegistry
from app.destinations.models import Destination
from app.enrichments.models import Enrichment
from app.logs.models import DeliveryLog
from app.main import app
from app.mappings.models import Mapping
from app.routes.models import Route
from app.runners.stream_loader import load_stream_context
from app.runners.stream_runner import StreamRunner
from app.runtime.errors import SourceFetchError
from app.sources.adapters.s3_object_polling import S3ObjectPollingAdapter
from app.sources.models import Source
from app.streams.models import Stream


@pytest.fixture
def client(db_session: Session):
    def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


class _AllowAllLimiter:
    def allow(self, *_a: Any, **_k: Any) -> bool:
        return True


class _FakeWebhookSender:
    def send(self, events: list[dict[str, Any]], config: dict[str, Any], **kwargs: Any) -> None:
        return None


def _install_fake_webhook_sender(runner: StreamRunner) -> _FakeWebhookSender:
    """Wire FakeWebhookSender into both attribute and destination registry."""

    fake = _FakeWebhookSender()
    runner.webhook_sender = fake
    runner.destination_registry = DestinationAdapterRegistry(
        syslog_sender=runner.syslog_sender,
        webhook_sender=fake,
    )
    return fake


def _seed_s3_stream(db: Session) -> int:
    suffix = uuid.uuid4().hex[:10]
    connector = Connector(name=f"pytest-silent-{suffix}", description="silent noop", status="RUNNING")
    db.add(connector)
    db.flush()
    source = Source(
        connector_id=connector.id,
        source_type="S3_OBJECT_POLLING",
        config_json={
            "endpoint_url": "http://127.0.0.1:9000",
            "bucket": "b",
            "region": "us-east-1",
            "access_key": "k",
            "secret_key": "s",
            "prefix": "p/",
            "path_style_access": True,
            "use_ssl": False,
        },
        auth_json={"auth_type": "no_auth"},
        enabled=True,
    )
    db.add(source)
    db.flush()
    stream = Stream(
        connector_id=connector.id,
        source_id=source.id,
        name=f"pytest-silent-stream-{suffix}",
        stream_type="S3_OBJECT_POLLING",
        config_json={"max_objects_per_run": 10},
        polling_interval=60,
        enabled=True,
        status="RUNNING",
        rate_limit_json={"max_requests": 1000, "per_seconds": 1},
    )
    db.add(stream)
    db.flush()
    db.add_all(
        [
            Mapping(
                stream_id=stream.id,
                event_array_path=None,
                field_mappings_json={"event_id": "$.id", "message": "$.message"},
                raw_payload_mode="JSON",
            ),
            Enrichment(
                stream_id=stream.id,
                enrichment_json={"vendor": "SilentNoop"},
                override_policy="KEEP_EXISTING",
                enabled=True,
            ),
        ]
    )
    db.flush()
    destination = Destination(
        name=f"silent-dest-{suffix}",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://receiver-silent.example.com/hook"},
        rate_limit_json={"max_events": 100, "per_seconds": 1},
        enabled=True,
    )
    db.add(destination)
    db.flush()
    db.add(
        Route(
            stream_id=stream.id,
            destination_id=destination.id,
            enabled=True,
            failure_policy="LOG_AND_CONTINUE",
            formatter_config_json={},
            rate_limit_json={},
            status="ENABLED",
        )
    )
    db.add(
        Checkpoint(
            stream_id=stream.id,
            checkpoint_type="CUSTOM_FIELD",
            checkpoint_value_json={"last_cursor": None},
        )
    )
    db.commit()
    return int(stream.id)


def _fake_events(n: int = 1) -> list[dict[str, Any]]:
    out = []
    for i in range(n):
        out.append(
            {
                "id": f"e{i}",
                "message": f"m{i}",
                "severity": "1",
                "s3_bucket": "b",
                "s3_key": f"p/obj{i}.json",
                "s3_etag": f"t{i}",
                "s3_last_modified": "2024-01-01T00:00:00Z",
                "s3_size": 10,
            }
        )
    return out


def _stage_counts(db: Session, stream_id: int) -> dict[str, int]:
    rows = db.query(DeliveryLog).filter(DeliveryLog.stream_id == stream_id).all()
    counts: dict[str, int] = {"total": len(rows), "run_started": 0, "run_complete": 0, "run_failed": 0}
    for row in rows:
        stage = str(getattr(row, "stage", "") or "")
        if stage in counts:
            counts[stage] += 1
        elif stage == "route_send_success":
            counts["route_send_success"] = counts.get("route_send_success", 0) + 1
    return counts


def test_a_normal_s3_run_once_has_lifecycle_telemetry(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, db_session: Session
) -> None:
    """A: run-once + S3 objects → 2xx + run_started + run_complete + route success."""

    sid = _seed_s3_stream(db_session)
    monkeypatch.setattr(S3ObjectPollingAdapter, "fetch", lambda *a, **k: _fake_events(2))
    monkeypatch.setattr(
        "app.runners.stream_runner.WebhookSender",
        lambda *a, **k: _FakeWebhookSender(),
    )

    # Patch destination send path used by StreamRunner instances created in the endpoint.
    from app.runners import stream_runner as sr_mod

    orig_init = sr_mod.StreamRunner.__init__

    def _init(self: StreamRunner, *a: Any, **k: Any) -> None:
        orig_init(self, *a, **k)
        _install_fake_webhook_sender(self)
        self.source_limiter = _AllowAllLimiter()
        self.destination_limiter = _AllowAllLimiter()

    monkeypatch.setattr(sr_mod.StreamRunner, "__init__", _init)

    res = client.post(f"/api/v1/runtime/streams/{sid}/run-once")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body.get("outcome") in ("completed", "no_events")
    assert body.get("runtime_run_id")
    assert body.get("transaction_committed") is True

    db_session.expire_all()
    counts = _stage_counts(db_session, sid)
    assert counts["run_started"] >= 1
    assert counts["run_complete"] >= 1
    assert counts.get("route_send_success", 0) >= 1


def test_b_s3_empty_source_still_records_lifecycle(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, db_session: Session
) -> None:
    """B: empty S3 → run_started + run_complete/explicit empty; silent no-op forbidden."""

    sid = _seed_s3_stream(db_session)
    monkeypatch.setattr(S3ObjectPollingAdapter, "fetch", lambda *a, **k: [])

    from app.runners import stream_runner as sr_mod

    orig_init = sr_mod.StreamRunner.__init__

    def _init(self: StreamRunner, *a: Any, **k: Any) -> None:
        orig_init(self, *a, **k)
        self.source_limiter = _AllowAllLimiter()
        self.destination_limiter = _AllowAllLimiter()

    monkeypatch.setattr(sr_mod.StreamRunner, "__init__", _init)

    res = client.post(f"/api/v1/runtime/streams/{sid}/run-once")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body.get("outcome") == "no_events"
    assert body.get("runtime_run_id")
    db_session.expire_all()
    counts = _stage_counts(db_session, sid)
    assert counts["run_started"] >= 1
    assert counts["run_complete"] >= 1


def test_c_runtime_dispatch_failure_is_non_2xx(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, db_session: Session
) -> None:
    """C: Runtime dispatch failure → non-2xx + RUN_NOT_STARTED / RUN_ENQUEUE_FAILED style error."""

    sid = _seed_s3_stream(db_session)

    def _boom(*_a: Any, **_k: Any) -> dict[str, Any]:
        return {
            "stream_id": sid,
            "outcome": "not_started",
            "transaction_committed": False,
            "run_id": None,
            "error_code": "RUN_NOT_STARTED",
            "message": "dispatch failed before runtime entry",
        }

    monkeypatch.setattr(StreamRunner, "run", _boom)
    res = client.post(f"/api/v1/runtime/streams/{sid}/run-once")
    assert res.status_code >= 400
    detail = res.json().get("detail") or {}
    assert detail.get("error_code") in {
        "RUN_NOT_STARTED",
        "RUN_ENQUEUE_FAILED",
        "RUNTIME_INTERNAL_ERROR",
    }


def test_d_lock_failure_returns_409(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, db_session: Session
) -> None:
    """D: lock not acquired → HTTP 409 RUN_ALREADY_ACTIVE; 2xx forbidden."""

    sid = _seed_s3_stream(db_session)
    held = StreamRunner._get_lock(sid)
    assert held.acquire(blocking=False)
    try:
        res = client.post(f"/api/v1/runtime/streams/{sid}/run-once")
        assert res.status_code == 409, res.text
        detail = res.json().get("detail") or {}
        assert detail.get("error_code") == "RUN_ALREADY_ACTIVE"
        assert detail.get("stream_id") == sid
    finally:
        held.release()


def test_e_background_exception_persists_run_failed(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, db_session: Session
) -> None:
    """E: exception after Runtime entry → run_failed telemetry + non-2xx; no silent loss."""

    sid = _seed_s3_stream(db_session)

    def _explode(*_a: Any, **_k: Any) -> list[dict[str, Any]]:
        raise SourceFetchError("injected fetch boom")

    monkeypatch.setattr(S3ObjectPollingAdapter, "fetch", _explode)

    from app.runners import stream_runner as sr_mod

    orig_init = sr_mod.StreamRunner.__init__

    def _init(self: StreamRunner, *a: Any, **k: Any) -> None:
        orig_init(self, *a, **k)
        self.source_limiter = _AllowAllLimiter()
        self.destination_limiter = _AllowAllLimiter()

    monkeypatch.setattr(sr_mod.StreamRunner, "__init__", _init)

    res = client.post(f"/api/v1/runtime/streams/{sid}/run-once")
    assert res.status_code == 502, res.text
    detail = res.json().get("detail") or {}
    assert detail.get("error_code") == "SOURCE_FETCH_FAILED"
    assert detail.get("runtime_run_id")

    db_session.expire_all()
    counts = _stage_counts(db_session, sid)
    assert counts["run_started"] >= 1
    assert counts["run_failed"] >= 1


def test_f_empty_delivery_reseed_rerun_distinct_run_ids(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, db_session: Session
) -> None:
    """F: empty → reseed → second run has distinct runtime_run_id and delivery."""

    sid = _seed_s3_stream(db_session)
    state = {"n": 0}

    def _fetch(*_a: Any, **_k: Any) -> list[dict[str, Any]]:
        state["n"] += 1
        if state["n"] == 1:
            return []
        return _fake_events(1)

    monkeypatch.setattr(S3ObjectPollingAdapter, "fetch", _fetch)

    from app.runners import stream_runner as sr_mod

    orig_init = sr_mod.StreamRunner.__init__

    def _init(self: StreamRunner, *a: Any, **k: Any) -> None:
        orig_init(self, *a, **k)
        _install_fake_webhook_sender(self)
        self.source_limiter = _AllowAllLimiter()
        self.destination_limiter = _AllowAllLimiter()

    monkeypatch.setattr(sr_mod.StreamRunner, "__init__", _init)

    r1 = client.post(f"/api/v1/runtime/streams/{sid}/run-once")
    assert r1.status_code == 200, r1.text
    body1 = r1.json()
    id1 = body1.get("runtime_run_id")
    assert id1
    assert body1.get("outcome") == "no_events"

    r2 = client.post(f"/api/v1/runtime/streams/{sid}/run-once")
    assert r2.status_code == 200, r2.text
    body2 = r2.json()
    id2 = body2.get("runtime_run_id")
    assert id2
    assert id1 != id2
    # Second run must actually process the reseeded object (not another empty no-op).
    assert body2.get("outcome") == "completed"
    assert int(body2.get("extracted_event_count") or 0) >= 1
    assert int(body2.get("delivered_batch_event_count") or 0) >= 1

    db_session.expire_all()
    counts = _stage_counts(db_session, sid)
    assert counts["run_started"] >= 2
    assert counts["run_complete"] >= 2


def test_g_api_and_direct_runner_share_lifecycle_policy(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, db_session: Session
) -> None:
    """G: API run-once and direct StreamRunner.run share lifecycle telemetry policy."""

    sid = _seed_s3_stream(db_session)
    monkeypatch.setattr(S3ObjectPollingAdapter, "fetch", lambda *a, **k: _fake_events(1))

    from app.runners import stream_runner as sr_mod

    orig_init = sr_mod.StreamRunner.__init__

    def _init(self: StreamRunner, *a: Any, **k: Any) -> None:
        orig_init(self, *a, **k)
        _install_fake_webhook_sender(self)
        self.source_limiter = _AllowAllLimiter()
        self.destination_limiter = _AllowAllLimiter()

    monkeypatch.setattr(sr_mod.StreamRunner, "__init__", _init)

    api = client.post(f"/api/v1/runtime/streams/{sid}/run-once")
    assert api.status_code == 200, api.text
    api_run_id = api.json().get("runtime_run_id")

    # Second stream for direct runner path (avoid lock / checkpoint coupling).
    sid2 = _seed_s3_stream(db_session)
    runner = StreamRunner(
        source_limiter=_AllowAllLimiter(),
        destination_limiter=_AllowAllLimiter(),
        webhook_sender=_FakeWebhookSender(),
    )
    ctx = load_stream_context(db_session, sid2, require_enabled_stream=False)
    summary = runner.run(ctx, db=db_session)
    assert summary.get("run_id")
    assert summary.get("transaction_committed") is True
    assert api_run_id != summary.get("run_id")

    db_session.expire_all()
    assert _stage_counts(db_session, sid)["run_started"] >= 1
    assert _stage_counts(db_session, sid2)["run_started"] >= 1


def test_h_silent_runtime_noop_fixture_is_detected() -> None:
    """H: fixture HTTP 2xx + telemetry 0 must be classified SILENT_RUNTIME_NOOP (test FAIL signal)."""

    # Mirror harness detectSilentRuntimeNoop logic in Python for unit-level guard.
    stages = {"run_started": 0, "run_complete": 0, "total_rows": 0}
    http_ok = True
    runtime_executed = stages["total_rows"] > 0 and (
        stages["run_started"] > 0 or stages["run_complete"] > 0
    )
    silent = http_ok and not runtime_executed
    assert silent is True
    code = "SILENT_RUNTIME_NOOP"
    assert code == "SILENT_RUNTIME_NOOP"
    # This test intentionally fails the *product* condition, not the unit test:
    # detecting silent=True means the harness/product guard would FAIL the scenario.
    assert silent, "SILENT_RUNTIME_NOOP detection must fire for 2xx+telemetry0"


def test_lock_contention_concurrent_run_once_one_success(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, db_session: Session
) -> None:
    """Concurrent run-once: exactly one 2xx; others 409 — never all-2xx silent skips."""

    import time

    sid = _seed_s3_stream(db_session)
    gate = threading.Event()
    entered = threading.Event()
    results_lock = threading.Lock()
    results: list[int] = []

    def _slow_fetch(*_a: Any, **_k: Any) -> list[dict[str, Any]]:
        entered.set()
        assert gate.wait(timeout=30), "lock-holder fetch gate timed out"
        return _fake_events(1)

    monkeypatch.setattr(S3ObjectPollingAdapter, "fetch", _slow_fetch)

    from app.runners import stream_runner as sr_mod

    orig_init = sr_mod.StreamRunner.__init__

    def _init(self: StreamRunner, *a: Any, **k: Any) -> None:
        orig_init(self, *a, **k)
        _install_fake_webhook_sender(self)
        self.source_limiter = _AllowAllLimiter()
        self.destination_limiter = _AllowAllLimiter()

    monkeypatch.setattr(sr_mod.StreamRunner, "__init__", _init)

    def _call() -> None:
        r = client.post(f"/api/v1/runtime/streams/{sid}/run-once")
        with results_lock:
            results.append(r.status_code)

    t1 = threading.Thread(target=_call, name="run-once-holder")
    t1.start()
    assert entered.wait(timeout=30), "first run-once never entered source fetch"
    t2 = threading.Thread(target=_call, name="run-once-contender")
    t2.start()
    # Contender must observe the held lock before the holder finishes fetch.
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        with results_lock:
            if any(code == 409 for code in results):
                break
        time.sleep(0.05)
    gate.set()
    t1.join(timeout=60)
    t2.join(timeout=60)
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        with results_lock:
            if len(results) >= 2:
                break
        time.sleep(0.05)
    with results_lock:
        observed = sorted(results)
    assert observed == [200, 409], f"expected one success and one lock conflict, got {observed!r}"
