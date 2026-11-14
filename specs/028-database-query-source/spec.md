# 028 Database query source (DATABASE_QUERY)

## Purpose

Lock the architecture and configuration surface for **DATABASE_QUERY** sources before implementation. Rows read from customer databases are converted into normalized events and processed through the existing stream pipeline (mapping → enrichment → route fan-out → destination delivery). **Checkpoint updates remain owned by StreamRunner and occur only after successful destination delivery** per `specs/002-runtime-pipeline/spec.md` and `.specify/memory/constitution.md`. This spec does **not** require changes to StreamRunner checkpoint rules or transaction semantics.

## Non-goals (explicitly out of scope for this roadmap)

- Oracle, Microsoft SQL Server, and other engines not listed under Supported DBs.
- Kafka, message queues, and cloud object stores beyond existing **S3_OBJECT_POLLING** (no new bucket protocols here).
- Runtime implementation, new migrations, or schema changes (this document is planning authority only unless a later task adds enums/adapters).

## Architecture alignment

- **Connector ≠ Stream ≠ Source ≠ Destination**: connection credentials and engine selection live at connector/source configuration; per-run query behavior and batching live on the stream.
- **Stream** is the execution unit; **Route** is the only path to destinations.
- **Mapping before enrichment**; checkpoint semantics unchanged at the platform level.
- Vendor-specific SQL and wire protocols must live in **isolated source adapters** registered via `SourceAdapterRegistry` (see `specs/001-core-architecture/spec.md` plugin adapter rules). StreamRunner must not embed engine conditionals.

## Source type

- **source_type**: `DATABASE_QUERY`

## Supported databases (initial)

| `db_type` value | Engine |
| --- | --- |
| `POSTGRESQL` | PostgreSQL |
| `MYSQL` | MySQL |
| `MARIADB` | MariaDB |

MariaDB is treated as a distinct `db_type` for UX and driver selection even when wire protocol compatibility overlaps with MySQL.

## Connection configuration (source / connector scope)

Stored with the source (and connector group) as encrypted-at-rest secrets where applicable. All user-facing strings remain **English-only**.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `db_type` | enum | yes | One of `POSTGRESQL`, `MYSQL`, `MARIADB`. |
| `host` | string | yes | Database hostname or IP. |
| `port` | integer | yes | Listener port (defaults may be suggested per engine in UI). |
| `database` | string | yes | Initial database / catalog name. |
| `username` | string | yes | Login user. |
| `password` | secret string | yes* | Password unless authentication is exclusively via other means defined in a later auth spec. |
| `ssl_mode` | enum | yes | e.g. `DISABLE`, `PREFER`, `REQUIRE`, `VERIFY_CA`, `VERIFY_FULL` (exact set validated per engine). |
| `connection_timeout_seconds` | integer | yes | Upper bound for connect + initial handshake; must align with stream-level statement timeout policy. |

Connectivity probes (future implementation) must be **non-destructive** (e.g. `SELECT 1` or driver ping) and must **not** return passwords or connection strings in API responses (mirror `specs/025-s3-object-polling-ui/spec.md` secret handling).

## Stream configuration (execution scope)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | Single **SELECT** statement (see Safety rules). |
| `query_params` | JSON array or object | no | Bound parameters for the query; must be serialized safely; no string concatenation of untrusted SQL fragments from the UI. |
| `max_rows_per_run` | integer ≥ 1 | yes | Hard cap on rows returned per scheduler run after checkpoint filter is applied. |
| `checkpoint_mode` | enum | yes | Defines how incremental state is interpreted. Initial set: `NONE` (full read each run, subject to `max_rows_per_run`), `SINGLE_COLUMN` (monotonic watermark on `checkpoint_column`), `COMPOSITE_ORDER` (watermark + deterministic tie-break using `checkpoint_order_column`). |
| `checkpoint_column` | string | conditional | Required when `checkpoint_mode` is `SINGLE_COLUMN` or `COMPOSITE_ORDER`. Must refer to a single column in the SELECT list (or an alias exposed in the result). |
| `checkpoint_order_column` | string | conditional | Required when `checkpoint_mode` is `COMPOSITE_ORDER`. Used when watermark ties occur. |
| `replay_time_column` | string | no | Date/time column of the query result that a backfill/replay time window filters. When omitted the platform uses `checkpoint_column` if it is a date/time, otherwise the single date/time column of the result; if none or several exist the backfill fails with an actionable error instead of comparing an integer watermark to a timestamp. |

Optional future extensions (e.g. primary-key pagination mode) must not contradict **checkpoint-after-delivery**.

## Row-to-event conversion

- Each result **row** becomes one **raw event** object: column names map to JSON-safe keys; driver-native types are normalized to JSON types (string, number, boolean, null; binary as base64 or hex per adapter policy documented at implementation time).
- The adapter attaches minimal **provenance** fields on the raw event (namespaced keys such as `gdc_db_*`) for debugging only; these fields may be stripped or ignored by mapping. They must **not** replace user mapping for business identifiers.
- Empty result sets yield zero events (not an error).

## Checkpoint model (payload semantics)

Checkpoint **persistence** remains the stream’s checkpoint record; **values** are advanced only when StreamRunner commits after successful delivery (same as today). The adapter supplies candidate metadata on successfully delivered events so `_update_checkpoint_after_success` (or equivalent) can persist:

| Field | Description |
| --- | --- |
| `last_processed_value` | Latest value from `checkpoint_column` among delivered events in the run (or batch), when applicable. |
| `last_processed_order_value` | Latest value from `checkpoint_order_column` when `checkpoint_mode` is `COMPOSITE_ORDER`. |
| `last_processed_primary_key` | Optional stable row identifier when the stream configures explicit PK columns (implementation phase may add `primary_key_columns`); used for tie-breaking or duplicate-safe incremental reads. |

For `NONE` mode, checkpoint advancement may still record **last_success_event** / run boundary per existing checkpoint service behavior without implying a SQL watermark.

## Safety rules (non-negotiable)

1. **SELECT-only**: the platform rejects queries that are not a single read-only SELECT (no `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `CALL`, DDL, or session mutation verbs).
2. **No multi-statement execution**: no semicolon-separated batches; no stacked queries.
3. **Parameterized binding**: `query_params` must use prepared-statement binding; forbid raw client-side string stitching of operator SQL.
4. **Limit enforcement**: the runtime applies `max_rows_per_run` as a hard cap (e.g. `LIMIT` injection or cursor fetch loop) in addition to any user-written `LIMIT` in SQL (platform wins the stricter cap).
5. **Timeout enforcement**: statement and connection timeouts must be enforced at the adapter/driver layer; exceeded timeouts surface as fetch errors without partial checkpoint advance on failed runs.
6. **Read-only connection recommendation**: documentation and UI copy should recommend a DB user with read-only grants.

## Rate limiting

- **Source rate limit** applies to DATABASE_QUERY as for other sources (`constitution.md`). **Destination rate limit** remains independent.

## Testing strategy

- **Unit tests** (per adapter): SQL classifier (reject non-SELECT), parameter binding, row-to-event typing, `max_rows_per_run` cap, timeout behavior with mocked driver.
- **Integration tests**: containerized PostgreSQL / MySQL / MariaDB with seed tables; incremental modes with duplicate watermark and order tie scenarios; verify no checkpoint persistence on simulated destination failure (reuse existing StreamRunner contract tests pattern).
- **Security tests**: injection attempts in `query` / `query_params`; verify no multi-statement escape.

## Documentation

Operator-facing connection tuning and SSL modes will live under `docs/sources/` when implementation lands (English-only).
