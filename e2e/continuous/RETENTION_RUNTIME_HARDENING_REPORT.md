# DATA_RELAY retention runtime hardening and controlled cleanup

Phase: `DATA_RELAY_RETENTION_RUNTIME_HARDENING_AND_CONTROLLED_CLEANUP`  
Date: 2026-09-13  
Host: `datarelay`  
Worktree: `/home/aella/gdc-platform-worktrees/db-retention-audit` (`audit/db-retention`)

This report does **not** overwrite prior audit evidence. It records the hardening sequence after PR #31 (`1350874`).

## Baseline

| Field | Value |
|-------|-------|
| `START_MAIN_HEAD` | `135087457cce86344b3c059c8179451e7f0bbbe6` |
| `START_RETENTION_HEAD` / `8bf00b1` | `8bf00b12662a8de0716dcf974f9bc6d14ed224ab` |
| Merge-base vs `origin/main-v2` | `1350874` (ahead 1 / behind 0) |
| `RETENTION_PR` | [#32](https://github.com/datarelay-labs/gdc-platform/pull/32) **MERGED** |
| `RETENTION_MERGE_COMMIT` / `POST_MERGE_MAIN_HEAD` | `a84051b1eda73b2fe4644f5d9c0e864adedebb54` |

## ORM root cause

Standalone scheduler (`python -m app.scheduler.standalone`) does not import FastAPI routers. Retention / stream supervision then configure SQLAlchemy mappers while string `relationship()` targets such as `Connector` (from `Stream`) are unregistered:

```text
InvalidRequestError: When initializing mapper Mapper[Stream(streams)],
expression 'Connector' failed to locate a name ('Connector')
```

Normal API (`app.main`) loads connector/stream model modules via routers, so the same mapper graph usually configures successfully there.

Affected entry points before the fix: entire standalone process (stream supervisor, continuous validation, runtime snapshot/analytics, **and** `OperationalRetentionScheduler`).

### Fix (bootstrap only)

- `app/db/orm_bootstrap.py` → `ensure_orm_models_registered()` imports relationship-linked model modules and calls `configure_mappers()`
- Called from `OperationalRetentionScheduler.start()` and `run_standalone_scheduler()`
- No retention_days change, no destructive defaults, no model metadata changes

## Retention entry points

| ENTRY_POINT | ORM_BOOTSTRAP_USED | ROW_DELETE | PARTITION_DROP | DESTRUCTIVE_GUARD | SCHEDULED |
|-------------|-------------------|------------|----------------|-------------------|-----------|
| `OperationalRetentionScheduler` → `cleanup_service.run_cleanup` | YES (`start` + standalone) | YES (category `logs`) | NO | `retention_execution_decision` | YES |
| `OperationalRetentionScheduler` → `run_supplement_bundle` | YES | YES (backfill/snapshots only) | NO | same | YES (throttled) |
| `PartitionMaintenanceScheduler` | N/A (DDL ensure) | NO | NO (CREATE only) | N/A | YES |
| `POST /api/v1/retention/run` → `run_operational_retention` | Via API process imports | YES | YES (if flag) | same + partition flag | NO (manual) |
| `GET /api/v1/retention/preview` | Via API | NO | preview only | N/A | N/A |
| `scripts/ops/retention_operator_helpers.sh` | HTTP only | dry-run | preview | N/A | NO |
| Lab `lab_cleanup_cli` | Lab-specific; DROP SQL print never executes | lab rows | SQL print only | lab flags | NO |

`RETENTION_ENTRY_POINT_GAPS`: scheduled path never performs partition DROP even when `GDC_RETENTION_DELIVERY_LOG_PARTITION_DROP_ENABLED=true` (DROP is only on `run_operational_retention` / manual API).

## Tests / scope

- Targeted: `38 passed, 1 skipped` (`orm_bootstrap`, operational retention, partition retention/env, delivery_logs partitioning, scheduler unified, cleanup service)
- CI on PR #32: all required checks green (`pytest`, `pytest-full`, e2e-smoke, frontend, release-gate, migrations)
- `SECRET_SCAN=PASS` / `RUNTIME_ARTIFACT_SCAN=PASS` / `UNRELATED_DIFF=NO` (four files only)

## Deploy / runtime verify

Redeployed **scheduler only** (image built from clean worktree at `8bf00b1`, recreated with main compose healthcheck):

| Field | Value |
|-------|-------|
| `DEPLOYED_GIT_HEAD` / runtime code | merge content `8bf00b1` / main `a84051b` |
| Image | `sha256:002355a7ce…` includes `/app/app/db/orm_bootstrap.py` |
| Health | `healthy` (process cmdline probe) |
| Destructive flags | all **false** (unchanged) |

Observed retention ticks (destructive OFF → guarded skip):

```text
logs:skipped(0), runtime_metrics:skipped(0), preview_cache:not_applicable(0), backup_temp:skipped(0)
supplement: backfill_*:skipped(0), continuous_validations...:skipped(0)
```

- `ORM_FAILURE_AFTER_FIX=NO`
- `logs_last_cleanup_at` remains NULL: **expected** — when destructive actions are disabled, cleanup forces effective dry-run and `_persist_outcome` does not mutate last-cleanup timestamps

## Dry-run / eligibility (NOW ≈ 2026-09-13 UTC)

```text
POLICY_DAYS=30
CUTOFF=2026-08-14T…Z

ELIGIBLE_PARTITIONS:
  delivery_logs_2026_07   rows=0   bounds=['2026-07-01','2026-08-01')   ~2611 MB

PROTECTED_PARTITIONS:
  delivery_logs_2026_08   ~4.48M rows  2026-08-29..2026-08-31  (in retention window)
  delivery_logs_2026_09   active current (~24 GB, writing)
  delivery_logs_2026_10   future pre-created
  delivery_logs_2026_11   future pre-created
  delivery_logs_default   default catch-all
```

Row-delete eligible `delivery_logs` count at cutoff: **0** (empty July + August rows all after cutoff).  
Storage reclaim for July requires **partition DROP**, not row DELETE.

### Per-partition (revalidated)

| PARTITION | ROW_COUNT | MIN/MAX | SIZE | RETENTION_ELIGIBLE | DROP_SAFE | REASON |
|-----------|-----------|---------|------|--------------------|-----------|--------|
| `…_2026_07` | 0 | n/a | ~2.6 GB | YES | YES | month_end ≤ cutoff_month; empty; not protected |
| `…_2026_08` | 4480118 | 08-29..08-31 | ~5.5 GB | NO | NO | in-window data; month not fully expired |
| `…_2026_09` | ~20.8M | 09-01..now | ~24 GB | NO | NO | active month |
| `…_2026_10/11` | 0 | n/a | 112 kB | NO | NO | future protected |
| `…_default` | 0 | n/a | 112 kB | NO | NO | default |

## Controlled July cleanup

`CONTROLLED_DROP_READY=YES`  
`DESTRUCTIVE_CLEANUP_EXECUTED=NO` (awaiting explicit approval; APPROVAL notification sent)

Proposed product path (July only via eligibility engine — do not ad-hoc `DROP TABLE`):

```bash
# one-shot env for operator process only — do NOT leave AUTOMATIC_DELETES on
GDC_RETENTION_DESTRUCTIVE_ACTIONS_ENABLED=true \
GDC_RETENTION_DELIVERY_LOG_PARTITION_DROP_ENABLED=true \
# then:
POST /api/v1/retention/run  {"dry_run": false, "tables": ["delivery_logs"]}
# or run_operational_retention(..., dry_run=False, tables={"delivery_logs"}, trigger="manual")
```

Do **not** enable `GDC_RETENTION_AUTOMATIC_DELETES_ENABLED` for this validation.

Pre-drop snapshot: DB total **32 GB**; July **2611 MB** table+indexes; partitions listed above.

## Automatic policy recommendation

| Concern | Finding |
|---------|---------|
| Row DELETE role | Partial/edge months + default partition; batch deletes inside retention cutoff |
| Partition DROP role | Preferred reclaim for **fully** expired monthly children |
| Order in `run_operational_retention` | DROP eligible partitions first, then batched DELETE |
| Duplicate work | Minimal if DROP removes whole months before DELETE |
| Bloat risk | Large row DELETE on hot partitions creates dead tuples; prefer DROP when safe |
| Scheduler DROP gap | **INTENTIONAL_MANUAL_POLICY** (esp. production forbids automatic deletes) with **DOCUMENTATION_GAP** / wiring note: scheduled `run_cleanup` never drops partitions |

Recommended flags for **non-production lab** once operator accepts automatic reclaim (not applied this phase):

```text
GDC_RETENTION_DESTRUCTIVE_ACTIONS_ENABLED=true
GDC_RETENTION_AUTOMATIC_DELETES_ENABLED=true   # row path via OperationalRetentionScheduler
GDC_RETENTION_DELIVERY_LOG_PARTITION_DROP_ENABLED=true
```

Still requires either manual/cron `retention/run` for DROP, or a follow-up to schedule partition DROP outside production.  
`AUTOMATIC_POLICY_CHANGE_APPLIED=NO`

Production remains: destructive + production deletes only for explicit manual runs; no automatic scheduler deletes.

## Other findings

### `platform_alert_history`

- ~101 MB, ~98k rows, growing (~2–29k rows/day recently)
- No production retention policy / cleanup code found
- Classification: `RETENTION_POLICY_MISSING` + `FOLLOWUP_REQUIRED` (low priority vs delivery_logs)
- Do not invent a retention duration in this phase

### Autovacuum / bloat

- September partition: large live set, low dead tuples (283); analyze present; autovacuum not recently recorded on that child
- `runtime_analytics_bucket_5m`: elevated dead tuples → **MONITOR**
- Empty July/August heaps are **storage from empty partitions**, not classic bloat
- Classification: table/index → `MONITOR` / July reclaim via DROP preferred; no `VACUUM FULL` / `REINDEX`

### E2E / DEV VALIDATION volume

- Last-hour share ≈ continuous E2E **14.2%** / DEV VALIDATION+E2E lab **85.8%**
- Many DEV VALIDATION streams emit `FAILED` / WireMock 404 noise while still enabled (product rule: **do not remove** DEV VALIDATION / DEV E2E assets)
- Classification: `EXPECTED_TEST_LOAD` + `ACTIVE_TOO_NOISY`; `STALE_E2E_RESOURCES_CLEANED=NO`

### Growth model

| Metric | Estimate |
|--------|----------|
| `CURRENT_DAILY_DB_GROWTH` | ~1.5–2 GB/day (Sep partition ≈24 GB / 13 days; row rates 0.8–1.7M/day) |
| `PROJECTED_30_DAY_WITH_RETENTION_OFF` | unbounded; ~+45–60 GB / 30d at current rate → ~80–90 GB class |
| `PROJECTED_30_DAY_WITH_RETENTION_ON` | bounded near ~30 days of hot data (~50–60 GB class at current write rate) after DROP+DELETE work |
| `EXPECTED_STEADY_STATE_DB_SIZE` | ~1 month of delivery_logs + small operational tables, once DROP lifecycle is operated |

## Product health after hardening (no destructive cleanup)

| Check | Result |
|-------|--------|
| Active delivery logging | PASS (`delivery_logs_2026_09` writes; thousands / 5m) |
| Checkpoint continuity | PASS (checkpoint_update rows in last 5m) |
| Stream health sample (continuous E2E 337) | PASS (route HEALTHY; stream IDLE/RUNNING) |
| Unexpected data loss | NO |
| Full 32k / real SaaS | NO |

## Next recommended action

1. Explicitly approve July-only controlled DROP via product retention path above  
2. After July reclaim, decide non-prod automatic flag set + whether to schedule partition DROP outside production  
3. Follow-up: `platform_alert_history` retention policy design (no duration invented here)
