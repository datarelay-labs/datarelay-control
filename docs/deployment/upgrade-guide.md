# Upgrade workflow (release candidate)

Use `scripts/release/upgrade.sh` for a **backup-first**, **migration-aware**, **volume-preserving** upgrade of a running Docker Compose stack.

## Preconditions

- Same requirements as install: Docker Engine + Compose v2 (install via `scripts/release/install.sh` on Ubuntu 24.04 if needed).
- **PostgreSQL must be running** in the target project so `backup-before-upgrade.sh` can `pg_dump` from the `postgres` service.
- Set `GDC_RELEASE_COMPOSE_FILE` to the same compose file used at install time (default: `docker-compose.platform.yml`).
- Platform stack catalog: **`gdc`** (role **`gdc`** for current `docker-compose.platform.yml`; legacy clusters may still use older `datarelay` volumes — set `GDC_BACKUP_DB_USER` if needed).

## Command

```bash
export GDC_RELEASE_COMPOSE_FILE=docker-compose.platform.yml   # or deploy/docker-compose.https.yml
./scripts/release/upgrade.sh
```

## What happens

1. **Pre-upgrade backup (mandatory)** — `scripts/release/backup-before-upgrade.sh` writes a timestamped `*.sql.gz` under `deploy/backups/` (or `GDC_BACKUP_DIR` if set). The dump targets the **`POSTGRES_DB`** catalog for the `postgres` service in the selected compose file (merged `docker compose config`), so the default matches `docker-compose.platform.yml` (`gdc`) and HTTPS compose (`gdc`) without manual overrides. Set `GDC_BACKUP_DB_NAME` only when you intentionally need a different catalog; a warning is printed if it disagrees with compose. Backups must resolve under the repository root; the script refuses dangerous system paths (including `/tmp` roots), refuses timestamp collisions, and creates private 0600 archives/logs with an archive-specific SHA256 integrity receipt (not encrypted, signed or restore-verified).
2. **Image refresh** — `docker compose ... build --pull` rebuilds application images with newer base layers where applicable.
3. **Alembic** — `alembic upgrade head` runs once inside the `api` container (`run --rm`).
4. **Rolling-style recreate** — `postgres`, then `api` (waits for health or running), then `reverse-proxy` when that service exists, followed by a final `up -d` to converge any other services. Named volumes are never removed.
5. **Rollback hints** — the script prints manual rollback steps and log locations at the end.

Upgrade logs are appended to `deploy/backups/upgrade_<UTC-timestamp>.log`.

## Rollback strategy

There is no automatic down-migration. If an upgrade fails:

1. Stop the stack: `docker compose -f <compose> down` (omit `-v` to keep volumes).
2. Restore the database from the latest backup using `scripts/release/restore.sh` and `docs/deployment/backup-restore.md`.
3. Check out the previous application Git tag or image tag and start again.

## TLS, HTTPS compose, and published ports

For `deploy/docker-compose.https.yml`, ensure `deploy/tls/server.crt` and `server.key` remain valid before and after upgrade. Regenerate with `scripts/release/generate-self-signed-cert.sh` only when appropriate for your environment.

If you upgrade from an older install that assumed **8080** / **8443** host ports, set `GDC_HTTP_PORT`, `GDC_HTTPS_PORT`, and `GDC_PUBLIC_HTTPS_PORT` explicitly in `.env`, or adopt the platform defaults (**18080** / **18443**) and update operator bookmarks and firewalls. Older `.env` files that still contain `GDC_ENTRY_HTTP_PORT` / `GDC_ENTRY_HTTPS_PORT` are read by the install/dev scripts only to seed the new keys; the platform compose file now uses `GDC_HTTP_PORT` and `GDC_HTTPS_PORT`. See `docs/deployment/https-reverse-proxy.md`.

After changing published ports, recreate the reverse proxy:

```bash
docker compose -f docker-compose.platform.yml up -d --force-recreate reverse-proxy
```

## What we intentionally do not automate

- Full heavy E2E on every CI run (see `.github/workflows/*` and `docs/testing/full-e2e-dev-validation.md`).
- Automatic deletion of user-created connectors, streams, routes, or checkpoints.
- SQLite or any non-PostgreSQL catalog database.
