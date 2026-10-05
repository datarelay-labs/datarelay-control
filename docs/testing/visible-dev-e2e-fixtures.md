# Visible dev E2E UI fixtures

This workflow seeds **idempotent**, **UI-visible** catalog rows (names prefixed with
`[DEV E2E] `) so you can open the product UI and run **Run Once** for each supported
source type against **local lab services only** (no public internet).

## Recommended path: validation lab (`scripts/validation-lab/`)

From the repository root, after a fresh or drifted `gdc` lab schema you may reset (interactive, **test DB only**):

```bash
./scripts/validation-lab/reset-db.sh
```

Then start the lab (Docker stack, migrations, platform admin seed, **source fixtures**, and **visible `[DEV E2E]` catalog seed** by default):

```bash
./scripts/validation-lab/start.sh
```

- **UI:** http://127.0.0.1:5173 — sign in as `admin` (default password `admin` unless `GDC_SEED_ADMIN_PASSWORD` was explicitly set; see lab start output).
- **Skip catalog + source fixture scripts only:** set `SKIP_VISIBLE_E2E_SEED=1` when invoking `start.sh`. That skips both `scripts/testing/source-e2e/seed-fixtures.sh` and `scripts/dev-validation/seed-visible-e2e-fixtures.sh` (MinIO keys, fixture DB rows, SFTP files, and `[DEV E2E]` rows are not refreshed for that run).

`start.sh` is idempotent for `[DEV E2E]` entities: re-running does not create duplicate connectors/streams/destinations/routes with the same names (upsert by name in `app/dev_validation_lab/visible_e2e_seed.py`).

The **development platform** (`docker compose -f docker-compose.platform.yml up`) also runs the same idempotent seed on API startup when `ENABLE_DEV_VALIDATION_LAB=true` and `APP_ENV` is not production (see `run_visible_e2e_fixtures_startup` in `app/dev_validation_lab/runtime.py`). Set `SKIP_VISIBLE_E2E_SEED=1` to disable. Source-expansion fixtures (MinIO, fixture PostgreSQL, SFTP) still require `./scripts/dev-validation/bootstrap-platform-dev-validation.sh` once so container DNS resolves `gdc-minio-test`, `gdc-postgres-query-test`, and `gdc-sftp-test`.

### Where entities appear in the UI

| Area | What to look for |
|------|------------------|
| **Connectors** | `[DEV E2E] HTTP API Connector`, `[DEV E2E] S3 Object Connector`, `[DEV E2E] Database Query Connector`, `[DEV E2E] Remote File Connector` |
| **Streams** | `[DEV E2E] HTTP API Stream`, `[DEV E2E] S3 Object Stream`, `[DEV E2E] Database Query Stream`, `[DEV E2E] Remote File Stream`, `[DEV E2E] Webhook Receiver Stream` |
| **Destinations** | `[DEV E2E] Webhook Destination`, `[DEV E2E] Syslog UDP Destination`, `[DEV E2E] Syslog TCP Destination`, `[DEV E2E] Syslog TLS Destination` |
| **Routes** | Open each stream’s routing: webhook route on all four streams; UDP/TCP/TLS syslog routes on the **HTTP** stream |

Each stream has **mapping**, **enrichment**, and a **checkpoint** row created by the same seed (no StreamRunner semantic changes).

### Manual Run Once

1. Open **Streams** and select a `[DEV E2E] …` stream.
2. Use **Run Once** from the runtime UI (same as continuous validation readiness).

Ensure **source fixtures** exist: `start.sh` runs `scripts/testing/source-e2e/seed-fixtures.sh` unless `SKIP_VISIBLE_E2E_SEED=1`. If objects are missing, re-run:

```bash
./scripts/testing/source-e2e/seed-fixtures.sh
./scripts/dev-validation/seed-visible-e2e-fixtures.sh
```

## Alternative: full E2E lab script only

If you only need containers + migrations without the Vite/backend foreground processes:

```bash
./scripts/dev-validation/start-full-e2e-lab.sh
```

Optional UI catalog in the same invocation:

```bash
./scripts/dev-validation/start-full-e2e-lab.sh --seed-visible-fixtures
```

## Seed UI-visible fixtures alone

Default catalog target is the lab platform DB:

`postgresql://gdc:gdc@127.0.0.1:55442/gdc`

Run (idempotent — safe to run twice):

```bash
./scripts/dev-validation/seed-visible-e2e-fixtures.sh
```

### Local disposable catalog named `gdc`

When you intentionally use a **local** PostgreSQL development catalog (`gdc`, or a disposable `gdc_dev_*` catalog created for browser/dev work) on loopback, opt in explicitly:

```bash
DATABASE_URL=postgresql://gdc:gdc@127.0.0.1:5432/gdc \
  ./scripts/dev-validation/seed-visible-e2e-fixtures.sh --local-dev-mode
```

For a disposable browser/dev catalog on the platform PostgreSQL port:

```bash
DATABASE_URL=postgresql://gdc:gdc@127.0.0.1:55432/gdc_dev_example \
  ./scripts/dev-validation/seed-visible-e2e-fixtures.sh --local-dev-mode
```

The script **refuses** cloud-looking hosts and `APP_ENV=production` / `prod`.

### Environment overrides

| Variable | Purpose | Default |
|----------|---------|---------|
| `DATABASE_URL` | Platform catalog (PostgreSQL) | `postgresql://gdc:gdc@127.0.0.1:55442/gdc` |
| `WIREMOCK_BASE_URL` | HTTP source base URL | `http://127.0.0.1:28080` |
| `GDC_VISIBLE_E2E_WEBHOOK_BASE_URL` | Webhook destination base | `http://127.0.0.1:18091` |
| `GDC_VISIBLE_E2E_SYSLOG_HOST` | Syslog destinations host | `127.0.0.1` |
| `GDC_VISIBLE_E2E_SYSLOG_PLAIN_PORT` | UDP + TCP (plaintext) | `15514` |
| `GDC_VISIBLE_E2E_SYSLOG_TLS_PORT` | TLS listener (host map) | `16514` |
| `SOURCE_E2E_MINIO_*` | MinIO S3-compatible source | see `start-full-e2e-lab.sh` / `start-dev-validation-lab.sh` |
| `SOURCE_E2E_SFTP_*` | SFTP remote file source | see same |
| `SOURCE_E2E_PG_FIXTURE_*` | Fixture DB for `DATABASE_QUERY` | see same |

## Syslog TLS listener

The `syslog-test` image exposes:

- **15514** — plaintext TCP and UDP (same host port for both protocols inside the container map).
- **16514** — TCP with TLS (self-signed certificate generated at **image build** time).

The `[DEV E2E] Syslog TLS Destination` uses `tls_verify_mode=insecure_skip_verify` for
lab convenience only.

## Cleaning `[DEV E2E]` fixtures

There is **no automatic cleanup** in the seed script (by design: no accidental removal
of unrelated rows).

If a future **safe cleanup mode** is added, it should:

1. Restrict itself to streams/connectors/destinations whose `name` starts with `[DEV E2E] `.
2. Delete **routes** only for those lab streams (and optionally only toward lab destinations).
3. Remove dependent **mappings**, **enrichments**, and **checkpoints** for those streams.
4. Delete **streams**, then **sources** / **connectors**, then **destinations**, respecting
   foreign keys and any delivery log retention policies.

Until then, use a disposable catalog (`gdc` or `gdc_e2e_test`) or manual SQL in a **test-only** environment.

## Safety guardrails (summary)

- **PostgreSQL only** for the platform catalog; no SQLite fallback in this workflow.
- **Loopback + allow-listed DB:** `gdc` on local dev/platform ports, user `gdc`; the seed module also allows `gdc_e2e_test`.
- **No production reset:** `reset-db.sh` wraps `reset-dev-validation-db.sh`, which refuses anything other than the local `gdc` dev-validation database.
- **No deletes of non-lab rows** in the visible seed: only creates/updates rows whose names are under `[DEV E2E] ` (and routes tied to those streams/destinations).
- **No external internet:** URLs must resolve to loopback for WireMock, webhook, MinIO, syslog, fixture DB, SFTP.
- **No real credentials:** lab defaults only (see compose + seed scripts).
- **StreamRunner / checkpoint semantics** unchanged (seed uses the same checkpoint-after-delivery model as production; see `specs/002-runtime-pipeline/spec.md`).

## Verification commands

```bash
bash -n scripts/validation-lab/reset-db.sh
bash -n scripts/validation-lab/start.sh
bash -n scripts/dev-validation/seed-visible-e2e-fixtures.sh
```

Rebuilding the syslog test image after TLS support was added:

```bash
docker compose -p gdc-platform-test -f docker-compose.test.yml --profile test build syslog-test
```
