# Data Relay Control Repository Engineering Rules

This repository follows the canonical Data Relay Labs Engineering System:
https://github.com/datarelay-labs/engineering-system

Adoption baseline: version 1.3.1 at commit `165cc976cae1b6ef30c7bf90800eed289df3c6fa`.

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

1. Actual code, schema, configuration, and runtime truth
2. Current Data Relay Product Charter, source-of-truth index, and current implementation specs
3. Valid Data Relay-specific stricter repository rules
4. Canonical Engineering System common engineering rules
5. Derived/general AI guidance
6. Historical conversation or superseded documents

Project-specific invariants remain in the current product/spec documents and retained `.cursor/rules/*.mdc`. Do not duplicate their full text here.

## Execution rules

- Preserve unrelated user work, persisted data, and live configuration.
- Make the smallest correct change and do not silently expand scope.
- Run the cheapest affected deterministic tests first and expand only by risk.
- Bug fixes should add durable regression coverage whenever practical.
- Never weaken valid tests merely to obtain PASS.
- Never reuse different-HEAD or historical evidence as current qualification.

## Session continuity

When explicitly resuming work, resolve this repository and branch first, load exactly one matching active repository-scoped AI Work Packet, verify actual HEAD/dirty/PR/CI state, and continue only from its Next Action.

Tool-specific adapters must not weaken these rules.
