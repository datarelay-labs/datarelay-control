"""C-PERF runtime E2E with real StreamRunner, PostgreSQL, WebhookSender and HTTP receipts.

Never runs against shared state. The repository pytest catalog guard applies.
"""
from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from sqlalchemy.orm import Session

from app.checkpoints.route_delivery_state import ROUTE_DELIVERY_STATE_KEY, strip_route_delivery_state
from app.delivery.connection_pool import invalidate_httpx_client
from app.delivery.webhook_sender import WebhookSender
from app.destinations.models import Destination
from app.logs.models import DeliveryLog
from app.runners.stream_loader import load_stream_context
from tests.test_stream_runner_e2e import (
    _FakePoller, _build_runner, _checkpoint_value, _seed_stream_runtime,
)


@pytest.mark.parametrize(("routes", "fail_index"), [(1, None), (2, None), (5, None), (2, 1)])
def test_streamrunner_postgres_real_webhook_and_checkpoint(
    db_session: Session, routes: int, fail_index: int | None
) -> None:
    receipts: list[tuple[int, object]] = []

    class Receiver(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            index = int(self.path.rsplit("/", 1)[-1])
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            receipts.append((index, body))
            if index == 1:
                time.sleep(0.008)
            self.send_response(503 if index == fail_index else 200)
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, *_args) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Receiver)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    urls = []
    try:
        policies = ["LOG_AND_CONTINUE"] * routes
        if fail_index is not None:
            policies[fail_index] = "PAUSE_STREAM_ON_FAILURE"
        seed = _seed_stream_runtime(db_session, failure_policies=policies)
        for idx, destination_id in enumerate(seed["destination_ids"]):
            destination = db_session.get(Destination, destination_id)
            assert destination is not None
            url = f"http://127.0.0.1:{server.server_port}/events/{idx}"
            urls.append(url)
            destination.config_json = {
                "url": url, "timeout_seconds": 5, "retry_count": 0,
                "retry_backoff_seconds": 0, "batch_size": 10,
            }
            db_session.add(destination)
        db_session.commit()

        before = _checkpoint_value(db_session, seed["stream_id"])
        poller = _FakePoller(response={"items": [
            {"id": "evt-cperf-0", "message": "보안🛡️", "vendor": "test", "int_big": 9007199254740993},
            {"id": "evt-cperf-1", "message": "é汉字", "vendor": "test", "int_big": 9007199254740994},
        ]})
        runner = _build_runner(poller=poller, webhook_sender=WebhookSender())
        context = load_stream_context(db_session, seed["stream_id"])
        runner.run(context, db=db_session)
        after = _checkpoint_value(db_session, seed["stream_id"])

        # Native WebhookSender defaults to SINGLE mode: two HTTP requests
        # per Route, not one batch request. A 503 stops the failing Route
        # at its first event without advancing the checkpoint.
        successes = [(idx, payload) for idx, payload in receipts if idx != fail_index]
        failures = [(idx, payload) for idx, payload in receipts if idx == fail_index]
        assert len(successes) == (routes - (fail_index is not None)) * 2
        assert len(failures) == (1 if fail_index is not None else 0)
        for idx in range(routes):
            batch = [payload for route_idx, payload in receipts if route_idx == idx]
            expected = 1 if idx == fail_index else 2
            assert len(batch) == expected
            assert [item["message"] for item in batch] == ["보안🛡️", "é汉字"][:expected]
            assert [item["int_big"] for item in batch] == [
                9007199254740993, 9007199254740994,
            ][:expected]
        if fail_index is None:
            assert after["last_success_event"]["event_id"] == "evt-cperf-1"
            logs = db_session.query(DeliveryLog).filter(
                DeliveryLog.stream_id == seed["stream_id"],
                DeliveryLog.stage == "route_send_success",
            ).all()
            assert {log.route_id for log in logs} == set(seed["route_ids"])
        else:
            assert strip_route_delivery_state(after) == before
            assert ROUTE_DELIVERY_STATE_KEY in after
            assert context.stream["status"] == "PAUSED"
            logs = db_session.query(DeliveryLog).filter(
                DeliveryLog.stream_id == seed["stream_id"],
                DeliveryLog.stage == "route_send_failed",
            ).all()
            assert len(logs) == 1 and logs[0].route_id == seed["route_ids"][fail_index]
    finally:
        for url in urls:
            invalidate_httpx_client(f"webhook:{url}")
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
