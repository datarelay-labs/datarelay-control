"""Repeatable local-only StreamRunner + PostgreSQL + real HTTP receiver benchmark.

This is a synthetic bounded I/O throughput test, not a Browser/FUE or
production performance benchmark. Only use an explicitly guarded pytest catalog.
"""
from __future__ import annotations

import gc
import json
import os
import resource
import statistics
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.delivery.connection_pool import invalidate_httpx_client
from app.delivery.webhook_sender import WebhookSender
from app.destinations.models import Destination
from app.logs.models import DeliveryLog
from app.runners.stream_loader import load_stream_context
from tests.test_stream_runner_e2e import _FakePoller, _build_runner, _seed_stream_runtime


def _pct(data: list[float], fraction: float) -> float:
    values = sorted(data)
    return round(values[min(len(values)-1, int((len(values)-1)*fraction))], 3)


@pytest.mark.parametrize("route_count", [1, 2, 5])
def test_local_real_http_postgres_fanout_throughput(db_session: Session, route_count: int) -> None:
    # No extra Stream records outside pytest catalog. A small artificial delay
    # on the second route makes network backpressure observable.
    delivered: list[tuple[int, int, str]] = []
    class Receiver(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            route = int(self.path.split("/")[-1])
            received = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            assert isinstance(received, list) and len(received) == 32
            if route == 1:
                time.sleep(0.01)
            delivered.append((route, len(received), received[-1]["event_id"]))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, *_args) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Receiver)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    urls: list[str] = []
    try:
        seed = _seed_stream_runtime(db_session, failure_policies=["LOG_AND_CONTINUE"]*route_count)
        for idx, destination_id in enumerate(seed["destination_ids"]):
            dest = db_session.get(Destination, destination_id)
            assert dest is not None
            url = f"http://127.0.0.1:{server.server_port}/ingest/{idx}"
            urls.append(url)
            dest.config_json = {
                "url": url, "payload_mode": "BATCH_JSON_ARRAY",
                "timeout_seconds": 5, "retry_count": 0,
                "retry_backoff_seconds": 0, "batch_size": 32,
            }
            db_session.add(dest)
        db_session.commit()
        poller = _FakePoller()
        runner = _build_runner(poller=poller, webhook_sender=WebhookSender())
        user_before = os.times()
        gc_before = [x["collections"] for x in gc.get_stats()]
        latencies: list[float] = []
        started = time.perf_counter()
        for sequence in range(7):
            poller.response = {"items": [
                {"id": f"batch{sequence:02d}-event{j:02d}",
                 "message": "⚙️security-test"+"A"*4096,
                 "vendor": "cperf-only", "exact_large_int": 9007199254740993+j,
                 "nested": {"sources": [{"ip":"198.51.100.1", "unicode":"한글"}]}}
                for j in range(32)
            ]}
            context = load_stream_context(db_session, seed["stream_id"])
            t0 = time.perf_counter()
            run = runner.run(context, db=db_session)
            latencies.append((time.perf_counter()-t0)*1000)
            assert run["outcome"] in ("completed", "success"), run
        elapsed = time.perf_counter()-started
        cpu = os.times()
        assert len(delivered) == route_count*7
        assert all(events==32 for _,events,_ in delivered)
        assert all(sorted(x[0] for x in delivered[i*route_count:(i+1)*route_count]) == list(range(route_count)) for i in range(7))
        checkpoint = db_session.query(Checkpoint).filter(Checkpoint.stream_id==seed["stream_id"]).one()
        assert checkpoint.checkpoint_value_json["last_success_event"]["event_id"]=="batch06-event31"
        logs = db_session.query(DeliveryLog).filter(
            DeliveryLog.stream_id==seed["stream_id"], DeliveryLog.stage=="route_send_success"
        ).all()
        assert len(logs)==7*route_count
        metrics = {
            "scope":"isolated-db-http-e2e", "routes":route_count, "event_payload_chars":4096,
            "events_per_run":32,"runs":7,"receiver_events":len(delivered)*32,
            "input_eps":round(7*32/elapsed,2),
            "p50_ms":_pct(latencies,0.5),"p95_ms":_pct(latencies,0.95),
            "p99_ms":_pct(latencies,0.99),
            "cpu_user_s":round(cpu.user-user_before.user,3),
            "cpu_sys_s":round(cpu.system-user_before.system,3),
            "rss_kb":resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
            "gc_collections":[z["collections"]-o for z,o in zip(gc.get_stats(),gc_before)],
            "failures":0,"checkpoint":"batch06-event31",
        }
        print("CPERF_IO_JSON="+json.dumps(metrics,sort_keys=True))
    finally:
        for url in urls:
            invalidate_httpx_client(f"webhook:{url}")
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
