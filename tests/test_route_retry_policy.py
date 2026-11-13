"""Route retry/backoff follows the configured policy; replay evidence and records (F-168, F-169, F-170)."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.logs.models import DeliveryLog
from app.replay.models import StreamReplayEvent
from app.runners.route_retry_policy import (
    RouteRetryPolicy,
    is_retryable_delivery_error,
    resolve_route_retry_policy,
)
from app.runners.stream_loader import load_stream_context
from app.runtime.errors import DestinationSendError
from app.runtime.replay_service import assess_replay_eligibility
from tests.test_stream_runner_e2e import (
    _FakePoller,
    _build_runner,
    _delivery_logs,
    _seed_stream_runtime,
)

ROUTE_URL = "https://receiver-0.example.com/events"
EVENT = {"items": [{"id": "evt-retry", "message": "hello", "vendor": "MappedVendor"}]}


class _ScriptedSender:
    """Fails with the scripted exceptions in order, then succeeds."""

    def __init__(self, failures: list[Exception]) -> None:
        self.failures = list(failures)
        self.calls: list[dict[str, Any]] = []

    def send(self, events: list[dict[str, Any]], config: dict[str, Any], formatter_override: Any = None, **kwargs: Any) -> None:
        self.calls.append({"events": events, "config": dict(config)})
        if self.failures:
            raise self.failures.pop(0)


def _always(exc_factory: Any, times: int) -> list[Exception]:
    return [exc_factory() for _ in range(times)]


def _run(db: Session, *, rate_limit: dict[str, Any], sender: _ScriptedSender, policy: str = "RETRY_AND_BACKOFF") -> dict[str, Any]:
    fixture = _seed_stream_runtime(db, failure_policies=[policy], route_rate_limit_jsons=[rate_limit])
    context = load_stream_context(db, fixture["stream_id"])
    runner = _build_runner(poller=_FakePoller(response=EVENT), webhook_sender=sender)
    delays: list[float] = []
    runner._sleep_unless_stopped = lambda _sid, seconds: delays.append(round(seconds, 3)) or False  # type: ignore[method-assign]
    runner.run(context, db=db)
    return {"fixture": fixture, "delays": delays, "stream_id": fixture["stream_id"], "route_id": fixture["route_ids"][0]}


def _rows(db: Session, stream_id: int, stage: str) -> list[DeliveryLog]:
    return [row for row in _delivery_logs(db, stream_id) if row.stage == stage]


# --- pure policy ---------------------------------------------------------------------------


def test_policy_reads_the_route_editor_configuration() -> None:
    policy = resolve_route_retry_policy(
        {
            "rate_limit_json": {
                "enabled": True,
                "max_retry": 5,
                "retry_backoff": "Exponential",
                "initial_backoff_sec": 1,
                "max_backoff_sec": 60,
                "max_delivery_time_sec": 0,
            }
        }
    )
    assert policy == RouteRetryPolicy(5, "exponential", 1.0, 60.0, 0.0)
    assert [policy.delay_before_retry(i) for i in range(5)] == [1, 2, 4, 8, 16]


def test_policy_caps_exponential_delay_at_max_backoff() -> None:
    policy = resolve_route_retry_policy({"rate_limit_json": {"max_retry": 8, "initial_backoff_sec": 10, "max_backoff_sec": 30}})
    assert [policy.delay_before_retry(i) for i in range(4)] == [10, 20, 30, 30]


def test_policy_linear_backoff() -> None:
    policy = resolve_route_retry_policy(
        {"rate_limit_json": {"max_retry": 4, "retry_backoff": "Linear", "initial_backoff_sec": 2, "max_backoff_sec": 5}}
    )
    assert [policy.delay_before_retry(i) for i in range(4)] == [2, 4, 5, 5]


def test_policy_zero_max_retry_is_honored_not_defaulted() -> None:
    assert resolve_route_retry_policy({"rate_limit_json": {"max_retry": 0}}).max_retries == 0


def test_policy_falls_back_to_legacy_route_columns_then_defaults() -> None:
    assert resolve_route_retry_policy({"retry_count": 4, "backoff_seconds": 0.5}).max_retries == 4
    assert resolve_route_retry_policy({"retry_count": 4, "backoff_seconds": 0.5}).initial_backoff_sec == 0.5
    assert resolve_route_retry_policy({}).max_retries == 2


@pytest.mark.parametrize(
    ("status", "retryable"),
    [(401, False), (403, False), (404, False), (422, False), (408, True), (429, True), (500, True), (503, True), (None, True)],
)
def test_client_errors_are_not_retryable(status: int | None, retryable: bool) -> None:
    assert is_retryable_delivery_error(DestinationSendError("x", http_status=status)) is retryable
    assert is_retryable_delivery_error(RuntimeError("boom")) is True


# --- runtime -------------------------------------------------------------------------------


def test_runtime_follows_configured_max_retry_and_backoff(db_session: Session) -> None:
    sender = _ScriptedSender(_always(lambda: DestinationSendError("HTTP 500", http_status=500), 20))
    out = _run(
        db_session,
        rate_limit={"max_retry": 4, "retry_backoff": "Exponential", "initial_backoff_sec": 1, "max_backoff_sec": 60},
        sender=sender,
    )
    # one initial attempt plus exactly the configured four retries, with exponential delays
    assert len(sender.calls) == 5
    assert out["delays"] == [1.0, 2.0, 4.0, 8.0]
    failed = _rows(db_session, out["stream_id"], "route_retry_failed")
    assert len(failed) == 1
    row = failed[0]
    assert row.retry_count == 4
    assert row.http_status == 500
    payload = row.payload_sample
    assert payload["max_retries"] == 4
    assert payload["give_up_reason"] == "retries_exhausted"
    assert [a["attempt"] for a in payload["retry_attempts"]] == [1, 2, 3, 4]
    assert [a["delay_before_sec"] for a in payload["retry_attempts"]] == [1.0, 2.0, 4.0, 8.0]
    assert all(a["outcome"] == "failed" and a["http_status"] == 500 for a in payload["retry_attempts"])


def test_sender_level_retries_are_not_multiplied_when_the_route_owns_retries(db_session: Session) -> None:
    sender = _ScriptedSender(_always(lambda: DestinationSendError("HTTP 500", http_status=500), 5))
    _run(db_session, rate_limit={"max_retry": 1, "initial_backoff_sec": 0}, sender=sender)
    assert len(sender.calls) == 2
    assert all(call["config"].get("retry_count") == 0 for call in sender.calls)


def test_non_retryable_401_is_not_retried(db_session: Session) -> None:
    sender = _ScriptedSender(_always(lambda: DestinationSendError("HTTP 401", http_status=401), 10))
    out = _run(db_session, rate_limit={"max_retry": 5, "initial_backoff_sec": 1}, sender=sender)
    assert len(sender.calls) == 1
    assert out["delays"] == []
    row = _rows(db_session, out["stream_id"], "route_retry_failed")[0]
    assert row.retry_count == 0
    assert row.http_status == 401
    assert row.payload_sample["give_up_reason"] == "non_retryable_error"
    assert "HTTP 401 is not retryable" in row.message


def test_max_retry_zero_means_no_retry(db_session: Session) -> None:
    sender = _ScriptedSender(_always(lambda: DestinationSendError("HTTP 500", http_status=500), 5))
    out = _run(db_session, rate_limit={"max_retry": 0}, sender=sender)
    assert len(sender.calls) == 1
    row = _rows(db_session, out["stream_id"], "route_retry_failed")[0]
    assert row.payload_sample["give_up_reason"] == "retries_disabled"


def test_max_delivery_time_stops_retrying(db_session: Session) -> None:
    sender = _ScriptedSender(_always(lambda: DestinationSendError("HTTP 500", http_status=500), 20))
    out = _run(
        db_session,
        rate_limit={"max_retry": 10, "initial_backoff_sec": 100, "max_backoff_sec": 100, "max_delivery_time_sec": 50},
        sender=sender,
    )
    assert len(sender.calls) == 1
    assert _rows(db_session, out["stream_id"], "route_retry_failed")[0].payload_sample["give_up_reason"] == "max_delivery_time_reached"


def test_retry_success_records_attempts_and_no_replay_job(db_session: Session) -> None:
    sender = _ScriptedSender([DestinationSendError("HTTP 500", http_status=500)])
    out = _run(db_session, rate_limit={"max_retry": 3, "initial_backoff_sec": 0}, sender=sender)
    assert len(sender.calls) == 2
    ok = _rows(db_session, out["stream_id"], "route_retry_success")
    assert len(ok) == 1 and ok[0].retry_count == 1
    assert ok[0].payload_sample["retry_attempts"][0]["outcome"] == "succeeded"
    # the batch was delivered by the retry: nothing may be left to replay
    assert db_session.query(StreamReplayEvent).filter(StreamReplayEvent.stream_id == out["stream_id"]).count() == 0


# --- F-170: one replay job per failed batch -------------------------------------------------


def test_failed_batch_creates_exactly_one_replay_job_under_retry_policy(db_session: Session) -> None:
    sender = _ScriptedSender(_always(lambda: DestinationSendError("HTTP 500", http_status=500), 20))
    out = _run(db_session, rate_limit={"max_retry": 2, "initial_backoff_sec": 0}, sender=sender)
    jobs = db_session.query(StreamReplayEvent).filter(StreamReplayEvent.stream_id == out["stream_id"]).all()
    assert len(jobs) == 1
    assert jobs[0].route_id == out["route_id"]


def test_failed_batch_creates_exactly_one_replay_job_under_log_and_continue(db_session: Session) -> None:
    sender = _ScriptedSender(_always(lambda: DestinationSendError("HTTP 500", http_status=500), 20))
    out = _run(db_session, rate_limit={}, sender=sender, policy="LOG_AND_CONTINUE")
    assert db_session.query(StreamReplayEvent).filter(StreamReplayEvent.stream_id == out["stream_id"]).count() == 1


# --- F-169: the failed log row carries the events needed to replay it ------------------------


def test_failed_delivery_log_row_is_replayable(db_session: Session) -> None:
    sender = _ScriptedSender(_always(lambda: DestinationSendError("HTTP 500", http_status=500), 20))
    out = _run(db_session, rate_limit={}, sender=sender, policy="LOG_AND_CONTINUE")
    failed = _rows(db_session, out["stream_id"], "route_send_failed")
    assert len(failed) == 1
    assert failed[0].http_status == 500
    assert failed[0].payload_sample.get("replay_events"), "route_send_failed row must carry replay_events"
    eligibility = assess_replay_eligibility(db_session, failed[0])
    assert eligibility.eligible is True, eligibility.message


# --- sender: a client error is not retried (F-168) ---------------------------------------------


def _webhook_with_status(monkeypatch: pytest.MonkeyPatch, status: int) -> list[int]:
    import httpx

    requests: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(1)
        return httpx.Response(status, json={"error": "x"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.delivery.webhook_sender.get_httpx_client", lambda **_kw: client)
    monkeypatch.setattr("app.delivery.webhook_sender.invalidate_httpx_client", lambda _key: None)
    monkeypatch.setattr("app.delivery.webhook_sender.time.sleep", lambda _s: None)
    return requests


@pytest.mark.parametrize("status", [400, 401, 403, 404, 422])
def test_webhook_sender_does_not_retry_client_errors(monkeypatch: pytest.MonkeyPatch, status: int) -> None:
    from app.delivery.webhook_sender import WebhookSender

    requests = _webhook_with_status(monkeypatch, status)
    with pytest.raises(DestinationSendError) as excinfo:
        WebhookSender().send([{"a": 1}], {"url": "https://r.example.com/h", "retry_count": 5})
    assert len(requests) == 1
    assert excinfo.value.http_status == status
    assert "not retried" in str(excinfo.value)


@pytest.mark.parametrize("status", [429, 500, 503])
def test_webhook_sender_still_retries_transient_errors(monkeypatch: pytest.MonkeyPatch, status: int) -> None:
    from app.delivery.webhook_sender import WebhookSender

    requests = _webhook_with_status(monkeypatch, status)
    with pytest.raises(DestinationSendError) as excinfo:
        WebhookSender().send([{"a": 1}], {"url": "https://r.example.com/h", "retry_count": 2})
    assert len(requests) == 3
    assert excinfo.value.http_status == status
