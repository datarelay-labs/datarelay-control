# Configuration mutation concurrency

Operator-facing configuration PUT endpoints use optimistic concurrency:

| Entity | Token field(s) | Stale error |
|--------|----------------|-------------|
| Route | `expected_updated_at` | `ROUTE_STALE_WRITE` |
| Connector | `expected_updated_at` + `expected_source_updated_at` | `CONNECTOR_STALE_WRITE` / `CONNECTOR_SOURCE_STALE_WRITE` |
| Source | `expected_updated_at` | `SOURCE_STALE_WRITE` |
| Stream | `expected_updated_at` | `STREAM_STALE_WRITE` |
| Destination | `expected_updated_at` | `DESTINATION_STALE_WRITE` |

Contract:

1. Clients read `updated_at` (and Connector `source_updated_at`).
2. Clients send the same value(s) as `expected_*` on PUT.
3. Handlers lock the row(s) with `SELECT … FOR UPDATE`, compare tokens, and reject stale writes with **409**.
4. Stale requests apply **no** mutation, audit success row, or config-version snapshot.

## Source API

`PUT/DELETE /sources/{id}` is an operator-facing mutable API. Mutations emit `SOURCE_*` audit events. Config-version / rollback snapshots are **not** expanded for Source in this phase (Connector compound updates already own most operator Source edits; rollback infrastructure stays on Stream/Route/Destination).

## Stream runtime fields

- `source_type` is read-only on Stream responses (derived from the linked Source).
- Runtime `status` is owned by `/streams/{id}/start` and `/streams/{id}/stop`, not configuration PUT.
