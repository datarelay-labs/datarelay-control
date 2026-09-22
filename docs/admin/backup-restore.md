# PostgreSQL backup and restore (operations runbook)

This runbook describes **read-only backups** and **controlled restores** for the GDC platform **PostgreSQL** database only. It does not replace your organisation’s wider backup policy (off-site copies, retention, encryption at rest, access control).

**Distinct from JSON configuration export/import:** Admin **Backup & Import** (`/api/v1/backup/*`, `specs/015-backup-export-import/spec.md`) is portable configuration migration (additive/clone only). It is **not** database disaster recovery and does **not** replace this PostgreSQL procedure.

## Safety rules (non-negotiable)

- **Backup** uses `pg_dump` only: it is **read-only** with respect to the database and does **not** modify application checkpoints.
- **Restore** can change database contents; it must never be run casually against production.
- **Never** print or paste full `DATABASE_URL` values into tickets, chat, or screenshots (passwords live in the URL).
- These scripts **do not** `DROP`, `TRUNCATE`, or reset production data by themselves; a restore still **overwrites** objects/data according to the archive and `pg_restore` behaviour. Test on a **clone** or **staging** database first when possible.
- **PostgreSQL only** — no other data stores are covered here. Copy **runtime configuration** (environment files, secrets manager entries, systemd units, reverse proxy TLS material) through your normal secure configuration management; do not commit secrets to git.

## Prerequisites

- PostgreSQL client tools installed: `pg_dump`, `pg_restore` (same major version as the server, or compatible).
- `DATABASE_URL` set to a `postgresql://` or `postgres://` URL that includes a **database name** (and host/port or local socket path as appropriate).
- `python3` on `PATH` (used for URL validation only).

## Backup

From the **repository root**:

```bash
export DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/DBNAME'
./scripts/ops/backup-postgres.sh
```

Optional **gzip** of the custom-format dump:

```bash
GZIP_BACKUP=1 ./scripts/ops/backup-postgres.sh
# or
./scripts/ops/backup-postgres.sh --gzip
```

Custom output directory:

```bash
export BACKUP_DIR=/secure/path/to/backups
./scripts/ops/backup-postgres.sh
```

Artifacts:

- Default directory: `var/backups/postgres/` under the repo root (created if missing).
- Filename pattern: `gdc-postgres-YYYYMMDDTHHMMSSZ.dump` (or `.dump.gz` when gzip is enabled).
- Format: **custom** (`-Fc`), suitable for `pg_restore`.

### Docker example (backup)

If Postgres runs in a container named `postgres` and your app URL is on the host:

```bash
docker exec -e DATABASE_URL="$DATABASE_URL" -e GZIP_BACKUP=1 \
  -v /secure/backups:/backups -w /work \
  YOUR_CLIENT_IMAGE \
  bash -lc 'export BACKUP_DIR=/backups && /work/scripts/ops/backup-postgres.sh'
```

Mount the repo or copy the script into the image so the path exists; adjust `YOUR_CLIENT_IMAGE` to an image that contains `pg_dump` and `bash`.

### Verification after backup

```bash
ls -la var/backups/postgres/
# custom format: pg_restore --list path/to/gdc-postgres-....dump | head
```

## Restore

Restore **requires** explicit confirmation and a valid dump file on disk:

```bash
export DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/DBNAME'
export CONFIRM_RESTORE=yes
./scripts/ops/restore-postgres.sh /path/to/gdc-postgres-YYYYMMDDTHHMMSSZ.dump
```

Compressed archives:

```bash
CONFIRM_RESTORE=yes ./scripts/ops/restore-postgres.sh /path/to/gdc-postgres-....dump.gz
```

Behaviour:

1. **`CONFIRM_RESTORE` must be exactly `yes`** — any other value (including unset) causes immediate refusal with no database changes beyond what a failed `pg_restore` might partially apply if you bypass checks (you should not).
2. **Empty or invalid `DATABASE_URL`** (wrong scheme, missing database name, etc.) is refused before any backup/restore step that needs a live connection for restore.
3. A **pre-restore backup** is taken first (same read-only `pg_dump` flow as the backup script) into `PRE_RESTORE_BACKUP_DIR` or, by default, `var/backups/postgres/pre-restore/` (override with `PRE_RESTORE_BACKUP_DIR` or `BACKUP_DIR`).
4. `pg_restore` runs with **`--no-owner --no-acl`** for portability and **without `--clean`** so the script does not instruct `pg_restore` to drop existing objects.

Optional parallelism:

```bash
export PGRESTORE_JOBS=1
CONFIRM_RESTORE=yes ./scripts/ops/restore-postgres.sh /path/to/file.dump
```

### Docker example (restore)

```bash
docker exec -e DATABASE_URL="$DATABASE_URL" -e CONFIRM_RESTORE=yes \
  -v /secure/backups:/backups -v /path/to/gdc-platform:/work -w /work \
  YOUR_CLIENT_IMAGE \
  bash -lc './scripts/ops/restore-postgres.sh /backups/gdc-postgres-....dump'
```

### Verification after restore

```bash
psql "$DATABASE_URL" -c 'SELECT version();'
psql "$DATABASE_URL" -c '\dt'
# Application: run migrations if required, smoke-test API, confirm scheduler health.
```

## Operational checklist

- [ ] Confirm target `DATABASE_URL` (staging vs production).
- [ ] Run backup; store artifact off the database host.
- [ ] For restore: confirm `CONFIRM_RESTORE=yes`, disk space, and maintenance window.
- [ ] After restore: verify schema, application connectivity, and **Maintenance Center** in Admin Settings.

## UI shortcut

Under **Admin Settings → Maintenance Center**, use **Backup & Restore Runbook** to jump to hosted documentation. Operators without a hosted URL should open this file in the repository: `docs/admin/backup-restore.md`.

To point the UI link at your own docs server, set at **frontend build time**:

`VITE_ADMIN_BACKUP_RESTORE_RUNBOOK_URL` — full URL to your published copy of this runbook (or a wrapper page).

## Script validation (CI / local)

```bash
./scripts/ops/validate-backup-restore-ops.sh
```

This runs `bash -n` on the ops scripts and non-destructive guard checks (no live `pg_restore`).
