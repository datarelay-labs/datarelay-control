# Configuration Diff and Rollback

## Purpose

Operators must compare configuration edits, inspect immutable before/after snapshots, and roll back safely without altering checkpoint semantics or runtime delivery ownership.

## Scope

Applies to persisted configuration for:

- Stream (`STREAM_CONFIG`): `name`, `enabled`, `polling_interval`, `config_json`, `rate_limit_json` only.
- Mapping (`MAPPING_CONFIG`): keyed by `stream_id`; mapping row fields only.
- Route (`ROUTE_CONFIG`): route row fields only.
- Destination (`DESTINATION_CONFIG`): destination row fields only.

Out of scope for rollback payloads: connector/source rows, enrichment-only saves, checkpoint rows, `delivery_logs`, stream `status` / `stream_type` / `connector_id` / `source_id`.

## Storage

Each `platform_config_versions` row may store:

- `snapshot_before_json` — JSONB nullable (null for legacy rows or create-only events).
- `snapshot_after_json` — JSONB nullable (null for legacy rows).

Snapshots are self-describing JSON objects with a `kind` field matching the entity family.

## Diff

- A single version row supports inline diff: `snapshot_before_json` → `snapshot_after_json`.
- Cross-version compare is allowed only when `entity_type` and `entity_id` match both rows; diff is computed on chosen sides (default: each row’s `snapshot_after_json`, falling back to `snapshot_before_json` when `after` is null).

## Rollback / Apply Snapshot

`POST /api/v1/admin/config-versions/{id}/apply-snapshot` with
`{ "target": "before" | "after", "expected_version": <int> }` writes the selected
snapshot onto the live configuration row.

`expected_version` is the current **target** tip
(`MAX(platform_config_versions.version)` for the same `entity_type` / `entity_id`),
captured at preview time. It is not the historical snapshot row's own version.
Mismatch yields HTTP **409** `CONFIG_APPLY_STALE_VERSION` and must not mutate state
or record a successful apply audit.

Safety rules:

- Never read or write `checkpoints` in this flow.
- Never change stream `status` via snapshot apply (excluded from snapshot schema).
- For `STREAM_CONFIG` or `MAPPING_CONFIG` affecting `stream_id` S: stream S must have `status != "RUNNING"`.
- For `ROUTE_CONFIG` on route R: parent stream `R.stream_id` must have `status != "RUNNING"`.
- For `DESTINATION_CONFIG` on destination D: every stream that has an enabled or disabled route referencing D must have `status != "RUNNING"` (conservative guard).
- Reject apply when `expected_version` does not equal the live entity tip (stale restore).

Successful apply appends a new audit event and a new `platform_config_versions` row documenting the rollback transaction (current live state as `before`, applied snapshot as `after`).

## Runtime Semantics

This feature adds administrative persistence and HTTP endpoints only. It does not change StreamRunner, mapping engine, route fan-out, checkpoint commit rules, or delivery adapters.
