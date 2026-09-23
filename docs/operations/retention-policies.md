# Operational data retention — operator guidance

This guide summarizes **what** the platform ages out automatically, **recommended windows**, and **how** to operate cleanup safely. Authoritative behaviour is defined in **`specs/034-data-retention/spec.md`**, implemented under `app/retention/`, `app/platform_admin/cleanup_service.py`, and the HTTP API `GET/POST /api/v1/retention/*`.

## Scope (what retention touches)

| Domain | Primary tables / artefacts | Default window (code) | Policy knobs |
|--------|----------------------------|----------------------|--------------|
| **Delivery logs** | `delivery_logs` | 30 days (`logs_retention_days` on `platform_retention_policy`) | `logs_enabled`, batch size, scheduler |
| **Runtime / validation metrics** | `validation_runs`, `validation_recovery_events` (and related operational rows per scheduler) | 30 days default in code defaults; **row** policy uses `runtime_metrics_retention_days` | `runtime_metrics_enabled` |
| **Validation snapshots** | `continuous_validations.last_perf_snapshot_json` cleared when older than snapshot window | 7 days env default (`GDC_RETENTION_VALIDATION_SNAPSHOTS_DAYS` overrides) | Supplement scheduler (`GDC_OPERATIONAL_RETENTION_INTERVAL_SEC`) |
| **Backfill progress** | `backfill_progress_events`, `backfill_jobs` (stale jobs only; **never** delete `RUNNING` / `CANCELLING`) | 14 days defaults | `GDC_RETENTION_BACKFILL_*` env overrides |

**Never deleted by retention:** connector/stream/source/destination/route/mapping/checkpoint configuration rows required for runtime semantics. Retention operates on **operational telemetry and job bookkeeping**, not on active topology.

## Recommended retention windows

These are **starting points** for a typical mid-size deployment; increase when compliance or forensics requires longer online history.

| Data | Recommended online retention | Notes |
|------|-------------------------------|-------|
| **delivery_logs** | 14–90 days | Higher volume → shorter window or smaller `cleanup_batch_size` to spread I/O. |
| **validation_runs / recovery events** | 30–180 days | Longer if validation SLAs need historical proof. |
| **validation snapshots (embedded JSON)** | 7–30 days | Large JSON snapshots benefit from shorter windows. |
| **backfill progress events** | 7–30 days | Operational noise; keep long enough to debug recent jobs. |
| **backfill jobs (terminal)** | 14–60 days | Retains audit of completed/failed jobs; running jobs are protected. |

## Archive strategy (out of band)

The product retention layer performs **online deletion in PostgreSQL** only. For compliance:

1. **Logical export** before tightening retention: `pg_dump` / `COPY (SELECT …)` for relevant tables into encrypted object storage.
2. **WORM or glacier** tier for yearly compliance bundles if required.
3. **Restore drill:** periodically prove dumps restore into a non-production cluster.

The platform does **not** ship automatic archival to S3; wire your organisation’s backup pipeline (`docs/deployment/backup-restore.md`, `docs/admin/backup-restore.md`).

## Cleanup schedule

- **Primary scheduler:** `OperationalRetentionScheduler` (`app/retention/scheduler.py`) — default tick on the order of **minutes** in production compose; see spec 034 for lifecycle.
- **Supplement bundle:** validation snapshot trim + backfill-related housekeeping — interval `GDC_OPERATIONAL_RETENTION_INTERVAL_SEC` (default **86400s** / daily).
- **Manual / CI-safe checks:** `GET /api/v1/retention/preview` (counts only) and `POST /api/v1/retention/run` with `dry_run: true`.

Use **Admin → Operational** UI or the API to confirm `cleanup_scheduler_enabled`, last run timestamps, and last deleted counts.

## Destructive execution guard

Retention previews and dry-runs are available by default. Actual deletion is disabled until the operator explicitly enables it:

```bash
GDC_RETENTION_DESTRUCTIVE_ACTIONS_ENABLED=true
```

Production manual deletes also require:

```bash
GDC_RETENTION_PRODUCTION_DELETES_ENABLED=true
```

Automatic scheduler deletes are forbidden in production. Outside production, scheduler deletes require:

```bash
GDC_RETENTION_AUTOMATIC_DELETES_ENABLED=true
```

When automatic deletion is not allowed, the scheduler records a skip and does **not** run a `delivery_logs` `COUNT(*)` preview. That preview was a host-level I/O amplifier on large monthly partitions. Operator dry-run and preview still return exact counts while `delivery_logs` is under 1 GiB. At or above that size, preview and cleanup use partition catalog estimates (`pg_class.reltuples`) and bounded deletes (`max_deleted`) instead of a full-tree count. Re-enable destructive cleanup only after confirming the bounded path on a representative large `delivery_logs` tree. Current and next month partitions stay protected.

Expired runtime aggregate snapshot cleanup is also disabled by default and requires:

```bash
GDC_RUNTIME_AGGREGATE_SNAPSHOT_CLEANUP_ENABLED=true
```

Delivery log partition retention exposes partition drop planning in preview/dry-run output. Partition drop execution also requires `GDC_RETENTION_DELIVERY_LOG_PARTITION_DROP_ENABLED=true`. Current and next month partitions are always protected and never returned as drop targets.

Optional env overrides (merged into effective retention policies):

```bash
GDC_DELIVERY_LOG_RETENTION_DAYS=90
GDC_CHECKPOINT_HISTORY_RETENTION_DAYS=180
```

Checkpoint history (`checkpoint_update` rows in `delivery_logs`) uses `checkpoint_history_days` when set; otherwise it follows delivery log retention. Partition layout and maintenance: `docs/runtime/postgresql-partitioning.md`.

## Non-destructive operator scripts

Read-only / dry-run helpers live under `scripts/ops/` (see `scripts/ops/README.md`). They wrap the preview and dry-run retention APIs and **never** delete data by default.

## Related reading

- `specs/034-data-retention/spec.md`
- `specs/045-postgresql-partitioning-retention/spec.md`
- `docs/runtime/postgresql-partitioning.md`
- `app/retention/config.py` — `DEFAULT_RETENTION_POLICIES`
- `docs/deployment/uvicorn-gunicorn-production.md` — pool sizing vs retention batch load
