# P0-4 Route Dirty-State

## Dirty definition

`editable form state != last successfully persisted authoritative baseline` (semantic compare after normalization).

## Surfaces

| Surface | Mechanism |
|---------|-----------|
| Route Edit delivery | `route-delivery-dirty.ts` baseline after load/save |
| Route Edit transform | fingerprint snapshot; panel kept mounted across tabs |
| Delivery message prefix | `mergeMessagePrefixDrafts` preserves dirty drafts on reload |
| Stream Edit Wizard | flush pending autosave on unmount; destination refresh merges without clobbering processing overrides |
| Route stale-write | `Route.updated_at` / `expected_updated_at` on PUT; HTTP 409 `ROUTE_STALE_WRITE` |

## Stale-write contract

- GET `/api/v1/routes/{id}` returns server-managed `updated_at`.
- PUT `/api/v1/routes/{id}` requires `expected_updated_at`.
- Backend loads the row with `FOR UPDATE`, compares tokens, and rejects mismatch with **409** `ROUTE_STALE_WRITE` and **zero mutation**.
- Route Edit sends the last successful baseline token; on 409 local dirty edits are preserved and conflict recovery offers Keep editing / Refresh latest (refresh uses the existing discard confirmation when dirty).

## Explicit non-goals

- `ROUTE_STALE_WRITE_GAP=NO` — closed in this phase.
- No new draft backend / autosave product / Stream Wizard redesign.
- Filtering UI still absent (dead default only).
- No platform-wide optimistic-locking framework for Stream/Connector/Destination/Policy.

## Runtime vs unsaved

UI states that edits are local until Save; runtime continues on persisted config.
