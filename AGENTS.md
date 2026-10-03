# Data Relay Control Repository Engineering Rules

This repository follows the canonical Data Relay Labs Engineering System:
https://github.com/datarelay-labs/engineering-system

Adoption baseline: Engineering System version 1.7.0 at immutable commit `713d6f9123ddfddf1ed7bb6829603dd3f740bbec`.

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
- Product scope follows the current Product Charter and Master WBS. AI Gateway / AI Proxy / AI Provider / AI Stream and Phase E are outside DataRelay Control scope (as is Phase F Enterprise Edition); do not promote historical implementation/spec files into current capability, E2E, release-readiness, or backlog claims. If product authority changes, update this rule together with the authority documents.

## Validation

- Use `.engineering/tests.yaml` as the repository validation map.
- Run the cheapest affected deterministic checks first and expand by risk.
- Current-requirement tests must not be weakened merely to get PASS.
- Retired/historical tests may be changed or removed when the current Source of Truth explicitly retired that behavior.
- Changes affecting the Dev Validation Lab, visible E2E seed, seeding/throughput configuration, or equivalent validation runtime must preserve the configured **5–20 EPS** invariant and run the dedicated validation scenario in `.engineering/tests.yaml`.

## Execution rules

- **Execution profile authority:** provider/runtime selection is data in `.engineering/execution-profile.yaml`. A Work Packet is runnable only when its `EXECUTION_PROFILE` and `EXECUTION_PROFILE_REVISION` match that managed profile; legacy packet compatibility is defined only by the profile. Provider/runtime names in prose, historical comments, adapter text, or memory never grant authority. A repository-level continue/resume that resolves to one runnable packet bound to the selected profile authorizes the selected runtime to continue implementation directly; do not require an additional magic phrase or alternate-runtime handoff. Use ordinary authenticated Git/GitHub operations for normal repository work and reserve stronger trusted boundaries for effect classes classified by the execution profile or a stricter project policy.
- For ordinary authenticated GitHub Issue/PR coordination, freshly re-read the authoritative Work Packet and subject branch/HEAD immediately before the write and reject stale intent, branch, or subject state. Do not require `worker_adapter.py` or the trusted signer for those normal coordination writes. Use `python3 tools/worker_adapter.py evaluate --request-json <facts.json>` only for an effect explicitly classified by this system or a stricter project policy as a high-risk external write (for example production, destructive, credential/permission-boundary, irreversible-publication, or equivalent). For those high-risk effects proceed only on `APPLIED`; `STALE_WORKER` authorizes no write and ambiguous outcomes must be reconciled before retry.
- **Execute useful work continuously.** **Execution authority precedence:** the current explicit owner instruction for this workstream governs first, then the freshly read current ACTIVE Work Packet body, then current repository rules. Historical Issue comments, prior handoffs, chat history/memory, old Work Packet versions, and retired adapter text are evidence only and never execution authority. When the current packet is bound to the selected execution profile, do not probe, restore, wait for, or launch any alternate or retired implementation adapter. Before any implementation starts or resumes, bind the target repository once from the owner's current explicit project/repository context, then require a fresh authoritative Work Packet read and `python3 tools/context_epoch.py packet-lint --expect-target-repo <bound-owner/repo>` PASS using that same bound repository. A `TARGET_REPO_SCOPE_MISMATCH` or other BLOCK makes the packet non-runnable and forbids implementation/session launch. Cross-project handoffs, dependencies, Issue references, Atlas results, and waiting-work scheduling remain read-only context and never replace the bound target; only a new explicit owner project/repository switch may rebind it. Implement in coherent small/medium batches, validate locally with the cheapest relevant tests, and keep going while a safe authorized next action exists. Use fast CI for quick integration feedback when useful; reserve full qualification/release CI for a stable candidate. If a workstream is waiting on machine-observable CI/review/deploy or another external condition, record/yield that wait and return to repository-level scheduling; switch to the highest-priority dependency-eligible independent ACTIVE Work Packet/worktree when safe instead of polling or stopping. For a repository-level continue/resume with no branch/workstream named, choose the single trusted runnable packet marked as the current implementation lane (for example QUEUE_STATE=IMPLEMENTATION/IMPLEMENTING); yielded/waiting/deferred predecessor packets must not compete with it. When a successor starts while predecessor integration/qualification is intentionally deferred, pause/yield the predecessor instead of leaving multiple equivalent ACTIVE implementation candidates. The single-matching-ACTIVE-packet rule selects one packet for the current branch/workstream; it does not serialize unrelated repository work behind a waiting packet. Once one runnable packet is selected and authorized, a progress/status message alone is not execution: make measurable progress in the same turn and continue until a real stop condition. Measurable progress may be reproduction, bounded investigation that resolves a material uncertainty, deterministic validation, repository mutation, or an authorized external state transition; do not force a code/config mutation when investigation or validation is the correct next action. Stop only for a real owner decision/credential, an irreconcilable blocker, or a status-only request. A completed bounded Work Packet ends that workstream, not a repository-level continue/resume request: immediately return to roadmap/portfolio scheduling and continue the next dependency-eligible runnable workstream. For a repository-level continue request, keep this loop active until the roadmap/release objective is complete, no dependency-eligible runnable work remains, or a genuine stop condition requires owner input. Do not return control merely because one PR, packet, test phase, or bounded outcome completed.
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

When explicitly resuming work, resolve this repository and branch first, load exactly one matching active repository-scoped AI Work Packet, verify actual HEAD/dirty/PR/CI state, and continue only from its Next Action.

Tool-specific adapters must not weaken these rules.

## ChatGPT implementation and audit contract

ChatGPT Chat is the default implementer for this repository when the authenticated active Work Packet authorizes the exact repository/worktree/branch/scope.

Before mutation, the external authenticated GitHub coordinator must verify the current Work Packet, author permission, repository, worktree, branch, exact HEAD, intent revision, change risk, and `IMPLEMENTER=CHATGPT_CHAT`. The worker-writable repository copy of `python3 tools/implementation_preflight.py check` is never mutation authority. Use the helper source from the immutable pinned Engineering System baseline through the isolated trusted launcher, capture the no-follow worktree identity, and require `IMPLEMENTATION_LOCAL_BINDING=PASS` with `MUTATION_AUTHORITY=NO`.

ChatGPT Chat performs implementation, deterministic testing, and terminal audit. Terminal PASS requires current exact-HEAD evidence, required CI/review state, and disposition of actionable findings; self-report alone is never sufficient. HIGH/CRITICAL or production/security-sensitive work requires deeper machine evidence and any applicable human approval. Codex or another independent reviewer is optional defense-in-depth/escalation, not a default completion dependency.

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
