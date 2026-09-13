# DATA_RELAY partial partition retention policy hardening

Phase: `DATA_RELAY_PARTIAL_PARTITION_RETENTION_POLICY_HARDENING`  
Date: 2026-09-13  
Worktree: `/home/aella/gdc-platform-worktrees/partial-retention-policy`  
Branch: `test/partial-retention-policy`

## Baseline

| Field | Value |
|-------|-------|
| `DOCS_PR33_STATUS` | **MERGED** |
| `DOCS_PR33_MERGE_COMMIT` | `41adf3ee35dbfc956824c389699169647810b27d` |
| `START_MAIN_HEAD` | `41adf3ee35dbfc956824c389699169647810b27d` |
| `WORK_HEAD` | `41adf3ee35dbfc956824c389699169647810b27d` (+ local tests) |
| Live destructive defaults | unchanged (`false`) |

Docs PR #33 review: single file `e2e/continuous/RETENTION_RUNTIME_HARDENING_REPORT.md`; no runtime artifacts, credentials, or unrelated code; CI green; merged.

## Live August guardrail (read-only)

| Field | Value |
|-------|-------|
| `NOW_UTC` | `2026-09-13T06:29:58Z` |
| `CUTOFF_UTC` (30d) | `2026-08-14T06:29:58Z` |
| `AUGUST_ROWS` | `4,480,118` |
| `AUGUST_MIN` / `MAX` | `2026-08-29` … `2026-08-31` |
| `AUGUST_ELIGIBLE_ROWS` | **0** |
| Live August row DELETE | **NOT EXECUTED** |

## Code audit (actual paths)

### Authoritative timestamp

- Column: **`delivery_logs.created_at`** (timestamptz, UTC)
- Predicate: **`created_at < cutoff`** (strictly before)
- Cutoff: `datetime.now(UTC) - timedelta(days=retention_days)` via `retention_cutoff()`
- Boundary: `T - 1µs` expired; `T` retained; `T + 1µs` retained — validated in tests

### Row DELETE path

| Item | Behavior |
|------|----------|
| Implementation | `app/retention/batch.py` → `batch_delete_by_time_before` |
| Callers | `run_operational_retention` (API/manual) and `cleanup_service` (scheduler category `logs`) |
| Scope | Parent table `DeliveryLog` filter (partition pruning applies naturally) |
| Batching | `id IN (SELECT … ORDER BY created_at, id LIMIT batch_size)` |
| Commit | **per batch** (bounded transactions) |
| Max per pass | `_MAX_BATCH_ITERATIONS=200` × `cleanup_batch_size` (default 5000 → **1M rows/pass**) |
| Exhaustion | Not guaranteed in one pass if eligible > cap; **next run resumes** |
| Locks | Short deletes; no table-wide lock by design |
| Retry | No automatic retry; exceptions → caller rollback of uncommitted work; committed batches stay |
| Active/future partitions | Not excluded from row DELETE if rows are older than cutoff (correct for partial months) |

### Partition DROP path

| Item | Behavior |
|------|----------|
| Eligibility | `calculate_delivery_log_partition_drop_targets`: month upper bound ≤ cutoff month; **current + next month protected**; default partition never listed |
| Execution | Only in `run_operational_retention` when `GDC_RETENTION_DELIVERY_LOG_PARTITION_DROP_ENABLED=true` |
| Order | **DROP eligible partitions first**, then batched row DELETE |
| Scheduler | `OperationalRetentionScheduler` → `run_cleanup` → **row DELETE only** (no DROP) — intentional gap vs manual API |

## Isolated fixture results (pytest catalog)

| Field | Value |
|-------|-------|
| `FIXTURE_OLD_ROWS` | `12000` |
| `FIXTURE_RECENT_ROWS` | `12000` |
| `FIXTURE_TOTAL_ROWS` | `24000` |
| Partition | `delivery_logs_2026_08` (mixed ages; not DROP-eligible at fixed clock) |
| `DROP_CANDIDATES` (mixed) | `0` |
| `ROW_DELETE_CANDIDATES` | `12000` (= old) |
| Controlled DELETE | old → 0; recent preserved; partition preserved |
| Second run | `ROWS_DELETED_SECOND_RUN=0` |
| Batching | multi-batch PASS (`batch_size=1000`, `3250` old) |
| Interrupt | first batch committed; uncommitted work rolled back; resume completes; recent untouched |
| Fully expired + DROP on | July DROPped first; August mixed → row DELETE only |
| Fully expired + DROP off | rows deleted; **empty partition remains** → `RETENTION_EFFICIENCY_GAP` |

Tests: `tests/test_partial_partition_retention_policy.py` — **9 passed**.  
Regression: operational retention / partitioning / cleanup / ORM bootstrap — **30 passed**.

## Dead tuples / autovacuum

Live cluster:

| Setting | Value |
|---------|-------|
| `autovacuum` | `on` |
| `autovacuum_vacuum_threshold` | `50` |
| `autovacuum_vacuum_scale_factor` | `0.2` |
| September `n_dead_tup` | `283` (low vs ~20.8M live) |
| August stats | stale (`n_live_tup=0` despite 4.48M rows) — MONITOR / ANALYZE gap, not retention bug |

Fixture expectation after deleting 12k of 24k:

- Dead tuples expected after DELETE (not a bug)
- Autovacuum threshold ≈ `50 + 0.2 * 12000 = 2450` ≪ 12000 dead → **expected to trigger**
- Space reclaim for **fully** expired months remains far better via **DROP** than vacuum after row DELETE

No forced `VACUUM FULL` / aggressive vacuum in this phase.

## Answers to phase questions

1. **Is row DELETE intended for partially expired partitions?**  
   **YES** — by design. DROP eligibility requires the whole month to be ≤ cutoff month; partial months are left for `created_at < cutoff` deletes.

2. **Does it delete exactly rows older than cutoff?**  
   **YES** — strict `< cutoff` on `created_at`.

3. **Does it preserve newer rows in the same partition?**  
   **YES** — validated on mixed fixture.

4. **Unacceptable table/index bloat?**  
   **Expected dead tuples**; not unacceptable for partial months. Fully expired months left as empty partitions (when DROP off) are the real storage problem.

5. **Does autovacuum recover adequately?**  
   **YES for dead-tuple cleanup** under default settings for realistic partial volumes. **Does not reclaim empty-partition disk** the way DROP does.

6. **Can row DELETE and DROP coexist without duplicate work?**  
   **YES when DROP enabled** — DROP runs first; remaining rows only then.  
   **Efficiency gap when DROP disabled** — fully expired months still row-deleted, empty partition retained.

7. **Should row DELETE be scheduled automatically?**  
   **Non-prod lab: YES** (with `DESTRUCTIVE` + `AUTOMATIC_DELETES`).  
   **Production: NO automatic** (manual/explicit only; matches existing safety gates).

8. **Should fully expired DROP be scheduled automatically?**  
   **Non-prod: recommended eventually** (today DROP is manual/`retention/run` only).  
   **Production: keep manual** unless a separate, heavily gated operator policy is approved.  
   Classification: `INTENTIONAL_MANUAL_POLICY` + scheduler wiring gap for DROP.

9. **Defaults?**  

| Env | Destructive | Automatic row DELETE | Partition DROP |
|-----|-------------|----------------------|----------------|
| **Production** | `false` (enable only for explicit manual runs + `PRODUCTION_DELETES`) | `false` (forbidden even if set) | `false` (enable only for approved manual reclaim) |
| **Non-prod lab** (when reclaim desired) | `true` | `true` | `true` (still prefer manual first DROP until scheduled DROP is productized) |

**This phase did not change any live defaults.**

## Conceptual model verdict

```text
current/future partition     → protected from DROP (code)
partially expired partition  → row DELETE (created_at < cutoff)   ✓ intended
fully expired partition      → DROP whole partition (when flag)   ✓ intended
default partition            → never DROP target                  ✓ protected
```

Model matches existing architecture; validated with isolated fixtures.

## Recommended next actions (not done here)

1. When August becomes partially eligible: allow **row DELETE only** via product path; never DROP August until month fully past cutoff month.
2. Productize optional scheduled partition DROP for non-prod (today API/manual only).
3. Monitor August/September `ANALYZE` freshness (`n_live_tup` stale on August).
4. Keep production automatic deletes off.

`AUTOMATIC_POLICY_CHANGE_APPLIED=NO`  
`LIVE_AUGUST_MODIFIED=NO`  
`FINAL_STATUS=PASS`
