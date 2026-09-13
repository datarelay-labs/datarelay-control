# Source Outage Health Hardening Report

- Phase: `DATA_RELAY_SOURCE_OUTAGE_HEALTH_HARDENING`
- Branch: `fix/source-outage-health`
- Worktree: `/home/aella/gdc-platform-worktrees/source-health-hardening`
- START_MAIN_HEAD: `c44059e1cdbc49c57828669995f53d484f95ec0f` (unchanged from `origin/main-v2`)
- Discovered by: 8.51h Continuous E2E soak (`test/e2e-overnight-soak-r2`)
- Historical soak report preserved: `e2e/continuous/OVERNIGHT_SOAK_REPORT.md` in the r2 soak worktree (not rewritten)

## Product status findings reviewed (4/4)

| # | Time (UTC) | Fault | Stream | Classification |
|---|------------|-------|--------|----------------|
| 1 | 2026-09-12T16:44:15Z | http_source (WireMock stop) | Healthy CRM contacts | **REAL_PRODUCT_BUG** / SAME_ROOT_CAUSE |
| 2 | 2026-09-12T17:14:15Z | postgres_source | Healthy ITSM tickets (PostgreSQL) | **REAL_PRODUCT_BUG** / SAME_ROOT_CAUSE |
| 3 | 2026-09-12T17:44:16Z | s3_source | Idle / no-new-data S3 docs | **REAL_PRODUCT_BUG** / SAME_ROOT_CAUSE |
| 4 | 2026-09-12T18:14:11Z | sftp_source | Healthy finance invoices (SFTP) | **REAL_PRODUCT_BUG** / SAME_ROOT_CAUSE |

Pattern in all four: run-once correctly returned non-2xx (`SOURCE_FETCH_FAILED` / `RUNTIME_INTERNAL_ERROR`) while operational `health_status` remained `HEALTHY`.

## Root cause

```text
Layer diagnosis = B (facts persisted, classifier ignored) + D (historical success masked)
               + F (run-once SourceFetchError path skipped snapshot refresh)
```

1. Source outages persist as `delivery_logs.stage=run_failed`.
2. Operational/scored health only consumed route delivery stages (`route_send_*`).
3. Historical `last_success_at` therefore kept streams `HEALTHY`.
4. Run-once `SourceFetchError` raised before snapshot refresh (PR #30 refresh was success-path only).
5. Idle/no-data recovery writes `source_fetch` / `run_complete` without `route_send_success`, so after an outage `last_success` never advanced past `run_failed` until `source_fetch` was included in stream last-success.

No second health model was introduced. Destination PR #30 stage set remains delivery-only for routes/destinations.

## Canonical facts / classifier

- **Facts:** `run_failed` (exhausted source failure), `source_fetch` (successful collection including empty), `route_send_*` (delivery).
- **Stream stages:** `STREAM_FAILURE_STAGES = FAILURE_STAGES | {run_failed}`; `STREAM_SUCCESS_STAGES = SUCCESS_STAGES | {source_fetch}` (last-success only; EPS stays delivery-only).
- **Classifier:** existing `classify_stream_health` — unrecovered outage → `DEGRADED`/`ERROR`; recovered (`last_success >= last_error` and no failed routes) → `HEALTHY` even if the 5m failure window still lags.

## Collateral fix surfaced by health truthfulness

Scheduler had been writing ~500 `run_failed`/hour with SQLAlchemy `DetachedInstanceError` on detached `Mapping` ORM rows (invisible while health ignored `run_failed`). Eager mapping/enrichment snapshots in `stream_loader` stop that noise (`detached_last_2m=0` after deploy).

## Stream count reconciliation (14)

| Class | Count | Streams |
|-------|------:|---------|
| NORMAL_DELIVERING | 12 | CRM, commerce, ITSM, SFTP, multi-route, rate-limited, dest-slow, schema-drift, latency, Syslog TLS, WordPress, Frappe |
| INTENTIONAL_IDLE | 1 | Idle / no-new-data S3 docs |
| OTHER_EXPECTED | 1 | Collaboration webhook push → Syslog TCP (requires inbound payload; not run-once deliverable) |
| UNEXPECTED_NON_DELIVERING | 0 | — |

`12 + 1 + 1 = 14`. `STREAM_COUNT_RECONCILED=YES`.

## DB growth classification

Overnight: ~32.2GB → ~32.9GB (+~0.6GB). Dominant tables: `delivery_logs_2026_09` (~24GB), older partitions Jul/Aug still present, plus analytics buckets / alert history.

```text
DB_GROWTH_CLASSIFICATION=EXPECTED_WITH_RETENTION
DB_RETENTION_FOLLOWUP_REQUIRED=YES  # old delivery_logs partitions + linear history
```

Not a product leak from this fix; overnight delta is linear operational history.

## Validation

### Unit

- `tests/test_source_outage_health.py` + destination regression suite: **23 passed**

### Live Continuous E2E short soak (~3m primary + destination retest)

| Case | Result |
|------|--------|
| HTTP 500 stub → recover | PASS (ERROR during fault, HEALTHY after) |
| HTTP WireMock stop ×3 | PASS |
| Postgres stop | PASS (DEGRADED/ERROR → HEALTHY) |
| S3/MinIO stop | PASS |
| SFTP stop | PASS |
| Toxiproxy timeout | PASS |
| Idle S3 no-data | PASS (HEALTHY, not ERROR) |
| Destination total failure (Syslog collector) | PASS (retest; longer collector warmup) |
| False HEALTHY after fix | NO |
| Stuck ERROR after recovery | NO (after Mapping snapshot + source_fetch last-success) |

Evidence: `e2e/continuous/soak/evidence/source_outage_health_short_soak/` (local only; not committed).

## E2E infra

Ported TLS assertion update from r2 soak (PR #30-compatible collector failure/recovery checks) into `e2e/lab/tls-negative/tls_negative_recovery.test.py`.

## Semantics preserved

- Successful retry / final success → not stuck ERROR
- No Data / Idle S3 → not ERROR
- Destination total → ERROR; partial route failure remains DEGRADED path
- Checkpoint/runtime fetch behavior unchanged
