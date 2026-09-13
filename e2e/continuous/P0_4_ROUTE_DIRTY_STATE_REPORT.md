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

## Explicit non-goals

- `ROUTE_STALE_WRITE_GAP=YES` — route PUT remains last-write-wins (`updated_at` unused). Follow-up only.
- No new draft backend / autosave product / Stream Wizard redesign.
- Filtering UI still absent (dead default only).

## Runtime vs unsaved

UI states that edits are local until Save; runtime continues on persisted config.
