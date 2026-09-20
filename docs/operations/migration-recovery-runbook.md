# Migration recovery and Alembic drift hardening

Operational guide for PostgreSQL-only Alembic state. Does not change StreamRunner, checkpoints, or `delivery_logs` schema.

## Quick validation

```bash
# Platform stack (default)
./scripts/ops/validate-migrations.sh --pre-upgrade

# Inside a running api container
docker compose -f docker-compose.platform.yml run --rm --no-deps api \
  python -m app.db.validate_migrations --json

# Static DATABASE_URL reference audit
./scripts/ops/audit-database-urls.sh
```

Exit codes for `validate_migrations`: `0` ok, `1` error, `2` warnings only.

## Expected catalog names

| Compose file | `POSTGRES_DB` | Typical host tools URL |
|--------------|---------------|-------------------------|
| `docker-compose.platform.yml` | `gdc` | `postgresql://gdc:…@127.0.0.1:55432/gdc` |
| `deploy/docker-compose.https.yml` | `gdc` | internal only (`@postgres:5432/gdc`) |

The **api** service `DATABASE_URL` is set by Compose. Host `.env` must match when you run Alembic or scripts on the host against the same volume.

## Repository head (current)

Always resolve the head from the exact checkout you are recovering. Do not reuse a memorized revision ID from older docs or audits:

```bash
alembic heads
# or
./scripts/ops/validate-migrations.sh --host-only
# (prints repository heads via --print-alembic-heads)
```

Verified on this documentation update against `main-v2` HEAD `5fab5ab18b265727a422c838b774359c7e086b75`, the single Alembic head is:

`20260804_0062`

(`alembic/versions/20260804_0062_restore_delivery_logs_connector_id_index.py`)

There is **no** `20260513_0021_dl_parts` file in this repository.

### Historical note (2026-05-16 audit)

An earlier audit recorded `20260513_0019_must_change_pw` as the then-current single head. That revision remains in the graph as an ancestor; it is **not** the current repository head. Never stamp a current-schema database to that obsolete revision.

### Schema shape that is *not* current

Current head schema includes monthly **partitioned** `delivery_logs` (plus many later tables). Partitioning is introduced by committed revision `20260517_0021_obs_scale` (`alembic/versions/20260517_0021_observability_scale_foundation.py`), which revises `20260516_0020_rt_metrics_30d`.

A single unpartitioned `delivery_logs` heap table is therefore a **historical / pre-partition** shape. It must **never** be treated as “matches current repo,” and must **never** be stamped directly to `head`.

## Orphan revision: `20260513_0021_dl_parts` (historical incident)

**Symptom:** `Can't locate revision identified by '20260513_0021_dl_parts'` during `alembic upgrade`, `alembic current`, or startup validation.

**Meaning:** `alembic_version.version_num` references a migration that is not in `alembic/versions/` (never committed, removed, or applied from another branch). This orphan is still a known recovery case; it is unrelated to the current repository head above.

**Do not:** `docker compose down -v`, truncate `delivery_logs`, delete migration files, or `git reset`.

### Recovery procedure

1. **Backup**

   ```bash
   ./scripts/release/backup-before-upgrade.sh
   # Targets POSTGRES_DB from GDC_RELEASE_COMPOSE_FILE (default docker-compose.platform.yml → gdc).
   # or pg_dump against the target catalog
   ```

2. **Inspect**

   ```sql
   SELECT version_num FROM alembic_version;
   \dt delivery_logs*
   SELECT c.relname AS child, p.relname AS parent
     FROM pg_inherits i
     JOIN pg_class c ON c.oid = i.inhrelid
     JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = 'delivery_logs' OR c.relname LIKE 'delivery_logs%';
   SELECT EXISTS (
     SELECT 1
     FROM pg_partitioned_table pt
     JOIN pg_class c ON c.oid = pt.partrelid
     WHERE c.relname = 'delivery_logs'
   ) AS delivery_logs_is_partitioned;
   ```

3. **Classify recovery evidence (fail closed)**

   Use the inspection results to choose **one** path. Do not invent revision IDs and do not stamp from incomplete evidence.

   **A. Pre-partition / historical shape**

   Evidence examples: one heap `delivery_logs` table; `delivery_logs_is_partitioned = false`; no `delivery_logs_YYYY_MM` / `delivery_logs_default` partition children.

   - This is **not** current head schema.
   - **Never** run `alembic stamp head` on this shape.
   - Preferred recovery: restore the missing migration/history from backup, or otherwise recover with evidence that reintroduces the real applied chain.
   - If — and only if — an independent inventory proves the database is equivalent to a **specific committed ancestor** for both **schema and data effects** of that revision, you may stamp **that ancestor only**, then upgrade. Because `alembic_version` still holds the unresolvable orphan ID, a normal `alembic stamp <rev>` will fail resolving the current revision — use `--purge` after backup + equivalence proof:

     ```bash
     # After proving schema + data effects ≡ a specific committed revision ID (not "looks close")
     docker compose -f docker-compose.platform.yml run --rm --no-deps api \
       alembic stamp --purge <proven_ancestor_revision>
     docker compose -f docker-compose.platform.yml run --rm --no-deps api \
       alembic upgrade head
     ```

     Graph facts (not a stamp recipe by themselves):
     - The last committed revision that still keeps unpartitioned `delivery_logs` is `20260516_0020_rt_metrics_30d`.
     - The next revision (`20260517_0021_obs_scale`) converts `delivery_logs` to monthly partitions and creates `runtime_aggregate_snapshots`.
     - `20260516_0020_rt_metrics_30d` also performs a **data** update (`platform_retention_policy.runtime_metrics_retention_days` 90→30) that DDL inspection alone cannot prove. If catalog shape matches 0020 but that data effect is unproven, do **not** stamp 0020 — stamp an earlier proven revision (for example `20260513_0019_must_change_pw` when that ancestor is fully proven) so `upgrade head` still executes 0020, or fail closed.
     - Having a single `delivery_logs` table alone does **not** prove equivalence to `20260516_0020_rt_metrics_30d` or to `20260513_0019_must_change_pw`.
   - If equivalence cannot be proven, **stop**: restore from backup or perform evidence-led recovery. Do not guess a stamp target.

   **B. Current-schema equivalence independently proven**

   Evidence must cover the complete current state for the deployed checkout, including at least: partitioned `delivery_logs` (`delivery_logs_is_partitioned = true` with expected partition children), intervening tables/objects created after partitioning, no material missing columns/indexes versus head, **and** proof that head-era **data effects** have already been applied (DDL alone is insufficient). Fresh examples of data transformations that a head stamp would skip: `20260606_0042_gov_lifecycle` (`DISABLED` → `RETIRED` for governance policies) and `20260609_0053_product_group` (connector product-group backfill). A single-table `delivery_logs` check is insufficient.

   - Only after that full schema **and** data-effect verification **and** operator sign-off may you align Alembic to the current repository head. Re-run `alembic heads` on the deployed checkout first. When recovering from an orphan row in `alembic_version`, use `--purge` so Alembic does not try to resolve the missing revision first:

     ```bash
     # Only when complete current-schema + data-effect equivalence is already proven
     docker compose -f docker-compose.platform.yml run --rm --no-deps api \
       alembic stamp --purge head
     ```

   - If DDL already matches head but data effects remain unproven, do **not** stamp head and do **not** stamp an earlier ancestor to “replay” those migrations. Intervening revisions also perform non-idempotent DDL (for example `add_column` in `20260606_0042_gov_lifecycle` / `20260609_0053_product_group`), so rewinding the version table and running `upgrade head` fails on already-present objects without repairing the data. **Fail closed**: restore from backup, re-introduce the real applied history, or use a separately verified data-repair procedure with operator sign-off.

   Mis-stamping corrupts history; use `validate_migrations` and a schema/data inventory before any stamp. Do not stamp a current-schema database down to a historical ancestor such as `20260513_0019_must_change_pw`.

   **C. Partial / ambiguous partitioning or mixed DDL**

   - Do not stamp. Restore from backup or re-introduce the exact migration chain that created the observed DDL.

4. **Verify**

   ```bash
   ./scripts/ops/validate-migrations.sh --strict
   docker compose -f docker-compose.platform.yml run --rm --no-deps api alembic upgrade head
   ```

## Upgrade path (`scripts/release/upgrade.sh`)

1. Mandatory backup  
2. Image build  
3. **Pre-upgrade** `validate_migrations --pre-upgrade` (fails on orphan; allows “behind head”)  
4. `alembic upgrade head`  
5. Rolling service refresh  

## Startup diagnostics

- Logs: `stage=startup_database_diagnostics` / `startup_readiness_summary`  
- API: `GET /api/v1/runtime/status` includes `migration_integrity` when evaluated  
- Admin maintenance health includes Alembic panel (orphan revisions surface as errors)

## Safe rollback

1. `docker compose -f <compose> down` (no `-v`)  
2. Restore Postgres from `deploy/backups/` per `docs/deployment/backup-restore.md`  
3. Checkout previous release image/git tag  
4. `alembic upgrade head` only after `validate-migrations` passes on restored DB  

## Related

- `docs/operations/retention-policies.md` — row deletes on `delivery_logs` (not partition DROP)  
- `specs/034-data-retention/spec.md`  
- Dev-only destructive reset: `scripts/dev-validation/reset-dev-validation-db.sh` (`gdc` dev-validation DB only)
