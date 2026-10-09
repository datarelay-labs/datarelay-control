# DataRelay Control — Flow-First IA & Implementation Contract

**Owner decision:** Approved 2026-10-09, UX roadmap #354. Execution owner: existing Work Packet #413 / Draft PR #414.
**Status:** ARCHITECTURE APPROVED / IMPLEMENTATION PENDING; not a user-test PASS or merge/release approval.
**Authority:** Product Charter > UX/Stream Wizard Charters > implementation specifications. This contract refines existing objects and user experience; it creates no new Product/Runtime/Database entity.
**Initial source baseline:** feat/control-saas-usability-convergence at c64da365e781d2f04e5ec468ee5b18008b8d3bd6. The owner preview on 127.0.0.1:18997 stays pinned to its already built bundle until separately rebuilt.

## 1. User finding and reason to change

A prominent Create stream button starts a Wizard before Connector/Destination prerequisites are available. Five template cards mostly lead into the same Wizard while varying only some defaults. The operator sees separate Streams, Routes, Route Flow, KPIs and a detailed table, but not one high-signal map explaining where events go and what each path is doing.

**Approved direction:** distinguish creating a Data Flow, monitoring data paths, and configuring reusable resources. Competitor precedents documented in #354: Axoflow/Confluent operational lineage, Cribl/StreamSets stage canvas and preview, Airbyte contextual source/target creation. These precedents inform UI behavior, not the canonical Control runtime.

## 2. Exact responsibilities, terminology, and architecture

| Entity or user surface | Operator question | Current ownership |
| --- | --- | --- |
| Connector | How does Control access this source? | Reusable credentials/access, source product |
| Stream | What do we collect; is it running? | Source/extraction, sampling, scheduling, checkpoint, collection execution |
| Route | What is done to data on this specific path? | Destination-specific transform/protection/classification/policy, formatter, failure/retry/limits, delivery |
| Destination | Where is the data sent? | Reusable receiver endpoint, configured receiving capacity when provided |
| Data Flows *view* | Where are data paths connected, how much data moves, which path is unhealthy? | Read-only lineage/topology/operational triage over existing Stream+Route+Destination |
| Governance | Is the governance operation healthy? | Authorized operational investigation; configuration remains in Stream/Route |

**Event path:** Connector (Source access) → Stream (collection) → one or more Routes (processing/delivery) → each Route's Destination.

**Setup dependency order is NOT runtime order.** Reusable Connectors and Destinations may be registered before Streams. Do not depict Connector → Destination → Stream as events travelling through a Destination before collection.

**Invariants:** One Stream → Many Routes → Many Destinations; Destination selection before Route Processing; one canonical Route Processing runtime; no duplicated Stream for per-Destination changes; RBAC and persisted user data unchanged.

## 3. Approved primary navigation and action

    [DataRelay Control]    [+ New Data Flow]
    Dashboard               current health, attention, investigations
    Data Flows              operator-first live connection/Route graph
    Streams                 Source collection, execution, checkpoint
    Connections             infrequently modified reusable resources
      Connectors            Source access/authentication
      Destinations          Receiving endpoint and capacity
    Governance              preserve role-gated #362 single Dashboard entry/group
    Administration          existing task-group system settings

- Rename *Routes overview presentation* to Data Flows; keep /routes as the URL and all existing deep links until compatible redirects are available. The user-visible label is not permission to create a new DataFlow backend entity.
- Preserve Route Edit and Stream Edit as distinct configuration screens reachable from a selected path; no duplicate primary Route-creation menu.
- Replace topmost Create stream CTA with **New Data Flow** only when the guided dependency-aware path is working. No dead-end if Connector/Destination are absent.
- Existing advanced deep links, navigation role gates, mobile focus rules and reusable configuration pages stay available. Governance #362 exception stays in force.
- Global search/recent/favorites remain ROI-deferred until real operator evidence supports them.

## 4. P0-UX-01: Routes becomes a Data Flows operational workspace

**Primary layout (concept, not invented source metrics):**

    +------------------------------------------------------------------+
    | Data Flows   Operational health | EPS | success/failure | time |
    +----------------+------------------------------+------------------+
    | Sources/Streams| Connector                     | Selected Route   |
    | groups/filter  |    ↓ source access           | Health/age       |
    | Stream A       | Stream A (ingest EPS)         | Egress EPS       |
    | Stream B       |    ├─ Route 1 ─> SIEM         | Fail/Retry       |
    |                |    └─ Route 2 ─> Storage      | Capacity*        |
    |                |                              | Logs / Route Edit|
    +----------------+------------------------------+------------------+
    | Expert: original searchable Route table / accessible list view  |
    +------------------------------------------------------------------+

- Graph displays only actual positive/valid Source/Stream/Route/Destination IDs returned by existing read APIs. No synthetic edges or fabricated healthy resources.
- Clicking a Stream focuses its branches; clicking a Route opens the corresponding runtime inspector; clicking a Destination opens its authorized details. The visual selection is **read-only**.
- Retain the searchable/filtered expert Route catalog and an accessible keyboard-operated equivalent of the graph. Scale with grouping and bounded visible nodes; 1440px, 375px and 320px layouts must remain usable.
- Surface operational snapshot timestamp, selected time-window and stale/error/IDLE/disabled/partial/unknown states clearly; never replace absent measurements with 0 or Healthy.
- Metrics provenance: Stream EPS = ingest, Route EPS = route-specific delivery/send according to existing API definitions. NEVER add fan-out route egress together as single source ingest.
- Route outcome: expose observed EPS, failure/retry, success rate, health, activity/latency and policy only when backed by the actual API. A connection test, a preview, an attempted UDP send, and confirmed receiver ingestion are distinct claims.
- Destination capacity use is available only when an authorized configured limit with compatible units/windows exists. Without a limit: Not configured, not 0% used.
- No new endpoint/API call per graph node. Reuse getOperationalSnapshot, fetchRoutesList, buildRouteRowsFromOperationalSnapshot and buildRouteFlowTree; no mutation until an authorized Route Edit.
- Avoid using a large mental-model banner and multiple redundant tables as the primary viewport: the graph + inspector must occupy the prominent operator work area.

**Route acceptance tests:**
1. One Stream with two Routes to two Destinations is depicted as one source path with two distinct branches; each Route inspector reflects its own saved identity and runtime data.
2. Two identical Stream display names remain distinguishable by IDs; selecting B cannot expose A's inspector or extra edges.
3. Disabled, IDLE, errored, missing snapshot, missing Destination ID and unknown capacity are visibly different; stale data is never silently Healthy.
4. The original expert Route table, deep links and keyboard/table fallback remain usable with no new mutating request.
5. Runtime metrics keep their actual units/windows, distinguish ingest from per-Route output, and do not claim UDP receiver acknowledgment without evidence.
6. On a narrow viewport selection and inspector do not overflow; primary path is task-based rather than catalog-first.


## 5. P0-UX-02: New Data Flow with context-preserving prerequisite creation

The global New Data Flow action starts the existing Stream Wizard, not a different server/runtime. Existing five functional stages and persistence gates remain:

1. **Connect Source:** pick reusable Connector, or Add Connector in context when missing. After authorized creation, return to the exact Wizard draft/step with the new Connector selected and without losing prior input.
2. **Sample / Record Selection:** perform real source test, explicitly confirm record path/event root/checkpoint; do not infer an untested successful source.
3. **Destinations:** pick one or more reusable Destinations; Add Destination in context when missing. On success or cancel return to the same Wizard draft and selected Routes. Destination First, Route Processing Second.
4. **Route Processing:** use existing shared configuration and per-Destination Route overrides. One Stream with two Destinations has one collection source and two actual Route configs.
5. **Deploy and verify:** require current API validation/RBAC, clearly distinguish saved, active and runtime-proven states; navigate to Data Flows or Stream Runtime to inspect a real outcome.

**Draft/return safety:**
- Navigating temporarily to Connector or Destination creation may use an approved in-app drawer or a resumable state mechanism. Before selecting implementation, verify the existing Wizard state, router and connected forms; do not assume localStorage is a safe persistent place for credentials.
- On cancel or failed creation restore the exact parent Step/input/selection without orphan records or double-saving. If exact restoration cannot yet be supported, show an explicit unsaved-draft warning rather than silently discarding changes.
- No template or preview click may perform a persistent create, activate a Stream, or bypass operator roles.
- Reuse existing create APIs and source/destination validation; no new permission assumption.
- Evaluate the five current intent cards by actual distinct configuration, not superficial renaming. Make prerequisites visible within the goal flow. Keep Start from scratch for experts.
- The reported simultaneous Healthy header and Offline/local draft message is a P0 source-truth defect to investigate and fix using real auth/API state, not hardcoded labels.

**Onboarding acceptance tests:**
1. First-run 0 Connector/0 Destination: the missing resources can be created without abandoning the original draft. Source test and selected targets survive return.
2. Existing resources: repeated creation selects them directly; no forced re-creation.
3. Multi-destination: one Stream / two Routes with distinct processing overrides, same validation and no duplicate collection.
4. Cancel/back/reload: draft state remains or an honest unsaved-draft dialog blocks accidental loss; no synthetic PASS.
5. Operators without create permission see appropriate guidance/read-only state; frontend alone is never an authorization gate.
6. After Deploy, saved configuration and runtime sending are separately verified. UDP or best-effort results do not mean confirmed receiver ingestion.

## 6. P0-UX-03/04, P1: nav roles, truth, and accessibility

- Roll out sidebar + CTA labels only after New Data Flow and Data Flows are functionally ready, with backward-compatible URLs. Do not make the label lead into a dead-end Stream-only flow again.
- Streams owns collection/source/running status; Data Flows owns delivery paths; Connections groups low-frequency reusable Source/Receiver resources. Keep Governance #362 and Administration ownership stable.
- Correct unknown/loading/error/offline status and missing metrics/receiver confirmation. Do not use visual color to infer a status.
- Keep meaningful compact mobile navigation, 320/375 focus and keyboard operations. Do not repeat any previously platform-denied compact-sidebar mutation; only an explicitly authorized safe independent change is allowed.
- Global search/recent/favorites remain optional and ROI-gated.

## 7. Batch order and exact implementation entry points

| Sequence | Runnable packet | Source entry points (confirm actual code before edits) | Regression gate |
| --- | --- | --- | --- |
| PREP | Reconcile Owner Charter, Wizard, WBS and existing worktree | existing UX Charter / Wizard Charter / #354 / #413; source branch c64da365 plus 3 protected uncommitted Routes UI files | Source-of-Truth validator, diff check, clean documentation-only commit |
| P0-01 | Promote Routes visual graph/selected Route inspector to actual Data Flows operations page | frontend/src/components/routes/routes-overview-page.tsx, routes-architecture-workspace.tsx, routes-flow-helpers.ts, routes-flow-tree-table.tsx, api/operationalSnapshot.ts | RED→GREEN selected Stream/Route/unknown/duplicate tests + production frontend build |
| P0-02 | Contextual Connector/Destination create and return into Wizard | frontend/src/components/streams/new-stream-wizard-page.tsx, wizard/step-source.tsx, step-delivery.tsx, wizard-state.ts, wizard-step-gates.ts, existing connector/destination forms | first-run, repeat, cancel, draft return, permissions, multi-target + build |
| P0-03 | Sidebar and global CTA structure, precise shell status | frontend/src/config/app-navigation.tsx, nav-paths.ts, components/layout/sidebar.tsx, top-header.tsx, app-shell-layout.tsx, wizard/intent-template-picker.tsx | nav/role/breadcrumb, a11y, mobile, truthful unavailable/Healthy tests + build |
| P0-04 | Owner isolated preview and manual visual acceptance | existing loopback Vite preview 18997 is pinned to old c64da365 build | intentional rebuild/update, actual Chromium 1440/375/320 after auth; preserve unrelated preview 18996 |
| RELEASE GATE | Browser/Full User E2E same integrated exact HEAD | docs/BROWSER_FEATURE_SCENARIO_RECONCILIATION.md and docs/FULL_USER_E2E_SCENARIOS.md, read in full before the corresponding gate | 20 BFS/97 capabilities/control census, two-user Full User E2E, then HEAD freeze and qualification |

**Preserve existing in-flight code:** before PREP the #413 worktree contains modified frontend/src/components/routes/routes-overview-page.tsx, modified routes-overview-page.test.tsx and untracked routes-architecture-workspace.tsx. Treat them as valuable, **uncommitted** implementation in progress. Do not reset, overwrite, stash, rebase or claim these files are already deployed/CI-verified. The existing 18997 preview remains pinned to the old bundle unless separately rebuilt and browser-reviewed.

**Execution boundaries:** ChatGPT Chat is implementer, not Cursor. Use current AGENTS.md, .engineering/project.yaml and .engineering/tests.yaml. Read actionable PR review feedback before completion. Keep #414 Draft, no merge or production/release changes; no database migration or unauthorized data changes. A previous #410 isolated test DB cleanup was explicitly blocked by platform safety—do not reattempt/reroute/bypass it. Use only independent nonblocked work.

## 8. Owner decision vs details to verify in code

**Approved design:** Data Flows operational topology, per-Route inspector, Collections/Streams vs Connections separation, New Data Flow unified onboarding, preservation of existing canonical Route runtime/RBAC and URLs.

**Implementation-time checks (not assumptions):** existing Connector and Destination form return-state contracts, destination capacity fields/metric time windows, Route receiver confirmation semantics, exact origin of offline and Healthy status, graph scale and virtualized accessible fallback. Where source evidence is absent display Unknown instead of creating new metrics or claiming success.

**Explicitly deferred:** drag-to-mutate running Routes, additional runtime/engine, Marketplace M29, AI Gateway, enterprise IAM, unaudited production change, command palette/recents/favorites without ROI proof. No release until authenticated Browser reconciliation and same-HEAD Full User E2E satisfy current contracts.
