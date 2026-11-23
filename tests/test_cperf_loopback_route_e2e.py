"""C-PERF-4: actual loopback HTTP receiver receipts for CPU-optimized Route fanout.

This is an isolated runtime integration test; not a Browser/FUE acceptance pass.
"""
from __future__ import annotations

import copy
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen

import pytest

from app.parsers.event_extractor import extract_events
from app.route_delivery.config import RouteSendOutcome
from app.runners.route_context import RouteTransformConfig, SharedBatchContext
from app.runners.route_stage import process_routes
from tests.test_route_runtime_delivery import _route_ctx


@pytest.mark.parametrize("route_count", [1, 2, 5])
def test_actual_receiver_route_fanout_and_no_cross_route_mutation(route_count: int) -> None:
    received: list[tuple[int, list[dict]]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 (stdlib callback)
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length))
            received.append((int(self.headers["X-Route-ID"]), payload))
            if self.headers["X-Route-ID"] == "101":
                time.sleep(0.008)  # Artificial backpressure, still acknowledge.
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, *_args) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        raw = {
            "items": [
                {
                    "id": f"e-{idx}", "message": "보안🛡️", "big_int": 9007199254740993 + idx,
                    "nested": {"labels": ["Ω", None, {"flag": True}]},
                }
                for idx in range(5)
            ]
        }
        original = copy.deepcopy(raw)
        events = extract_events(raw, "$.items")
        shared = SharedBatchContext(
            stream_id=123, batch_id="cperf-loopback", event_root=None,
            union_schema=[], extracted_events=events, schema_observation={},
            sensitive_detection_result=None, checkpoint_cursor_before=None,
            shared_runtime_data={},
        )
        routes = []
        for idx in range(route_count):
            ctx = _route_ctx()
            ctx.route_id = 100 + idx
            ctx.destination_id = 200 + idx
            ctx.stream_id = 123
            ctx.effective_config.transform = RouteTransformConfig(
                field_mappings={
                    "event_id": "$.id", "message": "$.message",
                    "precise_int": "$.big_int",
                },
                enrichment={"route_tag": f"route-{idx}"},
                override_policy="KEEP_EXISTING",
                mapping_source="route", enrichment_source="route",
            )
            routes.append(ctx)

        def send(ctx, payload):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            request = Request(
                f"http://127.0.0.1:{server.server_port}/receiver",
                data=body, method="POST",
                headers={"Content-Type": "application/json",
                         "X-Route-ID": str(ctx.route_id)},
            )
            with urlopen(request, timeout=5) as response:
                assert response.status == 200
                assert response.read() == b"ok"
            return RouteSendOutcome(success=True, latency_ms=0)

        result = process_routes(routes, shared, send_fn=send)
        assert result.metrics.route_delivery_success_count == route_count
        assert result.metrics.route_delivery_failure_count == 0
        assert len(received) == route_count
        for idx, (route_id, payload) in enumerate(received):
            assert route_id == 100 + idx
            assert len(payload) == 5
            for event_index, item in enumerate(payload):
                assert item["precise_int"] == 9007199254740993 + event_index
                assert item["message"] == "보안🛡️"
                assert item["route_tag"] == f"route-{idx}"
                assert item["nested"]["labels"] == ["Ω", None, {"flag": True}]
        assert raw == original
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
