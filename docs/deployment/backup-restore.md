# Backup and restore (PostgreSQL)

Operator scripts live under `scripts/release/`:

| Script | Purpose |
|--------|---------|
| `backup-before-upgrade.sh` | `pg_dump` from the Compose `postgres` service, gzip, timestamped filename |
| `restore.sh` | Restore a gzip SQL dump into the Compose database (destructive; explicit confirmations) |

## Backup

### Requirements

- `docker` and `docker compose` available.
- Target stack running with a healthy `postgres` service.
- `GDC_RELEASE_COMPOSE_FILE` aligned with the stack (default `docker-compose.platform.yml`).

### Output layout

- Default directory: `deploy/backups/` (override with `GDC_BACKUP_DIR`; must still resolve **under the repository root**).
- Filenames: `gdc_pg_<UTC-timestamp>.sql.gz`, its matching `.sql.gz.sha256` checksum receipt, and `backup_<timestamp>.log`. The backup script sets restrictive 0600 file permissions and refuses to overwrite an existing archive, digest, log or dangling symlink. The checksum is integrity evidence **only**: neither encryption, an authenticated signature, nor proof of a successful restore.

### Safety rules

- **Path safety**: refuses backup roots that are not under the repository checkout (mitigates accidental writes to host system paths) and refuses obvious volatile roots such as `/tmp` / `/var/tmp` prefixes.
- **No volume deletion**: scripts never run `docker compose down -v` or `docker volume rm`.
- **PostgreSQL-only** platform policy is unchanged; backups are logical SQL dumps from PostgreSQL.

### Environment knobs

| Variable | Default | Meaning |
|----------|---------|---------|
| `GDC_RELEASE_COMPOSE_FILE` | `docker-compose.platform.yml` | Compose file path relative to repo root |
| `GDC_BACKUP_DIR` | `deploy/backups` | Output directory (must stay under repo root) |
| `GDC_BACKUP_DB_NAME` | _(unset → inferred)_ | Overrides the catalog used for `pg_dump`. When unset, the script reads merged Compose (`docker compose … config`) for the `postgres` service `POSTGRES_DB` (normally `gdc`). |
| `GDC_BACKUP_DB_USER` | _(unset → inferred from compose `POSTGRES_USER`)_ | Role for `pg_dump` (normally `gdc`) |

Before dumping, the backup script checks `pg_database` and fails with a clear message if the target catalog is missing.

## Restore

Restore is **destructive** for the target database inside the Compose PostgreSQL instance.

### Hard requirements

1. Environment: `RESTORE_CONFIRM=YES_I_UNDERSTAND`
2. Interactive prompt: you must type the **exact** database name that will be dropped/recreated (defaults to the same catalog inferred from Compose `POSTGRES_DB` when `GDC_RESTORE_DB_NAME` is unset).
3. **Unknown DB guard**: the resolved target must be `gdc` or `datarelay`. Other names are refused to avoid targeting unexpected catalogs.

### Example

```bash
export GDC_RELEASE_COMPOSE_FILE=docker-compose.platform.yml
# Optional: only if restoring into a catalog different from POSTGRES_DB in that compose file
# export GDC_RESTORE_DB_NAME=datarelay
RESTORE_CONFIRM=YES_I_UNDERSTAND ./scripts/release/restore.sh deploy/backups/gdc_pg_20260101T000000Z.sql.gz
```

### After restore

- Run `alembic upgrade head` if the restored data is from an older schema revision (same pattern as install/upgrade: `docker compose ... run --rm api alembic upgrade head`).
- Verify application health (`/health`, Maintenance Center, sample authenticated API).

### What restore does **not** do

- Does not restore Docker volume metadata beyond what is inside the dump.
- Does not validate application-level secrets or connector credentials beyond what is stored in the database.
- Does not bypass RBAC or StreamRunner semantics — those remain enforced at runtime.

## Legacy volume and catalog migration

- **New installs** use compose volume **`gdc_platform_postgres_data`** and catalog **`gdc`** (`docker-compose.platform.yml`).
- **Legacy dev installs** may still have Docker volume **`gdc-platform-test_gdc_test_postgres_data`** and catalog **`gdc_test`**. Do not delete that volume unless you have a verified backup.
- Rename catalog in place (idempotent): `scripts/release/rename-catalog-gdc-test-to-datarelay.sh` (see `docs/deployment/install-guide.md`). Set `GDC_RENAME_DB_USER` to match the cluster superuser (`gdc` or `datarelay`).

## Operational alignment

- Retention and cleanup APIs remain separate (`specs/034-data-retention/spec.md`); backups are operator-driven.
- For JSON export/import of configuration entities, see `specs/015-backup-export-import/spec.md` (distinct from raw `pg_dump`).
