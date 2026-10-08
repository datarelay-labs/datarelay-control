# Data Relay Control Repository Engineering Rules

This repository follows the canonical Data Relay Labs Engineering System:
https://github.com/datarelay-labs/engineering-system

Adoption baseline: Engineering System version 1.7.0 at immutable commit `d41b4cf5d47b47c25c0d7b7520a8f1262d19923c`.

## Minimum context first

Always read:
1. `AGENTS.md`
2. `.engineering/project.yaml`

Then only when relevant:
3. `.engineering/tests.yaml` for implementation/debugging/testing
4. `.engineering/release.yaml` for release/version/artifact work
5. Only the task-relevant product specification, ADR, runbook, or Engineering System standard

Do not preload all standards, archived specifications, historical audits, or Wiki content.

## Repository authority

Use `docs/architecture/source-of-truth-index.md` as the canonical authority map. Do not infer authority from a filename, directory name, document age, or implementation convenience.

For intended product behavior:
1. `docs/source-of-truth/PRODUCT-CHARTER-Version-1.2.1-FINAL.txt` — top-level product authority.
2. Current subordinate product/UX documents explicitly designated by `docs/architecture/source-of-truth-index.md`.
3. The current task-relevant implementation spec under `specs/`.
4. ADRs/runbooks only for the bounded architecture decision or operational procedure they own.

Actual code, schema, configuration, migrations, runtime state, and deterministic tests are authoritative evidence of what exists now, but they do not override an explicit current product requirement merely because implementation has drifted.

`.engineering/*` defines engineering process, validation selection, and release evidence; it is not a product-feature specification. README/architecture overview/release notes/audits/Wiki are derived or historical unless the authority map explicitly gives them a stronger role.

If two current normative artifacts conflict, fail closed and surface the conflict. Do not resolve it from version-looking filenames, commit dates, or AI inference. Known filename/internal-version mismatches are recorded in `docs/source-of-truth/README.md`; do not silently rewrite those source documents.

Historical or explicitly retired behavior is not protected by no-regression policy. If an old test conflicts with current authority, verify whether the test is stale before changing implementation.

## Data Relay Control invariants

- Delivery architecture: **One Stream → Many Routes → Many Destinations**.
- Route Processing is the only supported product runtime path. Do not resurrect the retired flag-OFF / parallel stream-scoped pipeline as a first-class runtime.
- Prefer the existing operational Runtime Snapshot read path for operational UI/data when it already supplies the required information; do not add duplicate runtime queries or APIs without a contract need.
- Preserve operational visibility required by current Source of Truth, including EPS, delivery success, checkpoint state, route health, and delivery health where those surfaces require them.
- Preserve user-created connectors, streams, sources, destinations, routes, mappings, checkpoints, and persisted configuration. Do not delete, truncate, reset, or overwrite live/operator data unless the user explicitly requests the specific destructive action. Destructive fixtures and resets must target test-only databases.
- Repository artifacts are English by default: source identifiers/comments, user-facing product copy, docs/specs, commit messages, PR descriptions, and repository rules. Chat replies may follow the user's language.
- Do not hard-code temporary release scope into permanent rules. For AI Gateway / AI Proxy or other release-scoped capabilities, read the current Product Charter and current release scope/limitations when the task is relevant.

## Validation

- Use `.engineering/tests.yaml` as the repository validation map.
- Run the cheapest affected deterministic checks first and expand by risk.
- Current-requirement tests must not be weakened merely to get PASS.
- Retired/historical tests may be changed or removed when the current Source of Truth explicitly retired that behavior.
- Changes affecting the Dev Validation Lab, visible E2E seed, seeding/throughput configuration, or equivalent validation runtime must preserve the configured **5–20 EPS** invariant and run the dedicated validation scenario in `.engineering/tests.yaml`.

## Execution rules

- For `project.user_facing: true`, require Surface Reconciliation and Full User E2E on the same exact candidate. Before either named gate, read its entire current repository-local contract and execute it as the applicable User/Operator/Admin persona on the actual public surface. Drivers and scripts may support real actions, never substitute synthetic PASS. Follow `standards/USER_ACCEPTANCE.md`; do not restart the complete gate after every individual fix. Close findings with affected reruns, then one fresh complete confirmation.
- **Next-chat bootstrap fast path:** perform one bounded lookup when resuming durable work. With no ACTIVE packet, inspect current roadmap/Git/PR facts once and enter safe owner-authorized work; create or repair one packet when continuity needs it, not as a permission prerequisite. `NO_ACTIVE_PACKET` is a scheduling input, not a blocker.
- **Verified next-chat resume:** re-read the current Issue and mutable repo/worktree/HEAD/profile once; if unchanged, enter the persisted Next Action immediately. Do not replay handoff validation, rewrite unchanged state or reconstruct transcripts. Revalidate only changed facts.
- **Product execution ownership / supervisor fallback:** the product context owns product work. Engineering System owns shared policy, adoption and systemic recovery, including uncontrolled Issue proliferation. Repair only what restores product autonomy, then return ownership. Never mutate an actively progressing owner-authorized worker dirty worktree or create a competing product lane.
- **Execution profile authority:** `.engineering/execution-profile.yaml` selects the runtime unless the current explicit owner instruction overrides it. A continue/resume request authorizes direct implementation, testing, audit and ordinary Git/GitHub work; no additional magic phrase or alternate-runtime handoff is required. Historical prose and retired adapters do not select a runtime. Before claiming missing tools or access, discover the connected task-relevant tools and attempt a minimal authorized action when exposed. Reuse successful same-session, same-target, same-action evidence unless a fresh failure or scope change invalidates it. Report the exact attempted operation and observed error; unattempted is not denied. Existing approvals and explicit tool denials remain binding.
- For ordinary authenticated GitHub Issue/PR coordination, re-read the intended target, branch/HEAD and any packet relied on before writing; reconcile ambiguous outcomes before retrying. Stronger trusted boundaries apply only to effect classes production, destructive, credential/permission change, irreversible publication and release authority, or stricter project policy; follow `standards/SECURITY.md`.
- **Execute useful work continuously.** **Execution authority precedence:** the current explicit owner instruction governs, then the fresh Work Packet, execution profile and repository rules. Historical Issue comments and prior handoffs are evidence only and never execution authority. Bind the owner-selected repository and verify actual branch/HEAD/worktree before mutation; cross-project references never retarget work without explicit owner scope. Implement, test and audit in coherent batches; make measurable progress in the same turn. Repair stale coordination state within owner scope instead of stopping. Advance independent work during machine-observable waits instead of polling; after a bounded task return to roadmap priority. While this turn can execute, continue until the requested roadmap/release objective is complete, no safe runnable work remains, genuine owner input is needed, or a real platform/tool/safety boundary stops execution. Attempt the next safe authorized action before giving a progress-only report, and reselect roadmap work after each verified batch. If work remains when this turn ends, preserve actual progress and the precise Next Action and report the incomplete state without claiming background execution. `tools/work_admission.py disposition` is an optional pure scheduling diagnostic; its `FINAL_ALLOWED` value cannot control the lifecycle of a ChatGPT response. Status-only requests are exempt.
- Classify the change and identify affected domains/contracts/security/operations.
- For material design-bearing changes, apply the canonical `standards/DESIGN.md` minimal design gate before implementation.
- Preserve unrelated user work and dirty worktrees.
- Make the smallest correct change and do not silently expand scope.
- Bug fixes should add durable regression coverage whenever practical.
- Never report skipped, blocked, historical, or different-HEAD evidence as current PASS.
- Before merge or terminal completion, inspect machine-observable PR review feedback. Fix and revalidate every actionable review finding, or explicitly disposition it with concise evidence when it is non-actionable, out of scope, or incorrect. Do not treat COMMENTED/advisory review state as automatic PASS.
- Runtime behavior may change only when required by the requested task or current Source of Truth; when it changes, run the affected runtime validation defined in `.engineering/tests.yaml`.
- If the user reports an outage, degraded service, failed upgrade, data-loss risk, or other production-impacting symptom, switch to the canonical `standards/OPERATIONS.md` incident lifecycle. Preserve evidence before mutation and do not perform destructive/irreversible recovery without explicit approval unless an approved runbook authorizes it.
- When the user explicitly asks to apply/adopt/bootstrap the Engineering System to this repository, use the canonical `standards/ADOPTION.md` workflow.

## Session continuity

When resuming, reconcile current owner intent, priority, dependencies and branch context; select eligible work and verify actual repository state before acting.

Tool-specific adapters must not weaken these rules.

## Implementation and audit contract





The selected runtime performs implementation, deterministic testing, and terminal audit. Terminal PASS requires current exact-HEAD evidence, required CI/review state, and disposition of actionable findings; self-report alone is never sufficient. HIGH/CRITICAL or production/security-sensitive work requires deeper machine evidence and any applicable human approval. Codex or another independent reviewer is optional defense-in-depth/escalation, not a default completion dependency.

## Browser feature-scenario reconciliation execution shortcut

When the user says `브라우저 상에서 버튼, 기능, 시나리오 연계테스트를 진행해`, `브라우저 버튼 기능 시나리오 연계테스트 진행해`, or an equivalent Browser ↔ Feature ↔ Scenario reconciliation request, execute `docs/BROWSER_FEATURE_SCENARIO_RECONCILIATION.md` immediately.

This is an execution request, not a plan-only request. ChatGPT Chat owns the run end to end: onboarding, exact audit-HEAD pinning (not release-candidate freeze), isolation, browser-first control inventory, mandatory BFS scenarios, persistence/runtime verification, failure continuation, evidence retention, cleanup/offboarding, and GitHub reporting.

For browser-required user actions, API/runtime/database are verification or forensic layers only. They must never replace a blocked browser action and promote the scenario to PASS.

Do not patch product code during the active reconciliation audit. Exhaust independent scenarios, freeze evidence, complete offboarding, then create bounded remediation Work Packets for findings.

## Full User E2E and pre-release exhaustive user-test gates

When the user says `Full User E2E 진행해`, `사용자 E2E 진행해`, `전체 사용자 E2E 진행해`, or equivalent wording without narrower scope, execute `docs/FULL_USER_E2E_SCENARIOS.md` immediately. This is an execution request, not a planning request. ChatGPT Chat owns onboarding, exact audit-HEAD isolation (not release-candidate freeze), browser execution, runtime/delivery verification, failure continuation, cleanup/offboarding, GitHub reporting, and final status.

For release readiness after the product roadmap implementation is complete, the mandatory closure order is:

`Browser Feature Scenario Reconciliation ↔ bounded remediation/re-audit until clean → Full User E2E ↔ bounded remediation/re-run until clean → candidate freeze → exact-head machine qualification/final CI → owner/manual acceptance → release authorization`.

A repository-level `DR Control 계속` / continue-resume after feature implementation closure must enter or continue the Browser reconciliation/remediation loop first. It must not select candidate freeze, full machine qualification, release CI, hashes/provenance, or public smoke while required Browser or Full User E2E closure is still incomplete.

The final Browser Feature Scenario Reconciliation PASS and final Full User E2E PASS must be established on the same exact HEAD; that HEAD becomes the release candidate only after both gates are clean. If Full User E2E remediation changes browser-visible/product behavior, re-establish the affected Browser reconciliation gate before rerunning Full User E2E. If later machine qualification finds a defect that requires a product change, unfreeze the candidate and return to the appropriate user-test loop before freezing a new candidate.

Both exhaustive tests must use an actual Chromium/Chrome browser process driven by ChatGPT (Playwright is allowed as the driver; headless Chromium still counts as a real browser). jsdom/component tests, API-only flows, static DOM inspection, and CI contract checks do not count as execution PASS. Neither exhaustive test substitutes for the other, and machine Full Regression / operational E2E passes do not substitute for either ChatGPT-executed exhaustive user test. CI/static contract validation only proves the gates are wired; actual PASS authority is the active release Work Packet plus retained exact-HEAD browser run evidence.

Do not freeze or declare a release candidate ready while either required exhaustive test is missing, PARTIAL, BLOCKED, from another final HEAD, or has unresolved P0/P1/user-blocking P2 findings.
