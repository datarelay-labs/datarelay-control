# C-PERF Control Runtime Profiling and Python Optimization — 2026-11-23

**Tracker:** [#466](https://github.com/datarelay-labs/datarelay-control/issues/466) · **WBS registration:** [PR #467](https://github.com/datarelay-labs/datarelay-control/pull/467) · **Parent roadmap:** [#354](https://github.com/datarelay-labs/datarelay-control/issues/354).

**Safety:** An isolated development worktree based on PR #467. No edits to active UX #413 worktrees, operator Streams, credentials, live DB, seed EPS, or production deployments. Python 3.12 on dev-drcontrol; fixtures are fully synthetic. This report is not a release qualification or observed customer throughput gain.

## C-PERF-0 — Reproducible source and baseline

- Baseline source tree: `0cdea717db6c53de90b9d809e8862814cde3f76e` (docs-only).
- Candidate code commit: `11c8d6b6bb52f0b640f887101e57d5d3af0aed20`.
- Benchmark: `scripts/perf/cperf_route_cpu.py --iterations 9 --events 50`, cold process per run, JSONPath warmed once per scenario.
- Workloads: 50 synthetic records per batch, small/medium/large message (64/2048/16384 characters), nested arrays/objects, 2^53+ ints, unicode, distinct transforms and policy/route send.
- Real Route Processing functions: `extract_events` then `process_routes` with 1, 2 or 5 routes; simulated successful destination serialization plus SHA-256 receiver checksums.
- Metrics: input EPS, batch latency p50/p95/p99 (9 sample percentiles), user/system CPU, process high-water RSS, GC, successful receiver event counts and error count.
- Important limit: CPU-only, no real DB or remote destination; tiny sample size means p95/p99 and cross-run percent gains are directional, **not** operator-visible guarantees.

## C-PERF-1 — CPU attribution

Reproducible cProfile evidence: baseline 50-record medium/5-route sample (`/home/aella/.local/state/control-cperf-20261123/baseline.prof`). Top cumulative times in the sampled call graph: Route pipeline 0.137 s, mapping 0.075 s, unknown-field residual handling 0.054 s, recursive copying 0.047 s (overlapping inclusive costs). JSONPath matching 0.029 s and enrichment 0.024 s. The existing 1024-entry JSONPath compile cache and batch-local route transform/protection reuse were present before this work. Sensitive Detection and external I/O were not activated by this synthetic sample and remain outside its proof.

## C-PERF-2 — Initial Python change and exploratory A/B (historical; see matched results below)

1. `app/mappers/pass_through.py`: prune only premarked path ancestors instead of descending through unrelated source structures, preserving untouched empty containers.
2. `app/parsers/event_extractor.py`: remove redundant isolation copies before the single normalizing deep copy; source objects remain unmodified and output remains detached.
3. `tests/test_pass_through.py` and `tests/test_event_extractor_copy_once.py`: nested/array/root/error/unicode/large integer and mutation-isolation coverage.
4. `app/mappers/mapper.py` and `app/mappers/pass_through.py`: reuse guarded first JSONPath matches; differential tests check old vs new results, literals, nested selectors, errors and source isolation.

| Payload | Routes | Baseline input EPS | Candidate EPS | Change | Baseline p95 ms | Candidate p95 ms | Receipt hash |
|---|---:|---:|---:|---:|---:|---:|---|
| small | 1 | 2084.73 | 2579.42 | +23.7% | 24.97 | 19.94 | MATCH |
| small | 2 | 834.45 | 1207.92 | +44.8% | 76.20 | 39.12 | MATCH |
| small | 5 | 774.98 | 1107.07 | +42.9% | 72.11 | 47.73 | MATCH |
| medium | 1 | 1839.19 | 2131.88 | +15.9% | 36.38 | 22.12 | MATCH |
| medium | 2 | 977.12 | 1282.81 | +31.3% | 58.60 | 38.83 | MATCH |
| medium | 5 | 791.42 | 879.18 | +11.1% | 65.97 | 57.34 | MATCH |
| large | 1 | 1322.73 | 1335.39 | +1.0% | 38.14 | 43.89 | MATCH |
| large | 2 | 591.68 | 655.12 | +10.7% | 88.21 | 81.94 | MATCH |
| large | 5 | 332.83 | 349.26 | +4.9% | 158.06 | 144.34 | MATCH |

All nine synthetic receipt digests match exactly, with the same event and Route delivery counts. Some large-record p95 samples worsened; there is no blanket performance PASS. See retained machine JSON in `docs/performance/evidence/` for p50/p99, CPU, RSS, GC, errors and digests.

## C-PERF-2 matched A/B after JSONPath first-match reuse (e60d5390)

The initial one-pass reported gains were not stable: a first 31-iteration A/B exposed 3–5% five-Route regressions. The new candidate reuses already evaluated first JSONPath matches in mapping and residual pruning, with guarded fallback for different path lists.

Two alternating baseline/candidate runs, each 31 batches of 50 events for each 1/2/5 Route × small/medium/large workload. Medians across two runs. CPU-only synthetic measurement, not actual customer EPS or SLA.

| Size | Routes | Baseline EPS | New EPS | Change | Baseline p95 | New p95 | Baseline p99 | New p99 | Receipt |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| small | 1 | 2054.47 | 2799.45 | +36.3% | 32.83 | 20.02 | 35.63 | 21.32 | MATCH |
| small | 2 | 1178.27 | 1416.33 | +20.2% | 45.35 | 42.14 | 47.87 | 46.68 | MATCH |
| small | 5 | 944.28 | 1192.08 | +26.2% | 64.29 | 46.39 | 89.07 | 68.86 | MATCH |
| medium | 1 | 2127.84 | 2448.00 | +15.0% | 27.42 | 25.11 | 28.89 | 32.40 | MATCH |
| medium | 2 | 1044.83 | 1265.58 | +21.1% | 54.47 | 44.62 | 56.46 | 45.09 | MATCH |
| medium | 5 | 787.17 | 887.91 | +12.8% | 82.67 | 71.64 | 100.08 | 81.86 | MATCH |
| large | 1 | 1290.48 | 1335.32 | +3.5% | 41.44 | 39.41 | 42.61 | 43.40 | MATCH |
| large | 2 | 591.34 | 675.54 | +14.2% | 108.99 | 78.44 | 118.27 | 103.61 | MATCH |
| large | 5 | 344.41 | 367.20 | +6.6% | 171.26 | 150.97 | 180.83 | 166.12 | MATCH |

All nine median EPS improved +3.5% to +36.3%. Some p99 values worsened; no blanket latency claim. Four machine JSON runs are retained in evidence/ as cperf-e60-paired-*.json.

## C-PERF-3 — Conditional native/Rust evaluation

The external [fast-anything](https://github.com/EL4CTEO/fast-anything) project is MIT-licensed and uses PyO3 for Python. No Rust toolchain was installed on this dev host. The measured hot path involves Python jsonpath-ng AST objects and route/context-sensitive copy/mapping semantics; naive per-field FFI would add conversion costs and a separate platform wheel/rollback dependency. **No Rust port was attempted or deployed:** the conditional native trial has no demonstrated incremental whole-pipeline gain beyond the Python changes, so it remains **NOT ADOPTED** pending a separately demonstrated portable pure-function hotspot with a positive FFI-inclusive A/B.

## C-PERF-4 — Transport and backpressure scope

Dedicated `tests/test_cperf_loopback_route_e2e.py` sends real HTTP loopback requests to a temporary threaded receiver for 1/2/5 route fanout, tests receiver receipts, large integer value fidelity, nested/unicode payloads, route-specific enrichment and unmodified original records. Route 2 introduces controlled receiver delay. The additional `tests/test_cperf_streamrunner_http_e2e.py` runs the actual `StreamRunner → WebhookSender → HTTP Receiver` with real disposable PostgreSQL checkpoint and delivery logs (4/4 PASS): 1/2/5 Route success plus an HTTP 503 destination with PAUSE_STREAM_ON_FAILURE and held checkpoint. The native webhook default sends one POST per event. Full authenticated Browser, Quarantine and Replay acceptance remain separate and NOT PASSED.

## C-PERF-4a — Measured PostgreSQL and native Webhook A/B (2026-11-24)

A source-matched, isolated actual-transport test (`tests/test_cperf_transport_io_perf.py`) executes native `StreamRunner.run` through `WebhookSender`, a live loopback HTTP receiver and a disposable PostgreSQL16 `gdc_pytest` catalog. Destination explicitly uses `BATCH_JSON_ARRAY` (32 events), seven source batches per Route scenario, each with a 4,096-character synthetic message. Receiver introduces 10ms delay for the second Route. It verifies all HTTP receipts, precise checkpoints, and delivery-log row counts. No operator/test seed changes, no shared DB or authentication configuration changes. This test does not exercise RBAC or browser login.

Baseline source `0cdea717`; optimized source `4f78240c`. Three runs of each variant. EPS and p95 are *run-level medians*; 7 samples per run make percentile tails weak estimates. Service/network state, OS caches and host contention are not perfectly controlled.

| Routes | Baseline median EPS | Candidate median EPS | Delta | Baseline p95 ms | Candidate p95 ms | Baseline CPU-user s | Candidate CPU-user s |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | 80.89 | 95.82 | +18.5% | 361.93 | 168.36 | 1.26 | 0.98 |
| 2 | 86.62 | 85.75 | -1.0% | 224.83 | 220.53 | 0.96 | 1.04 |
| 5 | 70.15 | 68.62 | -2.2% | 285.76 | 304.61 | 1.47 | 1.57 |

**Interpretation:** 1-Route median throughput improved, but 2-Route and 5-Route medians declined slightly. These runs do **not** establish a universal whole-system gain for network/DB-bound routes; the CPU-only improvements in C-PERF-2 must not be quoted as customer throughput. The 2/5 Route differences are small relative to run-to-run variance. Do not add Rust/native fast-path or merge for performance alone without representative operator evidence.

**Machine evidence:** `docs/performance/evidence/cperf-http-db-ab-20261124.json`. Every scenario across both variants passed with zero send errors, exact checkpoint, and 224/448/1120 received records for 1/2/5 Route, respectively.

## C-PERF-5 — Regression and acceptance

- Final isolated PostgreSQL affected regression (after first-match reuse): **201 passed, 1 skipped, 0 failed** across 18 Python files (2026-11-23).
- Synthetic route loopback receiver integration: **3/3 passed** for 1/2/5 routes.
- Actual WebhookSender/StreamRunner/PostgreSQL+HTTP receiver: **4/4 passed**, including HTTP 503 checkpoint hold.
- Post-change focused Mapping/extraction/differential test run: **56/56 PASS**.
- Unit regression and route loopback test outputs are retained in `/home/aella/.local/state/control-cperf-20261123/`; update this section after full CI.
- Existing `5–20 EPS` dev lab seeding is unmodified by this patch; dedicated EPS guardrail `test_lab_throughput_config.py`, `test_dev_validation_lab.py`, and `test_visible_e2e_seed.py` passed **43/44 (1 pre-existing skip, 0 failures)** on 2026-11-24.
- Formal BFS 20, two-user FUE 24, official UX57 **not claimed PASSED**; active UX #413 has separate dirty worktrees and is not overwritten.
- Actual StreamRunner+PostgreSQL+Webhook receipt/checkpoint policy is covered in isolated tests. Customer/live network capacity, all replay/quarantine/failover conditions and the authenticated Browser/FUE product surfaces remain unverified.

## C-PERF-6 — Rollback and handoff

Rollback is a normal revert of the two Python optimization commits (`11c8d6b6` and `e60d5390`) or using the previous immutable main-v2 artifact; no database schema, persisted contract, new service, Rust wheel or runtime flag is introduced. Disable by reverting commit, retest extraction and pass-through mapping. Do not deploy to production/merge until active UX user gates and exact-head CI/review are completed.
