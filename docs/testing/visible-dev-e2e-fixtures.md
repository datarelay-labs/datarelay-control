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

When you intentionally use a **local** PostgreSQL database named `gdc` on
loopback outside the canonical lab ports, opt in explicitly:

```bash
DATABASE_URL=postgresql://gdc:gdc@127.0.0.1:5432/gdc \
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

## Remote File live EPS ceiling (M1-06)

The visible [DEV E2E] Remote File Stream reads one bounded 40-event NDJSON
fixture by exact filename. A one-second polling interval permitted 31+ actual
completed polls per minute, exceeding 20 ingested EPS even though the
configuration's generic estimate was inside the 5-20 band. The isolated
validation fixture therefore uses a **two-second minimum polling interval**.
All other validation sources keep their existing cadence.

After the changed implementation is installed on the isolated preview, update
only the exact owned [DEV E2E] Remote File Stream configuration through the
guarded development fixture path. Verify two consecutive 60-second windows
using run_complete.input_events; compare each enabled Route's receipts by
run ID, and preserve operator-created objects and credentials. This native
test does not substitute for authenticated Browser acceptance.

## Feeder endpoint readiness (M1-07)

The development feeder sends synthetic Webhook Receiver events to
LAB_THROUGHPUT_API_BASE_URL. Before starting or restarting, identify the
currently served development API and verify /health on that exact address.
A previous preview port can disappear without warning. The collector being
healthy does not prove the inbound Webhook source is receiving fresh events.

Start the feeder using the existing development/fixture environment:

    LAB_THROUGHPUT_API_BASE_URL=http://CURRENT_DEV_API_HOST:CURRENT_API_PORT \
      ./scripts/dev-validation/start-lab-throughput-feeder.sh --tick-seconds 1

The launcher rejects an unreachable API before it generates fixture traffic.
Before restarting an already-running feeder, verify its owned process PID,
worktree, APP_ENV=development and isolated preview catalog; stop only that
feeder, not the scheduler or API. Never put credentials in durable evidence
files or alter unrelated operator resources. Afterwards, verify a test-only
Webhook POST and two non-overlapping 60-second windows of real
run_complete.input_events and per-Route delivery receipts. Count ingested
events once per Stream, not once per Route. Keep final authenticated Browser
acceptance separate from these native runtime checks.

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


## Isolated HTTPS development preview (UX M1-01 / M1-02)

The native seeder can target an existing isolated preview catalog without changing
its administrator, authentication configuration or operator-owned resources.
Before seeding, verify the actual HTTPS UI/API source identity, reverse-proxy
upstreams, loopback PostgreSQL binding and schema. Retain a private catalog backup,
proxy configuration snapshot, administrator preservation digest and existing object
IDs. A login-page HTTP 200 is not authenticated browser acceptance.

The preview opt-in requires all of the following: `APP_ENV=development`,
`--local-dev-mode`, a loopback PostgreSQL host, port `55441`, user `gdc`, and
`--preview-database` exactly matching a catalog named
`datarelay_rue2e_preview_<8-to-32 lowercase hex characters>`. URI options,
fragments, additional path segments, compose aliases and any other database name
are refused even when legacy compose support is enabled. Missing opt-in keeps the
existing allowlist unchanged. No production environment is accepted.

```bash
# DATABASE_URL must already identify the verified isolated preview, not gdc_pytest.
# Preserve the existing process authentication/encryption environment.
APP_ENV=development bash scripts/dev-validation/seed-visible-e2e-fixtures.sh \
  --local-dev-mode --preview-database "$VERIFIED_PREVIEW_DATABASE"
```

Run the same native command twice and compare Connector/Source/Stream/Route/
Destination/Mapping/Enrichment/Checkpoint IDs and counts. Both runs must keep the
same IDs and retain the administrator preservation digest. Resources are labelled
`[DEV E2E]`; the seed does not reset the catalog or delete operator rows.

Affected verification is `DEV-VALIDATION-EPS-GUARDRAIL` in
`.engineering/tests.yaml`. Run its pytest command on the dedicated `gdc_pytest`
catalog, never on the preview catalog. Configured EPS tests do not prove live
5–20 EPS: UX M1-06 separately requires two consecutive 60-second measurement
windows with per-Stream input and per-Route receiver reconciliation. Seeding does
not establish authenticated Browser or independent two-user acceptance.
