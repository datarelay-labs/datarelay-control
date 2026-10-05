# OSS v1.0.1 Sprint 8 — Replay Engine Optimization

## Status

Implemented (S4-12 Replay Queue N+1 removal, S4-13 Replay index optimization).

## Scope

- Batch quarantine lookup for Governance Replay list (in-memory join).
- Composite indexes on `stream_replay_events` for list/queue queries.

## Excluded (unchanged)

SSO/SAML/OIDC, Enterprise IAM, Fan-out parallelization, multi-node, OpenTelemetry.

## S4-12 Replay Queue N+1 Removal

- `app/governance_replay/service.py`:
  - `_load_quarantine_for_replays`: one bounded SELECT for the explicit quarantine IDs referenced by the replay batch.
  - Replay/quarantine correlation is provenance-based, never inferred from "same Stream + earlier quarantine" timing.
  - Delivery-failure replays remain independent even when older quarantine history exists on the Stream.
  - The explicit Quarantine Replay action stamps the selected replay with `replay_origin=quarantine` and `quarantine_event_id` before execution.
  - `list_governance_replay_events` passes the preloaded explicit map to `_row_to_entry`.

## S4-13 Replay Index Optimization

- Migration `20260609_0052_replay_list_indexes`:
  - `idx_stream_replay_events_created_at_id` — `(created_at DESC, id DESC)` for window list.
  - `idx_stream_replay_events_status_created_at_id` — `(status, created_at DESC, id DESC)` for status queues.

## Regression

Replay, Governance, Quarantine, AI Gateway, Policy, Classification suites must remain PASS.

## Measurement

Sprint 8 tests assert replay list query count does not scale with row count for quarantine lookup.
