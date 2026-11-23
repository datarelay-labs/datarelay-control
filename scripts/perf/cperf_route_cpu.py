"""Synthetic, non-production Route Processing CPU A/B harness for Issue #466.

No database access, credentials, network traffic or live Stream changes. Covers
extraction, per-route transform/protection/classification/policy and transport
serialization. This is NOT a substitute for operational receiver or browser E2E.
"""
from __future__ import annotations

import argparse
import cProfile
import gc
import hashlib
import json
import os
from pathlib import Path
import pstats
import resource
import statistics
import subprocess
import time
from datetime import datetime, timezone
from typing import Any

from app.parsers.event_extractor import extract_events
from app.route_delivery.config import RouteSendOutcome
from app.route_protection.resolver import resolve_route_protection_config
from app.runners.route_context import (
    RouteEffectiveConfig, RouteRuntimeContext, RouteTransformConfig, SharedBatchContext,
)
from app.runners.route_stage import process_routes


def source_records(size: str, count: int) -> dict[str, Any]:
    length = {"small": 64, "medium": 2048, "large": 16384}[size]
    return {"items": [
        {"id": f"event-{i}", "message": "é测试🛡" + "x" * length,
         "severity": i % 5, "big_int": 9007199254740993 + i,
         "action": "allow" if i % 2 else "deny",
         "nested": {"source": {"ip": f"192.0.2.{i % 250 + 1}",
                                "port": 10000 + i},
                    "labels": [str(i), {"flag": i % 3 == 0}],
                    "extra": {"data": ["α", None, -0.5]}},
         "raw": [{"n": j, "text": "X" * 32} for j in range(3)]}
        for i in range(count)
    ]}


def route(number: int, complex_routes: bool) -> RouteRuntimeContext:
    fields = {
        "event_id": "$.id", "message": "$.message", "severity": "$.severity",
        "src": "$.nested.source", "labels": "$.nested.labels",
        "big_int": "$.big_int",
    }
    if complex_routes and number % 2:
        fields["action"] = "$.action"
    transform = RouteTransformConfig(
        field_mappings=fields,
        enrichment={"product": "cperf-fixture"},
        override_policy="KEEP_EXISTING",
        mapping_source="route", enrichment_source="route",
    )
    return RouteRuntimeContext(
        route_id=100 + number, stream_id=999, destination_id=200 + number,
        route_name=f"synthetic-route-{number}", route_type="WEBHOOK_POST",
        formatter={}, delivery_policy="LOG_AND_CONTINUE", rate_limit={},
        metadata={},
        effective_config=RouteEffectiveConfig(
            transform=transform,
            protection=resolve_route_protection_config(route_id=100 + number, stream_id=999),
        ),
    )


def exercise(raw: dict[str, Any], count: int, complex_routes: bool) -> dict[str, Any]:
    t0 = time.perf_counter_ns()
    events = extract_events(raw, "$.items")
    t1 = time.perf_counter_ns()
    receipts: list[tuple[int, int, str]] = []

    def send(ctx: RouteRuntimeContext, payload: list[dict[str, Any]]) -> RouteSendOutcome:
        wire = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        receipts.append((
            ctx.route_id, len(payload), hashlib.sha256(wire.encode("utf-8")).hexdigest()
        ))
        return RouteSendOutcome(success=True, latency_ms=0, adapter_stage="synthetic_receipt")

    shared = SharedBatchContext(
        stream_id=999, batch_id="synthetic-batch", event_root=None, union_schema=[],
        extracted_events=events, schema_observation={}, sensitive_detection_result=None,
        checkpoint_cursor_before=None, shared_runtime_data={},
    )
    result = process_routes([route(j, complex_routes) for j in range(count)], shared, send_fn=send)
    t2 = time.perf_counter_ns()
    if result.metrics.route_delivery_success_count != count or len(receipts) != count:
        raise AssertionError("Synthetic Route send count or pipeline disposition changed")
    if any(n != len(events) for _, n, _ in receipts):
        raise AssertionError("Synthetic receiver event count mismatch")
    checksum = hashlib.sha256(json.dumps(receipts, sort_keys=True).encode()).hexdigest()
    return {
        "extraction_ms": (t1 - t0) / 1e6, "route_ms": (t2 - t1) / 1e6,
        "wall_ms": (t2 - t0) / 1e6,
        "events": len(events), "deliveries": sum(n for _, n, _ in receipts),
        "receipt_sha256": checksum,
    }


def percentile(xs: list[float], frac: float) -> float:
    ordered = sorted(xs)
    return round(ordered[min(len(ordered) - 1, int((len(ordered) - 1) * frac))], 4)


def measure(size: str, count: int, routes: int, iterations: int,
            complex_routes: bool) -> dict[str, Any]:
    raw = source_records(size, count)
    exercise(raw, routes, complex_routes)  # Warm JSONPath and class imports.
    latencies: list[float] = []
    extraction: list[float] = []
    route_times: list[float] = []
    checksums: set[str] = set()
    before_gc = [entry["collections"] for entry in gc.get_stats()]
    wall_before = time.perf_counter()
    cpu_before = os.times()
    for _ in range(iterations):
        item = exercise(raw, routes, complex_routes)
        latencies.append(item["wall_ms"])
        extraction.append(item["extraction_ms"])
        route_times.append(item["route_ms"])
        checksums.add(item["receipt_sha256"])
    elapsed = time.perf_counter() - wall_before
    cpu_after = os.times()
    if len(checksums) != 1:
        raise AssertionError("Nondeterministic results across identical batches")
    return {
        "payload": size, "route_count": routes, "complex_routes": complex_routes,
        "events_per_batch": count, "iterations": iterations,
        "input_eps": round(count * iterations / elapsed, 2),
        "receiver_events": count * routes * iterations,
        "p50_ms": percentile(latencies, 0.50), "p95_ms": percentile(latencies, 0.95),
        "p99_ms": percentile(latencies, 0.99),
        "mean_extraction_ms": round(statistics.mean(extraction), 4),
        "mean_route_ms": round(statistics.mean(route_times), 4),
        "cpu_user_s": round(cpu_after.user - cpu_before.user, 4),
        "cpu_system_s": round(cpu_after.system - cpu_before.system, 4),
        "rss_max_kb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        "gc_collections": [
            entry["collections"] - n for entry, n in zip(gc.get_stats(), before_gc)
        ],
        "errors": 0, "receipt_sha256": next(iter(checksums)),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--iterations", type=int, default=7)
    parser.add_argument("--events", type=int, default=40)
    parser.add_argument("--profile", type=str, default="")
    parser.add_argument("--output", type=str, default="")
    args = parser.parse_args()
    if not (1 <= args.iterations <= 100 and 1 <= args.events <= 500):
        parser.error("Refuse unbounded profiling workload")
    rows = []
    for size in ("small", "medium", "large"):
        for routes in (1, 2, 5):
            rows.append(measure(size, args.events, routes, args.iterations,
                                complex_routes=True))
    if args.profile:
        profiler = cProfile.Profile()
        profiler.enable()
        exercise(source_records("medium", args.events), 5, True)
        profiler.disable()
        profiler.dump_stats(args.profile)
        pstats.Stats(profiler).sort_stats("cumtime").print_stats(18)
    out = {
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "git_sha": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
        "type": "synthetic-cpu-process-routes-no-io-no-db",
        "rows": rows,
    }
    payload = json.dumps(out, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(payload + "\n", encoding="utf-8")
    print("CPERF_RESULT_JSON=" + json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
