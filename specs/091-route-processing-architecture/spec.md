# M13.1 Route Processing Architecture — Foundation

**Milestone:** M13.1 (Route Processing Foundation)  
**Status:** Foundation spec retained. Current flag contract is normative; M13.1 flag-OFF rollout text below is historical and non-normative.
**Authority:** `.specify/memory/constitution.md`, Product Charter 1.2.1, Master WBS 1.2.1  
**Architecture companion:** [`docs/architecture/route-processing-foundation-implementation-spec.md`](../../docs/architecture/route-processing-foundation-implementation-spec.md)  
**Gap analysis:** [`docs/architecture/route-architecture-gap-analysis.md`](../../docs/architecture/route-architecture-gap-analysis.md)

---

## Current contract (normative)

Route Processing is the only supported product runtime.

- `GDC_ROUTE_PROCESSING_ENABLED` defaults to **true**.
- An explicit `false` is rejected at settings load. There is no flag-OFF runtime and no silent coercion to true.
- Emergency rollback uses a previous release image, not an in-process flag.

Statements later in this document that describe flag default `false`, a live flag-OFF path, flag-OFF regression gates, production default-off rollout, or flag-off rollback record the historical M13.1 plan. They are not current normative contracts. This section wins where they differ.

---

## 1. Problem Statement

Data Relay fully implements **delivery fan-out** (`One Stream → Many Routes → Many Destinations`) but does **not** implement Route as **Destination Specific Processing Unit**.

Today:

```text
One Stream
↓
Processing Once (Transform, Protection, Classification, Policy — all Stream-scoped)
↓
Fan Out (identical payload)
↓
Destinations
```

Product Charter 1.2.1 and WBS 1.2.1 require:

```text
One Stream
↓
Common Processing (Stream-scoped, once)
↓
Route Processing (Route-scoped, per destination)
↓
Destination Delivery
```

**Problem:** Route is a **Destination Link** (formatter, failure policy, rate limit) — not a **Processing Unit**. Operators who need different transforms or governance per destination must duplicate Streams, which violates Product Charter Rule: *users must not duplicate Streams because destinations require different processing*.

**M13.1 solves:** Establish the **foundation** — runtime context contracts, orchestration split, config resolution, feature flag, and backward compatibility — so M13.2–M13.6 can attach per-route engines without a new runtime or parallel pipeline.

---

## 2. Source of Truth Summary

| Document | Relevant mandate |
|----------|------------------|
| **Product Charter 1.2.1** | Route = Destination Specific Processing Unit; Execution Unit = Stream; Processing Unit = Route; Runtime Reuse First; No Parallel Pipeline; Destination First → Route Processing |
| **Master WBS 1.2.1** | M13.1 = Route Runtime Context, Route Configuration Model, Route Processing Lifecycle only |
| **UX Charter 1.2.1** | §24–29 Route model; users configure per-destination differences via Route, not Stream duplication |
| **Stream Wizard Charter v5.2** | Steps: Connect → Sample → Destinations → Route Processing → Deploy |
| **Governance UX Charter v1.1** | Configuration Scope = Stream; Execution Scope = Route |
| **Governance Workspace v1.1** | `route_overrides[]` model; governance processing becomes Route aware |
| **Union Schema UX Spec v1.1** | Union Schema = shared input for all Routes on a Stream |
| **ChatGPT Guardrail v1.0** | No new governance categories; Runtime priority; no parallel engines |

**Constitution alignment (unchanged):**

- Stream = runtime execution unit
- Route connects Stream → Destination
- Multi-destination fan-out preserved
- Mapping and Enrichment remain separate stages (internal; UX unifies as Transform)
- Checkpoint updated only after successful Destination delivery

**M13.1 extends constitution interpretation:** Processing **execution scope** moves to Route; Stream retains fetch, checkpoint, and shared observation.

---

## 3. Current Behavior

### 3.1 Entity model

```text
Stream (execution unit)
  ├─ mappings           UNIQUE stream_id
  ├─ enrichments        UNIQUE stream_id
  ├─ stream_protection_rules
  ├─ stream_classification_rules
  ├─ stream_policy_rules
  └─ Route (N) → Destination
       └─ delivery config only
```

**Evidence:** `app/routes/models.py`, `app/runners/stream_loader.py`

### 3.2 Runtime pipeline

```text
Source Fetch → Extract → Schema Observation
  → Mapping (stream) → Enrichment (stream)
  → Sensitive Detection → Classification → Schema Drift Policy
  → Protection → Policy → Dynamic Routing
  → Fan-out per Route → Formatter → Send
  → Checkpoint
```

**Evidence:** `app/runners/stream_runner.py` — `_collect_and_transform_events()` once, `_fan_out()` with identical payload.

### 3.3 Config loading

- `stream_loader` injects mapping, enrichment, governance rules on **stream** dict
- Routes loaded with delivery fields only: `formatter_config_json`, `failure_policy`, `rate_limit_json`, `enabled`

### 3.4 API surface

- ~47 `/runtime/streams/{id}/...` processing endpoints (stream-centric)
- `/runtime/routes/{id}` — CRUD for delivery fields only

### 3.5 Frontend

- Wizard: Connect → Sample → **Transform** → Destinations → Deploy (inverted vs SoT)
- Transform step is stream-global

---

## 4. Target Behavior

### 4.1 Entity semantics (no topology change)

```text
Execution Unit:   Stream
Processing Unit:  Route
Topology:         One Stream → Many Routes → Many Destinations  (unchanged)
```

### 4.2 Runtime pipeline (M13.1 orchestration skeleton)

When `GDC_ROUTE_PROCESSING_ENABLED=true`:

```text
StreamRunner (sole transaction owner — no new runner class)
  │
  ├─ SHARED PHASE (once per batch)
  │    Fetch → Extract → Schema Observation → Sensitive Detection
  │    → build SharedBatchContext
  │
  ├─ PER-ROUTE LOOP (for each enabled route)
  │    Resolve RouteRuntimeContext (dual-read config)
  │    → [Transform slot — no-op in M13.1]
  │    → [Protection slot — no-op in M13.1]
  │    → [Classification slot — no-op in M13.1]
  │    → [Policy slot — no-op in M13.1]
  │    → Delivery (existing formatter/send/failure policy)
  │
  └─ SHARED PHASE
       Checkpoint (stream cursor, post-delivery ACK — unchanged)
```

**Historical M13.1 plan (non-normative):** `GDC_ROUTE_PROCESSING_ENABLED=false` was specified as identical to the pre-split stream pipeline and as the default. That flag-OFF path is retired. Current runtime defaults the flag to true and rejects explicit `false`. See **Current contract**.

### 4.3 Config resolution

For each concern (`transform`, `protection`, `classification`, `policy`):

```text
effective_config(route) = route_config ?? stream_config ?? platform_default
```

Route config absent → stream fallback → backward compatible.

### 4.4 Loader output

`stream_loader` produces:

- Stream execution config (unchanged)
- `SharedBatchContext` template fields on stream load metadata
- `RouteRuntimeContext[]` — one per enabled route, with `effective_config` pre-resolved

Stage executors receive `RouteRuntimeContext`, not raw stream dict (boundary injection at loader).

### 4.5 Invariants (must not change in M13.1)

| Invariant | Spec |
|-----------|------|
| Checkpoint after delivery success | `specs/004-delivery-routing/spec.md` |
| Fan-out to all enabled routes | `specs/004-delivery-routing/spec.md` |
| Failure policy per route | Existing `routes.failure_policy` |
| No parallel delivery/governance engine | Product Charter |
| Mapping/Enrichment engine algorithms unchanged | `specs/064-advanced-transform/spec.md` |
| Stream tables not truncated | Workspace preserve-user-entities rule |

---

## 5. Scope

M13.1 **in scope** — foundation only:

| # | Deliverable | Owner files (future impl) |
|---|-------------|---------------------------|
| 1 | **Feature flag** `GDC_ROUTE_PROCESSING_ENABLED`. Historical M13.1 plan: default `false`. **Current:** default `true`; explicit `false` rejected | settings / env |
| 2 | **`SharedBatchContext`** dataclass or equivalent | `app/runners/` |
| 3 | **`RouteRuntimeContext`** dataclass or equivalent | `app/runners/` |
| 4 | **`resolve_route_config()`** dual-read function | `app/runners/stream_loader.py` |
| 5 | **`stream_loader` refactor** — emit `RouteRuntimeContext[]` | `app/runners/stream_loader.py` |
| 6 | **`StreamRunner` orchestration split** — shared phase + per-route loop with empty stage slots | `app/runners/stream_runner.py` |
| 7 | **Route Configuration Model** — additive table design documented (schema only, no migration in M13.1 label if deferred) | design doc / follow-on migration |
| 8 | **Processing readiness hook** — conceptual contract for deploy gating (`route.processing_ready` or equivalent) | loader + optional API stub |
| 9 | **Sample → Route contract** — `{ event_root, sample_count, union_schema }` payload shape documented | API spec addendum |
| 10 | **Spec index reference** — this spec listed in `.specify/specs-index.md` | docs |

**Orchestration hook names (implementation guidance, not fixed API):**

- `_build_shared_batch_context()` — shared phase output
- `_process_route_batch(route_ctx, shared_batch)` — per-route loop entry
- Stage slots inside `_process_route_batch`: `_route_transform`, `_route_protection`, `_route_classification`, `_route_policy` — **pass-through/no-op in M13.1**

---

## 6. Non-Scope

Explicitly **excluded** from M13.1:

| Milestone | Excluded |
|-----------|----------|
| **M13.2** | Route mapping/enrichment storage, mapper/enrichment invocation per route, route transform APIs/UI |
| **M13.3** | Route protection rules, protection engine per route, route overrides runtime |
| **M13.4** | Route classification rules, classification per route, stage order decision |
| **M13.5** | Route policy rules, policy evaluation per route |
| **M13.6** | Route metrics, route health, delivery observability extensions |
| **Wizard** | Destination First step reorder, `step-route-processing.tsx` |
| **Governance UI** | Route-aware dashboard, violations route breakdown |
| **Union Schema** | 10–20 enforcement, 30% rare threshold, field detail panel |
| **Backfill** | Migration script execution, data copy to route tables |
| **Any** | New `StreamRunner` subclass, new delivery engine, new governance engine, new scheduler |
| **Any** | Stream-scoped API removal or breaking change |
| **Any** | Enterprise IAM (M25) |

M13.1 stage slots **must exist** but **must not execute** route-specific transform/governance logic.

---

## 7. RouteRuntimeContext Contract

Conceptual contract for per-route processing. Implementation uses typed object (dataclass recommended).

### 7.1 Identity

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `route_id` | UUID | yes | Primary route identifier |
| `stream_id` | UUID | yes | Parent stream |
| `destination_id` | UUID | yes | Target destination |
| `enabled` | bool | yes | Route enabled flag |

### 7.2 Shared input (read-only reference)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `shared_batch_ref` | ref → SharedBatchContext | yes | Pointer to batch shared data; must not mutate shared events in place until protection copy semantics apply (M13.3) |

Nested read-only views (accessors or sub-refs):

| View | Source |
|------|--------|
| `extracted_events` | `SharedBatchContext.extracted_events` |
| `event_root` | Stream config |
| `union_schema` | Stream sample contract / runtime snapshot |
| `sensitive_suggestions` | `SharedBatchContext.sensitive_detection_result` |
| `schema_observation` | `SharedBatchContext.schema_observation` |

### 7.3 Effective config (resolved at load time via dual-read)

| Field | Type | M13.1 | Resolution |
|-------|------|-------|------------|
| `transform` | nullable object | placeholder | `route_mapping ?? stream_mapping ?? null` |
| `protection` | nullable object | placeholder | `route_protection ?? stream_protection ?? null` |
| `classification` | nullable object | placeholder | `route_classification ?? stream_classification ?? null` |
| `policy` | nullable object | placeholder | `route_policy ?? stream_policy ?? null` |
| `delivery` | object | populated | Existing route delivery fields |

`transform` internally may hold separate mapping + enrichment config (stage separation preserved per constitution).

### 7.4 Processing state (mutable per batch)

| Field | Type | M13.1 behavior |
|-------|------|----------------|
| `stage_timeline` | list | Record slot entries; slots marked `skipped` or `pass_through` |
| `current_events` | list | Starts as shared events ref; M13.2+ may replace with transformed copy |
| `errors` | list | Structured `{ stage, rule_id?, message }`; empty in M13.1 pass-through |

### 7.5 Delivery context (existing)

| Field | Source |
|-------|--------|
| `formatter_config` | `routes.formatter_config_json` |
| `failure_policy` | `routes.failure_policy` |
| `rate_limit` | `routes.rate_limit_json` |
| `destination_adapter_ref` | Resolved at send time (existing) |

### 7.6 Processing readiness (M13.1 hook)

| Field | Type | M13.1 |
|-------|------|-------|
| `processing_ready` | bool | `true` when orchestration skeleton can run; M13.2+ may gate on transform config |
| `readiness_reasons` | list[str] | Diagnostic strings for deploy UI (future) |

### 7.7 Contract rules

1. One `RouteRuntimeContext` per enabled route per stream load.
2. `effective_config` resolved **once** at load; not re-resolved mid-batch unless explicit reload.
3. Disabled routes: context may be built but loop skips them (existing behavior).
4. Context is **immutable** for identity and `effective_config` during batch; only `processing_state` mutates.
5. No route context may trigger source fetch or checkpoint update directly.

---

## 8. SharedBatchContext Contract

Conceptual contract for stream-scoped shared phase output.

### 8.1 Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `stream_id` | UUID | yes | Owning stream |
| `batch_id` | string | yes | Correlation ID for logs/debug (UUID or monotonic) |
| `extracted_events` | list[dict] | yes | Post record-path + event-root extraction |
| `schema_observation` | object | yes | Drift signals, baseline comparison result |
| `sensitive_detection_result` | object | yes | Field sensitivity suggestions (may be empty) |
| `union_schema_ref` | object \| null | no | Snapshot or reference for route processing input |
| `checkpoint_cursor_before` | object | yes | Cursor state before batch processing |
| `fetch_metadata` | object | no | Source fetch stats for observability |

### 8.2 Lifecycle

| Phase | Action |
|-------|--------|
| Create | After shared phase steps 1–4 complete |
| Consume | Read-only by all `RouteRuntimeContext` in batch |
| Discard | After checkpoint decision for batch completes |

### 8.3 Contract rules

1. Built **once** per execution cycle. **Historical M13.1 plan (non-normative):** when the flag was off, the pre-split path might not instantiate this context. That flag-OFF path is retired.
2. `extracted_events` shared across all routes — no per-route extraction.
3. Union Schema is **not** rebuilt per route.
4. Sensitive detection runs **once**; routes apply different protection later (M13.3).
5. Schema drift observation is stream-scoped; route unknown-field overrides are M13.5.

### 8.4 Sample → Route Processing contract (wizard/runtime boundary)

Normative payload shape for Route Processing input (from Sample step):

```json
{
  "event_root": "$.event",
  "sample_count": 20,
  "union_schema": []
}
```

All routes on a stream consume the same `union_schema`. Implementation of Union Schema hardening is parallel; M13.1 only requires the contract field names and shared semantics.

---

## 9. Feature Flag Strategy

### 9.1 Current flag contract

| Property | Value |
|----------|-------|
| Name | `GDC_ROUTE_PROCESSING_ENABLED` |
| Default | **`true`** |
| Explicit `false` | Rejected at settings load. No flag-OFF runtime |
| Scope | Platform / deployment (env) |
| Per-stream override | Not supported |
| Rollback | Previous release image |

### 9.2 Historical M13.1 flag definition (non-normative)

| Property | Historical M13.1 value |
|----------|------------------------|
| Name | `GDC_ROUTE_PROCESSING_ENABLED` |
| Default | `false` |
| Scope | Platform / deployment (env or admin settings) |
| Per-stream override | Not in M13.1 — platform flag only |

### 9.3 Historical M13.1 behavior matrix (non-normative)

| Flag | Runtime path | User impact |
|------|--------------|-------------|
| `false` | Legacy: process once at stream scope → fan-out identical payload | Zero change for streams that still had the pre-split path |
| `true`, no route config | Shared phase + per-route loop; dual-read falls back to stream config; stage slots no-op in the M13.1 skeleton | Behavior equivalent to the pre-split path until later milestones populated route config |
| `true`, route config present | Route config used where populated | Per-route processing active for configured concerns |

The `false` row is not a live path.

### 9.4 Flag evaluation

- Route Processing is always the runtime path. Explicit `false` fails settings load before a run starts.
- No hot-reload of a flag-OFF path exists.

**Historical M13.1 plan (non-normative):** the flag was evaluated at stream run start, and `stream_loader` / `StreamRunner` branched between the legacy path and the new path.

### 9.5 Historical M13.1 safety requirements (non-normative)

1. Default OFF in all environments until M13.2+ validation complete.
2. Flag OFF must pass the full existing e2e suite without modification to test expectations.
3. Flag ON with empty route config must produce equivalent delivery outcomes to flag OFF (dual-read fallback).
4. Flag must not disable checkpoint, fan-out, or failure policy behavior.

**Current safety requirement:** explicit `false` is rejected. Checkpoint, fan-out, and failure policy stay on the Route Processing path. Rollback uses a previous release image.

---

## 10. Backward Compatibility

### 10.1 Dual-read (mandatory)

```text
for concern in [transform, protection, classification, policy]:
  if route_has_config(concern):
    use route
  elif stream_has_config(concern):
    use stream
  else:
    use platform default / pass-through
```

Route config **must fallback to Stream config**. Never require route config for existing streams to function.

### 10.2 Dual-write (transition — not M13.1 implementation)

During migration window (M13.2+):

- Stream-scoped writes may mirror to all routes on that stream
- Stream-scoped reads may aggregate or return stream fallback

M13.1 documents policy only; shim implementation deferred.

### 10.3 Database

- **Additive only** — new `route_*` tables or nullable `route_id` columns
- **No truncate** of mappings, enrichments, streams, routes, or governance rules
- Stream UNIQUE constraints on `mappings.stream_id`, `enrichments.stream_id` **unchanged** in M13.1

### 10.4 API

- All existing `/runtime/streams/{id}/...` endpoints **remain**
- Route-scoped endpoints are **additive** (M13.2+)
- No breaking request/response shape changes in M13.1

### 10.5 Existing stream guarantees

| Guarantee | Mechanism |
|-----------|-----------|
| Same delivery payload when flag off | **Historical M13.1 plan (non-normative).** The legacy flag-OFF path is retired |
| Same delivery payload when flag on, no route config | Dual-read → stream config |
| Checkpoint semantics unchanged | Shared cursor; specs/004 rules |
| Multi-route fan-out unchanged | Per-route loop still iterates all enabled routes |
| User connectors/streams/routes preserved | No destructive migration in M13.1 |

### 10.6 Future backfill (policy only)

| Scenario | Auto backfill |
|----------|---------------|
| 1 stream, N routes, identical processing | Yes — copy stream config to each route |
| 1 stream, 1 route | Yes |
| Duplicate streams, same source, different transforms | No — operator merge UI |

---

## 11. Acceptance Criteria

M13.1 is **complete** when all criteria pass:

### 11.1 Spec and design

- [ ] **AC-1** This spec and `docs/architecture/route-processing-foundation-implementation-spec.md` are aligned with no conflicting lifecycle or scope statements.
- [ ] **AC-2** Route Configuration Model documented with additive table list (`route_mappings`, `route_enrichments`, `route_*_rules`, etc.) — no SQL required in spec, no stream table breaking changes.

### 11.2 Feature flag

- [ ] **AC-3 (historical M13.1, non-normative)** `GDC_ROUTE_PROCESSING_ENABLED` exists, default `false`. **Superseded:** current default is `true`; explicit `false` is rejected.
- [ ] **AC-4 (historical M13.1, non-normative)** Flag off: runtime behavior matches pre-M13.1 baseline. **Superseded:** there is no flag-OFF runtime.

### 11.3 Context contracts

- [ ] **AC-5** `SharedBatchContext` implemented with all §8.1 required fields.
- [ ] **AC-6** `RouteRuntimeContext` implemented with all §7.1–7.5 required fields.
- [ ] **AC-7** `stream_loader` returns `RouteRuntimeContext[]` with `effective_config` resolved via dual-read.
- [ ] **AC-8** Dual-read verified: route config absent → stream config used for all four concerns.

### 11.4 Orchestration

- [ ] **AC-9** `StreamRunner` with flag on: executes shared phase → builds `SharedBatchContext` → iterates enabled routes via `_process_route_batch`.
- [ ] **AC-10** Stage slots (transform, protection, classification, policy) exist and are **pass-through** — events unchanged, timeline records slot traversal.
- [ ] **AC-11** Delivery after route loop uses **existing** formatter/send/failure policy — no regression.
- [ ] **AC-12** Checkpoint updated per `specs/004-delivery-routing/spec.md` — unchanged semantics.

### 11.5 Boundaries

- [ ] **AC-13** No new runtime class, delivery engine, or governance engine introduced.
- [ ] **AC-14** No M13.2–M13.6 functionality (route transform/protection/classification/policy execution) shipped under M13.1.
- [ ] **AC-15** No user-created stream/route/mapping data deleted or truncated.

### 11.6 Observability (minimal)

- [ ] **AC-16** `delivery_logs` continue to include `route_id` on send — no regression.
- [ ] **AC-17** Optional: `stage_timeline` on route context logged at debug level when flag on.

---

## 12. Test Strategy

No test code in this spec; defines **required test matrix** for M13.1 implementation.

### 12.1 Unit tests

| Area | Cases |
|------|-------|
| `resolve_route_config` | Route config present → use route; absent → stream; both absent → default/null |
| `RouteRuntimeContext` build | All fields populated; disabled route skipped in loop |
| `SharedBatchContext` build | Events, observation, detection populated from shared phase mocks |
| Flag branch | **Historical M13.1 plan (non-normative):** loader/runner select legacy vs new path. Current settings reject explicit `false` |

### 12.2 Historical integration tests (flag OFF — non-normative)

This matrix recorded the M13.1 flag-OFF regression plan. It is not a current regression gate. Current runtime rejects explicit `false`.

| Case | Expected |
|------|----------|
| Single route stream | Identical delivery payload and checkpoint vs baseline |
| Multi-route stream | Identical payload to all routes |
| Stream with mapping + enrichment + protection | Same processing order and output |
| Failure policy LOG_AND_CONTINUE | Checkpoint behavior unchanged |
| Failure policy PAUSE_STREAM_ON_FAILURE | Stream paused on route failure |

**Historical gate (non-normative):** Full existing runtime integration suite passes with flag OFF without test expectation changes.

### 12.3 Integration tests (flag ON — skeleton)

Comparisons to flag OFF in this table mean the historical pre-split baseline. They do not authorize a live flag-OFF path.

| Case | Expected |
|------|----------|
| No route config, stream config present | Dual-read uses stream; delivery outcome matches flag OFF |
| Shared phase | `SharedBatchContext` built once per batch |
| Per-route loop | N enabled routes → N `_process_route_batch` invocations |
| Stage slots | Pass-through; `current_events` unchanged from shared extract |
| Disabled route | Skipped in loop |
| Checkpoint | Same rules as flag OFF |

### 12.4 Compatibility tests

| Case | Expected |
|------|----------|
| Stream with 0 routes | Graceful handling (existing behavior) |
| Stream loader hot path | No N+1 query regression beyond bounded route batch load |
| Import/export | Existing backup shape still valid (route config optional) |

### 12.5 Non-tests (deferred)

- Per-route transform output diff → M13.2
- Per-route protection mask diff → M13.3
- Route-aware governance dashboard → M13.9
- Performance benchmark N routes → post-M13.6

---

## 13. Rollout Strategy

### 13.1 Phases

The phase table below is the historical M13.1 rollout plan, including a production default-off deploy. It is not the current release procedure. Current runtime defaults the flag to true and rejects explicit `false`.

| Phase | Action | Exit criteria |
|-------|--------|---------------|
| **R0 — Spec** | Publish this spec + architecture doc | AC-1, AC-2 |
| **R1 — Skeleton** | Flag (default off), context types, loader refactor, runner split with no-op slots | AC-3–AC-12 |
| **R2 — Staging validation** | Enable flag ON in staging; dual-read fallback verified | AC-8, AC-10; integration §12.3 green |
| **R3 — Production default off** | Deploy M13.1 with flag off | AC-4; production e2e green |
| **R4 — M13.2+** | Populate route config tables and stage executors | Separate milestone gates |

### 13.2 Historical M13.1 rollout rules (non-normative)

1. Never enable flag globally until M13.2 validates transform per route in staging.
2. M13.1 production deploy is safe with flag OFF — zero operator action required.
3. Staging may enable flag ON to validate skeleton; expect equivalent behavior to the pre-split path when no route config exists.
4. No backfill script runs as part of M13.1 rollout.
5. No wizard or UI changes required for M13.1 deploy.

### 13.3 Rollback

**Current:** Emergency rollback uses a previous release image. Setting `GDC_ROUTE_PROCESSING_ENABLED=false` does not restore a legacy path; explicit `false` is rejected.

**Historical M13.1 plan (non-normative):**

| Trigger | Action |
|---------|--------|
| Regression with flag ON | Set `GDC_ROUTE_PROCESSING_ENABLED=false` — immediate return to legacy path |
| Orchestration bug | Flag off; no data migration rollback needed |
| Loader failure | Flag off; legacy loader path preserved |

### 13.4 Dependencies

| Dependency | Relationship |
|------------|--------------|
| M13.2 Per Route Transform | Requires M13.1 context + orchestration slots |
| M13.3–M13.5 | Require M13.1 + respective config tables |
| M13.6 Route Runtime Delivery | Requires M13.1 loop; extends delivery observability |
| Destination First Wizard | Independent of M13.1 runtime deploy; consumes Sample → Route contract |
| Union Schema hardening | Parallel; feeds shared input quality |

### 13.5 Documentation deliverables at rollout

- Update `.specify/specs-index.md` with this spec
- Add `GDC_ROUTE_PROCESSING_ENABLED` to deployment/env documentation
- Note in `specs/002-runtime-pipeline/spec.md` addendum (future): shared vs per-route phase split

---

## Appendix A — Route Configuration Model (design reference)

Additive artifacts for M13.2+ — **designed in M13.1, populated later**:

| Artifact | Key | Notes |
|----------|-----|-------|
| `route_mappings` | UNIQUE `route_id` | M13.2 |
| `route_enrichments` | UNIQUE `route_id` | M13.2 |
| `route_protection_rules` | `route_id` FK | M13.3 |
| `route_classification_rules` | `route_id` FK | M13.4 |
| `route_policy_rules` | `route_id` FK | M13.5 |
| `route_governance_overrides` | `route_id` + rule ref | M13.3 |
| `routes.processing_metadata_json` | optional | readiness hash, config version |

**Preference:** Additive `route_*` tables over altering `mappings`/`enrichments` UNIQUE constraints.

---

## Appendix B — Related specs

| Spec | Relationship |
|------|--------------|
| `specs/001-core-architecture/spec.md` | Stream execution unit; Route link |
| `specs/002-runtime-pipeline/spec.md` | Pipeline stages; addendum for shared/per-route split |
| `specs/003-db-model/spec.md` | DB patterns; route scope extension |
| `specs/004-delivery-routing/spec.md` | Fan-out, checkpoint, failure policy |
| `specs/064-advanced-transform/spec.md` | Engine unchanged; config source moves in M13.2 |
| `specs/065-protection-engine/spec.md` | Engine reused; route scope in M13.3 |
| `specs/066-classification-engine/spec.md` | Engine reused; route scope in M13.4 |

---

## Appendix C — Key implementation files

| File | M13.1 change |
|------|--------------|
| `app/runners/stream_runner.py` | Shared/per-route orchestration split |
| `app/runners/stream_loader.py` | Emit `RouteRuntimeContext[]`, dual-read |
| `app/routes/models.py` | Optional `processing_metadata_json` (future migration) |
| `app/runners/route_context.py` (new) | Context types + resolve helper |

---

*End of M13.1 companion spec. No code, database, API, or UI changes authorized by this document.*
