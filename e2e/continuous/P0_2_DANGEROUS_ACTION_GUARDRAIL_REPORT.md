# P0-2 Dangerous Action Guardrail

Phase: `DATA_RELAY_RETENTION_CLOSURE_AND_P0_2_DANGEROUS_ACTION_GUARDRAIL`  
Date: 2026-09-13  
Worktree: `/home/aella/gdc-platform-worktrees/p0-2-dangerous-actions`  
Branch: `feat/p0-2-dangerous-action-guardrail`

## Retention closure (Stage A)

| Field | Value |
|-------|-------|
| `RETENTION_CLOSURE_STATUS` | **PASS** |
| `RETENTION_TESTS_COMMITTED` | YES |
| `RETENTION_REPORT_COMMITTED` | YES |
| `RETENTION_CLOSURE_PR` | [#34](https://github.com/datarelay-labs/gdc-platform/pull/34) |
| `RETENTION_CLOSURE_PR_STATUS` | MERGED |
| `RETENTION_CLOSURE_MERGE_COMMIT` | `0646f146c8f94618b783f89763fa5dddf12221c3` |
| `RETENTION_SCHEDULED_DROP_IMPLEMENTED` | NO |
| `PLATFORM_ALERT_HISTORY_RETENTION_MODIFIED` | NO |

Follow-ups (documented only):

- `FOLLOWUP_RETENTION_DROP_SCHEDULING`: fully expired partition DROP currently manual
- `FOLLOWUP_PLATFORM_ALERT_HISTORY_RETENTION`: policy missing
- `FOLLOWUP_PROD_AUTOMATIC_DELETE`: remains OFF pending operational policy decision

## P0-2 baseline

| Field | Value |
|-------|-------|
| `P0_2_START_MAIN_HEAD` | `0646f146c8f94618b783f89763fa5dddf12221c3` |

## Audit summary

Prior UX mixed `window.confirm`, typed-name modals, inline panels, and silent actions. No shared dialog primitive existed under `frontend/src/components/ui/`.

### Risk inventory (representative)

| Surface | HIGH examples | MEDIUM examples | LOW (unchanged this phase) |
|---------|---------------|-----------------|----------------------------|
| Connectors | Delete connector | — | Clone/export |
| Streams | Delete stream (typed name) | — | Run once |
| Routes | Remove route | Disable/enable route | Edit/logs links |
| Destinations | Delete destination (typed name + preflight) | Disable destination | Enable destination |
| Policies | Delete retired policy | Retire policy | Submit review / activate |
| Replay/Quarantine | Execute replay, discard | — | **P0_3 / follow-up** |
| Backup/Restore | Full restore | — | **P0_3 follow-up** |
| Admin users | Delete user | — | **follow-up** |

`DANGEROUS_ACTIONS_AUDITED` ≈ **35** distinct UI actions reviewed across connectors, streams, routes, destinations, governance, replay, backup, retention operator UI, templates, mappings.

`HIGH_RISK_ACTIONS` ≈ **12** (delete connector/stream/destination/route/policy, retire policy, replay execute, backup restore, retention run, quarantine discard, admin user delete)

`MEDIUM_RISK_ACTIONS` ≈ **8** (disable route/destination, enable route, wizard mapping clear, transform reset, policy lifecycle non-delete)

`LOW_RISK_ACTIONS` ≈ **15+** (mapping row delete, template draft delete, enable-only toggles without stop semantics)

### Prior inconsistencies fixed in this PR

- Generic `window.confirm` on connector delete → dependency-aware dialog (`stream_count`)
- Generic confirm on policy delete/retire → impact + assignment counts
- Route disable via `confirm` + `prompt` → single medium-risk dialog with optional reason field
- Route remove via bare confirm → explicit consequence dialog
- Destination disable had no confirmation while delete required disable-first → disable now explains delivery stop vs delete permanence
- Stream delete inline modal duplicated markup → shared component

### Remaining gaps (not expanded in P0-2)

| Gap | Classification |
|-----|----------------|
| Quarantine discard / replay execute without confirm | `P0_3_FOLLOWUP` / governance follow-up |
| Stream stop with no confirm | intentional lightweight (DEV VALIDATION throughput) |
| Connector delete backend 409 after stale modal | `STALE_CONFIRMATION_SAFETY=PASS` (backend authoritative) |
| Stream delete without route count in dialog | `DEPENDENCY_VISIBILITY_GAP` (no preview API) |
| Admin user delete still `window.confirm` | follow-up |
| Retention operator `window.confirm` | ops path; not product entity delete |

## Canonical pattern

`CANONICAL_DANGEROUS_ACTION_PATTERN=frontend/src/components/ui/dangerous-action-dialog.tsx`

Features:

- Title + target name
- Impact bullet list
- Optional dependency block (authoritative counts only)
- Reversibility statement
- Risk-based CTA styling (`medium` amber vs `high/critical` destructive)
- Progressive friction: `click` vs `type-name`
- Optional note field (route disable reason)
- Cancel focused on open; Escape closes; explicit verb labels on confirm
- `blockReason` for RUNNING stream delete

`SHARED_COMPONENT_REUSED_OR_CREATED=CREATED (minimal shared dialog; reuses existing semantic tokens)`

## Surface results

| Check | Result |
|-------|--------|
| `DELETE_DISABLE_SEMANTICS` | **PASS** (destination disable vs delete; route disable vs remove) |
| `STREAM_GUARDRAILS` | **PASS** (shared typed delete + RUNNING block) |
| `SOURCE_CONNECTOR_GUARDRAILS` | **PASS** (connector delete shows stream_count) |
| `DESTINATION_GUARDRAILS` | **PASS** (preflight + typed delete + disable dialog) |
| `ROUTE_GUARDRAILS` | **PASS** (remove + disable/enable dialogs) |
| `POLICY_GUARDRAILS` | **PASS** (delete + retire dialogs with assignments) |
| `DEPENDENCY_VISIBILITY` | **PARTIAL** (destinations/connectors/policies; streams lack preview API) |
| `BACKEND_SAFETY` | **PASS** (no backend changes; existing 409 guards remain authoritative) |
| `STALE_CONFIRMATION_SAFETY` | **PASS** |
| `DANGEROUS_ACTION_ERROR_HANDLING` | **PASS** (errors shown in dialog; no optimistic removal beyond existing delivery-panel behavior) |
| `KEYBOARD_SAFETY` | **PASS** (cancel focus, Escape, non-submit buttons) |

## Verification

| Check | Result |
|-------|--------|
| `TARGETED_TESTS` | **PASS** — vitest 13/13 (dialog, policy guardrails, delivery panel) |
| `npm run build` | **PASS** |
| `VISUAL_REGRESSION` | **NOT_RUN** — no Playwright golden baseline covers these modal-only surfaces; wizard screenshot spec targets non-dialog pages |
| `VISUAL_DIFFS_REVIEWED` | N/A |
| `UNRELATED_UI_CHANGED` | NO (dialog-only / action-path changes) |
| `PRODUCT_SCOPE_DRIFT` | NO |

## P0 follow-ups

- `P0_3_FOLLOWUPS`: restore safety patterns; replay/quarantine confirm alignment
- `P0_4_FOLLOWUPS`: route dirty-state / unsaved-change sync (not touched)

`FULL_32K_RUNTIME_EXECUTED=NO`  
`OVERNIGHT_SOAK_EXECUTED=NO`  
`REAL_SAAS_STARTED=NO`

`FINAL_STATUS=PASS` (pending PR CI merge approval)
