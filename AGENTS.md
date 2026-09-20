# Data Relay Control Repository Engineering Rules

This repository follows the canonical Data Relay Labs Engineering System:
https://github.com/datarelay-labs/engineering-system

Adoption baseline: Engineering System version 1.5.0 at immutable commit `b2b6f64febb52f2c033eedc7af7570c220fca887`.

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

- Classify the change and identify affected domains/contracts/security/operations.
- For material design-bearing changes, apply the canonical `standards/DESIGN.md` minimal design gate before implementation.
- Preserve unrelated user work and dirty worktrees.
- Make the smallest correct change and do not silently expand scope.
- Bug fixes should add durable regression coverage whenever practical.
- Never report skipped, blocked, historical, or different-HEAD evidence as current PASS.
- Runtime behavior may change only when required by the requested task or current Source of Truth; when it changes, run the affected runtime validation defined in `.engineering/tests.yaml`.
- If the user reports an outage, degraded service, failed upgrade, data-loss risk, or other production-impacting symptom, switch to the canonical `standards/OPERATIONS.md` incident lifecycle. Preserve evidence before mutation and do not perform destructive/irreversible recovery without explicit approval unless an approved runbook authorizes it.
- When the user explicitly asks to apply/adopt/bootstrap the Engineering System to this repository, use the canonical `standards/ADOPTION.md` workflow.

## Session continuity

When explicitly resuming work, resolve this repository and branch first, load exactly one matching active repository-scoped AI Work Packet, verify actual HEAD/dirty/PR/CI state, and continue only from its Next Action.

Tool-specific adapters must not weaken these rules.
