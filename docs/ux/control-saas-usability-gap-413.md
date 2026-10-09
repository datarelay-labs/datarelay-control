# Control SaaS Usability Gap — Dashboard, Navigation, Stream Wizard

Status: Initial implemented design, pending authenticated browser comparison and owner User E2E
Work Packet: [#413](https://github.com/datarelay-labs/datarelay-control/issues/413)
Parent roadmap: [#354](https://github.com/datarelay-labs/datarelay-control/issues/354)
Baseline: `main-v2` at `b45ad9d37079a822ede0349fe0f1b00f01b38ce5`
Implementation branch: `feat/control-saas-usability-convergence`
Scope: frontend presentation and navigation only. No backend, data model, credential, runtime, or authorization changes.

## Authority and evidence

The current Product Charter, UX Charter, Stream Wizard Charter, and source-of-truth index govern this change. DataRelay remains a Data Delivery Gateway with optional Data Protection. Preserve:

- One Stream → Many Routes → Many Destinations.
- Connect → Sample & Record Selection → Destinations → Route Processing → Deploy.
- Runtime Is Truth: never create invented health, capacity, or delivery evidence.
- Existing task-oriented UX phases A–G already merged under #354. This iteration is a visible usability convergence, not a replacement of existing features or processing preview.
- Issue #362 remains unresolved: the Governance primary-navigation group and its child destinations are retained unchanged.

Evidence tiers used here:

1. **Product code inspected:** actual components on `b45ad9d`, before the implementation branch changes.
2. **Official vendor documentation:** explicitly cited product patterns below; these are documentation-level observations, not a live competitor tenant feature census.
3. **Implementation evidence:** a separate worktree's source edits, focused tests, build, and lint.
4. **NOT VERIFIED:** authenticated before/after Chromium screenshots, actual 320px/375px product-browser usability, and Full User E2E. The separate #410 browser audit lock remains exclusive.

## Competitor-pattern verification (official product documentation)

| Product | Documented UX pattern | Relevant Control use (not a code copy) |
| --- | --- | --- |
| [Cribl Stream Tour](https://docs.cribl.io/stream/tour/) | QuickConnect visually links sources to destinations; Data Routing exposes advanced branching | Teach the end-to-end flow at first entry without hiding route-specific expert controls |
| [Datadog Observability Pipelines Templates](https://docs.datadoghq.com/observability_pipelines/configuration/explore_templates/) | Choose a use-case template as the starting point for a pipeline | Make supported Stream intents easy to scan; templates continue to seed the existing wizard only |
| [Splunk Edge Processor](https://help.splunk.com/en/data-management/process-data-at-the-edge/use-edge-processors-for-splunk-cloud-platform/route-data-using-pipelines/process-a-subset-of-data-using-an-edge-processor) | Branch data by path and inspect a preview from the pipeline builder | Preserve existing route preview; improve setup orientation without changing execution semantics |
| [Confluent Stream Lineage](https://docs.confluent.io/cloud/current/stream-governance/stream-lineage.html) | Graph connects producers, transformations, and consumers with contextual metrics | Reuse the existing Stream Flow Map; do not duplicate pipeline truth on the Dashboard |
| [Elastic Kibana Interface](https://www.elastic.co/docs/explore-analyze/find-and-organize/kibana-interface) | Stable navigation, global context, page actions, and contextual flyouts | Keep current shell and contextual help; emphasize primary tasks and the active location |
| [Mezmo Demo Pipeline](https://docs.mezmo.com/telemetry-pipelines/demo-pipeline-guide) | A working guided example presents Sources, Processors, Destinations | Surface practical onboarding instructions; preserve the already-merged optional demo/sample path |

The table supports UI patterns, not competitor parity claims or a conclusion that each vendor currently implements every roadmap feature. Official Cribl and Datadog pages were cross-checked again on 2026-10-09: Cribl separately presents drag-and-drop QuickConnect and condition-based Routes; Datadog's current setup documentation starts with use-case templates and explicitly guides source → destination → processor simulation. These approaches are references only; DataRelay continues to use its approved five-step Destination First Wizard, not the competitors' product model.

## Baseline vs implemented UX gap

| Surface | Actual baseline (source inspection) | Implemented treatment | First-time/operational benefit | Priority / risk |
| --- | --- | --- | --- | --- |
| **Dashboard, populated** | `dashboard-overview.tsx`: small Action needed card containing seven possible issue categories as inline tiles; main action to investigate is one of several links | Bigger operational hero, issue-aware recommended action linking to the first **actual** snapshot-supported issue; adjacent New Stream entry. Existing health, traffic, and operational issues preserved | Reduces choice paralysis: one obvious next diagnostic click instead of interpreting a wall of tiles | P0 / low (presentation and existing links) |
| **Dashboard, no Streams** | One heading, explanatory sentence, Create First Stream button | Guided three-stage Connect / Route / Verify cards, more prominent First Stream action | Explains what a Stream does before the user configures one | P0 / low |
| **Sidebar** | `sidebar.tsx`: Dashboard, Data Sources, Delivery, Governance, Administration; group captions and subdued current-page highlight; creation available through Streams page | Larger accessible active-leaf treatment, explicit Create stream at top for Administrator/Operator/Connector Operator, mobile drawer closes on action | Newcomers can initiate the main workflow without knowing the Streams information architecture | P0 / low; no change to Governance grouping |
| **Wizard intent entry** | `intent-template-picker.tsx`: six equally weighted text-heavy cards, including Start from scratch | Use-case icon cards with clear descriptions, seed lists, explicit action; unmodified expert scratch path in a separate secondary panel | Novice intent selection first, experienced users keep a single-click blank path | P0 / low |
| **Wizard progress** | `wizard-stepper.tsx`: five tiles squeezed into a 2-column mobile grid, labels may truncate | Current-step text, accessible progressbar and swipeable mobile rail; 5-column desktop layout with retained validation gates | Operator can see overall progress and long step names at narrow widths | P0 / low |
| **Governance IA** | Top-level group with Dashboard and Workspace | **Unchanged** | Avoids silently deciding the current normative conflict #362 | Blocked on product decision |
| **Advanced route previews** | Existing Processing Preview Dock, Flow Map, intent/template features merged A–G under #354 | **Kept**, no duplicate implementation | Preserves prior expert functionality and avoids parallel semantics | Existing / not duplicated |

These are verified *source* before/after comparisons. They are not labeled photographic or authenticated-browser comparisons.

## Three screen specifications

### Screen 1 — Dashboard (highest priority)

**Desktop, populated**

```text
 Dashboard                                         Data mode  Refresh
 ┌─ Live operations / Action needed ────────────────────────────┐
 │  Snapshot-backed open signals: streams, routes, destinations │
 │  Recommended next step: review first real current issue     │
 │                            [Review issue] [New Stream]      │
 └─────────────────────────────────────────────────────────────┘
 ┌─ Overall Health ─────────────────────────────────────────────┐
 └─────────────────────────────────────────────────────────────┘
 ┌─ Traffic Overview ───────┐ ┌─ Operational Issues ──────────┐
 └──────────────────────────┘ └───────────────────────────────┘
 Streams / Delivery health / Destinations / Logs / Governance
```

**Fresh install:** replace populated panels with Welcome → three setup steps → Create First Stream. This states a *workflow*, not a claim that data has already been delivered. When available operational signals are partial, use the existing partial-data warning rather than say the environment is healthy.

**320px/375px target:** hero text and two buttons stack or wrap; no side scrolling from the hero; keyboard focus reaches Review issue then New Stream. To be measured in an isolated authenticated Chromium test after #410 releases the browser lock.

### Screen 2 — Primary Navigation

```text
 DataRelay                 [Collapse]
 [ + Create stream ]       (only for eligible write roles)
 Dashboard                 (highlight active route)
 DATA SOURCES
    Connectors
    Streams
 DELIVERY
    Destinations
    Routes
 GOVERNANCE                (position intentionally unchanged)
    Dashboard
    Governance Workspace
 Administration
 ---- Environment ----
 [Username] [Role] [Sign out]
```

**320px/375px target:** existing off-canvas mobile drawer; 44px minimum Create stream tap target; click calls existing `onNavigate` and closes drawer; collapsed sidebar keeps an accessible action name. Preserve full route list, task-group semantics, and #362 decision boundary. No new navigation package or global palette.

### Screen 3 — Stream Wizard entry and in-progress flow

```text
 Create a data flow
 What would you like to deliver?
 [ API logs → SIEM ] [ Database collection ]
 [ Multi-destination ] [ Archive raw data ]
 [ Protect sensitive data ]
 Already know your setup?             [Start from scratch]

 Step 1 of 5 — Connect
 ━━━────────────────────
 [Connect] → [Sample] → [Destinations] → [Route Processing] → [Deploy]
       (mobile: horizontal swipe, active step remains in view)
 [Source setup and validation]                     [Next: Sample]
```

Templates remain existing `applyWizardIntentTemplate` state setters; they do not grant privileges, skip required sampling, silently create credentials, or change Route Processing order. Route Processing previews and confirmation gates are unchanged.

## Minimal design gate

- **Goal:** first-run users can identify their next action in Dashboard, find the Stream creation path immediately, and understand the five Wizard stages at mobile widths.
- **Non-goals:** dashboard product rewrite; new NOC metrics; new runtime endpoints; new permissions; global palette; moving Governance; changing the Wizard's persistence, routing, or preview semantics.
- **Public surface:** UI visual/interaction hierarchy on existing routes; existing URLs and component testIDs maintained.
- **State/migration:** none. Templates still use existing local draft/normal Stream state; runtime uses existing operational snapshot.
- **Security/operations:** create shortcut visibility is limited by existing session role, but server API continues to be the authorization authority. This does **not** grant access. No production/environment change.
- **Architecture:** existing React components, Tailwind utility classes, `react-router-dom` links; no new package, second runtime, or backend contract.
- **Acceptance:** focused Dashboard/Sidebar/Wizard component tests; TypeScript/Vite production build; lint; documentation integrity; before/after 1440/375/320 authenticated browser comparisons *pending owner-visible gate*; exact-HEAD Browser BFS and Full User E2E not complete.

## Verification and remaining checkpoints

- [x] Independent worktree and branch based on `main-v2` `b45ad9d`.
- [x] Initial affected Dashboard/Sidebar/Wizard tests: 42/42 PASS (4 test files).
- [x] CI race remediation: Route Processing preserves the operator-selected Data Protection tab during late effective-status hydration; a deterministic deferred-response regression test covers this.
- [x] Affected UI + Route Processing tests after remediation: 49/49 PASS (5 test files).
- [x] `npm run build`: PASS.
- [x] `npm run lint`: PASS with 74 preexisting warnings and zero errors.
- [x] Documentation Source-of-Truth integrity test: PASS (9 current documents / 89 specs).
- [x] Initial source revision full frontend suite (7b73c0d): 1,740/1,740 PASS locally across 298 test files.
- [ ] Updated source revision complete CI test/build after the route-status race fix: check exact new HEAD; do not treat the previous full suite as new-HEAD evidence.
- [ ] Authenticated 1440/375/320 Chromium before/after comparison on exact UX branch HEAD: **NOT VERIFIED** (#410 exclusive browser audit lock).
- [ ] Browser Feature Scenario Reconciliation: **NOT PASS**.
- [ ] Full User E2E and owner acceptance: **NOT PASS**.
- [ ] Review and CI on the isolated UX PR.
- [ ] Owner decision #362 on Governance placement (independent product question).

Protect #410's Chromium test run, locked ports/session/DB, #411/PR #412 and PF-5B preview; do not merge or release before owner approval and user-E2E gates.
