# Data Relay Control — Full User E2E Test Scenarios

> **Document role:** Single canonical final User E2E execution contract for Data Relay Control
> **Canonical path:** `docs/FULL_USER_E2E_SCENARIOS.md`
> **Product scope:** Data Relay Control Phase A–D only
> **Execution model:** human black-box browser operation + runtime/receiver truth + failure/recovery + concurrency/performance
> **Automation:** `e2e/user-lifecycle/` is mandatory supporting evidence, but not a substitute for the human Full User E2E defined here
> **Status:** normative living E2E contract, subordinate to current product/UX Source of Truth

## 1. Purpose and execution trigger

This document defines what a real end user, data builder, operator, governance operator, administrator, incident responder, and platform maintainer must be able to accomplish before Data Relay Control can claim Full User E2E PASS.

An unqualified request such as `사용자 E2E`, `전체 E2E`, `전수 사용자 테스트`, `Full User E2E`, or `FULL_USER_E2E` means:

~~~text
PROFILE=FULL_USER_E2E
RUN_ALL_MANDATORY_ROLE_SCENARIOS=YES
RUN_SECURITY_NEGATIVE_AND_RECOVERY=YES
RUN_CONCURRENCY_AND_RELEASE_REQUIRED_PERFORMANCE=YES
USE_BROWSER_UI_FOR_USER_MUTATIONS=YES
USE_RUNTIME_AS_TRUTH=YES
VERIFY_REAL_DELIVERY_WHERE_APPLICABLE=YES
RETAIN_CURRENT_RUN_EVIDENCE=YES
~~~

A targeted request may run a subset only when the user explicitly narrows scope. Omitted scenarios are `NOT_RUN_BY_SCOPE`, never PASS.

Release qualification is separate and additionally follows `.engineering/release.yaml`, including exact-HEAD, provenance/artifact, operational E2E, public smoke, and configured full-E2E pass count.

### 1.1 Execution ownership

Full User E2E is executed and independently evaluated by ChatGPT acting as the user/operator/auditor. Cursor may implement fixes after findings, but Cursor output cannot declare Full User E2E PASS.

~~~text
ChatGPT -> pin candidate/build -> execute black-box journeys -> retain evidence -> classify findings -> finish independent discovery
If code change is required:
ChatGPT -> bounded Work Packet -> Cursor implementation/test -> ChatGPT independent verification -> affected E2E rerun
~~~

Historical PASS, unit/API-only evidence, Cursor reports, or evidence from another Git HEAD cannot be promoted into the current run.

### 1.2 Human black-box hard gate

During active Full User E2E the acting persona must use the public product: login, primary navigation, empty states, buttons, menus, drawers, forms, wizards, preview, Dashboard, Runtime, Logs, Governance, and Administration.

Do not inspect source/test code to decide the next user action. Do not mutate product state through a private API or database to bypass a blocked browser action and then call that user journey PASS.

Read-only API/runtime/DB checks are allowed after the UI action when needed to prove persistence/effective state. Test-only external fixtures may be managed outside Control because they are not Control user actions.

### 1.3 Evidence-layer separation

~~~text
DETERMINISTIC_TEST_PASS != AUTOMATED_BROWSER_LIFECYCLE_PASS
AUTOMATED_BROWSER_LIFECYCLE_PASS != HUMAN_FULL_USER_E2E_PASS
HUMAN_FULL_USER_E2E_PASS != EXACT_HEAD_MACHINE_QUALIFICATION_PASS
~~~

The automated browser lifecycle remains browser-authoritative for its assertions: user mutation is Browser/UI first; API/runtime/database/receiver evidence verifies the result; `STATIC_ONLY`, `PARTIAL`, or `BLOCKED` cannot become PASS.

### 1.4 Use-case coverage contract

Full User E2E is not a screen sweep. Every supported capability must map to a real use case with:

~~~text
PRODUCT_CAPABILITY -> PERSONA_GOAL -> SCENARIO_ID -> PUBLIC_UI_DISCOVERY -> USER_ACTION
-> PERSISTED_STATE -> EFFECTIVE_RUNTIME -> REAL_EFFECT -> NEGATIVE_VARIANT -> RECOVERY -> CLEANUP -> EVIDENCE
~~~

A page is not covered merely because it opened. A command/API is not covered merely because it returned 2xx. A delivery path is not covered until the intended external receiver observes the intended event where a receiver is available.

### 1.5 Failure discipline

On a finding: preserve user-visible evidence, classify it, recover only the test environment when safe, continue all independent scenarios, and defer source-level diagnosis/fix until independent discovery is exhausted.

Independent lanes should start as soon as their public prerequisites are available. Do not finish one long happy path before beginning unrelated source, governance, admin, negative-input, or load lanes when they can run safely in parallel. Serialization is reserved for shared-state mutations, destructive maintenance, or scenarios whose purpose requires coordinated ordering.

For an unqualified Full User E2E trigger, execute the contract rather than returning a plan-only response or handing the run to Cursor.

## 2. Authority and product invariants

Requirement authority follows `docs/architecture/source-of-truth-index.md`: Product Charter -> designated subordinate Source-of-Truth documents -> task-relevant current specs -> bounded ADR/runbook -> release/engineering qualification contract -> this document -> derived/historical material.

Observed code/runtime is evidence of current behavior; it does not silently rewrite product intent.

Mandatory invariants:

- Product identity: Enterprise Data Control Gateway.
- User goal: collect, transform, deliver, observe, and optionally protect data.
- Delivery architecture: **One Stream -> Many Routes -> Many Destinations**.
- Processing unit: Route; destination-specific Transform / Protection / Classification / Policy must be representable per Route.
- Destination selection precedes Route Processing.
- Route Processing is the only supported runtime path; retired Route-OFF/parallel pipeline behavior cannot qualify the product.
- Checkpoint normally advances only after required delivery success; the current delivery contract explicitly treats configured `LOG_AND_CONTINUE` as an absorbed exception that may advance checkpoint despite that route send failure.
- **Runtime Is Truth**; a green UI state cannot override runtime/receiver failure.
- Phase E AI Gateway and Phase F Enterprise Edition are outside current Data Relay Control scope and must not enter the denominator.

### 2.1 Source-scope rule

The Product Charter names HTTP API, Database Source, and Webhook Receiver as core collection scope. Current release evidence also treats S3 and Remote File/SFTP as supported extensions.

Therefore HTTP/PostgreSQL/Webhook are mandatory core source journeys. S3/SFTP are conditional mandatory when the tested release still claims them. Fixtures/backend enums alone never create new product scope.

### 2.2 PARTIAL capability rule

Current capability inventory includes PARTIAL items such as webhook destination header/auth UX, lookup enrichment, require-review variants, rate-limit behavior, and some fault/test infrastructure. Every PARTIAL item must be explicitly dispositioned; backend existence must not be promoted to complete UI support.

## 3. Personas and profiles

| Persona | Mission | Boundary |
| --- | --- | --- |
| First-time Operator | Understand current state and create the first flow | No hidden routes/internal IDs |
| Data Engineer / Stream Builder | Connect, sample, define Final Event, select destinations, configure Route Processing, deploy | Uses public Wizard/editors/preview |
| Operations Operator | Keep Streams delivering; diagnose/recover; edit/start/stop | Starts from Dashboard/Runtime/Logs symptoms |
| Governance Operator | Protect/classify/control data; investigate violations/quarantine/replay | Uses Governance + Route context |
| Administrator | RBAC, local account/settings, timezone, retention, network, backup/maintenance | Must not expand Control into Enterprise IAM |
| Incident Responder | Restore degraded source/destination/route/runtime | Uses user-visible diagnosis first |
| Platform Maintainer | Upgrade/restart/restore and prove continuity | Treats data/config integrity as outcome |
| External Source/Destination | Produce or receive protocol data | Supplies independent real-effect evidence |
| Load Generator | Generate controlled release workload | Does not privately mutate Control state |

Profiles:

- `FULL_USER_E2E`: all mandatory U/O/G/A/S/C and release-required P scenarios.
- `TARGETED_USER_E2E`: only explicitly named subset; omissions are not PASS.
- `RELEASE_QUALIFICATION`: Full User E2E plus current `.engineering/release.yaml` gates.

## 4. Environment, discovery and evidence identity

Use disposable or explicitly designated test systems for destructive work. Never reset or mutate live operator data merely to simplify E2E.

Record at minimum: TEST_RUN_ID, TEST_CONTRACT_HEAD, SOURCE_HEAD, WORKTREE_OR_ARTIFACT, WORKTREE_CLEAN, BUILD_OR_IMAGE_ID, PRODUCT_VERSION, DB_SCHEMA_HEAD, browser/version, UI/API endpoints, fixture set, UTC start/end.

Final qualification must use the release-selected production-like packaged path when the release claim is about the packaged product.

### 4.1 Public UI discovery

The persona begins from the shipped login/landing/navigation, not from a memorized internal route list. Discover tasks through page headings, primary nav, empty-state CTAs, visible controls, wizard stages, hints/tooltips, validation errors, status cards, recommended actions, and drill-down links.

If an important task is possible only by guessing an undiscoverable URL, hidden ID, or undocumented sequence, record a discoverability defect.

Every applicable major surface must receive a real-use-case disposition: Dashboard, Connectors, Streams, Stream Wizard/edit, Sample/Record Selection, Mapping/Transform/Enrichment, Stream Runtime, Destinations, Routes, Logs, Governance Dashboard/Operations/Data Protection/Violations/Quarantine/Replay/Audit/Notifications/Workspace, Administration, current Settings, Backup/Import, and release-visible health/validation surfaces.

Legacy redirects and out-of-scope AI routes are not separate supported capabilities.

### 4.2 Browser-first mutation rule

Mandatory user-facing create/edit/start/stop/delete/governance/admin actions must be performed through the browser. A blocked browser action remains a finding even if an API call can continue later independent testing.

### 4.3 Real-effect rule

~~~text
API_2XX != DELIVERY_PASS
UI_HEALTHY != DELIVERY_PASS
RUNTIME_ENQUEUED != DELIVERY_PASS
RECEIVER_OBSERVED_EXPECTED_EVENT = REQUIRED where a receiver exists
~~~

Governance output must match effective configuration. Checkpoint advancement is accepted only after the corresponding required delivery-success boundary, except where the current delivery contract explicitly defines an absorbed `LOG_AND_CONTINUE` failure as checkpoint-advancing.

## 5. Canonical use-case families

| UC | Goal |
| --- | --- |
| UC-00 | First-use login, navigation, discovery and role clarity |
| UC-01 | First working Connector -> Stream -> Route -> Destination flow |
| UC-02 | Supported source authentication and sampling |
| UC-03 | Record path, Union Schema, checkpoint, incremental fetch and dedup |
| UC-04 | Final Event: Mapping, JSONata/Regex, Enrichment, type/time normalization |
| UC-05 | One Stream -> many Routes/Destinations with independent health, including Dynamic Routing additive fan-out |
| UC-06 | Destination-specific Route Processing and effective override truth |
| UC-07 | Deploy/start/stop/edit/reload and daily operation |
| UC-08 | Dashboard/Runtime/Logs/delivery trace consistency |
| UC-09 | Source/auth failure diagnosis and recovery |
| UC-10 | Destination/partial-route failure, retry/failover and recovery |
| UC-11 | Sensitive detection, schema drift, Protection, Classification and Policy |
| UC-12 | Quarantine, Replay, Violations, Audit and Notifications |
| UC-13 | Safe destructive lifecycle and zero-orphan cleanup |
| UC-14 | RBAC, local administration, timezone, network/settings, retention/support |
| UC-15 | Configuration export/import boundary, PostgreSQL DR, upgrade/rollback |
| UC-16 | Concurrent/stale writers and cross-worker consistency |
| UC-17 | Correct operation under sustained release workload |
| UC-18 | Accessibility, terminology, state clarity and next-action guidance |

## 6. Canonical scenario matrix

### 6.1 User / Data Builder

| ID | Priority | Scenario | Mandatory proof |
| --- | --- | --- | --- |
| U-001 | P0 | First login / landing / discovery | role clear, visible next action, refresh survives, logout invalidates session |
| U-002 | P0 | First HTTP flow | browser create/test/sample/map/destination/route/deploy/start + actual receiver delivery |
| U-003 | P0 | HTTP auth matrix | each release-claimed auth mode succeeds; invalid credential fails; secrets stay redacted |
| U-004 | P0 | Webhook Receiver source | real inbound event traverses Stream/Route and reaches destination |
| U-005 | P0 | PostgreSQL source | auth/query/sample/checkpoint/incremental/live delivery + disconnect/recovery |
| U-006 | P1 | S3 source | conditional release extension: sample/watermark/new object/delivery/restart/failure/recovery |
| U-007 | P1 | Remote File/SFTP source | conditional release extension: auth/sample/watermark/delivery/restart/outage/recovery |
| U-008 | P0 | Sample/Record/Union Schema | nested record selection, optional/rare fields, checkpoint guidance, invalid correction preserves draft |
| U-009 | P0 | Mapping / Final Event | JSONPath + unmapped policy + JSONata/Regex where exposed; preview = delivered output |
| U-010 | P0 | Enrichment | supported static/calculated/conditional/normalize/type/time rules preview/save/read-back/deliver |
| U-011 | P0 | Multi-route fan-out | one Stream, >=2 Routes/Destinations, independent output and health |
| U-012 | P0 | Destination matrix | Webhook + release-claimed Syslog UDP/TCP/TLS test and live delivery |
| U-013 | P0 | Route Processing effective truth | shared + per-route override persists, effective state and receiver output agree |
| U-014 | P0 | Deploy and first delivery | deploy/start in UI, first real delivery verified, Runtime continuation works |
| U-015 | P1 | Terminology/guidance consistency | Connector/Stream/Route/Destination/processing/status terms and next actions do not contradict |
| U-016 | P1 | Keyboard critical path | login/nav/forms/dialogs/destructive confirm operable with visible focus/labels |
| U-017 | P0 | Dynamic Routing additive delivery | create/modify a dynamic rule through the current supported public UI; matching event adds the expected destination delivery, nonmatching event does not; runtime panel/log/receiver evidence agree; if no public mutation surface exists, record the product gap rather than configuring privately for PASS |

### 6.2 Operations

| ID | Priority | Scenario | Mandatory proof |
| --- | --- | --- | --- |
| O-001 | P0 | Post-deploy edit | UI save/reload/effective runtime/new delivery all match |
| O-002 | P0 | Source/auth failure | UI diagnosis -> corrective edit -> retest -> delivery recovery |
| O-003 | P0 | Destination failure | one Route fails, sibling continues, UI diagnosis/correction/recovery |
| O-004 | P0 | Partial-route failure | aggregate state shows partial impact without hiding failed Route |
| O-005 | P1 | Retry/failover | retry truth, no false success/loss; failover and recovery where claimed |
| O-006 | P0 | Checkpoint-after-delivery | required/unabsorbed failed delivery does not advance; `LOG_AND_CONTINUE` follows its explicit absorbed-failure exception; recovery delivers then advances where blocking policy applies |
| O-007 | P1 | Dedup/incremental | duplicate skipped per contract; new event delivers; restart continuity |
| O-008 | P0 | Stop/start/repeated action | browser stop/start works; repeated actions do not spawn phantom/duplicate runtime work |
| O-009 | P1 | Runtime/Logs traceability | delivered and failed event trace Stream -> Route -> Destination -> result |
| O-010 | P1 | Dashboard consistency | healthy/failing/recovered posture reconciles with Runtime/Route/Destination truth |
| O-011 | P1 | Refresh/service restart persistence | config/checkpoint/run state survive according to contract; delivery resumes if expected |
| O-012 | P0 | Delete lifecycle/orphans | dependency guard + browser delete + no active runtime + zero run-owned orphans |

### 6.3 Governance

| ID | Priority | Scenario | Mandatory proof |
| --- | --- | --- | --- |
| G-001 | P0 | Sensitive-data Protection | mask/tokenize/hash/drop preview/effective output equals receiver output |
| G-002 | P0 | Route-specific Classification/Policy | route override persists/effective; sibling isolation |
| G-003 | P1 | Schema drift + sensitive detection | controlled change/findings visible and configured behavior enforced |
| G-004 | P1 | Quarantine | governed event quarantined, not falsely delivered; authorized release/discard audited |
| G-005 | P1 | Replay | eligible item replayed through UI; new result observable; checkpoint/dedup intact |
| G-006 | P1 | Violations/Audit/Notifications | context, actor/result and navigable investigation remain consistent |
| G-007 | P2 | Approval/require-review | conditional: execute claimed portion; PARTIAL capability not promoted via hidden API |
| G-008 | P1 | Governance Workspace continuity | correct Stream/Route context survives drill-down/back/forward/navigation |

### 6.4 Administration / Platform

| ID | Priority | Scenario | Mandatory proof |
| --- | --- | --- | --- |
| A-001 | P0 | RBAC UI + backend parity | admin succeeds; operator UI denied/hidden and server rejects same privileged mutation |
| A-002 | P1 | Local account/password/profile | only current local-account model; no Enterprise IAM scope expansion |
| A-003 | P1 | IANA timezone | platform + user override + empty fallback; displayed local time, stored/runtime UTC |
| A-004 | P1 | Platform/network safeguards | invalid/reserved/duplicate values rejected; safe apply/reconnect/restore in disposable env |
| A-005 | P1 | Retention/cleanup | preview/dry-run where exposed; authorized cleanup respects policy and audit |
| A-006 | P0 | Backup/import/DR boundary | config import remains additive/clone semantics; PostgreSQL backup/restore proves real DR |
| A-007 | P1 | Maintenance health/support bundle | useful provenance/health; bundle contains no plaintext secrets |
| A-008 | P1 | Upgrade/rollback | pre-backup -> packaged upgrade -> health/data-flow -> rollback/restore when release claims upgrade |
| A-009 | P1 | Admin audit continuity | actor/time/object/action/result/change context traceable and secret-safe |
| A-010 | P1 | Stale writer conflict | two sessions cannot silently lose a protected concurrent update where OCC is supported |

### 6.5 Security / Failure

| ID | Priority | Scenario | Mandatory proof |
| --- | --- | --- | --- |
| S-001 | P0 | Invalid config atomicity | invalid URL/path/expression/regex/port/timezone/ref leaves no false partial success |
| S-002 | P0 | Secret leakage | forms/logs/audit/support/screenshots/evidence redact credentials/tokens/keys |
| S-003 | P0 | Authorization boundary | known URL/direct request does not bypass role restriction or leak protected object data |
| S-004 | P0 | Source auth/TLS negatives | truthful failure, actionable recovery, no false sample/delivery success |
| S-005 | P0 | Destination outage/TLS negatives | route isolation, retry/health/log/recovery correctness |
| S-006 | P0 | No false checkpoint advance | required/unabsorbed route failures cannot cross the checkpoint boundary; explicitly configured `LOG_AND_CONTINUE` must be tested as the documented absorbed-failure exception |
| S-007 | P0 | No false healthy/success | UI status never contradicts activation/route/runtime/receiver truth |
| S-008 | P0 | Destructive safeguards | impact clear, cancel safe, referenced resource protected/mediated, correct target deleted |
| S-009 | P1 | Refresh/stale-cache consistency | create/update/delete converges across requests/workers; deleted object does not reappear as current |
| S-010 | P1 | Out-of-scope containment | Phase E/F not exposed as normal Control product work; stale legacy URLs redirect safely |

### 6.6 Concurrency / Simultaneous operation

| ID | Priority | Scenario | Mandatory proof |
| --- | --- | --- | --- |
| C-001 | P1 | Parallel independent Stream builds | isolated sessions/resources do not cross-contaminate; receiver attribution remains correct |
| C-002 | P1 | Concurrent edit | intended OCC/conflict behavior; no silent lost update |
| C-003 | P1 | Route edit while siblings carry traffic | edited Route converges; sibling traffic stays correct |
| C-004 | P1 | Destination failure while traffic continues | failure isolation/retry/recovery with live traffic |
| C-005 | P1 | Repeated start/stop / duplicate user action | no duplicate runtime jobs or ambiguous phantom state |
| C-006 | P0 | Cross-worker catalog consistency | immediate post-mutation reads converge; cleanup reaches zero without stale process-local truth |
| C-007 | P1 | Governance mutation during traffic | subsequent events use new policy at documented boundary; in-flight semantics traceable |

### 6.7 Performance / Endurance

| ID | Priority | Scenario | Mandatory proof |
| --- | --- | --- | --- |
| P-001 | P1 | Baseline ingest/delivery | EPS, success/failure, checkpoint and queue/backlog evidence |
| P-002 | P1 | Multi-route under load | all intended outputs correct; slow route does not corrupt sibling route |
| P-003 | P1 | Destination failure/retry under load | isolation, bounded pressure, recovery, checkpoint correctness |
| P-004 | P1 | Control-plane responsiveness under load | Dashboard/Runtime/Logs and safe edit/stop-start remain usable |
| P-005 | P1 | Soak | no crash loop, silent loss, uncontrolled backlog, checkpoint regression or progressive stale state |
| P-006 | P2 | Restart recovery under load | config/checkpoint continuity and post-restart delivery correctness |
| P-007 | P2 | Practical saturation | only when selected by release profile; identify limiter and prove post-saturation recovery |

Where no approved numeric SLO exists, numeric performance is `MEASURED_NOT_QUALIFIED`; do not invent a threshold.

## 7. Detailed hard-gate journeys

### 7.1 First working flow

Required sequence: login -> create HTTP Connector -> connection/auth test -> Sample/Record Selection -> checkpoint decision -> Mapping/Final Event -> select/create Destination -> create Route -> Route Processing -> deploy -> browser start -> actual receiver delivery -> Runtime/Logs confirmation -> refresh/read-back -> stop.

Any browser-required mutation replaced by an API mutation makes that user step non-PASS.

### 7.2 Transform and Enrichment truth

Use deterministic multi-sample input. Verify source field -> mapping/rule -> preview -> persisted config -> effective Route output -> actual delivered event. Include no-match/null/invalid input behavior and confirm warnings/errors are not silently converted to successful output.

### 7.3 Multi-route effective processing

At least one route inherits shared processing and one uses a route-specific override. Verify Transform, Protection, Classification, and Policy effective state as applicable, then use a fixture whose destination outputs prove the difference.

### 7.4 Failure -> diagnosis -> corrective action -> recovery

Execute at least one source/auth failure and one destination failure from an initially healthy system. Start the incident persona from Dashboard/Runtime symptoms, not from hidden fixture knowledge. PASS requires public diagnosis, corrective UI action, restored actual delivery, and reconciled health/log state.

### 7.5 Checkpoint safety

Healthy required delivery advances. A required/unabsorbed failed delivery must not falsely advance. Separately, configure and exercise `LOG_AND_CONTINUE`: its failed route send is an explicitly absorbed outcome and may advance checkpoint according to `specs/004-delivery-routing/spec.md`. After recovery under a blocking/retry policy, the intended item is delivered and checkpoint then advances. Runtime/Logs/checkpoint views must agree in both cases.

### 7.6 Destructive lifecycle

Delete a Route/Stream and run-owned dependent resources through public UI. Dependency protection and impact confirmation must be understandable. Final orphan counts for run-owned Connector/Stream/Destination/Route are zero.

## 8. Current capability dispositions

Before every full run, rebuild the candidate's current capability ledger. At minimum explicitly disposition:

- core sources: HTTP API, PostgreSQL Database Query, Webhook Receiver;
- release-extension sources: S3, Remote File/SFTP;
- destinations: Webhook, Syslog UDP/TCP/TLS;
- HTTP auth modes currently marked supported;
- Mapping: JSONPath, full-event JSONata/Regex, unmapped-field policy;
- Enrichment supported rule types; lookup separately if still PARTIAL;
- Route global/per-route processing and delivery settings;
- Governance: Protection actions, sensitive detection, schema drift, Classification, Policy, Quarantine, Replay, audit/violations/notifications;
- Runtime: retry/backoff, failover, checkpoint-after-delivery, dedup, partial-route failure, restart recovery, health/metrics/logs;
- Dynamic Routing: mandatory from Product Charter/runtime architecture even if the generated capability inventory currently lacks a dedicated `dynamic_routing` capability ID; execute matching and nonmatching rules with additive receiver evidence and record the inventory omission as reconciliation drift until corrected;
- PARTIAL rate-limit/require-review/webhook-header behavior;
- current browser lifecycle infrastructure status.

Required reconciliation record:

~~~text
CAPABILITY_ID=
PRODUCT_AUTHORITY=
RELEASE_CLAIM=
USE_CASE_ID=
HUMAN_SCENARIO_IDS=
AUTOMATED_BROWSER_SCENARIO_IDS=
LOWER_LEVEL_TESTS=
REAL_EFFECT_REQUIRED=
RESULT=
GAP=
~~~

Completion requires zero **supported product-surface capabilities** without a real user use case and zero PARTIAL capabilities silently counted as supported PASS. Inventory rows whose purpose is test infrastructure or feature-flag enforcement are validation-support rows: they require explicit qualification disposition, but they are not invented into end-user use cases.

## 9. Relationship to `e2e/user-lifecycle`

The current automated package is a mandatory browser-first implementation layer. Its group intent maps approximately as:

| Automated group | Human contract intent |
| --- | --- |
| 00 | package/browser smoke only |
| 01 | Connector onboarding |
| 02 | authentication/recovery |
| 03 | Stream Wizard/create |
| 04 | sample/schema/record selection when implemented |
| 05 | Destinations/Routes |
| 06 | Protection/Transform output |
| 07 | browser start + actual delivery |
| 08 | source/destination failure + diagnosis |
| 09 | recovery |
| 10 | production edit |
| 11 | stop/start |
| 12 | destructive lifecycle |
| 13 | cleanup/orphans |
| 17/28/30/38/41/43/44/46 | targeted HTTP, persistence, checkpoint, dependency, observation, invalid-input and repeated-action contracts |

Exact scenario IDs are captured from the candidate during execution. Harness PASS supports but does not automatically grant human UX PASS.

## 10. Evidence and result rules

Allowed scenario results: `PASS`, `FAIL`, `BLOCKED_ENVIRONMENT`, `BLOCKED_TOOLING`, `NOT_APPLICABLE`, `NOT_APPLICABLE_NOT_CLAIMED`, `NOT_RUN_BY_SCOPE`, `MEASURED_NOT_QUALIFIED`.

`BLOCKED_*` is never PASS. `NOT_APPLICABLE` requires an explicit product/platform reason. `NOT_RUN_BY_SCOPE` is valid only for an explicitly narrowed request. If any execution layer uses `PARTIAL`, aggregate Full User E2E remains non-PASS until dispositioned.

Per scenario retain:

~~~text
SCENARIO_ID=  USE_CASE_ID=  PERSONA=  MISSION=
START_UTC=  END_UTC=  SOURCE_HEAD=  BUILD_OR_IMAGE_ID=  WORKTREE_CLEAN=
BROWSER=  DISCOVERY_PATH=  USER_ACTIONS=  PUBLIC_GUIDANCE_USED=
EXPECTED=  OBSERVED=  PERSISTED_STATE=  EFFECTIVE_RUNTIME_STATE=
REAL_EFFECT_EVIDENCE=  NEGATIVE_VARIANT=  RECOVERY_RESULT=  CLEANUP_RESULT=
TERMINOLOGY_CONSISTENT=  CURRENT_STATE_CLEAR=  ACTION_IMPACT_CLEAR=  NEXT_ACTION_CLEAR=
RESULT=  FAILURE_CLASS=  EVIDENCE_PATHS=  NOTES=
~~~

Secrets/tokens/passwords/private keys must be redacted from retained/shared evidence.

## 11. Cleanup contract

Every run uses namespaced disposable resources. At completion verify:

~~~text
RUN_OWNED_CONNECTORS_REMAINING=0
RUN_OWNED_STREAMS_REMAINING=0
RUN_OWNED_DESTINATIONS_REMAINING=0
RUN_OWNED_ROUTES_REMAINING=0
UNEXPLAINED_RUNTIME_JOBS_REMAINING=0
LIVE_OPERATOR_DATA_TOUCHED=NO
~~~

Cleanup failure prevents a clean Full User E2E PASS.

## 12. Final FULL_USER_E2E report

A full run must end with at least:

~~~text
PHASE=FULL_USER_E2E
PRODUCT=DATA_RELAY_CONTROL
EXECUTOR=ChatGPT
FINAL_AUDITOR=ChatGPT
FINAL_STATUS=PASS|PARTIAL|FAIL
TEST_CONTRACT_HEAD=
SOURCE_HEAD=
BUILD_OR_IMAGE_ID=
PRODUCT_VERSION=
DB_SCHEMA_HEAD=
QUALIFICATION_BROWSER=
USER_DATA_BUILDER_SCENARIOS=
OPERATIONS_SCENARIOS=
GOVERNANCE_SCENARIOS=
ADMIN_PLATFORM_SCENARIOS=
SECURITY_NEGATIVE=
CONCURRENCY_CONSISTENCY=
PERFORMANCE_FUNCTIONAL=
PERFORMANCE_NUMERIC_QUALIFICATION=
PUBLIC_UI_SURFACE_COVERAGE=
SUPPORTED_CAPABILITY_COVERAGE=
BROWSER_USER_MUTATIONS=
PRIVATE_API_USER_ACTION_SUBSTITUTIONS=
REAL_DELIVERY=
CHECKPOINT_AFTER_DELIVERY=
MULTI_ROUTE_ISOLATION=
DYNAMIC_ROUTING=
SOURCE_FAILURE_RECOVERY=
DESTINATION_FAILURE_RECOVERY=
STOP_START=
DESTRUCTIVE_LIFECYCLE=
CLEANUP_ORPHANS=
DASHBOARD_RUNTIME_CONSISTENCY=
LOG_TRACEABILITY=
TERMINOLOGY_CLARITY_CROSS_SURFACE=
DISCOVERABILITY_DEFECTS=
AMBIGUOUS_GUIDANCE_FINDINGS=
AUTOMATED_BROWSER_LIFECYCLE=
EXACT_HEAD_MACHINE_QUALIFICATION=
PUBLIC_SMOKE=
OWNER_ACCEPTANCE=
SCENARIO_TOTAL=
SCENARIO_PASS=
SCENARIO_FAIL=
SCENARIO_BLOCKED=
MANDATORY_SCENARIOS_UNEXECUTED=
SUPPORTED_PRODUCT_CAPABILITIES_WITHOUT_USE_CASE=
PARTIAL_CAPABILITIES=
UNRESOLVED_P0=
UNRESOLVED_P1=
USER_BLOCKING_P2=
BLOCKERS=
EVIDENCE_ROOT=
~~~

If final status is not PASS, list the exact failing/blocking scenario IDs.

## 13. Maintenance rule

Review this document in the same workstream whenever product scope, public navigation/Wizard stages, source/auth/destination support, Mapping/Enrichment, Route Processing, Dynamic Routing, checkpoint/dedup/retry/failover, Governance, Dashboard/Runtime/Logs semantics, RBAC/Admin/DR/upgrade contract, browser lifecycle acceptance, or release qualification changes.

Future Full User E2E invariant:

~~~text
USER_E2E_REQUEST
-> open docs/FULL_USER_E2E_SCENARIOS.md
-> capture exact candidate/build identity
-> act as a human black-box persona
-> discover next actions through the public UI
-> use browser UI for user mutations
-> verify persisted/effective runtime truth after UI action
-> verify actual external delivery where the scenario is about delivery
-> exercise negative + recovery behavior
-> continue independent lanes after findings
-> reconcile capability/UI/automation coverage
-> clean run-owned resources
-> report FAIL/BLOCKED/NOT_APPLICABLE honestly
-> only then enter engineering diagnosis/fix workflow
~~~

## Appendix A — Deliberate translation from Data Relay Link

This contract carries over the **testing philosophy** of Data Relay Link's `FULL_USER_E2E_SCENARIOS.md`, not Link-specific product mechanics.

| Data Relay Link concept | Data Relay Control equivalent |
| --- | --- |
| public CLI discovery | public browser UI discovery |
| command/variant coverage | capability + UI surface + user-action coverage |
| published network service real traffic | Source -> Stream -> Route -> Destination real data delivery |
| endpoint/policy truth | effective Route + Runtime-as-Truth + receiver truth |
| User / Agent Operator / DRLink Administrator | Data Builder / Operations / Governance / Administrator personas |
| AI-assisted CLI mirror | excluded: Phase E is outside current Control scope |
| throughput/CPS/connectivity stress | ingest/delivery EPS, route isolation, retry/backpressure, soak, control-plane responsiveness |

Carried over unchanged in spirit: one canonical entry point, persona-based black-box execution, use-case coverage instead of shallow sweep, current-run candidate evidence, negative/recovery and cleanup, independent-lane continuation after defects, explicit blocked/not-applicable outcomes, functional behavior under concurrency/load, and cross-surface terminology/guidance grading.

Product semantics remain governed by Data Relay Control's own Source of Truth.

## Appendix B — Current capability-inventory reconciliation oracle

This appendix snapshots the current Phase A–D capability inventory used while authoring this contract. It is an **auditor reconciliation oracle**, not a higher-level product authority. Rebuild/reconcile it against the tested candidate at execution time.

Authoring snapshot:

The current generated inventory has no dedicated Dynamic Routing capability row even though Dynamic Routing is explicitly in the Product Charter and implemented runtime/UI observation path. Product authority wins: U-017 is mandatory, and the missing inventory row is recorded as reconciliation drift rather than silently dropping the feature from E2E.

~~~text
TOTAL=95
SUPPORTED=84
PARTIAL=6
UI_ONLY=2
OUT_OF_SCOPE=3
~~~

Current supported capability IDs:

~~~text
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
source.http_api_polling
source.s3_object_polling
source.database_query_postgresql
source.remote_file_polling
source.webhook_receiver
destination.syslog_udp
destination.syslog_tcp
destination.syslog_tls
destination.webhook_post
wizard.step.connect
wizard.step.sample
wizard.step.destinations
wizard.step.route_processing
wizard.step.deploy
wizard.feature.connection_auth_test
wizard.feature.record_path
wizard.feature.event_root
wizard.feature.union_schema
wizard.feature.checkpoint
wizard.feature.incremental_fetch
wizard.feature.dedup
wizard.feature.resume
wizard.feature.stream_edit
processing.enrichment.static
processing.enrichment.calculated
processing.enrichment.conditional
processing.enrichment.normalize
processing.enrichment.timestamp_conversion
processing.enrichment.type_conversion
processing.enrichment.jsonata
processing.mapping.field_jsonpath
processing.mapping.full_event_jsonata
processing.mapping.full_event_regex
processing.mapping.unmapped_policy
routes.architecture.one_stream_many_routes
routes.global_processing
routes.per_route_transform
routes.per_route_protection_classification_policy
routes.delivery_settings
routes.metrics_health
governance.protection.audit
governance.protection.mask
governance.protection.tokenize
governance.protection.hash
governance.protection.drop_field
governance.delivery.continue
governance.delivery.quarantine
governance.delivery.block
governance.sensitive_detection
governance.schema_drift
governance.classification
governance.policy
governance.replay
governance.quarantine_ops
governance.audit_violations_notifications
runtime.retry_backoff
runtime.timeout
runtime.failover
runtime.checkpoint_after_delivery
runtime.dedup
runtime.partial_route_failure
runtime.process_restart_recovery
runtime.health_metrics_audit_logs
flag.gdc_route_processing_enabled
flag.gdc_protection_enabled
flag.gdc_sensitive_detection_enabled
flag.gdc_classification_enabled
test.pytest.wiremock_e2e
test.source_adapter_e2e
test.dev_validation_lab
test.wiremock_auth_fixtures
~~~

Current PARTIAL capability IDs — each requires explicit disposition and may not be silently counted as full support:

~~~text
auth.destination.webhook_headers
processing.enrichment.lookup
governance.delivery.require_review
runtime.rate_limit
runtime.fault_injection.fixtures
test.playwright.browser_e2e
~~~

Current UI-only heuristic capability IDs — validate UX behavior but do not treat them as independent runtime truth:

~~~text
wizard.feature.rare_field
wizard.feature.sensitive_suggestion
~~~

Current out-of-scope IDs — excluded from Data Relay Control Phase A–D coverage/readiness denominators:

~~~text
auth.ai_provider.api_key_or_bearer
source.ai_proxy_receiver
destination.ai_provider_post
~~~

Required reconciliation invariant:

~~~text
SUPPORTED_PRODUCT_CAPABILITIES_WITHOUT_USE_CASE=0
SUPPORTED_CAPABILITIES_WITHOUT_SCENARIO_DISPOSITION=0
TEST_OR_FLAG_ROWS_WITHOUT_VALIDATION_DISPOSITION=0
PARTIAL_CAPABILITIES_WITHOUT_EXPLICIT_DISPOSITION=0
UI_ONLY_CAPABILITIES_MISREPRESENTED_AS_RUNTIME_TRUTH=0
OUT_OF_SCOPE_CAPABILITIES_IN_CONTROL_DENOMINATOR=0
~~~
