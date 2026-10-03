# Data Relay Control — Full User E2E Test Scenarios

> **Document role:** Single canonical final real-user E2E execution contract for Data Relay Control
> **Executor:** ChatGPT Chat
> **Product scope:** Phase A-D only
> **Primary user surface:** Browser/UI
> **Verification layers:** API / runtime / database / actual destination, after browser action
> **Supporting harness:** e2e/user-lifecycle/
> **Release role:** Mandatory independent pre-release exhaustive gate; does not replace machine qualification or Browser ↔ Feature ↔ Scenario Reconciliation
> **Status:** Normative living execution document

## 1. Purpose and immediate execution trigger

This document defines the complete real-user E2E suite for Data Relay Control.

The following requests are immediate execution commands:

~~~text
Full User E2E 진행해
Full User E2E 테스트 진행해
사용자 E2E 진행해
사용자 E2E 테스트 진행해
전체 사용자 E2E 진행해
전수 사용자 테스트 진행해
Data Relay Control Full User E2E
~~~

Equivalent Korean/English wording has the same meaning unless the user explicitly narrows scope.

~~~text
PROFILE=FULL_USER_E2E
FIRST_ACTION=ONBOARD_AND_EXECUTE
EXECUTOR=CHATGPT_CHAT
PLAN_ONLY_RESPONSE=FORBIDDEN
CURSOR_EXECUTION=FORBIDDEN
BROWSER_FIRST=YES
ACTUAL_BROWSER_PROCESS_REQUIRED=YES
BROWSER_ENGINE=CHROMIUM_OR_CHROME
PLAYWRIGHT_REAL_BROWSER_DRIVER_ALLOWED=YES
HEADLESS_REAL_BROWSER_ALLOWED=YES
JSDOM_COMPONENT_TEST_SUBSTITUTE=NO
API_ONLY_SUBSTITUTE=NO
API_MUTATION_SUBSTITUTION_FOR_BROWSER_PASS=FORBIDDEN
REAL_DELIVERY_REQUIRED=YES
REAL_FAILURE_RECOVERY_REQUIRED=YES
CLEANUP_REQUIRED=YES
EXACT_CANDIDATE_REQUIRED=YES
RETAIN_EVIDENCE=YES
PHASE_E_F_EXCLUDED=YES
CONTRACT_FULL_READ_REQUIRED=YES
PRIMARY_PERSONA_EXECUTOR=CHATGPT_CHAT
SCRIPTED_USER_SCENARIO_EXECUTION=FORBIDDEN
WRAPPER_SCRIPT_AS_PERSONA=FORBIDDEN
AUTOMATED_HARNESS_ROLE=SUPPLEMENTAL_ONLY
PARALLEL_EXECUTION=MAXIMUM_SAFE
SERIAL_IDLE_WITH_RUNNABLE_WORK=FORBIDDEN
~~~

Do not substitute unit/component tests, Full Matrix, backend Full E2E regression, Browser Feature Scenario Reconciliation, historical browser evidence, API-only workflow tests, or a plan-only response.

A targeted request may execute a subset only when the user explicitly names that scope.

## 2. Execution ownership

FULL_USER_E2E is executed and finally evaluated by ChatGPT Chat.

~~~text
FULL_USER_E2E_EXECUTOR=CHATGPT_CHAT
FULL_USER_E2E_FINAL_AUDITOR=CHATGPT_CHAT
CURSOR_MAY_EXECUTE_FULL_USER_E2E=NO
CURSOR_MAY_DECLARE_FULL_USER_E2E_PASS=NO
~~~

ChatGPT owns onboarding and exact audit-HEAD pinning, isolated environment setup, browser execution, evidence collection, failure continuation, cleanup/offboarding, final determination, and GitHub reporting. Exact audit-HEAD pinning during this loop is not release-candidate freeze.

### 2.1 Deterministic contract resolution and full-read gate

Before starting Chromium, Playwright, `e2e/user-lifecycle/**`, a scenario runner, API/runtime probes, or any product test action, ChatGPT MUST resolve and read this exact canonical document **from first line to last line** on the audit HEAD.

~~~text
CANONICAL_REPO=datarelay-labs/datarelay-control
CANONICAL_PATH=docs/FULL_USER_E2E_SCENARIOS.md
CONTRACT_FULL_READ=YES
CONTRACT_SHA256=<sha256 of exact audit-HEAD document>
CONTRACT_GATES_ACKNOWLEDGED=PASS
~~~

Only repository/worktree resolution, mandatory Engineering System onboarding, Work Packet validation, and reading this contract are allowed before the full-read gate completes. A summary, remembered prior run, selected section, existing harness defaults, or scenario wrapper is not a substitute for reading the current contract.

Before user execution, evidence must confirm that ChatGPT reconciled the test profile, browser-first authority, persona rules, FUE-001..FUE-024 coverage, deliberate-mistake/repetition rules, harness boundary, failure continuation, cleanup, final PASS/FAIL contract, and release-order relationship.

If the contract hash or audit HEAD changes after any evidence-producing execution, the current RUN_ID is no longer PASS-eligible. Freeze its evidence, complete safe offboarding, then start a fresh RUN_ID on the new exact HEAD after reading the full current contract and recording its SHA-256. Only when the change occurs before any product-test or evidence-producing action may the same not-yet-started run record be updated before execution begins.

### 2.2 Direct user-persona execution and harness boundary

Full User E2E is a **ChatGPT-performed user test**, not a generic automated regression run.

For every FUE scenario, ChatGPT assigns and acts as the specified realistic persona and pursues the mission through the rendered browser. The persona chooses actions from the user goal and browser-visible product state, feedback, errors, labels, navigation, and normal product knowledge. It does not use source code, test code, hidden routes/selectors, direct database state, API request bodies, or a pre-scripted answer sequence to decide the next user action.

Playwright is allowed as the physical browser driver. Existing repository page objects/helpers may be reused as interaction primitives. The user-lifecycle shell runner and automated suites may perform setup, fixture orchestration, supporting regression, metrics, evidence collection, cleanup, or independently prove machine contracts, but they are **supplemental only** for Full User E2E persona evidence.

A one-shot wrapper such as `run-user-lifecycle-e2e.sh --all` MUST NOT, by itself, produce FUE user PASS evidence. A wrapper may support or shadow the active run, but ChatGPT must still directly execute and evaluate the browser persona mission.

A late manual spot-check does not retroactively convert an earlier scripted/wrapper scenario into user-persona evidence. If a FUE lane was driven from a preloaded scripted sequence or contaminated by source/oracle knowledge, invalidate that lane and rerun it from a clean persona context; run-wide contamination requires a fresh RUN_ID.

~~~text
USER_ROLE_EXECUTION=REQUIRED
PRIMARY_PERSONA_EXECUTOR=CHATGPT_CHAT
SCRIPTED_USER_SCENARIO_EXECUTION_COUNT=0
AUTOMATED_HARNESS_USER_SUBSTITUTION_COUNT=0
PERSONA_ORACLE_CONTAMINATION_COUNT=0
WRAPPER_SCRIPT_PASS_IS_USER_PASS=NO
~~~

### 2.3 Maximum-safe execution scheduling

Do not idle on a slow independent check while other safe work is runnable.

Full User E2E preserves realistic mission sequencing, but independent supporting lanes may run concurrently: fixture health checks, destination listeners, metrics capture, documentation/authority comparison, evidence classification, and isolated deterministic suites. Separate persona lanes may run in parallel only when they have fully isolated browser contexts, test data/resources, ports, databases, locks, and evidence paths.

Never parallelize shared mutable state merely to increase speed. Never reinterpret one wrapper running many scripted scenarios as parallel persona execution.

Record logical lanes and derive:

~~~text
PARALLEL_LANES_STARTED=
MAX_SIMULTANEOUS_ACTIVE_LANES=
SERIAL_IDLE_WITH_RUNNABLE_WORK=NO
AVOIDABLE_SERIAL_WAIT_COUNT=0
~~~

Implementation changes are forbidden during the active run.

If a product or harness fix is required:

~~~text
freeze evidence
→ finish every safe independent scenario
→ mandatory offboarding
→ close the audit run with FAIL/BLOCKED
→ create a bounded remediation Work Packet
→ implement and validate separately
→ pin the new exact audit HEAD
→ re-establish required Browser reconciliation if affected
→ start a fresh RUN_ID
~~~

## 3. What Full User E2E proves

Browser Feature Scenario Reconciliation asks whether every supported operator capability and actionable UI control is coherently connected.

Full User E2E asks whether real users can complete end-to-end missions from first login through real delivery, operations, failure diagnosis, recovery, editing, stop/start, destructive lifecycle, and cleanup.

It must prove depth, not only surface breadth.

~~~text
FIRST LOGIN
→ FIRST WORKING DATA FLOW
→ SUPPORTED SOURCE/AUTH USE
→ STREAM WIZARD
→ DESTINATIONS + MULTI-ROUTE
→ ROUTE PROCESSING
→ DEPLOY / START
→ ACTUAL DELIVERY
→ DAILY OPERATIONS
→ FAILURE
→ BROWSER DIAGNOSIS
→ BROWSER CORRECTION
→ ACTUAL RECOVERY
→ LIVE EDIT
→ RELOAD / NEW CONTEXT
→ STOP / START
→ DESTRUCTIVE LIFECYCLE
→ CLEANUP / ZERO ORPHANS
~~~

A saved form, 2xx response, or green UI badge alone is never sufficient evidence when runtime behavior is part of the user goal.

## 4. Authority and conflict rules

Use the repository authority model:

1. Product Charter;
2. current subordinate Source-of-Truth documents in docs/architecture/source-of-truth-index.md;
3. current task-relevant specs;
4. e2e/capabilities/data-relay-capabilities.yaml for current observed capability inventory;
5. exact-candidate browser/runtime behavior as implementation evidence.

Mandatory product invariants:

~~~text
One Stream → Many Routes → Many Destinations
Destination First
Route Processing is the only supported runtime
Runtime Is Truth
Checkpoint advances only after required delivery success
No parallel legacy runtime
Phase E/F are outside Control release scope
~~~

If current product authority and implementation disagree, record a product gap. Do not silently redefine the requirement from current code.

## 5. Test profiles

### 5.1 FULL_USER_E2E

Default for an unqualified Full User E2E request.

Runs every mandatory applicable FUE scenario in this document.

### 5.2 TARGETED_USER_E2E

Allowed only when the user explicitly names a target.

The report must say:

~~~text
PROFILE=TARGETED_USER_E2E
NOT_RUN_BY_SCOPE=<scenario IDs>
~~~

A targeted PASS cannot be used as release Full User E2E PASS.

### 5.3 RELEASE_QUALIFICATION

For release readiness:

~~~text
PROFILE=RELEASE_QUALIFICATION
MACHINE_QUALIFICATION_PASS_REQUIRED_FIRST=NO
CANDIDATE_FREEZE_REQUIRED_FIRST=NO
BROWSER_FEATURE_SCENARIO_RECONCILIATION_PASS_REQUIRED_FIRST=YES
FULL_USER_E2E_PASS_REQUIRED=YES
FINAL_BROWSER_AND_FULL_USER_HEAD_MUST_MATCH=YES
FINAL_USER_TEST_HEAD_BECOMES_RELEASE_CANDIDATE=YES
SAME_EXACT_CANDIDATE_REQUIRED=YES
ZERO_FAIL_PARTIAL_BLOCKED=YES
~~~

Machine qualification, Browser Feature Scenario Reconciliation, and Full User E2E are separate gates.

## 6. Onboarding — automatic and mandatory

On an execution trigger:

1. resolve repository datarelay-labs/datarelay-control;
2. read AGENTS.md;
3. read .engineering/project.yaml;
4. load exactly one active matching Full User E2E Work Packet;
5. determine exact audit branch/HEAD/worktree;
6. read this document in full from that exact audit HEAD and record its SHA-256;
7. verify `CONTRACT_FULL_READ=YES` and `CONTRACT_GATES_ACKNOWLEDGED=PASS` before any product-test or harness invocation;
8. verify the audit worktree clean;
9. inspect concurrent E2E/qualification/audit ownership;
10. allocate unique RUN_ID and evidence root;
11. proceed without asking the user for values already discoverable.

If no matching Work Packet exists, create one before mutable test activity.

Do not reinterpret the request as implementation work.

## 7. Exact audit-HEAD preflight

Record:

~~~text
RUN_ID=
START_UTC=
REPOSITORY=
BRANCH=
CANDIDATE_HEAD=
ORIGIN_MAIN_V2_HEAD=
WORKTREE=
WORKTREE_CLEAN=
ACTIVE_WORK_PACKET=
RELEASE_PROFILE=
BROWSER_ENGINE=
API_BASE_URL=
UI_BASE_URL=
DATABASE_URL_REDACTED=
EVIDENCE_ROOT=
BROWSER_RECONCILIATION_RUN_ID=
BROWSER_RECONCILIATION_HEAD=
CONTRACT_FULL_READ=YES|NO
CONTRACT_SHA256=
CONTRACT_GATES_ACKNOWLEDGED=PASS|FAIL
USER_ROLE_EXECUTION=PASS|FAIL
SCRIPTED_USER_SCENARIO_EXECUTION_COUNT=
AUTOMATED_HARNESS_USER_SUBSTITUTION_COUNT=
PERSONA_ORACLE_CONTAMINATION_COUNT=
~~~

Release-grade Full User E2E PASS requires `CANDIDATE_HEAD` to match the final Browser Feature Scenario Reconciliation HEAD. Before freeze, this technical field names the exact audit HEAD under test; when both final user-test gates PASS on that HEAD, the same HEAD becomes eligible for release-candidate freeze.

Different-HEAD evidence is diagnostic only. Machine qualification begins after this user-test closure, not before it.

## 8. Clean-room and collision gate

Acquire exclusive ownership before mutation.

Recommended lock:

~~~text
/tmp/datarelay-control-full-user-e2e.lock
~~~

The lock record must include RUN_ID, CANDIDATE_HEAD, OWNER_PID, START_UTC, WORKTREE, and EVIDENCE_ROOT.

Before creating user state:

1. list active qualification/browser/reconciliation/E2E processes;
2. identify shared fixture containers and ports;
3. allocate unique API/UI ports;
4. allocate unique PID/log directories;
5. allocate a disposable test DB;
6. verify live/operator DB is not targeted;
7. inventory pre-existing resources if shared state cannot be avoided;
8. verify prior interrupted Full User E2E ownership is resolved;
9. preserve unrelated processes and test runs.

Never kill a process solely because it listens on the desired port.

## 9. Browser-first black-box rule

During active user discovery and user-action execution:

~~~text
USER_ACTION_SURFACE=BROWSER
API_DB_RUNTIME_ROLE=VERIFICATION_OR_FORENSICS
SOURCE_INSPECTION_DURING_ACTIVE_USER_FLOW=FORBIDDEN
PRODUCT_CODE_EDIT_DURING_RUN=FORBIDDEN
TEST_CONTRACT_EDIT_DURING_RUN=FORBIDDEN
CANDIDATE_REBUILD_AFTER_FIRST_USER_MUTATION=FORBIDDEN
~~~

The browser may be driven through repository Playwright page objects/harness because those actions are real rendered UI operations.

API/runtime/database may verify persistence, effective route configuration, scheduler/runtime state, delivery logs, checkpoint, destination receipt, and orphan cleanup.

API mutation may be used only for test fixture setup where the mutation itself is not a claimed user action, controlled fault injection, forensic continuation, or cleanup after a browser failure.

If API mutation replaces a browser-required action:

~~~text
BROWSER_RESULT=FAIL|PARTIAL
API_CONTINUATION=FORENSIC_ONLY
PASS_PROMOTION=NO
~~~

## 10. Supporting harness and exact-build requirement

The repository harness is canonical **supporting infrastructure**, not the Full User E2E persona.

Reuse:

~~~text
e2e/user-lifecycle/run-user-lifecycle-e2e.sh
e2e/user-lifecycle/cli/main.ts
e2e/user-lifecycle/pages/**
e2e/user-lifecycle/helpers/**
e2e/framework/**
~~~

Do not build a second lifecycle framework.

However, do not equate a harness run with user execution. `run-user-lifecycle-e2e.sh --all`, its child scenario scripts, and automated Playwright suites can support environment setup, regression evidence, fixture creation, listeners, cleanup, or machine verification; they cannot substitute for ChatGPT's persona-led browser actions and judgment required by Section 2.2.

Before a release PASS-eligible run:

1. verify repository worktree clean;
2. record candidate HEAD;
3. build the frontend from the exact candidate immediately before serving it;
4. do not trust a pre-existing frontend/dist from an unknown/different HEAD;
5. bind API and scheduler to the disposable audit DB;
6. verify API health;
7. verify browser serves the newly built candidate;
8. record build/source identity before first product mutation.

If the harness cannot prove which candidate produced the served UI/API, the run is not PASS-eligible.

The harness may record API fallback for forensic continuation, but parent scenario PASS must still derive from browser authority.

For the broad release lifecycle run:

~~~text
REQUIRE_AUTH=true
ULC_REUSE_UI_DIST=0
unique GDC_E2E_API_PORT
unique GDC_E2E_UI_PORT
run-scoped GDC_E2E_PID_DIR
run-scoped GDC_E2E_LOG_DIR
~~~

A supporting broad-regression invocation may be equivalent to:

~~~bash
REQUIRE_AUTH=true \
ULC_REUSE_UI_DIST=0 \
ULC_RUN_ID=<RUN_ID> \
GDC_E2E_API_PORT=<UNIQUE_API_PORT> \
GDC_E2E_UI_PORT=<UNIQUE_UI_PORT> \
GDC_E2E_PID_DIR=/tmp/datarelay-control-full-user-e2e/<RUN_ID>/pids \
GDC_E2E_LOG_DIR=/tmp/datarelay-control-full-user-e2e/<RUN_ID>/logs \
./e2e/user-lifecycle/run-user-lifecycle-e2e.sh --all
~~~

That command is supporting regression evidence only. Its PASS does not set any FUE scenario to PASS until ChatGPT directly performs and evaluates the corresponding user-persona mission in the real browser.

If a mandatory FUE mission is not yet represented by the repository supporting harness, ChatGPT may drive additional Playwright browser actions from an ephemeral run-scoped script outside the repository. Record the script and SHA-256 in evidence. Do not dirty the exact-candidate worktree merely to finish an active audit.

Missing reusable harness coverage should become a follow-up test-harness improvement after the active run; it must not be hidden by API substitution.

## 11. Mandatory first-login/password-change proof

The current user-lifecycle shell runner intentionally clears must_change_password for the broad lifecycle run.

Therefore release Full User E2E must prove first-login password change separately on the same exact candidate using a disposable DB/session before the broad lifecycle.

Required:

~~~text
REQUIRE_AUTH=true
fresh seeded admin
must_change_password=true
browser sign-in
forced password-change screen visible
current/new/confirm workflow
successful update
old password rejected
new password accepted
normal SPA unlocked
~~~

API-only password change does not satisfy this gate.

Record:

~~~text
FIRST_LOGIN_PASSWORD_CHANGE=PASS|FAIL|BLOCKED
FIRST_LOGIN_CANDIDATE_HEAD=
FIRST_LOGIN_EVIDENCE=
~~~

A release Full User E2E cannot PASS without this proof when the production auth contract requires it.

## 12. Capability and mission inventory

Build the current mission inventory before execution from:

- current Product/UX authority;
- e2e/capabilities/data-relay-capabilities.yaml;
- current browser navigation;
- previous Browser Feature Scenario Reconciliation result on the same HEAD.

Full User E2E does not repeat every control merely for census purposes, but it must execute every user-significant capability family inside a real mission.

Required current families include:

~~~text
Authentication
HTTP API source
PostgreSQL Database source
S3 Object source
Remote File source
Webhook Receiver source
Stream Wizard
Sample / Record Path / Event Root / Union Schema
Checkpoint / Incremental / Dedup
Syslog UDP/TCP/TLS destinations
Webhook destination
One Stream → Many Routes
Global/shared processing
Per-route Transform override
Per-route Protection/Classification/Policy override
Delivery behavior / rate / failover as applicable
Dashboard / Stream Runtime / Routes / Logs
Schema drift / Sensitive Detection
Violations / Approval / Quarantine / Replay / Audit / Notifications
Administration / users / RBAC / timezone / retention / diagnostics
Backup/recovery only where current public UI/product contract exposes it
~~~

Engineering-only test infrastructure rows are not user missions.

### 12.1 Current capability anchors — maintenance guard

The following IDs are the current exact-candidate supported Source / Destination / operator-facing Authentication anchors. They are intentionally listed so a manifest expansion cannot silently bypass this contract.

~~~text
SOURCE_CAPABILITY_ANCHORS
source.http_api_polling
source.s3_object_polling
source.database_query_postgresql
source.remote_file_polling
source.webhook_receiver

DESTINATION_CAPABILITY_ANCHORS
destination.syslog_udp
destination.syslog_tcp
destination.syslog_tls
destination.webhook_post

AUTH_CAPABILITY_ANCHORS
auth.http.no_auth
auth.http.basic
auth.http.bearer
auth.http.api_key
auth.http.oauth2_client_credentials
auth.http.session_login
auth.http.jwt_refresh_token
auth.http.vendor_jwt_exchange
auth.s3.access_key_secret
auth.database.username_password
auth.remote_file.ssh_password_or_key
auth.webhook_receiver.inbound
auth.destination.syslog_tls_client_cert
~~~

The contract regression test MUST compare these anchors with the current capability manifest.

If a new `SUPPORTED` Source, Destination, or operator-facing Authentication capability appears in the manifest, this document must be reviewed in the same change and the corresponding Full User E2E mission added before release qualification.

`PARTIAL` capabilities remain explicitly dispositioned but are not silently promoted into this supported-anchor list.

Phase E/F are excluded except negative exposure checks.

## 13. Persona and mission contract

Each scenario records one primary persona:

~~~text
FIRST_TIME_ADMIN
DATA_ENGINEER
OPERATIONS_ENGINEER
GOVERNANCE_REVIEWER
PLATFORM_ADMIN
INCIDENT_RESPONDER
~~~

The persona must pursue a realistic mission, not click controls mechanically.

Examples:

- Data Engineer: onboard an HTTP source and deliver normalized events to two destinations.
- Operations Engineer: diagnose one failed route while another remains healthy.
- Governance Reviewer: review, approve/reject, quarantine/release/replay as permitted.
- Platform Admin: configure user/RBAC/timezone/retention and verify effect.
- Incident Responder: identify a degraded stream from Dashboard and recover it without source-code knowledge.

During active black-box execution, persona recovery must come from browser-visible state/guidance plus normal product knowledge, not hidden implementation details.

## 14. Deliberate mistakes and recovery

A release Full User E2E must include realistic mistakes inside real missions.

Applicable classes include:

~~~text
blank required value
invalid URL/host/port
wrong credentials
expired/revoked credential
wrong record path/event root
duplicate name
stale browser state
invalid destination
missing dependency
delete while referenced/running
stale write/conflict
wrong RBAC role
deep-link without required context
browser refresh mid-edit
Back/Cancel during draft
double Start/Stop/Create
source outage
destination outage
partial-route failure
~~~

For each injected mistake record:

~~~text
MISTAKE_CLASS=
USER_VISIBLE_FAILURE=
NEXT_ACTION_VISIBLE=YES|NO
RECOVERY_ACTION=
RECOVERY_BROWSER_FIRST=YES|NO
RECOVERY_PROVEN=YES|NO
~~~

A scenario that can recover only through hidden API/source knowledge is a user-experience finding.

## 15. Mandatory repetition and sequence variation

One successful lifecycle is insufficient for high-risk state-changing behavior.

Minimum release profile:

~~~text
CORE_CREATE_DEPLOY_DELIVER_DELETE_CYCLES>=2
STOP_START_CYCLES>=2
SOURCE_FAILURE_RECOVERY_CYCLES>=1
DESTINATION_FAILURE_RECOVERY_CYCLES>=1
RELOAD_NEW_CONTEXT_PERSISTENCE_CHECKS>=2
DESTRUCTIVE_CANCEL_THEN_CONFIRM>=1 each applicable destructive family
STALE_OR_CONCURRENT_WRITE_CASES>=1 where public product supports concurrent editors
~~~

The two core cycles must vary at least one meaningful dimension, for example source type, destination type, auth mode, processing choice, starting state, or sequence order.

Do not repeat identical actions solely to satisfy a counter.

## 16. Scenario terminal status vocabulary

Every mandatory scenario ends in exactly one:

~~~text
PASS
FAIL
PARTIAL
BLOCKED
NOT_APPLICABLE
~~~

Rules:

- PASS requires current-run exact-candidate evidence.
- FAIL means exercised behavior violated the current contract.
- PARTIAL never counts as PASS.
- BLOCKED never counts as PASS for an applicable mandatory scenario.
- NOT_APPLICABLE requires explicit current product/release reason.
- silent SKIP or missing row is forbidden.
- a fixture/tool limitation is BLOCKED_TOOLING reason under terminal BLOCKED.
- shared-state collision is BLOCKED_CONCURRENT_STATE reason under terminal BLOCKED.
- targeted scope omission is NOT_RUN_BY_SCOPE and cannot qualify a release.

## 17. Failure continuation

On a defect:

1. preserve exact user-visible evidence;
2. classify result/severity;
3. continue every safe independent scenario;
4. do not patch product code;
5. do not weaken the assertion;
6. do not promote API fallback to browser PASS;
7. stop only when continued execution threatens data, credentials, environment ownership, or reliable evidence.

The goal is one exhausted audit, not one defect per run.

## 18. Mandatory Full User E2E scenario catalog

### FUE-001 — First login and first-use orientation

Fresh authenticated browser → forced password change when applicable → Dashboard → primary navigation.

Verify:

- current Data Relay Control identity;
- no dead primary navigation;
- no Phase E/F current-product exposure;
- user can identify how to start a data flow;
- session survives normal navigation/reload;
- first-login proof from Section 11 is linked.

### FUE-002 — First working HTTP data flow

First-time Data Engineer mission:

~~~text
HTTP connector
→ connection/auth test
→ Stream Wizard
→ sample / record selection
→ destination
→ route processing
→ deploy/start
→ actual destination receipt
→ runtime/delivery evidence
~~~

Use browser actions for user mutations.

Require fresh actual-delivery evidence attributable to the created Stream/Route/Destination.

### FUE-003 — Supported source family lifecycle

Across the full run exercise all current supported source families:

~~~text
HTTP API
PostgreSQL Database
S3 Object
Remote File
Webhook Receiver
~~~

For each family prove the applicable sequence:

~~~text
discover
→ configure
→ test/sample or receive
→ create Stream
→ deploy/start
→ actual delivery
→ inspect runtime
→ edit where supported
→ cleanup
~~~

No source family may be omitted from release Full User E2E because another source passed.

### FUE-004 — Authentication and credential lifecycle

Use the same-head Browser Feature Scenario Reconciliation to establish exhaustive UI surface coverage.

Full User E2E must functionally exercise all current supported operator-facing authentication variants that can be run safely in the configured lab.

At minimum cover:

- HTTP no_auth;
- basic;
- bearer;
- API key;
- OAuth2 client credentials;
- session login cookie;
- JWT refresh;
- vendor JWT exchange;
- S3 access/secret;
- database username/password;
- Remote File password/private-key path as supported;
- Webhook Receiver inbound authentication modes;
- Syslog TLS client certificate when configured.

For each applicable mode include success and at least one failure/correction path.

If a supported mode cannot execute because a required real fixture is unavailable, result is BLOCKED, not representative PASS.

### FUE-005 — Stream Wizard continuity

Execute the complete five-stage wizard:

~~~text
Connect
→ Sample & Record Selection
→ Destinations
→ Route Processing
→ Deploy
~~~

Verify:

- validation gates;
- Back/Next;
- draft persistence;
- reload/resume;
- browser refresh mid-flow;
- Cancel applies no unintended product state;
- deploy summary reflects actual configured source/routes/destinations;
- no hidden API mutation is required to finish the browser journey.

### FUE-006 — Sample, schema, checkpoint, incremental and dedup

Use real sample data.

Verify applicable:

- Record Path / Event Root;
- Union Schema;
- rare/sensitive UI hints are not falsely presented as runtime enforcement;
- checkpoint recommendation/config;
- incremental fetch;
- dedup configuration;
- checkpoint changes only after required delivery success;
- duplicate events do not create unintended duplicate downstream effects according to current contract.

### FUE-007 — Destination family lifecycle

Across the full run exercise:

~~~text
Syslog UDP
Syslog TCP
Syslog TLS
Webhook POST
~~~

For each applicable destination:

- create through browser;
- test delivery where exposed;
- attach to Route;
- prove actual delivery;
- edit;
- invalid input;
- runtime/health visibility;
- dependency-safe delete.

### FUE-008 — One Stream → Many Routes → Many Destinations

Create one Stream with at least two Routes to distinct Destinations.

Verify:

- independent route identity;
- one Stream remains the source of truth;
- different route delivery/processing settings do not require Stream cloning;
- healthy route continues when another route fails;
- Routes/Runtime/Logs identify each path separately;
- recovery preserves route identities.

### FUE-009 — Route Processing real-output mission

Exercise global/shared processing plus route override.

Required processing dimensions:

~~~text
Transform
Protection
Classification
Policy
Delivery
~~~

Use at least two routes so effective inheritance/override is observable.

Require persisted read-back plus actual output/runtime evidence.

The same-head Browser Feature Scenario Reconciliation provides exhaustive control-option coverage; Full User E2E provides integrated real-effect proof.

### FUE-010 — Deploy, Start, first delivery and repeated Start

Deploy/start through browser.

Verify:

- browser control caused state change;
- start result is visible;
- actual delivery begins;
- second Start/repeated activation is deterministic and safe;
- no API start mutation contributes to browser PASS;
- Runtime Is Truth agrees with browser status.

### FUE-011 — Dashboard daily-operations mission

With healthy traffic running:

- open Dashboard;
- identify current operational health;
- drill to Stream/Route/Destination as appropriate;
- inspect Logs;
- correlate current event/delivery activity;
- verify deep links preserve enough context;
- verify reload does not invent stale healthy/degraded state.

### FUE-012 — Source/auth failure and recovery

Inject a source/auth failure without modifying product code.

The browser must allow the Incident Responder to answer:

~~~text
what happened?
which Connector/Stream is affected?
why?
what should I do?
did recovery actually work?
~~~

Correct through the browser where the product exposes the correction.

Require fresh post-recovery actual delivery, not only a successful test button.


### FUE-013 — Destination failure, partial-route isolation and recovery

With two active Routes, make one Destination fail while the other remains healthy.

Verify:

- failing Route is visible in browser;
- healthy Route keeps delivering;
- affected Destination/Route is identifiable;
- Dashboard/Routes/Logs do not collapse both paths into one generic failure;
- correction is browser-first when the product exposes the edit;
- fresh successful delivery proves recovery;
- API fallback may continue forensics but cannot satisfy browser recovery PASS.

### FUE-014 — Production edit and persistence truth

Edit an active Stream, Route, Destination, or processing configuration through browser.

For each selected edit:

~~~text
browser edit
→ save/apply
→ API read-back
→ hard reload
→ new browser context
→ effective runtime
→ actual delivery/effect
~~~

No false-success state is allowed.

Include at least one bounded partial-save or stale-write/conflict case where current product behavior supports it.

### FUE-015 — Stop / Start and runtime continuity

Stop through browser.

Verify:

- browser control is present/actionable;
- Stream runtime transitions to stopped;
- scheduled delivery stops;
- current contract for manual/run-once behavior remains truthful;
- endpoint/config identities are preserved.

Start through browser.

Verify:

- state returns to running;
- delivery resumes;
- checkpoint continuity is correct;
- no API stop/start mutation is used to make the browser scenario PASS.

Repeat at least twice according to Section 15.

### FUE-016 — Process restart / checkpoint recovery

Using the disposable test environment, restart only the audit-owned scheduler/API/runtime component according to supported test procedure while a checkpointed Stream exists.

Verify:

- persisted configuration survives;
- checkpoint resumes correctly;
- duplicate/missed delivery behavior matches current contract;
- browser Runtime/Logs recover;
- actual delivery resumes;
- no live/operator service is touched.

This scenario is runtime recovery, not a production incident drill.

### FUE-017 — Governance end-to-end mission

Create or obtain governance-relevant events and exercise applicable current Phase A-D flows:

~~~text
Sensitive Detection
Protection
Classification
Policy
Violation
Approval Workflow
Quarantine
Release / Discard
Replay
Audit
Notifications
Governance Workspace context
~~~

Approval Workflow must cover role-permitted submit / approve / reject / activate transitions.

Verify:

- user-visible state transition;
- RBAC visibility;
- correlation/deep-link context;
- Runtime Is Truth where the decision affects delivery;
- Audit continuity;
- no Phase E/F policy surface is required.

If a current governance SoT capability is absent from the capability manifest, retain the Browser Reconciliation finding and still execute the user mission where the UI/product supports it.

### FUE-018 — Administration, users, RBAC and settings

Exercise current operator-facing Administration flows within Phase A-D:

- Administration hub;
- local user lifecycle as safe in disposable DB;
- representative roles/permissions;
- user/platform timezone;
- network/platform settings only when safe in isolated test environment;
- retention dry-run / policy path where exposed;
- health/maintenance/support evidence where exposed.

Verify:

- read-only role cannot mutate;
- mutating role can perform authorized action;
- direct URL does not bypass backend authorization;
- disabled/hidden action semantics are coherent;
- settings survive reload/new context.

Do not invent Enterprise IAM/SSO scope.

### FUE-019 — Destructive lifecycle and blast-radius UX

Exercise destructive paths for audit-owned resources.

At minimum cover applicable:

~~~text
Route delete
Stream delete
Destination delete
Connector delete
Quarantine discard/release
Replay confirmation
user/config destructive action where safely exposed
~~~

For each:

1. attempt while referenced/running where applicable;
2. verify dependency/impact message;
3. Cancel/No and prove no mutation;
4. satisfy prerequisites;
5. Confirm;
6. prove final state;
7. verify checkpoint/history/config impact matches current product contract.

Never delete by name prefix alone without recorded ownership.

### FUE-020 — Invalid input, deep links, reload and browser resilience

Inside real tasks exercise:

- invalid source URL/port;
- invalid credentials;
- invalid destination;
- duplicate name;
- missing dependency;
- browser Back/Forward;
- hard reload;
- new browser context;
- direct deep link;
- unknown route;
- legacy redirect;
- OSS-guarded route;
- out-of-scope AI/Phase E/F route.

Verify current product routes remain understandable and do not expose hidden/retired Control capability.

### FUE-021 — Concurrent user/admin changes

Use two browser contexts against the same disposable candidate.

Exercise at least:

- two non-conflicting edits where supported;
- two conflicting edits to the same object/config;
- one operator monitoring while another edits;
- one route/destination edit while traffic remains active.

If the public product exposes stale-write/version conflict protection, stale submission must reject explicitly.

If it does not, do not call last-writer-wins “stale protection”; record the actual behavior and lost-update risk.

No unrelated fields may be corrupted.

### FUE-022 — Function under load

Run representative event flow while performing normal browser operations.

At minimum while traffic is active:

- Dashboard refresh/drill-down;
- Logs filtering;
- route edit;
- source/destination inspection;
- one failure/recovery cycle;
- Stop/Start on an owned Stream if safe.

Use the current configured validation throughput range and existing fixtures.

Numeric performance qualification is separate unless current release authority defines a numeric SLO.

Record:

~~~text
FUNCTION_UNDER_LOAD=PASS|FAIL|PARTIAL|BLOCKED
OBSERVED_EPS=
UI_ACTIONABILITY_UNDER_LOAD=
DELIVERY_CONTINUITY=
RECOVERY_UNDER_LOAD=
~~~

### FUE-023 — Soak / observation and post-stress recovery

Use the configured Full User E2E observation window.

Current harness default is 30 minutes unless the active release contract explicitly changes it.

During observation:

- keep representative Streams running;
- observe runtime health;
- verify delivery continues;
- monitor error/issue accumulation;
- verify no audit-owned resource explosion;
- sample checkpoint/delivery progression.

After observation or bounded stress, re-run a short core flow and verify the system remains usable.

A zero-minute debug run may prove a targeted fix but cannot replace the release observation requirement unless the release Work Packet explicitly records an approved exception.

### FUE-024 — Final delete / cleanup / orphan truth

Before final report:

1. freeze evidence;
2. delete/clean every audit-owned mutable resource in dependency-safe order;
3. drop disposable DB after audit processes release it;
4. stop only audit-owned API/UI/scheduler/browser/helper processes;
5. verify no audit-owned listeners/processes remain;
6. verify no audit-owned Connector/Stream/Route/Destination remains;
7. preserve shared fixture infrastructure and unrelated user/test resources.

Required:

~~~text
ORPHAN_CONNECTORS=0
ORPHAN_STREAMS=0
ORPHAN_ROUTES=0
ORPHAN_DESTINATIONS=0
ORPHAN_AUDIT_PROCESSES=0
ORPHAN_PORT_LISTENERS=0
AUDIT_DB_REMOVED=YES
PREEXISTING_SHARED_RESOURCES_PRESERVED=YES
CLEANUP_STATUS=PASS
~~~

## 19. Source/destination/auth completeness rule

Full User E2E release PASS requires every current supported operator-facing Source and Destination family to appear in at least one current-run real-effect scenario.

Authentication coverage is derived from the current capability inventory rather than a hard-coded count.

For each supported operator-facing auth variant:

~~~text
CONFIGURED_IN_BROWSER=YES
POSITIVE_RESULT=
NEGATIVE_RESULT=
CORRECTION_RESULT=
REAL_EFFECT_OR_CONNECTION_PROOF=
~~~

A same-head Browser Feature Scenario Reconciliation PASS may be reused as discoverability/control evidence, but it cannot replace the Full User E2E functional result.

## 20. Processing completeness rule

The Full User E2E run must cover integrated real effects across current supported processing families.

At minimum:

- mapping;
- enrichment;
- unmapped-field policy;
- per-route transform inherit/override;
- protection;
- classification;
- policy;
- delivery behavior.

Browser Reconciliation proves exhaustive visible option coverage.
Full User E2E proves that representative combinations produce the intended final event and delivery behavior end to end.

Any processing capability changed after the last Full User E2E PASS invalidates that PASS.

## 21. Runtime Is Truth and evidence hierarchy

For runtime-bearing scenarios, evidence strength is:

~~~text
ACTUAL_DESTINATION_RECEIPT
+ RUNTIME/DELIVERY LOG
+ EFFECTIVE CONFIG / READ-BACK
+ BROWSER USER ACTION
~~~

All applicable layers should agree.

A browser toast alone is insufficient for actual delivery.

An API response alone is insufficient for browser action.

A stored config alone is insufficient for runtime enforcement.

When evidence disagrees, report the disagreement; do not select the most convenient source.

## 22. Status / provenance consistency

Compare:

- repository candidate HEAD;
- worktree cleanliness;
- served frontend build identity when exposed;
- backend build/source identity when exposed;
- health/runtime identity;
- final artifact metadata;
- PR/CI exact HEAD for release profile.

Release PASS requires one coherent candidate identity.

If the served frontend may have come from a stale dist directory, FAIL_PRECONDITION/BLOCKED until rebuilt from the exact candidate.

## 23. Evidence layout

Use artifacts outside the repository.

Canonical root:

~~~text
/tmp/datarelay-control-full-user-e2e/<RUN_ID>/
~~~

The repository supporting harness may continue using:

~~~text
/tmp/data-relay-real-browser-e2e/<RUN_ID>/
~~~

when the Work Packet records that path as EVIDENCE_ROOT.

Required durable evidence includes:

~~~text
run.env
candidate.txt
final-summary.txt
scenario-results.tsv
issues.tsv
resource-ledger.tsv
browser-actions.tsv
network-evidence.tsv
delivery-evidence.tsv
status-evidence.tsv
checkpoint-evidence.tsv
cleanup-results.tsv
state.json
first-login/
failures/
screenshots/
~~~

Secret-bearing artifacts must be redacted before durable retention.

Recommended permissions:

~~~text
evidence directory: 0700
secret-bearing temporary file: 0600
~~~

Do not retain raw tokens, passwords, cookies, Authorization headers, private keys, or unredacted connector secrets.

## 24. Run-state / interruption recovery

Persist at minimum:

~~~text
RUN_ID
CANDIDATE_HEAD
CANDIDATE_WORKTREE_CLEAN
CURRENT_SCENARIO
LAST_COMPLETED_SCENARIO
CREATED_RESOURCE_IDS
OWNED_PROCESS_IDS
OWNED_PORTS
DATABASE_NAME
CLEANUP_REQUIRED
~~~

On interruption:

1. verify candidate identity;
2. verify lock ownership;
3. verify audit-owned processes/resources;
4. resume the same RUN_ID only if evidence identity is coherent;
5. otherwise perform cleanup/offboarding first;
6. never start a colliding mutable run.

An interrupted run cannot PASS until all mandatory scenarios and cleanup are complete.

## 25. Harness authority and fallback audit

Before a release run, execute the current browser-authority regression test.

Current expected command:

~~~bash
cd e2e && npm run test:user-lifecycle-authority
~~~

The contract must prove at minimum:

- destination-create parent PASS cannot come from API-created IDs;
- browser auth recovery requires browser-visible recovery;
- browser Stream start cannot be replaced by API start;
- destination failure/recovery browser edit cannot be replaced by API patch for PASS;
- Stop/Start does not API-mutate the primary Stream;
- delete lifecycle does not API-stop/delete for browser PASS;
- PARTIAL/BLOCKED fail terminal acceptance;
- resume requires exact HEAD and clean source identity;
- browser list/drill-down evidence is not replaced by direct-ID navigation when that navigation itself is under test.

Any new API mutation fallback added to a browser-required lifecycle must add durable regression coverage before release.

The browser-authority regression test remains supporting machine evidence. The direct-persona / no-wrapper-substitution gate is established by this document's run evidence and final closure validation; do not treat the regression test itself as proof that ChatGPT performed the user mission.

## 26. Machine-derived closure validation

Do not hand-type final coverage from memory.

Before final status, parse current-run ledgers/artifacts with an ephemeral validator outside the repository.

Minimum assertions:

~~~text
all FUE-001..FUE-024 have one terminal disposition
all mandatory applicable scenarios are PASS
no mandatory PARTIAL
no mandatory BLOCKED
all supported source families exercised
all supported destination families exercised
all required auth variants dispositioned
first-login proof PASS where required
browser-required mutations have browser evidence
actual delivery evidence exists for delivery scenarios
failure and recovery evidence are fresh and attributable
core lifecycle repeat minimum satisfied
Stop/Start repeat minimum satisfied
zero audit-owned resource residue
candidate HEAD consistent across evidence
worktree was clean for PASS-eligible execution
contract full-read/hash gate passed
USER_ROLE_EXECUTION=PASS
SCRIPTED_USER_SCENARIO_EXECUTION_COUNT=0
AUTOMATED_HARNESS_USER_SUBSTITUTION_COUNT=0
PERSONA_ORACLE_CONTAMINATION_COUNT=0
SERIAL_IDLE_WITH_RUNNABLE_WORK=NO unless serialization was required by a recorded safety/state dependency
summary counts equal ledger-derived counts
~~~

Store validator script and SHA-256 under EVIDENCE_ROOT.

If closure validation fails:

~~~text
FULL_USER_E2E=FAIL
CLOSURE_VALIDATION=FAIL
~~~

No manual override.

## 27. Final PASS / FAIL contract

Release Full User E2E PASS requires:

1. exact candidate identity is coherent;
2. candidate worktree was clean;
3. mandatory first-login proof passes;
4. FUE-001..FUE-024 are dispositioned;
5. every applicable mandatory scenario is PASS;
6. no PARTIAL/BLOCKED mandatory scenario remains;
7. supported source family coverage is complete;
8. supported destination family coverage is complete;
9. required authentication coverage is complete;
10. Browser Feature Scenario Reconciliation on the same HEAD is PASS;
11. user-required browser actions were not replaced by API mutation;
12. actual delivery is proven;
13. source failure/recovery is proven;
14. destination/partial-route failure/recovery is proven;
15. runtime edit/read-back/effective behavior is coherent;
16. Stop/Start browser authority is proven;
17. governance/administration/RBAC missions pass where applicable;
18. required repetition/sequence variation is satisfied;
19. function-under-load and observation requirements pass;
20. cleanup/orphan checks pass;
21. unresolved P0/P1/user-blocking P2 = 0;
22. CLOSURE_VALIDATION=PASS;
23. `CONTRACT_FULL_READ=YES` and the recorded `CONTRACT_SHA256` matches the executed exact-HEAD contract;
24. `USER_ROLE_EXECUTION=PASS`;
25. `SCRIPTED_USER_SCENARIO_EXECUTION_COUNT=0`;
26. `AUTOMATED_HARNESS_USER_SUBSTITUTION_COUNT=0`;
27. `PERSONA_ORACLE_CONTAMINATION_COUNT=0`;
28. `SERIAL_IDLE_WITH_RUNNABLE_WORK=NO` and `AVOIDABLE_SERIAL_WAIT_COUNT=0` unless a recorded safety/state dependency required serialization.

Anything else is FAIL or BLOCKED.

A Full User E2E run can be a completed audit with FINAL_STATUS=FAIL; that does not make the release gate pass.

## 28. Release qualification — mandatory two-test order

After the product roadmap implementation is complete, the exhaustive pre-release user-test order is:

~~~text
Browser Feature Scenario Reconciliation PASS1
→ batch remediation
→ Browser Feature Scenario Reconciliation PASS2
→ Full User E2E PASS1
→ batch remediation
→ re-establish Browser Feature Scenario Reconciliation on the remediated HEAD
→ Full User E2E PASS2
→ candidate freeze
→ exact-head machine qualification
→ release-specific gates
→ final exact-head CI
→ release audit
→ owner/manual acceptance
→ release authorization/publication
~~~

The browser/user remediation loop is intentionally before candidate freeze and full qualification. The final Browser Feature Scenario Reconciliation PASS and final Full User E2E PASS must share the same exact HEAD; only then may that HEAD be frozen as the release candidate. A product change made to remediate Full User E2E must re-establish affected Browser reconciliation before the next Full User E2E pass.

Mandatory contracts:

~~~text
docs/BROWSER_FEATURE_SCENARIO_RECONCILIATION.md
docs/FULL_USER_E2E_SCENARIOS.md
~~~

Release requirements:

~~~text
BROWSER_FEATURE_SCENARIO_RECONCILIATION_REQUIRED=YES
BROWSER_FEATURE_SCENARIO_RECONCILIATION_MIN_PASSES=2
FULL_USER_E2E_REQUIRED=YES
FULL_USER_E2E_MIN_PASSES=2
SAME_EXACT_CANDIDATE=YES
ZERO_FAIL_PARTIAL_BLOCKED=YES
~~~

These are separate from the repository machine operational-E2E pass count in .engineering/release.yaml.

The current machine release profile may require multiple Full Regression/operational E2E passes. Those machine passes do not replace either exhaustive ChatGPT-executed user test.

The CI/static release-contract check only proves that these mandatory contracts are present and correctly wired. It is **not** execution evidence for either exhaustive user test.

Actual PASS authority comes from the active release Work Packet and retained run evidence for the exact candidate HEAD.

## 29. Candidate invalidation rule

After either exhaustive user-test PASS, any relevant change to the following invalidates affected evidence:

- product frontend;
- product backend/runtime;
- migration/persistence;
- capability/status inventory;
- browser user-action semantics;
- user-lifecycle harness;
- release behavior;
- test contract when the change alters required execution/acceptance.

A changed candidate requires re-establishing the mandatory same-head gates.

A docs-only typo that provably does not alter execution semantics may be dispositioned under the active release Work Packet, but never silently reused.

## 30. GitHub reporting

Update the active Full User E2E Work Packet before final completion.

Required summary:

~~~text
PHASE=FULL_USER_E2E
RUN_ID=
CANDIDATE_HEAD=
FINAL_STATUS=PASS|FAIL|BLOCKED
PROFILE=
EVIDENCE_ROOT=
FIRST_LOGIN_PASSWORD_CHANGE=
BROWSER_RECONCILIATION_RUN_ID=
BROWSER_RECONCILIATION_STATUS=
FUE_TOTAL=
FUE_PASS=
FUE_FAIL=
FUE_PARTIAL=
FUE_BLOCKED=
FUE_NOT_APPLICABLE=
SOURCE_FAMILY_COVERAGE=
DESTINATION_FAMILY_COVERAGE=
AUTH_COVERAGE=
ACTUAL_DELIVERY=
SOURCE_FAILURE_RECOVERY=
DESTINATION_FAILURE_RECOVERY=
STOP_START=
GOVERNANCE=
ADMIN_RBAC=
FUNCTION_UNDER_LOAD=
OBSERVATION=
REPEAT_COVERAGE=
CLEANUP_STATUS=
CLOSURE_VALIDATION=
UNRESOLVED_P0=
UNRESOLVED_P1=
UNRESOLVED_USER_BLOCKING_P2=
FOLLOW_UP_ISSUES=
NEXT_ACTION=
~~~

List exact failing/blocking FUE scenario IDs when not PASS.

Do not paste secrets.

## 31. Mandatory offboarding

Offboarding runs after PASS, FAIL, or BLOCKED whenever safe.

### 31.1 Freeze evidence

Flush ledgers, save failure screenshots, redact secrets, record created IDs, and save final runtime/delivery state.

### 31.2 Stop audit-owned processes

Stop only run-owned browser, API, UI preview, scheduler, fault injectors, and helper/listener/load processes.

Preserve shared test fixtures unless this run owns them exclusively.

### 31.3 Resource cleanup

Use recorded IDs and dependency order.

Do not delete merely from a naming prefix.

### 31.4 Disposable database cleanup

After run-owned processes release the DB:

- verify DB name belongs to RUN_ID;
- drop only that disposable DB;
- verify live/shared catalog untouched.

### 31.5 Final residue verification

Require Section FUE-024 zero-residue values.

### 31.6 Final repository verification

Record:

~~~text
FINAL_REPO_HEAD=
FINAL_WORKTREE_CLEAN=
SOURCE_MUTATION_DURING_ACTIVE_RUN=NO
~~~

## 32. Terminal notification

After the Work Packet is truly terminal, evidence is durable, and cleanup is complete:

~~~bash
/usr/local/bin/notify.sh COMPLETE "Task: Data Relay Control Full User E2E
Status: PASS|FAIL|BLOCKED
Branch: <branch>
HEAD: <short-sha>
Run: <RUN_ID>
Evidence: <EVIDENCE_ROOT>"
~~~

Do not send terminal COMPLETE while tests or cleanup are still active.

Check exit status and follow current repository retry/blocker policy.

## 33. Relationship to Browser Feature Scenario Reconciliation

The two tests are intentionally separate.

### Browser Feature Scenario Reconciliation

Primary question:

Does every current operator capability/control have a coherent, discoverable, safe scenario and surface?

It is breadth-first and inventories pages/controls/capabilities.

### Full User E2E

Primary question:

Can real users complete complete missions, experience failures, recover, continue operating, and clean up on the exact release candidate?

It is depth-first and mission/runtime-effect oriented.

Evidence may be referenced across the same candidate, but one test cannot substitute the other.

Release requires both.

## 34. Maintenance and minimal trigger

Whenever current Phase A-D capability, browser navigation, Stream Wizard, Route Processing, runtime truth, governance, RBAC, destructive lifecycle, user-lifecycle harness, or release gate changes, review this document in the same change.

Minimal trigger:

~~~text
Full User E2E 진행해
~~~

On that trigger, ChatGPT must:

1. resolve current candidate and Work Packet;
2. open this document;
3. perform onboarding/clean-room/exact-build preflight;
4. execute first-login proof;
5. execute mandatory FUE scenarios;
6. continue independent scenarios after failures;
7. run machine-derived closure;
8. perform mandatory offboarding;
9. update GitHub;
10. send terminal notification only after terminal completion.

No additional planning prompt is required.
