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
- Issue #362 was resolved by explicit owner approval on 2026-10-09: Option A keeps Governance as an operational primary group with Governance Dashboard as its normal entry. Workspace is contextual/advanced and remains routable by authorized deep links; Browser BFS and User E2E acceptance remain pending.

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
| **Dashboard, unavailable snapshot** | Empty fallback bundle could incorrectly appear as a first installation with zero Streams | Separate operational-unavailable state; never infer zero Stream count or a healthy condition; explicit Retry status | Prevents API failure from being presented as a successful blank install | P0 / low |
| **Sidebar** | `sidebar.tsx`: Dashboard, Data Sources, Delivery, Governance, Administration; group captions and subdued current-page highlight; creation available through Streams page | Larger accessible active-leaf treatment, explicit Create stream at top for Administrator/Operator/Connector Operator, mobile drawer closes on action | Newcomers can initiate the main workflow without knowing the Streams information architecture | P0 / low; no change to Governance grouping |
| **Wizard intent entry** | `intent-template-picker.tsx`: six equally weighted text-heavy cards, including Start from scratch | Use-case icon cards with clear descriptions, seed lists, explicit action; unmodified expert scratch path in a separate secondary panel | Novice intent selection first, experienced users keep a single-click blank path | P0 / low |
| **Wizard progress** | `wizard-stepper.tsx`: five tiles squeezed into a 2-column mobile grid, labels may truncate | Current-step text, accessible progressbar and swipeable mobile rail; 5-column desktop layout with retained validation gates | Operator can see overall progress and long step names at narrow widths | P0 / low |
| **Governance IA** | Top-level group with Dashboard and equally prominent Workspace | **Owner-approved Option A:** Governance group retained; Governance Dashboard is the single primary leaf, advanced read-only Workspace accessed via secondary contextual link; deep links and operational investigations preserved | Clear operational starting point without hiding advanced Stream/Route evidence | #362 decision approved; browser acceptance pending |
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

**Fresh install:** replace populated panels with Welcome → three setup steps → Create First Stream only when an authoritative operational snapshot says there are zero Streams. If the snapshot is unavailable, show an explicit unverified-status state with Retry rather than an empty-install or healthy-state claim. When operational signals are partial, preserve the existing partial-data warning.

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
- [x] Affected UI + Route Processing tests after Route tab remediation: 49/49 PASS (5 test files).
- [x] Dashboard unavailable-snapshot presentation now fails closed and offers Retry rather than fabricating an empty installation; affected test exercises recovery.
- [x] `npm run build`: PASS.
- [x] `npm run lint`: PASS with 74 preexisting warnings and zero errors.
- [x] Documentation Source-of-Truth integrity test: PASS (9 current documents / 89 specs).
- [x] Initial source revision full frontend suite (7b73c0d): 1,740/1,740 PASS locally across 298 test files.
- [x] Previous exact-HEAD `29a7b910` GitHub Actions 5/5 PASS, before the Option A menu change. The final Option A revision requires separate exact-HEAD CI.
- [ ] Authenticated 1440/375/320 Chromium before/after comparison on exact UX branch HEAD: **NOT VERIFIED** (#410 exclusive browser audit lock).
- [ ] Browser Feature Scenario Reconciliation: **NOT PASS**.
- [ ] Full User E2E and owner acceptance: **NOT PASS**.
- [ ] Review and CI on the isolated UX PR.
- [x] Owner decision #362 on Governance placement: Option A approved 2026-10-09; implementation in Draft PR #414, actual browser acceptance still pending.

Protect #410's Chromium test run, locked ports/session/DB, #411/PR #412 and PF-5B preview; do not merge or release before owner approval and user-E2E gates.

## 2026-10-09 follow-up — explain the complete flow while configuring

**Research used (official documentation, not competitor live tenant parity):**

- [Datadog Set Up Pipelines](https://docs.datadoghq.com/observability_pipelines/configuration/set_up_pipelines/) and [Explore Templates](https://docs.datadoghq.com/observability_pipelines/configuration/explore_templates/): start with the operator's use case, then source/destination configuration and processor simulation.
- [Cribl Routes](https://docs.cribl.io/stream/routes/): make the relationship between a source, processing, and multiple delivery paths explicit; quick configuration and detailed routes serve different needs.
- [Mezmo Demo Pipeline](https://docs.mezmo.com/telemetry-pipelines/demo-pipeline-guide): show a realistic source-to-processing-to-destination narrative with examples before asking users to understand low-level settings.

**Accepted Control design / scope:** Show the five user-oriented setup actions *before* a template is selected, then retain an always-visible, read-only Source → Per-route Processing → Destinations outline alongside the existing five-step configuration controls. Show one short, stage-specific next action. The outline is **configuration evidence, never live delivery evidence**. It may display a selected connector name, route-enabled counts, and inherit/override counts but MUST NOT expose credentials or sample event contents. Destinations are still **selected before route-specific processing is configured**, even though the data-plane outline orders processing before delivery.

**Implementation:**
- `frontend/src/components/streams/wizard/intent-template-picker.tsx`: compact 5-action onboarding path; no new wizard step or forced selection.
- `frontend/src/components/streams/wizard/wizard-flow-overview.tsx`: source selection (not connection success), processing inheritance/customization, and configured/enabled delivery paths, updated from the existing wizard state. A selected-but-unmaterialized Connector Module is explicitly a draft.
- `frontend/src/components/streams/wizard/wizard-stepper.tsx`: shared read-only explanation for both New Stream and Stream Edit, with operator-oriented current-step instructions. Use "available" rather than incorrectly implying only completed steps are navigable.
- `frontend/src/components/streams/wizard/step-route-processing.tsx`: explain the default shared path and the exact exception action (select a Route and turn off Inherit) without hiding existing expert controls or changing processing behavior.
- Tests verify default/unconfigured vs configured/disabled/customized routes, no credential/sample payload disclosure, and current five-step UX and expert path remain unchanged.

**Boundaries:** No API, schema, runtime, auth, persistence, policy, sample-selection, checkpoint, route ordering, Step gate, actual Stream enablement, or delivery-proving changes. This is a visual orientation layer above existing canonical state. The pre-existing `#410` live browser reconciliation lab is exclusive; 1440/375/320 authenticated browser comparison and Full User E2E remain **NOT VERIFIED**, regardless of unit test/build/CI outcomes.

## 2026-10-09 continuation — destination prerequisite and recovery

**Observed usability gap:** The Stream Wizard already saved the current draft before following `Go to Destinations` when the destination catalog was empty. But in a populated catalog, `Create new destination` skipped that same pre-navigation save callback, risking lost unsaved Stream setup when adding another destination. This is a user-journey gap, not a backend or authorization change.

**Implemented fix:** In `frontend/src/components/streams/wizard/step-delivery.tsx`, both destination-creation links now invoke the existing `onOpenDestinationPrerequisite` save callback when provided; navigation is canceled if saving fails. For the New Stream flow, contextual text explains that users return to Create Stream and choose **Resume draft**. When the destination API fails to load, an in-place **Retry loading destinations** button uses the established forced-refresh path rather than requiring users to find a separate top-bar control. The existing draft/routes are not cleared on API failures.

**Regression evidence:** New failing-before/fixed-after tests cover populated-library navigation, failed draft save navigation blocking, and failed-catalog recovery without loss of configured delivery paths. The prior empty-catalog draft-save test remains in `new-stream-wizard-page.test.tsx`. Existing Stream Edit behavior is not silently changed; in-context draft-resume guidance appears only when the New Stream prerequisite save callback exists.

**Additional empty-state recovery:** The destination library previously rendered a blank list when a search/category filter matched nothing, or when every configured destination was disabled. It now presents distinct messages: **No destinations match this search or filter** with **Clear destination filters**, or **No enabled destinations are available** with **Manage destinations** (using the same guarded pre-navigation draft-save callback when provided). Search/filter reset is local UI state only; it does not change Route drafts or enable a destination. Component regressions cover both states.

## 2026-10-09 continuation — Stream Edit destination navigation safety

**Observed source-level risk:** The existing Stream Edit page debounces autosave by 1.2 seconds and attempts an asynchronous last-chance save on unmount. Unlike New Stream, its `StepDelivery` destination-management links had no pre-navigation guard. A user could leave while edits were unconfirmed, saving, or already known to have failed. An unmount save attempt is not proof of a persisted change; this was observed in code and component tests, not yet confirmed in an authenticated browser.

**Minimal UI decision:** Reuse the page's existing confirmed-snapshot and save-failure logic. For mutating users, the explicit **Destination management**, **Back to monitoring**, and Review **Open monitoring** exits are blocked until save is confirmed. An accessible page-level message distinguishes unsaved, in-flight, and failed saves: wait for completion or choose **Save now**, then retry. Read-only inspectors retain navigation without any save requests. This does not introduce a second autosave/persistence flow, API endpoint, storage format, or elevated permission. Sidebar/browser Back and other outside-page navigation are not covered by this bounded change; examine those separately.

**User guidance distinction:** `StepDelivery` exposes the Create Stream → Resume draft message **only** when the New Stream page explicitly opts in. Stream Edit uses the same navigation callback for safe departure, but never tells an editor to return via a new Stream draft. The New Stream copy explains that leaving **will trigger draft save**, rather than implying a draft was already persisted.

**Evidence:** `stream-edit-rbac.test.tsx` covers operator unsaved/in-flight/failed-save guards, confirmed-save navigation, read-only navigation, and both explicit monitoring exits. `step-delivery.test.tsx` plus New Stream tests verify the distinct draft-resume guidance. Regressions intentionally failed before the missing guards were implemented. Focused unit/integration tests and build are required but are **not** Browser BFS or 2-user E2E evidence. Preserve the #410 exclusive lab and do not promote CI to browser PASS.

## 2026-10-09 continuation — make destination checks understandable

**Verified usability defect:** `StepDelivery` already exposed **Test destination** in each selected Route card's overflow menu, but its handler discarded the destination-test API result and swallowed request errors. The user could not tell success, actual endpoint rejection, or inability to call the API apart.

**Bounded UI correction:** Read the existing `DestinationTestResult.success` and `message` from `POST /destinations/{id}/test`. The selected card now shows an accessible per-destination **Checking destination connectivity…** state, then **Connection check passed**, **Connection check failed** with backend-confirmed reason and an Open destination next action, or **Connection check unavailable** with safe authentication/API retry guidance. On a new attempt, clear the previous status so a stale success never remains visible. Exceptions are not echoed because they could contain credentials or internal network details. The overflow menu receives an accessible `Actions for <destination>` name. Duplicate Route cards referencing a destination may show the same endpoint test result; the result is not Route delivery evidence.

**Safe detail navigation:** The selected Route card's **Open destination** link previously bypassed the pre-navigation draft preservation used by **Create new destination** and **Manage destinations**. Its click now invokes the same existing `onOpenDestinationPrerequisite` callback and prevents navigation if saving is refused or the editor has unconfirmed edits. A red/green test covers both blocked and authorized navigation from the card. This does not silently introduce draft saving to the edit/persistence engine.

**Truth boundary:** A destination connectivity check is not proof of a running Stream, per-Route processing, persisted delivery, receiver acknowledgment, or checkpoint success. It never shows **Delivery proven**. No Stream/Route draft mutation, deployment, API contract, credential change, or remote test environment mutation occurs. Existing Destinations management remains the owner of full connectivity history/details.

**Validation:** Red/green component tests cover positive, negative, exception, and an in-flight retry that replaces a former success with a newer failure; regression/TypeScript build and document integrity required. The menu also disables another destination's **Test destination** while one connectivity request is active, rather than accepting and silently ignoring the second click; a dedicated red/green test verifies it becomes available when the first request completes. Authenticated Browser BFS and two-user Full User E2E remain separate, incomplete release gates; protect #410's exclusive browser lab.

## 2026-10-09 continuation — position is not completion

**Observed UX problem:** The five-step Wizard displayed `Step 5 of 5` and a **100% filled "Stream setup progress" bar** solely because the operator navigated to Review/Deploy. That represented navigation position, not configuration readiness; in Stream Edit, an operator can open Review without actually saving configuration. This risks the same misleading, NOC-like status that the SaaS usability work intends to avoid.

**User-first correction:** Keep **Step N of 5** for position. The single compact completion bar now counts only sections that the existing `computeStepCompletion` signal marks `complete`, with an explicit "N of 5 setup stages marked complete" label and accessible progressbar value. No new gate, invented readiness result, or live delivery proof. The existing Deploy Decision Center remains the authority for current readiness, persistence and actual delivery.

**Actionable next step:** New Stream operators see one plain-language instruction beneath the five-stage rail while Destinations or Deploy is gated. When no source is chosen: select a source and test it; when a source exists but sample confirmation is missing: the existing source-type-aware sample gate reason; once sample is confirmed but no delivery path is enabled: enable a delivery path. This uses canonical `wizardSampleStepGateReady`, `wizardDestinationGateReady` and their existing blocker reasons; **does not relax navigation gates**. Read-only/Edit mode has unrestricted stages and does not get a misleading locked-step instruction.

**Evidence:** Dedicated `wizard-stepper.test.tsx` red/green regressions cover Review open while zero stages are complete, partial progress, actionable source/sample/Route requirements, and Edit mode nonblocking navigation. Existing Stream Wizard modernization checks updated to distinguish location from completion. Real browser comparison and two-user E2E still pending under #410's exclusive test boundary.

**Protected boundaries:** no route/destination persistence semantics, API, credentials, runtime, policy, user rights, shared DB, or #410 browser process modified. Final authenticated UX/BFS and 2-user Full User E2E remain NOT VERIFIED.

## 2026-10-09 owner-approved Governance navigation — Option A (#362)

**Explicit owner decision:** Governance remains one primary **operations** group. The current Governance UX Charter is an approved domain exception to the general top-level navigation anti-pattern. This is recorded in GitHub #362 and in the authority index without rewriting either historical Source-of-Truth document.

**UI implementation on #413 / Draft PR #414:**

- Navigation configuration keeps `Governance` in the existing group structure with a single named `Governance Dashboard` destination. `Governance Workspace` is no longer an equally weighted primary leaf.
- Governance Dashboard retains posture, prioritized investigation, violations, quarantine, approvals, audit and replay links; its **secondary evidence** area adds an **Advanced** read-only Stream/Route governance context link.
- The existing `/governance/workspace` page and `?stream_id=...&route_id=...` context contract remain intact; its header offers **Back to Governance Dashboard**.
- Policy creation/editing does not move to the Dashboard. Stream/Route/Wizard ownership, existing RBAC, backend/runtime/persistence, and mobile sidebar component behavior are unchanged.

**Verification scope:** nav structure, roles, deep-link routing, Governance Dashboard/Workspace, app shell, documentation integrity, affected ESLint and production build. CI and code tests do **not** establish real browser acceptance: #410 holds its own authorized browser lab at older `b45ad9d`; actual latest-HEAD desktop/mobile 1440/375/320, full Browser BFS and two-user Full User E2E are not passed. No merge/freeze/prod deploy/release.

## 2026-10-09 competitor UX adoption reconciliation — P0 user priority

**Owner priority:** Complete the still-incomplete competitor-inspired UI usability work before non-UX roadmap polish. `#354` A–G merged source history is not owner-visible browser acceptance; this `#413` branch remains draft. The table distinguishes implemented UI code from verified user behavior rather than reporting every recommendation as completed.

| Research precedent / product outcome | Current code observation | Disposition |
| --- | --- | --- |
| Cribl: Source → multi-Route → Destinations explanation, usable input/output inspection | StreamFlowMap and Wizard flow overview exist; Route Edit uses a real no-send sample preview; Wizard stage overview previously repeated null comparisons | **PARTIAL** — make stage selection useful and truthful; full browser flow verification outstanding |
| Datadog: choose a use case before blank setup | IntentTemplatePicker seeds the existing 5-step Wizard; Start from scratch retained | **IMPLEMENTED IN CODE** — browser acceptance outstanding |
| Splunk Edge Processor: preview up to the selected processing action | WizardMappingOutputAside runs an existing final-event draft-preview API; stage overview often has no verified per-stage output | **PARTIAL** — never fabricate intermediate results; final stage-by-stage runtime-backed preview is pending |
| Confluent: investigate Action needed in context, not generic NOC counters | Dashboard Action needed existed, but count-only cards sent users to generic lists | **IMPROVED HERE** — snapshot-derived prioritized Stream/Route/Destination drill-down with exact resource links; browser acceptance pending |
| Elastic/Kibana: stable app shell and contextual help with deep documentation links | Shared help drawer now opens five actual in-app workflow guide routes via contextual deep links and a global Header Help Center action | **IMPLEMENTED IN PR #414 CODE**, browser/keyboard acceptance pending; optional external public docs URL not invented |
| Mezmo: working demo/sample learning flow | Isolated demo/sample path was merged previously (#380/#381) | **IMPLEMENTED IN CODE** — real browser operator acceptance outstanding |
| Confluent: recent resources / favorites; global command search | Not shipped; `#354` explicitly ROI-gated due lack of usage evidence | **DEFERRED**, not falsely complete; reconsider only if measured navigation evidence supports it |

### P0 UX changes in this worktree

1. **Dashboard: resource-first investigation.** Existing Runtime Snapshot only (no new API) drives a bounded, sorted list of unhealthy enabled Stream/Route/Destination resources, critical first, with actual IDs, names, and direct existing UI links. The primary **Review issue** CTA targets the exact highest-priority item instead of always pointing to the Streams catalog. Category-wide counters remain available as secondary diagnosis. Unknown/IDLE, disabled, or invalid-ID resources do not create guessed deep links. Backend error-message contents are not echoed as cards.
2. **Processing Preview Dock: staged, operator-selected inspection.** Replace five permanently exposed empty before/after panes with a focused 5-stage visual sequence and one inspection panel. Show actual supplied before/after evidence only, explicit missing-output guidance when evidence is unavailable, and clearly differentiated Preview/Saved/Runtime claim types. Existing Wizard and Route Edit no-send/runtime preview APIs remain authoritative; selecting a stage never sends events or persists configuration.

**RED→GREEN tests:** New Dashboard browser-component test initially failed because no exact-resource priority list existed; new Preview Dock tests initially failed because no active-stage state or focused comparison existed. Both pass after bounded presentation changes. Pure unit regression verifies critical sorting, only valid entity links, no raw error-message leaks, limits, and disabled/idle handling.

**No product runtime, database, authentication, Route execution, checkpoint, permissions, release, production service, or #410 audit lab changes.** These are visible UX code changes, **not** an authenticated browser BFS / Full User E2E PASS.

### Still-required user-visible acceptance

- Fully verify the latest branch at 1440/375/320 with an owner-authenticated real Chromium UI, navigation/read-back and task-first usability (not a component/jsdom substitute). Do not bypass prior platform denial of #410 disposable test DB cleanup.
- Verify complete Stream Wizard Source → Sample → Destinations → Route Processing → Deploy → first actual delivery with the current contract and same final HEAD.
- Validate the real in-app `/help/*` guide routes and contextual navigation in an authenticated browser. External published documentation links remain optional and must not be synthesized.
- Complete prescribed BFS-001..020 / capability-control census and two-user Full User E2E on final integrated HEAD. Keep PR Draft and release gates NOT PASS until the full contract is satisfied.
### P0 continuation: evidence-backed Mapping and Enrichment stages

**Previously missing:** the five-stage Route Processing UI did not populate verified Mapping or Enrichment output, even though its existing selected-Route Final Event workspace already called `POST /runtime/preview/final-event-draft`.

**Implemented:** the existing WizardMappingOutputAside passes its completed no-send API response upward with the selected Route draft key. The preview dock now displays the returned `mapped_events[0]` for Mapping and `final_events[0]` for Enrichment / Transform, retaining visible input/output comparisons. It clears stale previews on edits/failure, never displays another Route's results after selection changes, and adds **zero new API requests**. The Response contract has no Route Protection/Policy evaluation or formatted destination payload; these stages therefore display an explicit **not verified** state rather than invented output. The original detailed sample preview and refresh UI remain in place.

**Regression:** a newly added StepRouteProcessing rendered-component test initially failed because Mapping had no API output; it now passes and distinguishes available Mapping/Enrichment evidence from unavailable Route Policy proof. Focused Route Processing/Preview tests: **17/17 PASS**. This is component-level evidence, **not Browser BFS**, and all final user-test/release gates remain outstanding.

### P0 continuation — in-product contextual help and task guides (2026-10-09)

**Research pattern:** Elastic/Kibana contextual help needs a trustworthy follow-through, not an inert button or a guessed external documentation URL. The existing `PagePurposeHeader` help drawer was in use on Dashboard/Streams/Connectors/Destinations/Routes/Governance/Administration, but no production page supplied a `docsHref`.

**Implementation:** An in-product app-shell `/help` directory plus five real in-app guide routes (`/help/start`, `/help/operations`, `/help/delivery`, `/help/governance`, `/help/administration`). Each is a task-oriented step sequence with real existing product navigation (source/connector -> sample -> destinations -> Route Processing -> deploy -> runtime), evidence-versus-preview cautions, authorization boundaries, and no fake dynamic runtime claims. Guide content is adapted from the current `docs/ux/task-oriented-guided-operations.md`, Stream Wizard model, and repository Getting Started guide; historical screenshot placeholders and potentially outdated individual feature promises are not republished.

All seven existing primary page Help drawers now link to their relevant **in-product** guide, opened with `target="_blank"` and `rel="noopener noreferrer"` to preserve the current task/draft. A global **Help Center** link in the Top Header is available on all pages and opens a new tab, avoiding accidental loss of an unsaved draft. The app shell labels the help route correctly and suppresses its operational health badge, rather than showing the Dashboard title or a fabricated healthy-runtime claim. No new external domain, backend docs endpoint, auth permission, test DB, or production service.

**Boundaries:** This closes the **code-level** help destination gap only. The five guides are English, task-focused, and have deterministic component routing/interaction coverage; real 1440/375/320 browser accessibility, authenticated user UX acceptance, and two-user E2E remain NOT PASS. The repository's separate longer Getting Started markdown has historical screenshot placeholders and is not silently declared current or fully reconciled.


## 2026-10-10 — Remaining competitor-informed UX batches

This is a **reconciliation of the already approved product UX backlog**, not a new release or authorization. Competitor references remain UI patterns only: Cribl QuickConnect/Routing for a connected operations view, Confluent lineage for destination-specific evidence, Datadog templates for first-run setup, and Elastic contextual navigation. The existing Control Stream → per-Destination Route → Destination runtime architecture, Governance decision #362, and API permissions remain unchanged.

| Order | Delivery batch | Current status / bounded next acceptance |
| --- | --- | --- |
| **1. Data Flows operational workspace** | Read-only Stream → Route → Destination topology; selected Route evidence, attention-first inspection, progressive display of large flows, keyboard/mobile exploration, legacy expert table | **Code partial** on existing Draft PR #414. Topology/inspector previously implemented; this iteration adds snapshot-backed Error/Warning attention queue, direct Stream/Route selection by stable IDs, 12-path progressive disclosure, accessible selected-inspector control and unverified receiver language. Route overview title/time-window cleanup was previously platform-blocked and is **not** retried or considered accepted. Authenticated viewport review outstanding. |
| 2. New Data Flow onboarding | Templates, reusable Connector/Source/Destination discovery, contextual creation-and-return with preserved step/draft, multi-destination route overrides, permissions and no-send verification | Connector in-Wizard create is done; current Destination create/return edit was previously security-state-blocked; authenticated first-run/multi-destination acceptance pending. |
| 3. SaaS navigation and primary actions | Data Flows operational entry, Streams collection role, Connections (Connector + Destination), **New Data Flow** global CTA, Governance/Administration unchanged, deep link and role/mobile compatibility | **Gated** until 1 and 2 are navigable end-to-end; do not label an unfinished Stream-only Wizard as a completed new flow. |
| 4. Operator trust and browser release closure | No fabricated Healthy/Offline/capacity/receiver ingestion, recovery for catalog failures, 320/375/1440 usability, actual Browser Feature Scenario Reconciliation and same-HEAD two-user Full User E2E | Global header snapshot truth and catalog recovery code tested; authenticated UI gate and full BFS/FUE **NOT PASS**. No candidate freeze, PR merge or production release. |

### Batch 1 — independent accepted implementation slice (not full sign-off)

- Read-only **Delivery attention** groups only currently enabled Routes reported as Error/Warning by existing operational evidence, prioritizes Error, and labels stale/failed observations **Last reported**, not current live incidents. Disabled paths are counted separately. No missing-data/receiver confirmation is inferred as success.
- A single click on **Review highest priority** or a specific path selects the exact Stream and Route ID; identically named Streams remain distinguishable. Existing Route settings, Delivery logs and authorized Destination details links stay intact.
- Avoid rendering hundreds of graph cards by default: show 12 delivery paths initially, with explicit show-all/show-fewer and a path-independent selected Route inspector. Buttons remain native keyboard controls. Gateway-reported Route output is not mislabeled as verified downstream ingestion.
- No mutation of the previously platform-denied `routes-overview-page.tsx` view-title/metrics-window operation, no Destination-create changes, no #410 DB action. No API, database, runtime engine, credential, environment or security/permission change.
- Evidence required before marking the batch fully **Done**: current exact-HEAD affected tests/build/CI, authenticated 1440/375/320 visual and keyboard inspection, verified Route metrics/window provenance, previously blocked page-naming decision resolved via permitted path, and full product Browser/FUE acceptance. Component tests and CI alone cannot close the user test gates.
