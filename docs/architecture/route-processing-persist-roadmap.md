# Route Processing Persist Roadmap (v1.x Backlog)

**Status:** Design record — no implementation authorized  
**Date:** 2026-06-20  
**Branch context:** `feature/sensitive-detection-m5-clean` (post P2.1 Effective Status Alignment)  
**Authority:** P2.2 Scope Decision — Option B (OSS v1 complete → v1.x backlog)  
**Related:**

- `docs/ux/DATA-RELAY-ROUTE-PROCESSING-UX-SPEC.md` (§24 Deploy Projection, §25 Effective Status Alignment)
- `docs/architecture/m13-route-processing-ui-deferral.md` (OSS v1 deferral baseline)
- `docs/architecture/route-architecture-gap-analysis.md`
- Specs 091–096 (route processing architecture)

**Purpose:** Officially define **Route Processing Full Persist MVP** as v1.x backlog. This document records design intent only. **OSS v1 deploy behavior is unchanged.**

---

## 1. Current State

### 1.1 Shared Processing Persist (OSS v1 — complete)

At wizard deploy, stream-scoped processing is persisted before routes are created:

| Concern | Wizard surface | Persist target | Deploy hook |
|---------|----------------|----------------|-------------|
| Transform | Route Processing → Shared Processing | `StreamMapping`, `StreamEnrichment` | `POST /runtime/streams/{id}/mapping-ui/save` |
| Protection | Data Protection intents | `StreamProtectionRule` | `persistWizardDataProtectionIntents()` |
| Classification | Data Protection intents (derived) | `StreamClassificationRule` | same |
| Policy | Data Protection intents (derived) | `StreamPolicyRule` | same |
| Schema drift | Data Protection policies | `stream.config_json.governance.schema_drift_policy` | `persistWizardSchemaDriftPolicy()` |

Code: `frontend/src/components/streams/new-stream-wizard-page.tsx` (create flow).

### 1.2 Governance Route Override Persist (OSS v1 — complete)

After `POST /routes/` returns route IDs, governance document is persisted:

| Override type | Wizard source | Persist target | Runtime merge |
|---------------|---------------|----------------|-----------------|
| Field protection action | `dataProtection.routeOverrides[]` | `stream.config_json.governance.route_overrides[].protection_action` | `resolve_route_protection_config()` |
| Classification floor | `dataProtection.routeClassificationOverrides[]` | `route_overrides[].classification_level` | `resolve_route_classification_config()` |
| Delivery behavior (field) | `routeOverrides[].deliveryBehavior` | `route_overrides[].delivery_behavior` | `resolve_route_policy_config()` |
| Stream default rules | `dataProtection.intents[]` | `governance.rules[]` | stream-scoped engines |

Code: `wizard-governance-persist.ts` → `putStreamGovernance()`.

Post-deploy Effective API `processing_status` reflects governance overrides (P2.1, `app/runtime/route_processing_status.py`).

### 1.3 Delivery Persist (OSS v1 — complete)

Route delivery metadata persists at route creation:

- `enabled`, `failure_policy`, `formatter_config_json`, `rate_limit_json` via `POST /routes/`
- Code: `buildRouteCreatePayloads()` in `wizard-state.ts`

### 1.4 Deploy Intent Model (OSS v1 — by design)

Wizard Route Processing collects per-route **intent** that may not persist. Deploy Summary projects status via pure function (no runtime resolver):

```text
projectRouteProcessingStatusFromDeployIntent(draft, dataProtection)
  → processing_status: Inherited | Overridden | Mixed
  → persistKind: none | intent_only | governance
```

| `persistKind` | Operator label | Meaning |
|---------------|----------------|---------|
| `none` | — | Shared Processing only |
| `intent_only` | Intent only | Configured in wizard; **not saved** at deploy for that concern bundle |
| `governance` | Persisted through governance rules | Field-level overrides in `governance.route_overrides` |

Code: `wizard-deploy-projection.ts`. UX spec: §24.

**OSS v1 posture:** Deploy Intent ≠ post-deploy Effective API truth for `intent_only` concerns. This is intentional and documented; **not a defect in OSS v1.**

---

## 2. Known Gaps

Full **route override bundles** (`draft.inherit.<concern> === false` with route-scoped editor content) are **not** persisted at wizard deploy.

| Gap | Wizard trigger | Current `persistKind` | Post-deploy Effective API | Runtime effect |
|-----|----------------|----------------------|---------------------------|----------------|
| **Transform Bundle Persist** | `inherit.transform = false` + route mapping/enrichment draft | `route_transform` (complete); `intent_only` when empty | `Overridden` / `Mixed` when persisted; Effective read-back on save | Route transform dual-read when rows exist |
| **Protection Bundle Persist** | `inherit.protection = false` + route-scoped protection intents | `intent_only` | Stream / governance only | No `RouteProtectionRule` rows |
| **Classification Bundle Persist** | `inherit.classification = false` without floor override row | `intent_only` | Stream classification only | No `RouteClassificationRule` rows |
| **Policy Bundle Persist** | `inherit.policy = false` + route delivery behavior | `intent_only` | Stream policy only | No route-level policy bundle |

**Note:** Field-level governance overrides (protection action, classification floor) **are** persisted and are **not** listed as gaps.

**Workaround today:** Operator configures route bundles post-deploy via Route Edit APIs (`saveRouteMappingUiConfig`, `createRouteProtectionRule`, etc.).

---

## 3. v1.x MVP Scope

**Milestone name:** Route Processing Full Persist MVP (v1.1)

**Goal:** When an operator sets `inherit.<concern> = false` in Wizard Route Processing and deploys, the corresponding route-scoped bundle is persisted and post-deploy Effective API reflects **Overridden** (or **Mixed** where applicable).

### In scope (P0 — v1.1)

1. **Transform bundle persist** — After route IDs exist, for each route with `inherit.transform === false`, call route mapping/enrichment save APIs with draft override content.
2. **Policy bundle persist** — Persist route-level delivery behavior from `draft.overrides.policy` to `RoutePolicyRule` and/or governance `delivery_behavior` (design choice: prefer `RoutePolicyRule` for bundle parity with Route Edit).
3. **Deploy projection update** — New or extended `persistKind` (e.g. `route_bundle`) for concerns that will persist; remove `(Intent only)` for successfully persisted bundles.
4. **Deploy readiness** — Warn or block when persist fails per route (TBD: Warning vs Error policy in implementation spec).
5. **Tests** — Unit tests for persist orchestration; integration tests for wizard deploy → Effective API alignment (Transform, Policy first).

### In scope (P1 — v1.1–v1.2)

6. **Protection bundle persist** — Route-scoped intents → `RouteProtectionRule` rows (distinct from governance field overrides).
7. **Classification bundle persist** — Route-scoped classification → `RouteClassificationRule` or documented floor-only governance path (avoid duplicate semantics with existing floor persist).
8. **Mixed-state clarity** — Deploy Summary and Route Edit show consistent status when stream + route bundle + governance override combine.

### Explicitly deferred past MVP (v1.2+)

- `GDC_ROUTE_PROCESSING_ENABLED` default ON
- Flag removal
- Wizard step order changes beyond persist wiring
- New governance schema versions

---

## 4. API Impact

**No new endpoints required for MVP.** Existing route-scoped APIs are sufficient:

| Concern | Existing API (frontend client) | Persist payload source |
|---------|-------------------------------|------------------------|
| Transform | `saveRouteMappingUiConfig`, `saveRouteEnrichmentUiConfig` | `draft.overrides.transform` |
| Protection | `createRouteProtectionRule` (bulk if added) | `draft.overrides.protection.intents` |
| Classification | `createRouteClassificationRule` | route classification draft / floor |
| Policy | `createRoutePolicyRule` | `draft.overrides.policy.deliveryBehavior` |

**Optional additive changes (implementation phase only):**

- Bulk route-bundle save helper endpoint (convenience, not required for MVP)
- Effective API: no schema change expected; status should naturally become `Overridden` once rows exist

**Governance API:** `putStreamGovernance` unchanged for field-level overrides; bundle persist must not break existing `route_overrides` merge order.

**OSS v1:** No API contract changes until v1.x MVP ships.

---

## 5. Runtime Impact

| Layer | Impact |
|-------|--------|
| **Resolvers** | No resolver logic change required — dual-read already supports route rows |
| **Legacy path (flag OFF)** | Persisted route rows exist in DB but legacy fan-out may ignore route transform bundles; governance overrides already apply on legacy path |
| **Route pipeline (flag ON)** | Full benefit — `process_route_pipeline()` consumes persisted route bundles |
| **Effective API** | Already aligned for governance (P2.1); bundle persist closes remaining `intent_only` → `Inherited` gap |

**Important:** Persist MVP **does not** require enabling `GDC_ROUTE_PROCESSING_ENABLED`. Persisted config is durable and visible in Route Edit / Effective API even when runtime uses legacy path. Flag ON graduation is a separate P2 item.

**OSS v1 runtime behavior:** Unchanged until flag policy is explicitly updated in a later milestone.

---

## 6. Migration Impact

| Item | Assessment |
|------|------------|
| **Database migration** | **None required** — M13 tables exist (`route_mappings`, `route_enrichments`, `route_protection_rules`, `route_classification_rules`, `route_policy_rules`, alembic 0054–0057) |
| **Existing streams** | Unaffected — additive wizard deploy path only |
| **Existing governance documents** | Unaffected — bundle persist is orthogonal to `route_overrides` |
| **Wizard draft format** | May add persist metadata in outcome; backward-compatible draft migration preferred |

---

## 7. Feature Flag Strategy

| Flag | Current default | MVP behavior | Graduation (post-MVP) |
|------|-----------------|--------------|------------------------|
| `GDC_ROUTE_PROCESSING_ENABLED` | `False` (`app/config.py`) | Persist MVP **does not** flip default | P2: E2E validation → default ON roadmap → removal criteria |

**Principles:**

1. **Persist first, flag second** — Operators can configure and store route bundles before route pipeline is default.
2. **No silent behavior change on deploy** — Enabling flag in an environment is an explicit ops decision, not a side effect of v1.1 persist.
3. **Legacy path parity** — Governance overrides already work on flag OFF; document which bundle types require flag ON for full runtime effect (especially Transform).

---

## 8. E2E Verification Plan

### 8.1 Unit / integration (CI)

| Test | Assertion |
|------|-----------|
| Transform bundle deploy | `inherit.transform=false` → route mapping/enrichment rows created |
| Policy bundle deploy | `inherit.policy=false` → `RoutePolicyRule` or equivalent persisted |
| Protection bundle deploy (P1) | `inherit.protection=false` → `RouteProtectionRule` rows |
| Classification bundle deploy (P1) | floor/bundle → persisted + Effective API status |
| Governance regression | field `route_overrides` still persist when bundle persist added |
| Deploy projection | `persistKind !== intent_only` for persisted bundles |

Existing tests to preserve: `test_route_*_effective.py`, `wizard-governance-persist.test.ts`, `wizard-deploy-projection.test.ts`.

### 8.2 E2E smoke (post-implementation)

1. Wizard: 2 routes, route A transform override, route B shared → deploy → Effective API route A `Overridden`, route B `Inherited`.
2. Wizard: policy override on one route → deploy → policy effective `Overridden`; delivery gate matches behavior.
3. Wizard: governance field override + shared inherit → still `Mixed` / governance path (P2.1 regression).
4. Flag OFF: verify legacy delivery still succeeds; persisted rows visible in Route Edit.
5. Flag ON (test env): verify `process_route_pipeline` applies route transform bundle end-to-end.

Run via `./scripts/testing/run-smoke-tests.sh` after `./scripts/testing/start-test-stack.sh` when runtime-related.

---

## 9. Definition of Done

Route Processing Full Persist MVP is **done** when:

- [ ] Wizard deploy persists **Transform** and **Policy** route bundles (`inherit=false`) for all created routes
- [ ] Wizard deploy persists **Protection** and **Classification** route bundles (P1 scope)
- [ ] Deploy Summary `persistKind` reflects actual persist outcome (no `(Intent only)` for persisted bundles)
- [ ] Post-deploy Effective API `processing_status` matches wizard intent for all four concerns (within Mixed/Overridden rules in UX spec §25)
- [ ] Governance field overrides continue to work; no regression in P2.1 alignment tests
- [ ] Route Edit can load and edit wizard-persisted bundles without data loss
- [ ] Unit/integration tests cover persist orchestration per concern
- [ ] E2E smoke (§8.2) passes in test stack
- [ ] UX spec updated (new section or §24 extension for `route_bundle` persist kind)
- [ ] **OSS v1 deploy path behavior documented** — no undocumented breaking changes to streams created before v1.1

**Not required for MVP DoD:** `GDC_ROUTE_PROCESSING_ENABLED` default ON, flag removal, Enterprise-only features.

---

## 10. Out of Scope

The following remain **out of v1.x Full Persist MVP**:

| Item | Rationale |
|------|-----------|
| OSS v1 deploy behavior changes | This roadmap is backlog definition only |
| New DB tables or alembic migrations | Tables already exist |
| Runtime resolver / enforcement changes | Persist-only; runtime already dual-reads |
| Wizard Deploy Persist work for unrelated concerns | e.g. union schema, connector materialization |
| `GDC_ROUTE_PROCESSING_ENABLED` default ON | Separate P2 graduation milestone |
| Route Processing UI net-new surfaces | Route Edit / Wizard editors largely exist; MVP is persist wiring |
| AI-assisted transform, regex_replace, raw code execution | Product charter exclusions |
| Enterprise-only governance features | Core route persist is OSS scope |
| Collapsing Deploy Intent model entirely | Deploy remains Decision Center; truth shifts from projected to effective post-deploy |
| Stream duplication for per-destination processing | Violates Product Charter |

---

## Appendix: Persist Matrix (Reference)

| Concern | Config type | OSS v1 persist | v1.x MVP target |
|---------|-------------|----------------|-----------------|
| Transform | Shared | YES | — |
| Transform | Route bundle (`inherit=false`) | NO | **YES** |
| Protection | Shared intents | YES | — |
| Protection | Governance field override | YES | — |
| Protection | Route bundle (`inherit=false`) | NO | **YES** |
| Classification | Shared rules | YES | — |
| Classification | Governance floor | YES | — |
| Classification | Route bundle | NO | **YES** |
| Policy | Shared rules | YES | — |
| Policy | Governance delivery (field) | YES | — |
| Policy | Route bundle (`inherit=false`) | NO | **YES** |
| Delivery | Route metadata | YES | — |

---

## Revision History

| Date | Change |
|------|--------|
| 2026-06-20 | Initial v1.x backlog definition (P2.2 Scope Decision) |
