# Source expansion roadmap

This page summarizes **implemented** ingestion sources, **planned** sources locked by specs **028–030**, the **data backfill** direction, and **explicitly excluded** engines. Normative detail lives in the linked specs and in `docs/sources/s3-object-polling.md`.

## Implemented sources

| Source type | Spec / doc reference | Notes |
| --- | --- | --- |
| `HTTP_API_POLLING` | `specs/001-core-architecture/spec.md`, `specs/002-runtime-pipeline/spec.md` | MVP HTTP collection; WireMock and template coverage in `specs/005-wiremock-integration/spec.md`, `specs/013-template-connector-system/spec.md`. |
| `S3_OBJECT_POLLING` | `specs/025-s3-object-polling-ui/spec.md`, `docs/sources/s3-object-polling.md` | S3-compatible object list/fetch; NDJSON / JSON shapes; checkpoints after successful delivery. |

## Next sources (architecture locked)

| Source type | Spec | Scope |
| --- | --- | --- |
| `DATABASE_QUERY` | [`specs/028-database-query-source/spec.md`](../specs/028-database-query-source/spec.md) | PostgreSQL, MySQL, MariaDB; connection + stream query fields; incremental checkpoint fields; SELECT-only safety. |
| `REMOTE_FILE_POLLING` | [`specs/029-remote-file-polling-source/spec.md`](../specs/029-remote-file-polling-source/spec.md) | SFTP and SCP; remote directory polling; parser matrix; file checkpoint and mutation rules. |

## Data backfill workflow

Historical and bounded loads are specified separately from scheduler-driven runtime in [`specs/030-data-backfill/spec.md`](../specs/030-data-backfill/spec.md):

- UI: **Data Backfill** menu (English-only), run history, preview counts, cancel/stop.
- Initial supported targets: `DATABASE_QUERY`, `REMOTE_FILE_POLLING`, `S3_OBJECT_POLLING`.
- **Checkpoint protection**: backfill does **not** overwrite the active runtime checkpoint by default; optional merge requires administrator confirmation and audit.

Platform-wide checkpoint rule (unchanged): **checkpoint updates only after successful destination delivery** — see `specs/002-runtime-pipeline/spec.md` and `.specify/memory/constitution.md`.

## Excluded from this roadmap

The following are **out of scope** for specs **028–030** and this expansion wave:

- Oracle
- Microsoft SQL Server (MSSQL)
- Kafka and general message queues
- Cloud object storage beyond existing **S3_OBJECT_POLLING** (no new GCS/Azure Blob/etc. in this roadmap)

Webhook receiver and other future sources remain governed by `specs/001-core-architecture/spec.md` and the current authority map (`docs/architecture/source-of-truth-index.md`); they are not superseded by this page.
