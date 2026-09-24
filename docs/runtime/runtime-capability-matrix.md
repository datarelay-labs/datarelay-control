# Runtime capability vs seed / validation dataset

This document separates **what the runtime can execute today** (StreamRunner + source/destination adapters) from **where rows in the database came from** (bundled demo seed vs development validation lab). It is an operational clarity guide only — it does not add new adapters or change runner semantics.

**Related**

- `app/sources/adapters/registry.py` — source dispatch by `source_type`
- `app/destinations/adapters/registry.py` — destination dispatch by `destination_type`
- `app/db/seed.py` — bundled **create-only** demo graph (`Sample API Connector`, …)
- `app/dev_validation_lab/seeder.py`, `templates.py` — lab fixtures (`[DEV VALIDATION] …` prefix)

---

## Runtime-supported source types

All of the following are registered in `SourceAdapterRegistry` and invoked from `StreamRunner` via the linked source row’s **`source_type`** (not the stream name).

| `source_type` | Status | Notes |
|---------------|--------|--------|
| `HTTP_API_POLLING` | **Supported (primary path)** | Default UI and lab HTTP fixtures; uses `HttpApiSourceAdapter`. |
| `S3_OBJECT_POLLING` | **Supported (extended)** | Uses `S3ObjectPollingAdapter` (e.g. AWS S3, MinIO). Requires valid object-store config and network reachability. |
| `DATABASE_QUERY` | **Supported (extended)** | Uses `DatabaseQuerySourceAdapter` / SELECT safeguards. PostgreSQL only; requires DB connectivity and correct SQL + checkpoint fields. |
| `REMOTE_FILE_POLLING` | **Supported (extended)** | Uses `RemoteFilePollingAdapter` (SFTP-based SSH access; optional SFTP-compatible SCP byte transfer). Requires SSH reachability and path/pattern config. |
| `WEBHOOK_RECEIVER` | **Supported (push)** | Uses `WebhookReceiverSourceAdapter` and the webhook ingest runtime path. Aliases `WEBHOOK` and `WEBHOOK_PUSH` resolve to the same adapter. Push payloads enter the normal StreamRunner pipeline without a polling checkpoint. |

---

## Runtime-supported destination types

| `destination_type` | Status |
|--------------------|--------|
| `WEBHOOK_POST` | Supported |
| `SYSLOG_UDP` | Supported |
| `SYSLOG_TCP` | Supported |
| `SYSLOG_TLS` | Supported |

---

## Bundled demo seed (database provenance)

**Created by:** `python -m app.db.seed` (default mode, not `--platform-admin-only`).

**Intent:** Create-only sample rows so a fresh catalog has one end-to-end HTTP → mapping → enrichment → webhook route → checkpoint example.

| Entity | Typical name / pattern | Runtime? |
|--------|-------------------------|----------|
| Connector | `Sample API Connector` | Rows are normal DB rows; **runtime executes** if upstream URL and auth work. |
| Stream | `Sample Alerts Stream` | **HTTP_API_POLLING** — same as any user-defined HTTP stream. |
| Destination | `Sample Webhook Destination` | **WEBHOOK_POST** — requires reachable webhook URL. |

These are **“demo seed”** in **origin** only — they are not a separate execution engine.

---

## Development validation lab dataset (database provenance)

**Created when:** `ENABLE_DEV_VALIDATION_LAB` is enabled (non-production `APP_ENV`), lab seeder runs.

**Naming:** Most lab entities use the prefix **`[DEV VALIDATION] `** (`app/dev_validation_lab/templates.py` — `LAB_NAME_PREFIX`). The visible E2E fixture seed uses **`[DEV E2E] `** (`app/dev_validation_lab/visible_e2e_seed.py`); the UI treats both prefixes as lab/fixture provenance (see `frontend/src/utils/devValidationLab.ts`).

**Intent:** Synthetic traffic against WireMock, test webhooks/syslog receivers, optional MinIO/S3, optional DB-query and remote-file paths when feature flags and credentials allow.

| Lab area | Typical `source_type` | Runtime? |
|----------|----------------------|----------|
| HTTP WireMock streams | `HTTP_API_POLLING` | Supported; depends on lab network (e.g. WireMock container). |
| S3 / MinIO (if enabled) | `S3_OBJECT_POLLING` | Supported when `ENABLE_DEV_VALIDATION_S3` + credentials; extended adapter. |
| DB query (if enabled) | `DATABASE_QUERY` | Supported when `ENABLE_DEV_VALIDATION_DATABASE_QUERY` + DB config; extended adapter. |
| Remote file (if enabled) | `REMOTE_FILE_POLLING` | Supported when `ENABLE_DEV_VALIDATION_REMOTE_FILE` + SSH; extended adapter. |

Lab rows are **fixtures**, not “fake” streams — if prerequisites are missing, runs fail at fetch time like any misconfigured stream.

---

## UI labels (operational)

The Operations UI shows small **capability / provenance** badges derived from stream name and configured source type:

- **Runtime supported** — HTTP API polling (primary path).
- **Runtime supported · extended** — S3 / database / remote file (same pipeline, extra operational prerequisites).
- **Runtime supported · push** — Webhook Receiver (inbound push through the normal StreamRunner pipeline).
- **Demo seed** — stream name matches the bundled demo stream from `app/db/seed.py`.
- **Lab fixture** — stream name starts with `[DEV VALIDATION] ` or `[DEV E2E] `.

These labels clarify **dataset origin** and **adapter tier**; they do not turn off the real runtime.

---

## Dev validation lab — runtime validation depth (by stream)

Seeded when `ENABLE_DEV_VALIDATION_LAB` is on (see `app/dev_validation_lab/seeder.py`). Full semantics for OAuth2 vs JWT refresh: **`docs/testing/dev-validation-oauth2-runtime.md`**.

| Stream name (after `[DEV VALIDATION] ` prefix) | `source_type` | Real `StreamRunner`? | OAuth2 / token notes |
|------------------------------------------------|---------------|----------------------|----------------------|
| `Stream OAuth2 client-credentials` | `HTTP_API_POLLING` | Yes — full | Client-credentials **token POST every poll**; not static bearer. |
| `Stream OAuth2 refresh-cycle (JWT token URL)` | `HTTP_API_POLLING` | Yes — full | **`jwt_refresh_token`** token URL + `access_token` JSON — **not** OAuth2 refresh_token grant. |
| `Stream OAuth2 token-exchange-failure` | `HTTP_API_POLLING` | Yes — fetch fails | Token URL returns 401; mapping/delivery not reached. |
| `Stream s3-basic` | `S3_OBJECT_POLLING` | Yes — when `ENABLE_DEV_VALIDATION_S3` + MinIO | Static access keys in fixture config (not OAuth2). |
| `Stream db-query-basic` | `DATABASE_QUERY` | Yes — when DB flag + PostgreSQL fixture DB is up | DB user/password auth. |
| `Stream remote-file-basic` / `Stream remote-file-scp-json` | `REMOTE_FILE_POLLING` | Yes — when remote flag + SSH/SFTP fixture is up | Password auth to fixture containers. |

**OAuth2 RFC `refresh_token` rotation:** not implemented for HTTP polling auth in this codebase; lab does **not** claim validation of that grant.

---

## Remaining gaps (no new work in this task)

- **Partitioned `delivery_logs`** — not part of this matrix; see retention / migration docs if applicable.
- Any **future** destination or auth modes must be added to registries and documented here when shipped.
