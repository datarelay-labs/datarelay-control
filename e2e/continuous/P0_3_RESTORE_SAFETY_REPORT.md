# P0-3 Restore / Replay / Recovery Safety Report

## Scope

Harden Restore / Replay / Recovery / Quarantine destructive actions with the shared
`DangerousActionDialog` from P0-2. Backend remains authoritative.

## Semantics (product)

| Term | Meaning |
|------|---------|
| Restore | Replace operational config from backup snapshot / import |
| Replay | Re-deliver stored/historical events; checkpoint not advanced |
| Retry | Re-attempt failed replay job (governance Replay Center) |
| Resume | Continue collection from current checkpoint (stream Start) |
| Reset | Wipe/rebaseline (checkpoint API wipe, schema baseline) — no history rollback UI |
| Quarantine discard | Irreversible drop of held events |
| Quarantine release | Deliver held payload; may advance checkpoint |

## Guardrails implemented

- Stream Quarantine panel: release + discard dialogs
- Stream Replay panel: execute + discard dialogs
- Governance Quarantine Center: release / discard / replay (single + bulk; typed confirm for bulk discard)
- Governance Replay Center: execute (typed confirm for bulk)
- Delivery-log live replay: dialog (dry-run remains direct)
- Historical backfill live mode: dialog (dry-run remains direct)
- Backup apply: dialog; full restore requires typing `FULL RESTORE`
- Backend: full restore blocked with **409** while any stream is `RUNNING`

## Explicit non-goals / follow-ups

- `STREAM_DELETE_PREVIEW_API_FOLLOWUP` (P0-2) unchanged
- `ADMIN_USER_DELETE_GUARDRAIL_FOLLOWUP` unchanged
- Config snapshot apply UI remains planned/disabled
- Checkpoint PUT/reset remain API-only (no product UI)
- Checkpoint history rollback does not exist
- Governance audit journal gap for bulk paths remains partial (`AUDIT_GAP`)
- Route Dirty-State → `P0_4_FOLLOWUP`
- Retention → out of scope

## Stale restore

- Backup apply requires matching `preview_token` (stale preview rejected)
- Full restore additionally requires no RUNNING streams
- Config snapshot apply requires `expected_version` = current target tip
  (`MAX(platform_config_versions.version)` for the entity). Mismatch → **409**
  `CONFIG_APPLY_STALE_VERSION` with no mutate / no success audit
  (`STALE_RESTORE_SAFETY=PASS`)

## Duplicate delivery

Warnings explicitly state platform deduplication is **not assumed** for replay / release / live backfill / live delivery-log replay.
