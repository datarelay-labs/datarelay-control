# Development validation lab

## Purpose

The **development validation lab** is an **additive, development-only** subsystem that seeds WireMock-backed connectors, streams, routes, destinations, and `continuous_validations` definitions so operators can **see synthetic health directly in the GDC UI** (Connectors, Streams, Runtime, Validation, Logs, Analytics). It exercises **real** `StreamRunner` cycles and the continuous validation scheduler — it does **not** bypass the runtime, fake executions, or change checkpoint semantics.

This is **not** production customer data and **not** a substitute for the pytest WireMock E2E suite (`docs/testing/e2e-regression.md`). E2E remains the regression harness; the lab is for **local visual feedback** while coding.

**Canonical full-platform startup:** prefer **`./scripts/dev/start-platform.sh`**. This older lab starts host uvicorn + Vite for granular fixture debugging. Full comparison: **`docs/local-docker-workflow.md`**.

## TL;DR — three commands

Operators only need three commands. All other steps (Docker stack up, Alembic migrations, backend, frontend, API verification) happen inside `start.sh`.

```bash
# Start everything (Docker, migrations, backend, frontend, API checks)
./scripts/validation-lab/start.sh

# Check health (Docker, backend, frontend, [DEV VALIDATION] counts, latest failures)
./scripts/validation-lab/status.sh

# Stop backend + frontend, optionally also Docker (volumes always preserved)
./scripts/validation-lab/stop.sh --with-docker
```

Troubleshooting (only when `start.sh` explicitly reports schema drift on `gdc`):

```bash
./scripts/validation-lab/reset-db.sh
```

`reset-db.sh` is **destructive** and is **never auto-invoked**. It refuses to run unless the URL points at the isolated lab DB (`gdc` on `127.0.0.1:55442` by default, user `gdc`) and requires typing `RESET GDC DEV DB` to confirm. Docker volumes are not removed.

## What each command does

### `start.sh`

1. Brings up the Docker test stack via `docker-compose.dev-validation.yml` with project name **`gdc-platform-test`**: PostgreSQL **55442** by default, WireMock **28080**, HTTP echo **18091**, syslog sink **15514**.
2. Waits until PostgreSQL accepts connections.
3. Runs **`alembic upgrade head`** against `TEST_DATABASE_URL`. On schema drift (duplicate-table / missing `alembic_version` / "target database is not up to date") it **stops** and prints exactly one reset command — it never silently continues or auto-resets.
4. Exports the lab environment to the API process:
   - `ENABLE_DEV_VALIDATION_LAB=true`
   - `DEV_VALIDATION_AUTO_START=true`
   - `TEST_DATABASE_URL=postgresql://gdc:gdc@127.0.0.1:55442/gdc` (also used as `DATABASE_URL` for this process)
   - `WIREMOCK_BASE_URL=http://127.0.0.1:28080`
   - `DEV_VALIDATION_WIREMOCK_BASE_URL=http://127.0.0.1:28080`
   - `DEV_VALIDATION_WEBHOOK_BASE_URL=http://127.0.0.1:18091`
   - `DEV_VALIDATION_SYSLOG_HOST=127.0.0.1`, `DEV_VALIDATION_SYSLOG_PORT=15514`
5. Ensures **`platform_users` admin** exists via `python -m app.db.seed --platform-admin-only` against `gdc`. Default password is **`admin`** unless you export **`GDC_SEED_ADMIN_PASSWORD`** before starting. Existing admin password hashes are not reset automatically.
6. Starts **uvicorn** on `0.0.0.0:8000`, waits for `/health`.
7. Polls `GET /api/v1/connectors/` and `GET /api/v1/validation/` for the lab markers (`[DEV VALIDATION]`, `template_key` starting with `dev_lab`).
8. Starts Vite with `VITE_API_BASE_URL=http://127.0.0.1:8000` so the SPA at `http://127.0.0.1:5173` talks to the lab API.
9. Prints the URLs and the `status` / `stop` / `restart` commands. PID files live under `.dev-validation-logs/`.

Ctrl+C stops the backend and frontend processes. Docker containers keep running unless you also pass `--with-docker` to `stop.sh`.

### `status.sh` (read-only)

Single-screen triage view:

- Docker test stack (containers and host ports)
- Backend reachable (`/docs`, `/health`)
- Frontend reachable (`http://127.0.0.1:5173`)
- Direct DB diagnostics for `gdc` (Alembic version, public table count)
- `GET /api/v1/runtime/status` schema readiness summary
- **`[DEV VALIDATION]` connector count** from `GET /api/v1/connectors/`
- **`dev_lab` validation definition count** from `GET /api/v1/validation/`
- **Latest validation failures** from `GET /api/v1/validation/failures/summary` (failing/degraded counts, open alert counts, top 10 open alerts)
- Recent `dev_validation_lab_*` / `startup_database_*` lines from `backend.log`
- Newest log files under `.dev-validation-logs/`

### `stop.sh`

Stops the backend and frontend processes using PID files in `.dev-validation-logs/`. With `--with-docker`, also runs `docker compose stop` on the test stack. **Never** removes Docker volumes; `gdc` data is preserved between sessions.

### `reset-db.sh` (destructive, manual only)

`DROP SCHEMA public CASCADE` / `CREATE SCHEMA public` on `gdc`, then `alembic upgrade head`. Refuses to run against anything other than the lab DB. Requires typing `RESET GDC DEV DB`. Use only when `start.sh` told you to.

## Optional source expansion (S3 / DATABASE_QUERY / REMOTE_FILE)

Beyond WireMock HTTP traffic, the lab exercises **object polling**, **relational query sources**, and **SFTP/SCP remote file polling** when the slice flags are on. In `app/config.py` these default to **`false`** (production-safe). **`./scripts/validation-lab/start.sh`** (via `scripts/dev-validation/start-dev-validation-lab.sh`) sets them to **`true` by default** so MinIO, fixture Postgres/MySQL/MariaDB, and SFTP/SCP streams seed after fixture scripts — override with `export ENABLE_DEV_VALIDATION_S3=false` (etc.) if you want HTTP-only lab rows.

1. Ensure the **`dev-validation`** Compose profile is up so optional containers exist (`minio-test`, `postgres-query-test`, `mysql-query-test`, `mariadb-query-test`, `sftp-test`, `ssh-scp-test`). They live only in `docker-compose.test.yml` and never ship with `docker-compose.platform.yml`.
2. For **custom** stacks (not the lab start script), export the slice flags you need, for example:

   ```bash
   export ENABLE_DEV_VALIDATION_S3=true
   export ENABLE_DEV_VALIDATION_DATABASE_QUERY=true
   export ENABLE_DEV_VALIDATION_REMOTE_FILE=true
   export ENABLE_DEV_VALIDATION_PERFORMANCE=true
   ```

3. Run fixture scripts (published ports match `docker-compose.test.yml`):

   ```bash
   ./scripts/testing/source-expansion/seed-s3-fixtures.sh
   ./scripts/testing/source-expansion/seed-database-fixtures.sh
   ./scripts/testing/source-expansion/seed-remote-file-fixtures.sh
   ```

4. Restart the lab API so `seed_dev_validation_lab` runs again. The **Validation** overview includes a **“Dev validation — S3 / database / remote file smoke”** table. With `ENABLE_DEV_VALIDATION_PERFORMANCE=true`, each `dev_lab_*` validation stores `last_perf_snapshot_json` (run duration, extracted/delivered counts, average route latency, error count) after scheduled or manual runs — **smoke only**, not a benchmark harness.

When a slice flag is `false`, the scheduler and lab auto-start **skip** matching `dev_lab_*` rows so disabled integrations do not generate noise.

Normative one-pager: `specs/032-dev-validation-lab-source-expansion/spec.md`. OAuth2/token URL semantics (client credentials vs JWT refresh, no refresh-token grant): **`docs/testing/dev-validation-oauth2-runtime.md`**.

## Production separation

This subsystem is **development-only** by construction. Multiple independent guards prevent the lab from running in production:

| Layer | Guard |
| --- | --- |
| `app/config.py` | `ENABLE_DEV_VALIDATION_LAB` defaults to **`False`**. |
| `app/dev_validation_lab/seeder.py:lab_effective()` | Returns `False` whenever `APP_ENV` is `production` or `prod`, **regardless** of `ENABLE_DEV_VALIDATION_LAB`. |
| `app/dev_validation_lab/runtime.py` | Logs `dev_validation_lab_seed_skipped` with reason `production_app_env` or `lab_disabled`; no seeding, no auto-start. |
| Scheduler | `ENABLE_DEV_VALIDATION_LAB=false` excludes existing `[DEV VALIDATION]` and `[DEV E2E]` streams from polling in every `APP_ENV`, including development. The scheduler process flag wins if it disagrees with the API process. Push-only `WEBHOOK_RECEIVER` streams stay ingest-capable and are never polled. |
| Compose split | `docker-compose.yml` is the full development platform; production-style HTTPS uses `deploy/docker-compose.https.yml`. The standalone lab stack (`postgres-test`, `wiremock-test`, `webhook-receiver-test`, `syslog-test`) lives in `docker-compose.test.yml` / `docker-compose.dev-validation.yml` with project name `gdc-platform-test`. |
| Database isolation | Lab seeding only runs against `gdc` on the configured dev-validation port. `reset-db.sh` refuses any other URL. |

### Production checklist

When packaging or deploying production:

- **Do NOT set** `ENABLE_DEV_VALIDATION_LAB=true` in the production environment.
- **Do NOT set** `DEV_VALIDATION_AUTO_START=true` in the production environment.
- Set `APP_ENV=production` (or `prod`) — this is a hard kill-switch even if the lab flag is accidentally enabled.
- **Do NOT include** WireMock, the HTTP echo receiver (`mendhak/http-https-echo`), the syslog test sink, or any other lab-only test service in production Compose / Helm / Kubernetes manifests. The `wiremock` service in `docker-compose.yml` is intentionally behind the `test` profile and must not be promoted by removing the profile.
- The **validation engine itself (`continuous_validations`)** stays in production — it is general infrastructure used for real connector health checks. Only the seeded `[DEV VALIDATION]` rows and the supporting WireMock/echo/syslog mocks are dev-only.
- After deploy, confirm by hitting `GET /api/v1/connectors/` — it must contain **zero** rows whose name starts with `[DEV VALIDATION] `. If any appear, the production DB was contaminated by an earlier non-production run; clean by `DELETE FROM connectors WHERE name LIKE '[DEV VALIDATION]%'` (scoped to the operator's normal release process). The seeder will not recreate them when the lab is disabled.

## Configuration reference

| Variable | Default | Description |
| --- | --- | --- |
| `ENABLE_DEV_VALIDATION_LAB` | `false` | Master switch; must be explicit. **Leave unset/false in production.** When false, existing lab streams are not polled. One-second lab polling is only active while this flag is true and the stream is started. |
| `DEV_VALIDATION_AUTO_START` | `false` | After seed + WireMock sync, run each lab `continuous_validations` row once (fail-open). |
| `DEV_VALIDATION_WIREMOCK_BASE_URL` | `http://127.0.0.1:18080` | WireMock admin + stubs (use `28080` for the isolated lab stack). |
| `DEV_VALIDATION_WEBHOOK_BASE_URL` | `http://127.0.0.1:18091` | `http-https-echo` receiver. |
| `DEV_VALIDATION_SYSLOG_HOST` | `127.0.0.1` | Syslog UDP/TCP test sink host. |
| `DEV_VALIDATION_SYSLOG_PORT` | `15514` | Mapped port for `syslog-test`. |
| `ENABLE_DEV_VALIDATION_S3` | `false` | Optional MinIO slice; requires `MINIO_*` credentials. |
| `ENABLE_DEV_VALIDATION_DATABASE_QUERY` | `false` | Optional fixture Postgres/MySQL/MariaDB lab streams. |
| `ENABLE_DEV_VALIDATION_REMOTE_FILE` | `false` | Optional SFTP + SFTP-compatible SCP lab streams; requires `DEV_VALIDATION_SFTP_PASSWORD` / `DEV_VALIDATION_SSH_SCP_PASSWORD`. |
| `ENABLE_DEV_VALIDATION_PERFORMANCE` | `false` | When `true`, persist `last_perf_snapshot_json` on validation rows for dev smoke metrics. |
| `MINIO_ENDPOINT` | `http://127.0.0.1:9000` | Override to `http://127.0.0.1:59000` for `minio-test`. |
| `DEV_VALIDATION_PG_QUERY_HOST` / `DEV_VALIDATION_PG_QUERY_PORT` | `127.0.0.1` / `55433` | Fixture PostgreSQL (not the platform `gdc`). |
| `DEV_VALIDATION_MYSQL_QUERY_PORT` | `33306` | Fixture MySQL. |
| `DEV_VALIDATION_MARIADB_QUERY_PORT` | `33307` | Fixture MariaDB. |
| `DEV_VALIDATION_SFTP_*` / `DEV_VALIDATION_SSH_SCP_*` | see `app/config.py` | SSH endpoints for remote file lab (SCP slice uses `protocol: sftp_compatible_scp`). |
| `GDC_SEED_ADMIN_PASSWORD` | unset | Optional `admin` password source for development. Missing `admin` is created with this value when set; otherwise `admin/admin` is used. Existing admin hashes are not reset automatically. |
| `APP_ENV` | `development` | Set to `production` or `prod` to force-disable lab seeding regardless of other flags. |

## Seeded topology (summary)

- **9 connectors** — auth variants above plus **OAuth2 JWT refresh** (`jwt_refresh_token`) and **OAuth2 token exchange failure** (negative-path stub) against WireMock.
- **4 destinations** — echo webhook, syslog UDP/TCP, WireMock retry webhook.
- **13 HTTP-family streams** — core matrix plus **`Stream OAuth2 client-credentials`**, **`Stream OAuth2 refresh-cycle (JWT token URL)`**, **`Stream OAuth2 token-exchange-failure`** (see `docs/testing/dev-validation-oauth2-runtime.md`).
- **Routes** — mostly echo webhook; **delivery-only** fan-out (retry webhook + syslog UDP + syslog TCP); vendor stream fan-out to echo + syslog TCP.
- **Continuous validations** — include `AUTH_ONLY`, `FETCH_ONLY`, and multiple `FULL_RUNTIME` rows bound to lab streams. One row (`dev_lab_full_delivery`) is intentionally DEGRADED to exercise the alert path.

## UI surfaces

- **Streams / Runtime:** Lab streams are named `[DEV VALIDATION] Stream …` and run on the normal polling scheduler.
- **Validation:** Definitions are prefixed `[DEV VALIDATION]` and use `template_key` values starting with `dev_lab_`. Use the **"Dev validation lab only"** filter on the Validation overview page.
- **Connectors / Streams lists:** A **Dev lab** badge appears next to lab-scoped names, and the Connectors page has a **"Dev validation lab only"** filter.
- **Logs / Analytics:** Use existing runtime log search and analytics views filtered by lab stream IDs.

## Troubleshooting

### Port 8000 already in use

The lab starts **host uvicorn** on **8000**. Stop the conflicting process (often a leftover lab backend, or the platform `api` container publishing **8000**). For platform-only runs, set **`GDC_API_HOST_PORT`** to another host port (see `docker-compose.platform.yml` header comments). Details: **`docs/local-docker-workflow.md`**.

### API runs in Docker (e.g. `gdc-platform-api`) but lab connectors are missing

The **platform** `api` service uses **`postgresql://gdc:gdc@postgres:5432/gdc`** and enables the core dev-validation lab by default in development compose. If rows are missing, run **`./scripts/dev/validate-platform-ready.sh`** and inspect API startup logs.

### `gdc-wiremock` orphan container warning

**`gdc-wiremock`** comes from **`docker-compose.yml`** with **`--profile test`** (host **18080**). It is unrelated to **`docker-compose.platform.yml`** and unrelated to the lab’s **`gdc-wiremock-test`** (**28080**). Remove stray containers with `docker compose --profile test down` or `docker stop gdc-wiremock` as appropriate. See **`docs/local-docker-workflow.md`**.

### PostgreSQL container healthy but lab seed data missing

Confirm you are on the intended **`gdc`** database and port. If `postgres-test` is up but the API still has no lab rows, use **`./scripts/validation-lab/status.sh`** and inspect **`dev_validation_lab_*`** lines in **`.dev-validation-logs/backend.log`**. If **`reset-db.sh`** is required after schema drift, **back up `gdc` first** (example in **`docs/local-docker-workflow.md`**).

### `start.sh` reported schema drift

Run exactly the command it printed (`./scripts/validation-lab/reset-db.sh`) and re-start. This is the only supported recovery path for a drifted standalone lab DB; do not delete volumes or run ad-hoc DDL.

### UI shows no `[DEV VALIDATION]` items

1. `./scripts/validation-lab/status.sh` — check that the backend is reachable, schema is ready, and the connector / validation counts are non-zero.
2. Confirm the lab markers over HTTP:

   ```bash
   curl -fsS http://127.0.0.1:8000/api/v1/connectors/ | grep -F 'DEV VALIDATION' | head
   curl -fsS http://127.0.0.1:8000/api/v1/validation/ | grep -F 'dev_lab' | head
   ```

3. Open DevTools on `http://127.0.0.1:5173` and confirm the one-time `[gdc] API base resolved: …` log. If you set `localStorage` key `gdc.apiBaseUrlOverride`, clear it.
4. Inspect backend logs:

   ```bash
   tail -n 120 .dev-validation-logs/backend.log
   grep -E 'dev_validation_lab|startup_database' .dev-validation-logs/backend.log | tail -n 80
   ```

   Look for `dev_validation_lab_config_snapshot`, `dev_validation_lab_seed_complete` (with `inventory`), or `dev_validation_lab_seed_failed`.

### Lab keeps re-seeding the same rows

The seeder is **idempotent**: existing `[DEV VALIDATION]` rows are not duplicated and user rows are never deleted. Re-running `start.sh` is safe.

## Internal scripts (advanced)

The `scripts/validation-lab/*.sh` commands are thin wrappers over the implementation under `scripts/dev-validation/`. Operators should normally not need to call the underlying scripts directly; they exist for backwards compatibility and granular debugging.

```bash
scripts/dev-validation/start-dev-validation-lab.sh   # underlying start (verbose)
scripts/dev-validation/stop-dev-validation-lab.sh    # underlying stop
scripts/dev-validation/status-dev-validation-lab.sh  # underlying status (no failures summary)
scripts/dev-validation/reset-dev-validation-db.sh    # underlying destructive reset
scripts/dev-validation/test_reset_dev_validation_db.sh  # safety-only checks (no DB writes)
```
