# Full E2E dev validation lab

This guide covers the **development-environment** workflow that exercises
**every currently supported source/destination combination** plus a small
**performance smoke** suite. It is **additive** to the existing dev validation
lab (`docs/testing/dev-validation-lab.md`), source adapter E2E
(`docs/testing/source-adapter-e2e.md`), and continuous test environment
(`docs/testing/continuous-test-environment.md`) — none of those are replaced.

## Scope

Currently supported sources in this procedure:

Phase A–D Charter Data Collection:

- `HTTP_API_POLLING`
- `DATABASE_QUERY` (PostgreSQL Database Source)

Supported, release-qualified extensions (not Charter Data Collection scope):

- `S3_OBJECT_POLLING`
- `REMOTE_FILE_POLLING`

Currently supported destinations:

- `SYSLOG_UDP`
- `SYSLOG_TCP`
- `SYSLOG_TLS`
- `WEBHOOK_POST`

Pipeline executed for every E2E case (per
`specs/002-runtime-pipeline/spec.md`):

```
Source fetch → Mapping → Enrichment → Formatter → Route fan-out
            → Destination delivery → Checkpoint (only after success)
            → delivery_logs (committed outcomes)
```

Constitution rules respected (see `.specify/memory/constitution.md`):

- Connector ≠ Stream, Source ≠ Destination, Stream is the runtime unit.
- Route is the only path from Stream to Destination.
- Mapping happens before Enrichment.
- Checkpoint is updated **only** after every required route delivery succeeds.
- Source and Destination rate limits remain independent.
- `delivery_logs` persists committed runtime outcomes only.
- Database is **PostgreSQL only** (`gdc` or `gdc_e2e_test` for the lab).
- `StreamRunner` transaction and checkpoint semantics are **not** modified.

## Scripts

Primary operator entrypoints under `scripts/validation-lab/` wrap the same building
blocks as `scripts/dev-validation/`:

| Script | Purpose |
| --- | --- |
| `scripts/validation-lab/start.sh` | Operator entrypoint: lab Docker profile + migrations + admin seed + source fixtures + **default** `[DEV E2E]` UI catalog seed + backend + Vite. |
| `scripts/validation-lab/reset-db.sh` | Interactive **gdc dev-validation DB only** schema reset (wraps `reset-dev-validation-db.sh`). |
| `start-full-e2e-lab.sh` | Bring up the isolated test stack, apply alembic migrations, seed source fixtures. |
| `run-full-e2e-validation.sh` | Run the E2E coverage matrix across all source/destination buckets. |
| `run-performance-smoke.sh` | Run the performance smoke suite (delivery_logs insert, query latency, retention, backfill, EXPLAIN ANALYZE). |
| `stop-full-e2e-lab.sh` | Stop the lab (containers + named volumes preserved by default). |

Each script wraps existing, already-tested building blocks:

- `docker-compose.test.yml` (profiles `test` and/or `dev-validation` via `docker-compose.dev-validation.yml`) for fixtures.
- `scripts/testing/source-e2e/seed-fixtures.sh` for MinIO / fixture PG / SFTP seed data.
- `scripts/seed_delivery_logs_perf_data.py` for bulk insert seeding.
- `scripts/profile_query_plan.py` for EXPLAIN ANALYZE.
- Existing pytest markers/files: `source_e2e`, `e2e_smoke`,
  `e2e_delivery and e2e_regression`, and the syslog TLS suite (`tests/test_syslog_tls_destination.py`).

The `source_e2e` file also runs direct **S3 / DATABASE_QUERY / REMOTE_FILE_POLLING → SYSLOG** (UDP, TCP, TLS) matrix cases; the shell script is still an operator-facing wrapper over those pytest targets.

## How to start the lab

### Option A — Validation lab (UI + default `[DEV E2E]` seed)

Use this when you want the **Vite UI**, **FastAPI backend**, and **visible `[DEV E2E]`**
connectors/streams/destinations/routes in one step:

```bash
./scripts/validation-lab/reset-db.sh   # optional; interactive gdc dev-validation reset
./scripts/validation-lab/start.sh
```

`start.sh` brings up the `dev-validation` Docker profile (same core fixtures as the
full E2E stack: Postgres catalog, WireMock, webhook echo, syslog, MinIO, fixture
PostgreSQL, SFTP), applies migrations, seeds `scripts/testing/source-e2e/seed-fixtures.sh`,
then runs `scripts/dev-validation/seed-visible-e2e-fixtures.sh` **unless**
`SKIP_VISIBLE_E2E_SEED=1`.

See also: `docs/testing/visible-dev-e2e-fixtures.md`.

### Option B — Full E2E lab script (containers + migrations, optional UI seed)

```bash
./scripts/dev-validation/start-full-e2e-lab.sh
```

What it does:

1. Validates the safety gate (loopback PostgreSQL, `gdc` or
   `gdc_e2e_test`, local dev/test port, user `gdc`, `APP_ENV` not production).
2. Brings up the isolated Docker stack with project name
   `gdc-platform-test` and profile `test`:
   - `postgres-test` (platform catalog DB, `127.0.0.1:55432`)
   - `wiremock-test` (`127.0.0.1:28080`)
   - `webhook-receiver-test` (`127.0.0.1:18091`)
   - `syslog-test` (`127.0.0.1:15514` UDP+TCP)
   - `minio-test` (`127.0.0.1:59000`)
   - `postgres-query-test` (`127.0.0.1:55433`)
   - `sftp-test` (`127.0.0.1:22222`)
3. Waits for each fixture to be reachable.
4. Runs `alembic upgrade head` against `TEST_DATABASE_URL`.
5. Seeds MinIO objects, fixture rows in `gdc_query_fixture`, and SFTP files
   via `scripts/testing/source-e2e/seed-fixtures.sh`.

Optional flags for **Option B** (`start-full-e2e-lab.sh`):

- `--no-seed` — skip fixture seeding (use existing seeded data).
- `--no-migrate` — skip `alembic upgrade head`.
- `--with-perf-seed` — also bulk-insert `delivery_logs` for the perf smoke
  (default 10000 rows; override with `PERF_SEED_ROWS`).
- `--seed-visible-fixtures` — also run `seed-visible-e2e-fixtures.sh` (same catalog seed as validation-lab `start.sh` when `SKIP_VISIBLE_E2E_SEED` is unset).

## How to run E2E validation

```bash
# After the lab stack is up (e.g. ./scripts/validation-lab/start.sh or start-full-e2e-lab.sh):
./scripts/dev-validation/run-full-e2e-validation.sh
```

The E2E runner only needs the **fixture stack** reachable; it does not require the
backend from `start.sh` to stay running (pytest exercises the pipeline in-process).
If you used `start.sh`, you can leave backend/frontend up or stop them with
`scripts/dev-validation/stop-dev-validation-lab.sh` — Docker services remain until
you tear them down.

It executes the following buckets and aggregates pass/fail per bucket:

| Bucket | Wrapped pytest target | Coverage |
| --- | --- | --- |
| `http_webhook` | `pytest -m e2e_smoke tests/test_wiremock_template_e2e.py` | `HTTP_API_POLLING` → `WEBHOOK_POST` |
| `http_syslog` | `pytest -m "e2e_delivery and e2e_regression" tests/test_e2e_syslog_delivery.py` | `HTTP_API_POLLING` → `SYSLOG_UDP` / `SYSLOG_TCP` |
| `http_tls` | `pytest tests/test_syslog_tls_destination.py` | `HTTP_API_POLLING` → `SYSLOG_TLS` |
| `source_e2e` | `pytest -m source_e2e tests/test_source_adapter_e2e.py` | `S3_OBJECT_POLLING` / `DATABASE_QUERY` / `REMOTE_FILE_POLLING` → `WEBHOOK_POST` and `SYSLOG_UDP` / `SYSLOG_TCP` / `SYSLOG_TLS` |

The full coverage matrix that the script prints:

```
Source x Destination coverage matrix (D = direct StreamRunner E2E test)
-----------------------------------------------------------------------------------------
Source                  | SYSLOG_UDP | SYSLOG_TCP | SYSLOG_TLS | WEBHOOK_POST
HTTP_API_POLLING        |     D      |     D      |     D      |     D
S3_OBJECT_POLLING       |     D      |     D      |     D      |     D
DATABASE_QUERY          |     D      |     D      |     D      |     D
REMOTE_FILE_POLLING     |     D      |     D      |     D      |     D
-----------------------------------------------------------------------------------------
D = at least one pytest exercises this source+destination pair end-to-end.
```

- **D (direct):** full pipeline for that source × destination (`source_e2e` for
  S3 / DB / SFTP syslog and webhook columns; `http_*` buckets for HTTP).

Options:

- `--only http_webhook` (repeatable) — run only the listed bucket(s).
- `--keep-going` — run every bucket even if one fails; the overall exit
  code is non-zero if any bucket failed.
- `--list` — print the coverage matrix and exit without running anything.

Per-bucket logs are written to `.dev-validation-logs/e2e_<bucket>.log`.

## How to run performance smoke

```bash
./scripts/dev-validation/run-performance-smoke.sh
```

This delegates to `scripts/dev-validation/_perf_smoke.py`. It performs the
following checks and prints a fixed-width table:

| Check | Endpoint / operation | Threshold (ms) |
| --- | --- | --- |
| `delivery_logs_bulk_insert` | `scripts/seed_delivery_logs_perf_data.py` (10000 rows by default, days=1) | `12000` |
| `runtime_metrics_query` | `GET /api/v1/runtime/streams/{id}/metrics?window=24h` | `800` |
| `logs_explorer_query` | `GET /api/v1/runtime/logs/search?stream_id=…&limit=100&window=24h` | `800` |
| `route_runtime_aggregation` | same metrics endpoint (route rows aggregation) | `800` |
| `retention_preview` | `GET /api/v1/retention/preview` | `800` |
| `retention_run` | `POST /api/v1/retention/run` with `{"dry_run": true, "tables": ["delivery_logs"]}` | `1500` |
| `backfill_dry_run` | `POST /api/v1/backfill/jobs` (TIME_RANGE_REPLAY, PENDING, `dry_run: true`) | `2500` |
| `explain_analyze_delivery_logs` | `scripts/profile_query_plan.py` (max actual time across all key queries) | `200` |

Table columns:

```
check                          rows tested  elapsed (ms)  threshold (ms)  result  notes
```

- `rows tested` reflects either the seeded volume or the observed response
  list length when available.
- `elapsed (ms)` is the wall-clock latency for the check. For
  `explain_analyze_delivery_logs` it is the maximum `actual time` reported
  by EXPLAIN ANALYZE across the key delivery_logs queries.
- `result` is `PASS` if both the operation succeeded and `elapsed <=
  threshold`. The script exits non-zero on any failure.

Options:

- `--rows N` — number of rows to bulk insert (default `10000`).
- `--skip-explain` — skip the EXPLAIN ANALYZE delegation.
- `--json` — emit machine-readable JSON instead of the table.

Fixture entities:

- Performance smoke creates a dedicated `[PERF SMOKE] connector …`,
  `[PERF SMOKE] stream …`, `[PERF SMOKE] destination …`, and a matching
  route on `gdc`. These never collide with user-created entities.
- `delivery_logs` rows seeded by the smoke are scoped to the fixture
  stream/route/destination IDs (`--delete-existing` only deletes for that
  tuple).

## How to stop the lab

```bash
./scripts/dev-validation/stop-full-e2e-lab.sh           # stop containers; keep them around
./scripts/dev-validation/stop-full-e2e-lab.sh --down    # docker compose down; volumes preserved
CONFIRM=1 ./scripts/dev-validation/stop-full-e2e-lab.sh --down --with-volumes
                                                        # also wipe named volumes (test data ONLY)
```

The lab never targets the production stack (`docker-compose.platform.yml`).
Volumes are preserved by default so that `gdc` lab data, MinIO objects,
the fixture PostgreSQL DB, and SFTP files survive between sessions.

## Expected pass output

E2E validation:

```
================================================================
 Full E2E validation summary
================================================================
  http_webhook   : PASS
  http_syslog    : PASS
  http_tls       : PASS
  source_e2e     : PASS

Result: ALL PASS
```

Performance smoke (with default thresholds):

```
check                          | rows tested | elapsed (ms) | threshold (ms) | result | notes
-------------------------------+-------------+--------------+----------------+--------+-----...
delivery_logs_bulk_insert      | 10000       | 4321.0       | 12000          | PASS   | ok
runtime_metrics_query          | 10000       | 245.7        | 800            | PASS   | http=200
logs_explorer_query            | 100         | 132.4        | 800            | PASS   | http=200
route_runtime_aggregation      | 10000       | 248.9        | 800            | PASS   | http=200
retention_preview              | 6           | 88.1         | 800            | PASS   | http=200
retention_run                  | 0           | 167.5        | 1500           | PASS   | http=200
backfill_dry_run               | 0           | 312.4        | 2500           | PASS   | http=201
explain_analyze_delivery_logs  | 3000        | 18.2         | 200            | PASS   | max actual_time=18.20ms; seq_scan=False; exit=0

PERF SMOKE: PASS (8 checks ok)
```

## Troubleshooting common failures

### `Refusing pytest run: database name must be one of …`

`TEST_DATABASE_URL` or `DATABASE_URL` is not pointed at `gdc` or
`gdc_e2e_test`. The lab and the test suite both refuse anything else.
Re-export the URL and rerun the script.

### `Alembic upgrade failed`

Usually means schema drift on `gdc`. Recover with the dedicated
test-only reset:

```bash
./scripts/dev-validation/reset-dev-validation-db.sh
```

It requires typing `RESET GDC DEV DB` and refuses to run against any
other database.

### `WireMock not reachable`

`scripts/dev-validation/run-full-e2e-validation.sh` will mark this in its
pre-flight checks and skip the `http_webhook` / `http_syslog` buckets.
Re-run `start-full-e2e-lab.sh` and confirm `curl
http://127.0.0.1:28080/__admin/mappings` returns 200.

### `MinIO / fixture Postgres / SFTP FAIL` in pre-flight

Run the fixture seed again:

```bash
./scripts/testing/source-e2e/seed-fixtures.sh
```

Or restart the lab — `start-full-e2e-lab.sh` is idempotent.

### Performance smoke `FAIL` on `runtime_metrics_query`

- Confirm migrations are applied (`alembic current` should point at
  head).
- Confirm `delivery_logs` indexes exist by running
  `scripts/profile_query_plan.py` — every key query should use the
  expected index. The `explain_analyze_delivery_logs` check in the
  smoke surfaces the same data.
- If the latency exceeds threshold under a cold cache, rerun the smoke;
  the first run after `--with-perf-seed` is expected to be slowest.

### Performance smoke `FAIL` on `backfill_dry_run`

The check uses `POST /api/v1/backfill/jobs` which creates a `PENDING`
TIME_RANGE_REPLAY job foundation (no worker, no destination, no
checkpoint mutation). If this fails, the most common cause is the perf
fixture stream missing (re-run the smoke; it recreates fixtures every
run) or stale `gdc` schema (run the reset script above).

### Performance smoke `FAIL` on `explain_analyze_delivery_logs`

The notes column shows the parsed maximum `actual time` and whether a
`Seq Scan` was detected. If `seq_scan=True`, inspect the full plan in
`.dev-validation-logs/perf_smoke.log` or run
`scripts/profile_query_plan.py` directly for the verbose dump.

## Safety rules summary

- **PostgreSQL only.** No SQLite fallback at any layer (constitution).
- **Loopback only.** All scripts refuse hosts other than `127.0.0.1` /
  `localhost` / `::1`.
- **Dev/test DB names only.** `gdc` or `gdc_e2e_test` (matches
  `tests/conftest.py` allow-list).
- **No production targets.** The lab runs only against local dev/test
  compose projects and refuses production-looking hosts.
- **No real credentials.** All fixture credentials are baked into the
  compose file and seed scripts (`gdc/gdc`, `gdc_fixture/gdc_fixture_pw`,
  `gdc/devlab123`, `gdcminioaccess/gdcminioaccesssecret12`).
- **No external internet.** Every fixture is local (WireMock, MinIO,
  fixture Postgres, atmoz/sftp).
- **No deletion of user-created data.** Performance smoke entities use a
  `[PERF SMOKE]` name prefix and the bulk insert scopes `--delete-existing`
  to the perf-smoke tuple. The stop script preserves named volumes by
  default; volume removal requires explicit `--with-volumes` plus
  `CONFIRM=1`.
- **No StreamRunner / checkpoint semantic changes.** Every bucket and the
  perf smoke reuse the existing runtime; nothing in this workflow alters
  transaction ownership or the checkpoint-after-delivery rule
  (`.specify/memory/constitution.md`, `specs/002-runtime-pipeline/spec.md`).
- **RBAC remains intact.** The perf smoke uses `tests/conftest.py`-style
  request defaults (anonymous administrator fallback when `REQUIRE_AUTH`
  is false) only because the underlying FastAPI app already supports it
  for the dev/test profile; production deployments keep RBAC unchanged
  (`specs/035-rbac-lite/spec.md`).

## Related documentation

- `docs/testing/source-adapter-e2e.md`
- `docs/testing/dev-validation-lab.md`
- `docs/testing/continuous-test-environment.md`
- `docs/testing/e2e-regression.md`
- `docs/operator-runbook.md`
- `specs/036-source-adapter-e2e/spec.md`
- `specs/032-dev-validation-lab-source-expansion/spec.md`
- `specs/031-source-expansion-test-environment/spec.md`
- `specs/004-delivery-routing/spec.md`
- `specs/002-runtime-pipeline/spec.md`
- `specs/001-core-architecture/spec.md`
