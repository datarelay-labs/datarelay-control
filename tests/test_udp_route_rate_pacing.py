"""BFS #410 UDP 10 EPS Route Edit regression; no live sockets or product DB."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

import app.delivery.syslog_sender as syslog_module
from app.delivery.syslog_sender import SyslogSender
from app.rate_limit.process_destination_limiter import reset_process_destination_rate_limiter_for_tests
from app.runners.stream_runner import StreamRunner
from app.runtime.errors import DestinationSendError


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        assert seconds >= 0.0
        self.now += seconds


class DatagramSocket:
    def __init__(self, clock: Clock, sent: list[tuple[float, str]]) -> None:
        self.clock = clock
        self.sent = sent

    def __enter__(self) -> "DatagramSocket":
        return self

    def __exit__(self, *_args: object) -> None:
        pass

    def settimeout(self, _timeout: float) -> None:
        pass

    def connect(self, _address: tuple[str, int]) -> None:
        pass

    def send(self, payload: bytes) -> int:
        self.sent.append((self.clock.monotonic(), payload.decode("utf-8")))
        return len(payload)

    def getsockopt(self, *_args: object) -> int:
        return 0


@pytest.fixture
def udp_lab(monkeypatch: pytest.MonkeyPatch) -> tuple[StreamRunner, Clock, list[tuple[float, str]]]:
    reset_process_destination_rate_limiter_for_tests()
    clock = Clock()
    sent: list[tuple[float, str]] = []
    monkeypatch.setattr(syslog_module.socket, "socket", lambda *_args, **_kw: DatagramSocket(clock, sent))
    monkeypatch.setattr(syslog_module.time, "monotonic", clock.monotonic)
    monkeypatch.setattr(syslog_module.time, "sleep", clock.sleep)
    monkeypatch.setattr(
        syslog_module,
        "format_delivery_lines_syslog",
        lambda events, *_args, **_kw: [str(event["seq"]) for event in events],
    )
    runner = StreamRunner(
        poller=MagicMock(),
        webhook_sender=MagicMock(),
        syslog_sender=SyslogSender(),
    )
    runner._log = MagicMock()  # type: ignore[method-assign]
    runner._set_stream_status = MagicMock()  # type: ignore[method-assign]
    runner._db_read = MagicMock(return_value={})  # type: ignore[method-assign]
    runner._db_write = MagicMock()  # type: ignore[method-assign]
    runner._maybe_record_replay_event = MagicMock()  # type: ignore[method-assign]
    yield runner, clock, sent
    reset_process_destination_rate_limiter_for_tests()


def _route(route_id: int = 42, *, rate: dict | None = None) -> dict:
    return {
        "id": route_id,
        "failure_policy": "PAUSE_STREAM_ON_FAILURE",
        "formatter_config_json": {},
        "rate_limit_json": rate if rate is not None else {
            "enabled": True,
            "per_second": 10,
            "burst_size": 10,
            "batch_size": 100,
        },
        "destination": {
            "id": route_id + 100,
            "name": "UDP receiver",
            "destination_type": "SYSLOG_UDP",
            "enabled": True,
            "config": {"host": "127.0.0.1", "port": 514, "timeout_seconds": 0},
        },
    }


def _send(runner: StreamRunner, route: dict, count: int, offset: int = 0):
    return runner._send_route_events(
        {"id": 20, "name": "source", "routes": [route]},
        route,
        [{"seq": i} for i in range(offset, offset + count)],
    )


def test_ui_rate_10eps_paces_every_udp_datagram_without_dropping_events(udp_lab) -> None:
    runner, _clock, sent = udp_lab
    result = _send(runner, _route(), 27)
    assert result.success is True
    assert [value for _, value in sent] == [str(i) for i in range(27)]
    # Burst=10 means the eleventh and subsequent events must be paced.
    assert sent[9][0] == pytest.approx(0.0)
    assert sent[10][0] >= 0.09
    assert sent[20][0] >= 1.0
    runner._set_stream_status.assert_not_called()


def test_pacing_budget_persists_across_batches_and_is_per_route(udp_lab) -> None:
    runner, clock, sent = udp_lab
    one = _route(42)
    two = _route(43)
    assert _send(runner, one, 8).success
    assert _send(runner, one, 5, offset=8).success
    assert sent[9][0] == pytest.approx(0.0)
    assert sent[10][0] >= 0.09
    before = clock.monotonic()
    assert _send(runner, two, 10, offset=100).success
    assert sent[-1][0] == pytest.approx(before)


def test_disabled_ui_limit_and_legacy_batch_limit_are_unchanged(udp_lab) -> None:
    runner, clock, sent = udp_lab
    assert _send(runner, _route(10, rate={"enabled": False}), 27).success
    assert clock.monotonic() == pytest.approx(0.0)
    assert len(sent) == 27
    legacy = _route(11, rate={"max_events": 1, "per_seconds": 1})
    assert _send(runner, legacy, 27).success
    denied = _send(runner, legacy, 27, offset=100)
    assert denied.rate_limited is True
    assert len(sent) == 54  # legacy guard still blocks the entire second batch


def test_retries_reuse_ui_pacing_policy_without_bypassing_it(udp_lab) -> None:
    runner, _, _ = udp_lab
    route = _route()
    route["failure_policy"] = "RETRY_AND_BACKOFF"
    route["retry_count"] = 1
    route["backoff_seconds"] = 0
    captured: list[dict] = []

    def fake_send(_type, _events, config, **_kwargs):
        captured.append(config)
        if len(captured) == 1:
            raise DestinationSendError("first attempt down")

    runner._send_to_destination = fake_send  # type: ignore[method-assign]
    result = _send(runner, route, 3)
    assert result.success is True
    assert len(captured) == 2
    assert all(x["_route_udp_event_rate"]["route_id"] == 42 for x in captured)


def test_failover_secondary_udp_uses_its_own_configured_budget(udp_lab) -> None:
    runner, _, _ = udp_lab
    sent_configs: list[dict] = []
    runner._db_read = MagicMock(return_value={"host": "127.0.0.1", "port": 514})  # type: ignore[method-assign]
    runner._send_to_destination = (  # type: ignore[method-assign]
        lambda _type, _events, config, **_kwargs: sent_configs.append(config)
    )
    binding = SimpleNamespace(
        failover_route_id=3,
        secondary_destination_enabled=True,
        secondary_destination_id=7,
        secondary_destination_name="UDP backup",
        secondary_destination_type="SYSLOG_UDP",
        secondary_destination_config={"host": "127.0.0.1", "port": 514},
        secondary_rate_limit_json={"enabled": True, "per_second": 10, "burst_size": 10},
    )
    outcome = runner._attempt_failover_send(
        {"id": 20, "name": "source"},
        route_id=42,
        primary_destination_id=9,
        events=[{"seq": 1}],
        formatter_override=None,
        failover_bindings={9: binding},
        primary_error=DestinationSendError("primary down"),
        primary_latency_ms=1,
    )
    assert outcome.succeeded is True
    assert len(sent_configs) == 1
    assert sent_configs[0]["_route_udp_event_rate"]["route_id"] == -(3 + 1_000_000)



def test_bfs410_270_udp_events_at_ten_eps_take_at_least_26_seconds(udp_lab) -> None:
    runner, _, sent = udp_lab
    assert _send(runner, _route(), 270).success
    assert len(sent) == 270
    assert sent[-1][0] >= 25.9
    assert [value for _, value in sent] == [str(i) for i in range(270)]


def test_bad_enabled_rate_never_sends_unlimited_udp_datagrams(udp_lab) -> None:
    runner, _, sent = udp_lab
    invalid = _route(42, rate={"enabled": True, "per_second": 0, "burst_size": 10})
    outcome = _send(runner, invalid, 27)
    assert outcome.success is False
    assert sent == []
    assert outcome.primary_send_failed is True
    assert outcome.error is not None and "UDP Route rate-limit" in outcome.error


def test_partial_udp_socket_failure_does_not_report_route_delivery_success(
    udp_lab, monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner, clock, sent = udp_lab
    class FailAfterEleven(DatagramSocket):
        def send(self, payload: bytes) -> int:
            if len(self.sent) == 11:
                raise OSError("receiver unavailable during batch")
            return super().send(payload)

    monkeypatch.setattr(
        syslog_module.socket, "socket", lambda *_args, **_kw: FailAfterEleven(clock, sent)
    )
    runner._update_checkpoint_after_success = MagicMock()  # type: ignore[method-assign]
    outcome = _send(runner, _route(), 27)
    assert outcome.success is False
    assert len(sent) == 11
    assert outcome.primary_send_failed is True
    assert all(value == str(i) for i, (_, value) in enumerate(sent))
    assert runner._set_stream_status.call_args.args[1] == "PAUSED"
    runner._update_checkpoint_after_success.assert_not_called()


def test_destination_pacing_default_is_used_without_route_override(udp_lab) -> None:
    runner, _, sent = udp_lab
    route = _route(rate={})
    route["destination"]["rate_limit_json"] = {
        "enabled": True, "per_second": 5, "burst_size": 2
    }
    assert _send(runner, route, 5).success
    assert sent[1][0] == pytest.approx(0)
    assert sent[2][0] >= 0.19
    assert sent[4][0] >= 0.59



def test_dynamic_udp_route_receives_its_own_rate_intent(udp_lab) -> None:
    runner, _, _ = udp_lab
    captured = []
    runner._send_to_destination = (  # type: ignore[method-assign]
        lambda _type, _events, config, **_kwargs: captured.append(config)
    )
    match = SimpleNamespace(
        destination_id=70,
        dynamic_route_id=5,
        destination_enabled=True,
        destination_name="dynamic UDP",
        destination_type="SYSLOG_UDP",
        destination_config={"host": "127.0.0.1", "port": 514},
        rate_limit_json={"enabled": True, "per_second": 10, "burst_size": 10},
    )
    sent = runner._deliver_dynamic_routes(
        {"id": 20, "name": "stream"},
        [{"seq": 10}],
        dynamic_routing=SimpleNamespace(matches=[match]),
        skip_destination_ids=set(),
    )
    assert sent == 1
    assert captured[0]["_route_udp_event_rate"]["route_id"] == -5


def test_udp_token_reservations_preserve_budget_under_parallel_requests() -> None:
    from concurrent.futures import ThreadPoolExecutor

    from app.rate_limit.destination_limiter import DestinationRateLimiter

    limiter = DestinationRateLimiter()
    with ThreadPoolExecutor(max_workers=8) as pool:
        delays = sorted(pool.map(
            lambda _index: limiter.reserve_event(
                42, per_second=10, burst_size=10, now=0,
            ),
            range(27),
        ))
    assert delays[:10] == [0] * 10
    assert delays[10] == pytest.approx(0.1)
    assert delays[-1] == pytest.approx(1.7)
    assert limiter.reserve_event(43, per_second=10, burst_size=10, now=0) == 0



def test_prior_ui_rate_shape_without_enabled_flag_still_paces(udp_lab) -> None:
    runner, _, sent = udp_lab
    # Route Edit already regards numeric per_second and enabled != false as ON.
    route = _route(rate={"per_second": 10, "burst_size": 10})
    assert _send(runner, route, 12).success
    assert sent[10][0] >= 0.09
    assert len(sent) == 12
