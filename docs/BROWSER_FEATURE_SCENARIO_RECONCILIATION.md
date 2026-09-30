# Data Relay Control — Browser ↔ Feature ↔ Scenario Reconciliation

> **Document role:** Canonical executable browser test contract for product capability ↔ visible UI control ↔ real operator scenario reconciliation
> **Executor:** ChatGPT Chat
> **Scope:** Phase A-D browser surface completeness, buttons/actions, discoverability, terminology, procedure, persistence, runtime truth, safety, recovery, evidence, and cleanup
> **Target:** current Data Relay Control exact candidate until superseded
> **Release relationship:** independent from Full Matrix and the final Browser User Lifecycle; may compose their evidence but MUST NOT substitute either
> **Primary rule:** the user acts through the browser first; API/runtime/database are verification and forensic layers, never a substitute for a browser-required action

## 1. Exact execution trigger

The following user request is an **immediate execution command**, not a request for a plan:

~~~text
브라우저 상에서 버튼, 기능, 시나리오 연계테스트를 진행해
~~~

Equivalent requests include:

~~~text
브라우저 버튼 기능 시나리오 연계테스트 진행해
버튼, 기능, 시나리오 연계성 테스트 진행해
브라우저 기능 시나리오 전수 테스트
UI 버튼 기능 시나리오 reconciliation 진행해
Browser feature scenario reconciliation
Browser button feature scenario audit
~~~

When triggered, ChatGPT MUST resolve this file from the active Data Relay Control repository and execute it immediately.

Do not substitute a generic Playwright smoke test, Full Matrix, unit tests, static source review, prior evidence, or a plan-only response.

~~~text
AUDIT_PROFILE=BROWSER_FEATURE_SCENARIO_RECONCILIATION
FIRST_ACTION=EXECUTE
EXECUTOR=CHATGPT_CHAT
BROWSER_FIRST=YES
PUBLIC_UI_REQUIRED_FOR_USER_ACTIONS=YES
API_RUNTIME_DB_VERIFICATION_LAYER=YES
API_FALLBACK_CAN_CREATE_PASS=NO
BLACK_BOX_FIRST=YES
POST_HOC_SOURCE_ENUMERATION=YES
PRODUCT_SOURCE_EDITS_DURING_ACTIVE_AUDIT=NO
RETAIN_EVIDENCE=YES
UPDATE_ACTIVE_AI_WORK_ISSUE=YES
FULL_MATRIX_SUBSTITUTE=NO
FULL_USER_E2E_SUBSTITUTE=NO
PHASE_E_F_EXCLUDED=YES
~~~

## 2. What this test proves

Full Matrix asks whether declared capability combinations execute.

Final Browser User Lifecycle asks whether a representative operator can complete the full end-to-end journey.

This reconciliation asks a different question:

**Does every supported Phase A-D product capability have one coherent, discoverable, safe browser surface and at least one complete operator scenario, with browser actions connected to persisted state and effective runtime truth?**

It MUST find defects such as:

- supported feature exists but no usable browser control exists;
- a button exists but no current product capability justifies it;
- two visible controls mutate the same thing with conflicting semantics;
- a button is visible but permanently disabled or has no actionable disabled reason;
- the user can create something but cannot inspect, test, edit, recover, or delete it;
- a browser action appears successful but persistence/read-back disagrees;
- persisted state exists but effective runtime ignores it;
- an API fallback silently converts a failed browser action into PASS;
- Dashboard/Logs/Governance drill-down cannot identify the affected Stream, Route, Destination, or Connector;
- confirmation or cancellation semantics do not match destructive impact;
- RBAC hides the wrong action or exposes an unauthorized one;
- reload/back/new browser context loses previously saved state;
- empty/error states provide no next action;
- current UI exposes Phase E/F or retired runtime concepts as Control features;
- cleanup leaves test resources or modifies pre-existing operator data.

## 3. Authority and conflict rule

Use the repository authority model in this order:

1. `docs/source-of-truth/PRODUCT-CHARTER-Version-1.2.1-FINAL.txt`.
2. current subordinate Source-of-Truth documents registered by `docs/architecture/source-of-truth-index.md`.
3. current task-relevant implementation specs under `specs/`.
4. `e2e/capabilities/data-relay-capabilities.yaml` for current observed Phase A-D capability inventory.
5. current browser UI and installed exact-candidate runtime behavior as observed implementation evidence.
6. active operational/release documentation.

Higher product authority defines intended behavior.
Runtime/code/tests prove observed behavior.
Observed implementation drift does not silently rewrite product intent.

Phase E AI Gateway and Phase F Enterprise Edition are outside this reconciliation except for negative exposure checks.

Mandatory product invariants:

~~~text
One Stream → Many Routes → Many Destinations
Route Processing is the only supported runtime
Destination First
Runtime Is Truth
Checkpoint advances only after required delivery success
No parallel legacy runtime resurrection
No Phase E/F promotion into Control
~~~

## 4. Onboarding — immediate and mandatory

On `dev-drcontrol`:

1. resolve repository `datarelay-labs/datarelay-control`;
2. read `AGENTS.md`;
3. read `.engineering/project.yaml`;
4. load exactly one matching active `[AI Work]` Work Packet for this audit;
5. determine the candidate branch, exact HEAD, and authorized worktree;
6. read this document from that exact repository state;
7. inspect `.engineering/tests.yaml` and `.engineering/release.yaml` only as needed;
8. record any concurrently running qualification/E2E processes;
9. choose an isolated browser-audit environment and disposable database;
10. start execution without asking the user to repeat repository, branch, or test intent already known.

If no audit Work Packet exists, create one before mutation.

If another qualification is running on the same candidate, do not modify or reuse its worktree, database, API/UI ports, PID directories, or evidence directory.

A browser audit is not product implementation. Do not patch product code during the active audit.

## 5. Candidate preflight

Record before browser mutation:

~~~text
RUN_ID=
START_UTC=
REPOSITORY=
BRANCH=
REPO_HEAD=
ORIGIN_MAIN_V2_HEAD=
WORKTREE=
WORKTREE_CLEAN=
ACTIVE_WORK_PACKET=
PR=
CANDIDATE_EXACT_HEAD=YES|NO
QUALIFICATION_CONCURRENT=YES|NO
AUDIT_DB=
API_BASE_URL=
UI_BASE_URL=
ARTIFACT_ROOT=
BROWSER_ENGINE=
RELEASE_SCOPE=PHASE_A_D
~~~

If installed/running content differs from `REPO_HEAD`, record both identities.

Different-SHA findings are useful diagnostics but MUST NOT be reported as exact-head PASS evidence.

## 6. Isolation and collision ownership gate

Before starting browser actions:

1. list active browser/E2E/qualification processes;
2. identify shared PostgreSQL, WireMock, MinIO, SFTP, webhook, syslog, and ports;
3. allocate unique API/UI ports and unique PID/log directories;
4. use a disposable `datarelay_rue2e_<run-id>` or equivalent test-only database;
5. use an audit-specific resource name prefix;
6. snapshot pre-existing resources if any shared state must be touched;
7. never stop another workstream's process;
8. never delete a resource only because its name looks temporary.

When another test owns required mutable shared state:

~~~text
RESULT=NOT_RUN_SHARED_STATE
OWNER=
RESOURCE=
SAFE_INDEPENDENT_CHECKS_CONTINUE=YES
~~~

Continue independent checks instead of blocking the whole audit.

### 6.1 Exact-candidate browser lab bring-up

Prefer the existing `e2e/user-lifecycle/` isolation model instead of inventing another lab.

For a fresh reconciliation run:

1. use the exact candidate source tree;
2. allocate a unique disposable database name;
3. allocate unique API/UI ports;
4. allocate unique PID/log directories;
5. reuse canonical external fixtures only after ownership/health verification;
6. build/serve the frontend from the exact candidate;
7. start API/scheduler processes bound to the disposable audit database;
8. start Chromium through the repository Playwright dependencies;
9. verify API `/health` and browser login before scenario execution;
10. write candidate/build identity into evidence before the first mutable user action.

Useful existing assets include:

~~~text
e2e/user-lifecycle/config/defaults.env
e2e/user-lifecycle/run-user-lifecycle-e2e.sh
e2e/user-lifecycle/pages/**
e2e/user-lifecycle/helpers/**
e2e/framework/**
scripts/testing/start-test-stack.sh
~~~

The reconciliation executor may extend page coverage during the run only through audit tooling/evidence code that does not change product behavior. Any product defect fix belongs to a later remediation Work Packet.

## 7. Evidence root

Create evidence outside the repository:

~~~text
/tmp/datarelay-control-browser-reconciliation/<RUN_ID>/
~~~

Recommended layout:

~~~text
run.env
candidate.txt
browser-actions.tsv
network-evidence.tsv
console-errors.json
screenshots/
ledger/
  capability-ledger.tsv
  page-ledger.tsv
  control-ledger.tsv
  feature-surface-scenario.tsv
  route-deeplink-ledger.tsv
  docs-ui-ledger.tsv
scenarios/BFS-*.txt
findings/P0-*.txt
findings/P1-*.txt
findings/P2-*.txt
findings/P3-*.txt
cleanup/
summary.txt
~~~

Evidence containing credentials, tokens, cookies, private keys, raw Authorization headers, backup contents, or secret connector configuration MUST be redacted before durable retention.

## 8. Build the capability inventory first

Do **not** start from buttons.

Start from current Phase A-D product authority and `e2e/capabilities/data-relay-capabilities.yaml`.

Inventory all applicable capabilities, including at minimum:

~~~text
Authentication and Connected Credential behavior
HTTP API source
PostgreSQL Database source
S3 Object source
Remote File source
Webhook Receiver source
Stream Wizard
Sample & Record Selection
Union Schema
Checkpoint / Incremental / Dedup
Destinations: Syslog UDP/TCP/TLS and Webhook
One Stream → Many Routes
Route delivery settings
Transform / Mapping / Enrichment
Protection
Classification
Policy
Schema Drift / Unknown Field handling
Deploy / Start / Stop / Run Once where exposed
Runtime health / metrics / delivery evidence
Dashboard / Logs / Operational drill-down
Partial-route failure isolation
Retry / timeout / failover
Quarantine
Replay
Violations / Audit / Notifications
Administration / local users / RBAC
Timezone / platform settings
Backup / restore / retention where exposed
Support / diagnostics where exposed
Delete lifecycle and dependency safety
~~~

For every capability create:

~~~text
CAPABILITY_ID=
FEATURE=
PRODUCT_AUTHORITY=
MANIFEST_STATUS=
IN_SCOPE=YES|NO
EXPECTED_PRIMARY_SURFACE=
EXPECTED_SECONDARY_SURFACE=
EXPECTED_LIFECYCLE=
EXPECTED_SCENARIO=
RUNTIME_TRUTH_REQUIRED=YES|NO
ACTUAL_DELIVERY_REQUIRED=YES|NO
~~~

Status handling:

- `SUPPORTED`: must have a complete justified public lifecycle unless explicitly API-only by product contract.
- `PARTIAL`: test the supported subset; do not promote to full support.
- `UI_ONLY`: browser behavior may PASS as UI behavior, but MUST NOT imply runtime support.
- `API_ONLY` / `RUNTIME_ONLY`: require explicit justification; visible UI absence may be a gap if the product promises operator use.
- `OUT_OF_SCOPE`: exclude from positive capability totals and test for accidental Control exposure.
- `NOT_IMPLEMENTED`: must not appear as a working Control feature.

## 9. Build the browser surface inventory independently

Before source inspection, enumerate what an operator can actually see and invoke.

Capture:

- primary sidebar entries and grouped navigation;
- page-level primary and secondary actions;
- buttons;
- links that behave as actions;
- switches/toggles;
- menus and overflow actions;
- tabs that expose actionable configuration;
- forms and Save/Apply/Test/Deploy actions;
- dialogs and confirmation controls;
- row actions;
- empty-state CTAs;
- error-state recovery actions;
- Dashboard problem links;
- Logs/Governance drill-down links;
- Administration actions.

Current primary Control navigation is expected to align with:

~~~text
Dashboard
Data Sources
  Connectors
  Streams
Delivery
  Destinations
  Routes
Governance
  Dashboard
  Governance Workspace
Administration
~~~

Do not treat source code route existence as proof of public discoverability.

## 10. Browser control ledger

Every visible actionable control gets a row:

~~~text
CONTROL_ID=
PAGE=
CONTROL_TYPE=BUTTON|LINK|SWITCH|MENU|TAB|FORM_ACTION|ROW_ACTION|EMPTY_STATE_CTA
VISIBLE_LABEL=
ACCESSIBLE_NAME=
ROLE=
DISCOVERED_BY=
VISIBLE_WHEN=
ENABLED_WHEN=
DISABLED_REASON=
PRODUCT_FEATURE=
CAPABILITY_ID=
ACTION=
EXPECTED_MUTATION=
EXPECTED_NAVIGATION=
EXPECTED_CONFIRMATION=
SUCCESS_FEEDBACK=
FAILURE_FEEDBACK=
SCENARIO_ID=
EVIDENCE=
~~~

A control with no current feature mapping is not ignored.

A capability with no usable public control is not ignored.

## 11. Black-box browser first, source enumeration second

### Phase A — public black-box capture

Preserve browser discovery before reading implementation details.

Use deterministic Playwright/browser interaction to record:

- visible navigation;
- accessible roles/names;
- buttons/links/switches;
- dialogs;
- success and failure feedback;
- navigation target;
- network request initiated by the browser;
- persisted read-back after reload;
- runtime result where applicable.

### Phase B — post-hoc source enumeration

Only after black-box capture, inspect source to find:

- routed pages not publicly discoverable;
- buttons hidden behind conditions;
- role-gated controls;
- duplicate action components;
- stale links or redirects;
- hidden/legacy runtime pages;
- exposed Phase E/F routes;
- API endpoints with no intended browser owner;
- buttons whose handler is no-op or UI-only;
- browser controls absent from the initial public census.

Source inspection is reconciliation evidence only.
It MUST NOT convert a failed browser scenario into PASS.

## 12. Feature ↔ Surface ↔ Scenario ledger

For every in-scope capability reconcile all dimensions.

| Capability | Product authority | Browser surface | Browser control | Persist/read-back | Runtime truth | Real scenario | Result |
|---|---|---|---|---|---|---|---|
| Per-route Protection | Route/Governance authority | Route Edit / Wizard Route Processing | Protection actions | route-scoped read-back | effective route policy | configure → deploy → deliver → inspect | PASS/FAIL |

Allowed dispositions:

~~~text
FEATURE_WITH_BROWSER_SURFACE
FEATURE_API_ONLY_JUSTIFIED
FEATURE_NO_BROWSER_GAP
FEATURE_RUNTIME_ONLY_GAP
BROWSER_CONTROL_WITHOUT_FEATURE
BROWSER_CONTROL_DUPLICATE_PATH
DISCOVERY_GAP
SCENARIO_BLOCKED
SCENARIO_DEAD_END
TERMINOLOGY_DRIFT
PROCEDURE_DRIFT
STRUCTURE_DRIFT
STATE_SEMANTICS_DRIFT
PERSISTENCE_DRIFT
EFFECTIVE_RUNTIME_DRIFT
CONFIRMATION_DRIFT
ERROR_FEEDBACK_DRIFT
RBAC_VISIBILITY_DRIFT
EMPTY_STATE_SILENCE
NEXT_ACTION_STALE
DEEP_LINK_CONTEXT_LOSS
RELOAD_PERSISTENCE_DRIFT
DOC_UI_RUNTIME_MISMATCH
OUT_OF_SCOPE_SURFACE_EXPOSURE
CLEANUP_RESIDUE
~~~

No in-scope capability row and no visible actionable control may be left without a disposition.

## 13. Canonical operator lifecycle

For each major capability, test the applicable parts of this lifecycle:

~~~text
DISCOVER
→ OPEN
→ CREATE / CONFIGURE
→ TEST / PREVIEW
→ SAVE / APPLY
→ READ-BACK
→ RELOAD / NEW CONTEXT
→ DEPLOY / START
→ VERIFY EFFECTIVE RUNTIME
→ VERIFY ACTUAL DELIVERY where applicable
→ MONITOR
→ INJECT OR OBSERVE FAILURE
→ DIAGNOSE IN BROWSER
→ RECOVER IN BROWSER
→ VERIFY RECOVERY
→ EDIT
→ VERIFY EDIT EFFECT
→ STOP / DISABLE where applicable
→ DELETE / RESET / DISCARD
→ CLEANUP
~~~

A feature is not complete merely because Create or Save works.

## 14. Browser-first authority rule

For any scenario whose user action is expected in the UI:

~~~text
BROWSER_ACTION_REQUIRED=YES
API_MUTATION_FALLBACK_ALLOWED_FOR_PASS=NO
~~~

API/runtime/database may verify:

- persisted identifiers;
- stored configuration;
- effective merged configuration;
- runtime health;
- delivery logs;
- checkpoint;
- actual destination receipt;
- cleanup.

They may also support forensics after the browser path has been checked.

They MUST NOT replace a blocked or missing browser action and then label the user scenario PASS.

If a browser action fails and API mutation is used only to continue independent downstream forensics:

~~~text
BROWSER_RESULT=FAIL|PARTIAL
API_CONTINUATION=FORENSIC_ONLY
PASS_PROMOTION=NO
~~~

## 15. Button and action semantics

For every material control verify applicable behaviors:

1. visible label and accessible name are understandable;
2. control is reachable from the expected workflow;
3. enabled/disabled state is correct;
4. disabled controls explain what prerequisite is missing when materially blocking;
5. single click performs one intended action;
6. rapid/double activation does not duplicate destructive or start/create actions;
7. loading state prevents accidental repeats when necessary;
8. success feedback states what changed;
9. failure feedback states what failed and gives a canonical next action;
10. Cancel/Close/Back applies no unintended mutation;
11. Save/Apply cannot claim success when a subresource failed;
12. browser reload shows actual persisted truth;
13. new browser context shows actual persisted truth;
14. keyboard activation matches click semantics for standard controls;
15. destructive actions require impact-appropriate confirmation.

## 16. Discoverability and navigation

Compare:

- sidebar/group navigation;
- page CTAs;
- empty-state CTAs;
- row actions;
- dialogs;
- Dashboard issues;
- Logs links;
- Governance links;
- Stream Runtime links;
- Administration hub links;
- deep links generated by error/recovery text.

Flag when:

- a user must memorize a URL;
- a capability appears in a page but cannot be reached from the intended navigation;
- a Dashboard problem links only to a generic page when exact context is available;
- a deep link loses stream/route/destination context;
- a legacy path redirects to a misleading current page;
- an out-of-scope AI/Enterprise page is discoverable as a Control feature.

## 17. Terminology consistency

Search visible UI, dialogs, help text, errors, docs, and runtime-facing labels for one current product model.

Explicitly compare:

~~~text
Connector / Data Source
Stream
Destination
Route
Transform / Mapping / Enrichment
Protection
Classification
Policy
Governance
Violation
Quarantine
Replay
Checkpoint
Schema Drift
Runtime / Operations
Administration
DataRelay / Data Relay Control
~~~

Flag:

- two public names for one current object without clear UX reason;
- one public name used for different concepts;
- internal engine names exposed where user intent should be shown;
- legacy NOC or retired runtime terminology;
- Phase E/F nouns shown in Phase A-D primary UX.

## 18. Persistence and effective-runtime truth

For every configuration-changing browser action, reconcile:

~~~text
BROWSER_DRAFT
→ SAVE/APPLY RESPONSE
→ API READ-BACK
→ RELOAD/NEW-CONTEXT READ-BACK
→ EFFECTIVE RUNTIME CONFIG
→ RUNTIME OBSERVATION
~~~

For route-scoped processing explicitly test:

~~~text
Transform
Protection
Classification
Policy
Delivery settings
~~~

A browser Save is not PASS if persisted state or effective runtime disagrees.

A persisted value is not PASS if runtime silently ignores it.

## 19. Runtime Is Truth

For operational scenarios use current runtime truth, especially:

- operational snapshot;
- stream runtime detail;
- route health;
- destination health;
- delivery logs;
- actual destination receiver;
- checkpoint;
- failure and recovery timestamps.

The browser must expose enough evidence for the operator to answer:

~~~text
What happened?
What is affected?
Why?
What should I do?
Did recovery actually work?
~~~

API-only knowledge that the browser does not surface is not sufficient for an operator-diagnosis PASS.

### 19.1 Status, version, and candidate provenance consistency

Compare all browser-visible and machine-observable identity surfaces that claim release/build/runtime state.

At minimum reconcile:

~~~text
repository exact HEAD
origin/main-v2 candidate HEAD
browser footer/banner version when present
Administration/system information when present
health/build identity endpoints
support/diagnostic public metadata when safe
release artifact provenance/hash evidence when this run is part of release qualification
~~~

Flag contradictions such as:

- browser claims a release/build different from the exact candidate;
- a page reports healthy while Runtime Is Truth reports a material unresolved failure without explanation;
- stale legacy product/repository identity appears in current UI;
- support/diagnostic metadata points to another source HEAD;
- an exact-head run cannot prove which source built the served frontend/backend.

Formatting may differ. Meaning and candidate identity must not contradict.

## 20. Empty, loading, success, and error states

Test each major page/control in applicable states:

~~~text
EMPTY
LOADING
SUCCESS
WARNING
ERROR
PARTIAL_FAILURE
STALE_WRITE
UNAUTHORIZED
FORBIDDEN
NOT_FOUND
DEPENDENCY_BLOCKED
~~~

Required:

- empty state explicitly says none/zero or gives a clear CTA;
- loading cannot be mistaken for empty;
- success cannot be claimed before persistence completes;
- partial failure identifies which part failed;
- errors are actionable;
- stale-write/conflict does not overwrite silently;
- unauthorized actions are hidden/disabled consistently and backend remains authoritative;
- 500/Internal Server Error without user guidance is a finding.

## 21. RBAC and role visibility

For representative roles:

1. verify page visibility;
2. verify control visibility;
3. verify disabled versus hidden policy;
4. attempt direct URL access where safe;
5. attempt API action only as authorization verification, not user-action substitution.

Expected:

- browser surface matches effective permission;
- unauthorized UI action is not presented as usable;
- backend rejects unauthorized mutation;
- changing role/permission is reflected after appropriate session refresh;
- no Phase F enterprise IAM scope is invented.

## 22. Safety and destructive confirmation

Inventory every browser action that can:

- delete Connector, Stream, Route, Destination, user, or configuration;
- discard/release Quarantine;
- replay data;
- reset policy/settings;
- restore backup;
- change retention with destructive implications;
- stop data flow;
- widen or block delivery;
- remove credentials;
- overwrite conflicting configuration.

For every destructive control record:

~~~text
CONTROL=
ACTUAL_EFFECT=
DEPENDENCY_IMPACT=
HISTORICAL_DATA_IMPACT=
CHECKPOINT_IMPACT=
CONFIRMATION_PRESENT=
CONFIRMATION_DEFAULT_SAFE=
CANCEL_NO_MUTATION=
DOUBLE_ACTION_SAFE=
MUTATION_BEFORE_CONFIRMATION=
ERROR_FEEDBACK=
~~~

Do not infer safety from the button label.

## 23. Mandatory scenario catalog

### BFS-001 — First login and primary navigation

Fresh login → required password change when configured → Dashboard → each primary sidebar group → verify current product identity, no dead links, no accidental Phase E/F exposure.

### BFS-002 — Connector / source onboarding

For representative supported source families: discover → create → connection/auth test where applicable → inspect → reload → edit → dependency behavior → eventual cleanup.

Required families across the complete audit:

~~~text
HTTP API
PostgreSQL Database
S3 Object
Remote File
Webhook Receiver
~~~

### BFS-003 — Authentication variants

Exercise representative HTTP auth plus source-specific credential forms.
At minimum cover positive and negative authentication, browser-visible failure reason, correction, retest, and recovery.

### BFS-004 — Stream Wizard end-to-end

Connect → Sample & Record Selection → Destinations → Route Processing → Deploy.

Verify Back/Next, validation gating, draft persistence, reload/resume, no hidden required step, and browser-only user action authority.

### BFS-005 — Sample, Union Schema, checkpoint, incremental, dedup

Run sample/API test → select event root/record path → verify Union Schema and field evidence → checkpoint configuration → incremental/dedup settings where supported → read-back/reload.

Rare-field and sensitive-suggestion UI-only behavior MUST NOT be represented as runtime enforcement.

### BFS-006 — Destination lifecycle

Create each supported destination family over the audit campaign:

~~~text
Syslog UDP
Syslog TCP
Syslog TLS
Webhook POST
~~~

Verify test delivery where supported, edit, invalid input, dependency reference, status, and cleanup.

### BFS-007 — Multi-route architecture

One Stream → create/select multiple Destinations → multiple Routes → verify Route list/detail → route-specific settings → actual independent delivery → failure isolation.

The audit MUST fail if destination-specific differences require cloning the Stream.

### BFS-008 — Route Processing

Configure and reconcile:

~~~text
Transform
Protection
Classification
Policy
Delivery
~~~

Verify shared/default behavior, per-route override, persisted read-back, effective runtime, actual output, and no parallel legacy processing path.

### BFS-009 — Deploy, Start, first real delivery

Deploy → start/run through browser control → verify runtime state → prove first actual destination delivery → prove delivery evidence is attributable to the intended Stream/Route.

Do not accept API start as a substitute for a browser-required start control.

### BFS-010 — Dashboard, Stream Runtime, Routes, Logs operational drill-down

Generate healthy traffic and an actionable condition.
From Dashboard/operations surfaces identify the exact affected resource, drill into Stream/Route/Destination/Logs, and correlate runtime truth.

### BFS-011 — Source/auth failure diagnosis and recovery

Inject source/auth failure → browser must show an actionable problem → identify affected Stream/Connector → show root cause or actionable diagnosis → correct through browser → verify recovery and actual delivery.

### BFS-012 — Destination and partial-route failure

Break one destination/route while another remains healthy → browser diagnosis must identify the failing path → healthy route continues → correct through browser → verify both recovery and isolation.

### BFS-013 — Production edit / partial-save reconciliation

Edit an active Stream/Route/Destination → save → read-back → reload → effective runtime → actual delivery.

Inject a bounded subresource failure where safe.
No false-success state is allowed.

### BFS-014 — Stop / start / repeated action semantics

Stop through browser → prove scheduler delivery stops → verify explicit manual behavior according to current contract → start through browser → prove recovery.

Probe repeated/double Start/Stop safely for duplicate or inconsistent state.

### BFS-015 — Governance operations

Exercise applicable:

~~~text
Sensitive Detection
Protection
Classification
Policy
Violations
Quarantine
Replay
Audit
Notifications
Governance Workspace stream/route context
~~~

Verify Dashboard is operational, configuration remains in intended configuration surfaces, and Route-aware context is preserved.

### BFS-016 — Administration / settings / RBAC

Audit visible Administration controls, local user/RBAC actions, timezone/platform/network/settings, diagnostics/support/retention surfaces within current Phase A-D scope.

Verify permission visibility and actionable disabled/error states.

### BFS-017 — Backup / recovery / destructive operations

Where current product UI exposes the operation: backup → validation/preflight → restore/destructive confirmation → cancel path → fail-closed behavior.

Never restore over live/shared operator data.
Use disposable test state only.

### BFS-018 — Invalid input, empty state, deep-link, reload, new-context resilience

Probe representative invalid names/URLs/credentials, empty lists, direct deep links, browser Back/Forward, hard reload, and new browser context.

User-facing state must remain coherent and persisted truth must win.

### BFS-019 — Delete lifecycle and dependency safety

Attempt delete while active/dependent → verify safe block and full impact message → stop/remove dependencies → confirm → delete.

Verify documented checkpoint/history/config impact matches actual behavior.

### BFS-020 — Cleanup and orphan verification

Remove every audit-owned resource in dependency-safe order and prove zero audit-owned Connector/Stream/Route/Destination or other mutable residue.

## 24. Active documentation and browser text scan

Scan current operator-facing documentation and compare with the observed browser workflow.

At minimum include:

~~~text
README.md
docs/getting-started/**
docs/operations/**
docs/release/KNOWN-LIMITATIONS.md
docs/testing/**
current Source-of-Truth UX documents
browser empty/error/recovery text
Administration guidance
Stream Wizard labels/help
~~~

Classify statements/examples as:

~~~text
CANONICAL_PUBLIC
CURRENT_LIMITATION
INTERNAL_EXPLICITLY_LABELLED
NONCANONICAL_ACTIVE_GUIDANCE
HISTORICAL_IGNORE
DOC_UI_RUNTIME_MISMATCH
~~~

Historical/archive documents do not create current findings unless the active UI links to them or repeats their stale guidance.

## 25. Post-hoc hidden surface enumeration

After black-box scenarios, enumerate source/routes/API ownership.

Record:

~~~text
PUBLIC_PAGE_COUNT=
PUBLIC_ACTION_CONTROL_COUNT=
PUBLIC_MUTATION_CONTROL_COUNT=
ROUTED_BUT_UNDISCOVERABLE_PAGE_COUNT=
VISIBLE_CONTROL_WITHOUT_CAPABILITY_COUNT=
CAPABILITY_WITHOUT_BROWSER_SURFACE_COUNT=
DUPLICATE_PUBLIC_MUTATION_PATH_COUNT=
OUT_OF_SCOPE_PUBLIC_SURFACE_COUNT=
API_WITHOUT_PUBLIC_OWNER_COUNT=
NOOP_OR_UI_ONLY_CONTROL_COUNT=
~~~

Not every API requires a browser button.
The question is whether the current product contract expects an operator-facing action.

## 26. Failure continuation

When a defect is found:

1. preserve exact evidence;
2. classify severity and disposition;
3. continue all independent scenarios;
4. do not patch product code during the active audit;
5. do not weaken assertions or use API mutation to hide a browser gap;
6. stop only when continuing would risk data, credentials, environment integrity, or another owned test.

The goal is to exhaust the surface before remediation.

## 27. Severity

- **P0** — security, destructive/data-loss, credential exposure, unsafe restore/delete, or severe authorization bypass; release blocker.
- **P1** — supported feature orphan, user lifecycle dead end, false success/persistence/runtime divergence, browser-required action missing, or major recovery failure; release blocker.
- **P2** — material discoverability, terminology, procedure, state, deep-link, feedback, or RBAC presentation defect.
- **P3** — polish only.

A user-blocking P2 blocks this reconciliation gate.

## 28. Required counters

~~~text
BROWSER_FEATURE_SCENARIO_RECONCILIATION=PASS|FAIL|BLOCKED
CAPABILITY_INVENTORY_TOTAL=
CAPABILITY_SUPPORTED_TOTAL=
CAPABILITY_PARTIAL_TOTAL=
CAPABILITY_UI_ONLY_TOTAL=
CAPABILITY_OUT_OF_SCOPE_TOTAL=
IN_SCOPE_CAPABILITIES_RECONCILED=
PUBLIC_PAGE_COUNT=
PUBLIC_ACTION_CONTROL_COUNT=
PUBLIC_MUTATION_CONTROL_COUNT=
FEATURE_NO_BROWSER_GAP_COUNT=
CAPABILITY_WITHOUT_BROWSER_SURFACE_COUNT=
VISIBLE_CONTROL_WITHOUT_CAPABILITY_COUNT=
DUPLICATE_PUBLIC_MUTATION_PATH_COUNT=
ROUTED_BUT_UNDISCOVERABLE_PAGE_COUNT=
DISCOVERY_GAP_COUNT=
SCENARIO_BLOCKED_COUNT=
SCENARIO_DEAD_END_COUNT=
TERMINOLOGY_DRIFT_COUNT=
PROCEDURE_DRIFT_COUNT=
STRUCTURE_DRIFT_COUNT=
STATE_SEMANTICS_DRIFT_COUNT=
PERSISTENCE_DRIFT_COUNT=
EFFECTIVE_RUNTIME_DRIFT_COUNT=
CONFIRMATION_DRIFT_COUNT=
ERROR_FEEDBACK_DRIFT_COUNT=
RBAC_VISIBILITY_DRIFT_COUNT=
EMPTY_STATE_SILENCE_COUNT=
NEXT_ACTION_STALE_COUNT=
DEEP_LINK_CONTEXT_LOSS_COUNT=
RELOAD_PERSISTENCE_DRIFT_COUNT=
DOC_UI_RUNTIME_MISMATCH_COUNT=
OUT_OF_SCOPE_SURFACE_EXPOSURE_COUNT=
CLEANUP_RESIDUE_COUNT=
UNRESOLVED_P0=
UNRESOLVED_P1=
UNRESOLVED_USER_BLOCKING_P2=
~~~

## 29. PASS / FAIL contract

PASS requires all of the following:

1. every applicable supported Phase A-D capability is reconciled;
2. every visible material control maps to a current capability or justified operational action;
3. every user-required action has a usable browser path;
4. no browser-required PASS is created by API mutation fallback;
5. no unjustified duplicate public mutation path exists;
6. no operator scenario dead end remains;
7. browser Save/Apply agrees with persisted read-back;
8. persisted configuration agrees with effective runtime;
9. actual delivery/recovery is proven where the capability requires it;
10. Dashboard/Logs/Governance diagnosis exposes actionable affected-resource context;
11. destructive controls fail closed with correct confirmation/impact semantics;
12. RBAC browser visibility and backend authority agree;
13. empty/error/partial states are actionable;
14. Phase E/F are not exposed as current Control capability;
15. cleanup residue count is zero;
16. unresolved P0/P1/user-blocking P2 are zero.

Anything else is FAIL or explicitly BLOCKED with evidence.

## 30. Offboarding — mandatory

Offboarding is part of the test and MUST run even after FAIL whenever safe.

### 30.1 Freeze evidence first

Before cleanup:

1. flush browser/network/scenario ledgers;
2. save failure screenshots;
3. redact secrets;
4. record all created resource IDs;
5. capture final runtime/problem snapshot needed for findings.

### 30.2 Stop audit-owned execution

Stop only audit-owned:

- browser process;
- API/UI preview processes;
- scheduler process if started by this run;
- run-scoped helper/listener processes.

Do not stop another Work Packet or normal platform process.

### 30.3 Resource cleanup

Prefer disposable test DB teardown after all audit-owned processes release it.

If resource-by-resource cleanup is required, use recorded IDs and current dependency semantics.

Safe conceptual order:

~~~text
stop audit streams
resolve/delete audit streams and dependent routes according to current product contract
delete audit connectors after dependencies are gone
delete audit destinations after route references are gone
remove audit-only temporary files/bundles/backups
clean audit-only governance/replay/quarantine fixtures when the harness owns them
~~~

Never delete by name prefix alone when ownership is ambiguous.

### 30.4 Verify zero residue

Record:

~~~text
ORPHAN_CONNECTORS=
ORPHAN_STREAMS=
ORPHAN_ROUTES=
ORPHAN_DESTINATIONS=
ORPHAN_AUDIT_PROCESSES=
ORPHAN_PORT_LISTENERS=
AUDIT_DB_REMOVED=YES|NO|NOT_APPLICABLE
PREEXISTING_SHARED_RESOURCES_PRESERVED=YES|NO
CLEANUP_STATUS=PASS|FAIL|PARTIAL
~~~

Cleanup residue is a finding.

### 30.5 Final worktree check

The audit MUST NOT modify product source.

Record:

~~~text
FINAL_REPO_HEAD=
FINAL_WORKTREE_CLEAN=
SOURCE_MUTATION_DURING_AUDIT=NO
~~~

## 31. GitHub reporting — mandatory

Before declaring terminal completion, update the active `[AI Work]` issue with:

~~~text
RUN_ID=
REPO_HEAD=
FINAL_STATUS=
EVIDENCE_ROOT=
BROWSER_ENGINE=
SCENARIOS_EXECUTED=
SCENARIO_PASS=
SCENARIO_FAIL=
SCENARIO_PARTIAL=
SCENARIO_BLOCKED=
CAPABILITIES_RECONCILED=
CONTROLS_RECONCILED=
CLEANUP_STATUS=
RELEASE_BLOCKERS=
COUNTER_SUMMARY=
NEXT_ACTION=
~~~

For each P0/P1/P2 include:

- capability;
- page/control;
- exact operator action;
- expected behavior;
- actual behavior;
- persistence/runtime evidence;
- user impact;
- screenshot/network/log reference;
- remediation boundary.

Never paste secrets.

## 32. Remediation after FAIL

Only after the audit is exhausted and evidence is frozen:

1. group findings into bounded Work Packets;
2. remediate P0 → P1 → user-blocking P2 → remaining P2/P3;
3. add durable regression coverage;
4. merge fixes through normal PR/CI/review;
5. pin a new exact candidate;
6. execute this document again with a new RUN_ID;
7. only a fresh reconciliation PASS clears the gate.

Do not repair product code inside the active audit run.

## 33. Relationship to existing Control tests

### Capability manifest / Full Matrix

The capability manifest and Full Matrix remain authoritative for declared capability inventory and combinatorial execution coverage.

This reconciliation consumes that inventory but asks whether users can actually find and operate those capabilities coherently through the browser.

It does not replace Full Matrix.

### Browser User Lifecycle

`e2e/user-lifecycle/` remains the reusable browser-first execution harness.

This reconciliation SHOULD reuse its Playwright session, page objects, isolation, resource ledger, actual-delivery verification, and cleanup mechanisms where valid.

However, this reconciliation is broader in **surface completeness**:

- it inventories all material controls;
- it maps every capability to a public surface;
- it probes discoverability/dead ends;
- it checks buttons/actions not necessarily exercised by the representative lifecycle.

It does not replace the final Browser User Lifecycle PASS.

### Exact-head qualification

If this contract is designated as a release gate for a candidate, any relevant browser/product/test-contract change after PASS invalidates that PASS.

Do not merge this document or future reconciliation fixes into a candidate currently under exact-head qualification without intentionally restarting qualification.

## 34. Execution strategy

When the trigger phrase is received, ChatGPT MUST:

1. immediately perform Sections 4–6 onboarding/preflight;
2. create a unique RUN_ID and evidence root;
3. build capability inventory;
4. perform black-box public browser inventory;
5. execute BFS-001 through BFS-020 as applicable;
6. continue independent scenarios after defects;
7. perform post-hoc source enumeration only after public evidence exists;
8. reconcile all capability/control rows;
9. perform mandatory offboarding;
10. update GitHub;
11. report final PASS/FAIL/BLOCKED with concise counters and blocker list.

The user does not need to provide a long prompt, paste browser output, or select each scenario manually.

## 35. Minimal operator trigger

The human only needs to say:

~~~text
브라우저 상에서 버튼, 기능, 시나리오 연계테스트를 진행해
~~~

ChatGPT must find this document in the active repository and start execution immediately.
