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

Verified on this documentation update against `main-v2` HEAD `3e4daa31691589c66c89fbb9400ea4711c54d8b5`, the single Alembic head is:

`20260804_0062`

(`alembic/versions/20260804_0062_restore_delivery_logs_connector_id_index.py`)

There is **no** `20260513_0021_dl_parts` file in this repository.

### Historical note (2026-05-16 audit)

An earlier audit recorded `20260513_0019_must_change_pw` as the then-current single head. That revision remains in the graph as an ancestor; it is **not** the current repository head. Never stamp a current-schema database to that obsolete revision.

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
   SELECT child, parent FROM pg_inherits i
     JOIN pg_class c ON c.oid = i.inhrelid
     JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = 'delivery_logs' OR c.relname LIKE 'delivery_logs%';
   ```

3. **If schema matches current repo (single `delivery_logs` table, no missing columns)**

   - Restore the missing migration file from backup **or**
   - After operator sign-off, align the stamp to the **current** repository head (only when schema already matches). Re-run `alembic heads` on the deployed checkout first:

     ```bash
     # Example — verify with validate-migrations and alembic heads first
     docker compose -f docker-compose.platform.yml run --rm --no-deps api \
       alembic stamp head
     ```

   Mis-stamping corrupts history; use `validate_migrations` and a schema diff before stamping. Do not stamp to a historical ancestor such as `20260513_0019_must_change_pw` when the schema already matches today's head.

4. **If schema was partially migrated for partitioning**

   - Do not stamp blindly. Restore from backup or re-introduce the exact migration chain that created the current DDL.

5. **Verify**

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
