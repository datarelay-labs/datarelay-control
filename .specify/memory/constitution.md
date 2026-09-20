# Data Relay Control Specification Constitution

**Status:** Current implementation-governance bridge
**Last reviewed:** 2026-09-20

This file is deliberately small. It does not replace the Product Charter or duplicate every product requirement.

## Authority

Use `docs/architecture/source-of-truth-index.md` as the repository authority map.

For intended behavior, the precedence is:

1. `docs/source-of-truth/PRODUCT-CHARTER-Version-1.2.1-FINAL.txt` — top-level product identity, scope, non-goals, and durable principles.
2. The current subordinate product/UX documents explicitly listed by `docs/architecture/source-of-truth-index.md`.
3. The current task-relevant implementation specification under `specs/`.
4. ADRs/runbooks only for the architecture or operational decision they own.

Actual code, schema, configuration, runtime state, and deterministic tests are authoritative evidence of what exists now. They do not silently redefine intended product behavior when implementation has drifted.

If two current normative artifacts conflict, fail closed: do not infer a resolution from age, filename, implementation convenience, or historical behavior. Record the conflict and obtain an explicit product/specification decision.

## Non-negotiable product/runtime invariants

- Data Relay is an Enterprise Data Control Gateway; it is not an IAM, SIEM, SOAR, workflow, data-lake, or AI-agent platform.
- Delivery architecture is **One Stream → Many Routes → Many Destinations**.
- **Stream** is the execution unit. **Route** is the destination-specific processing unit.
- Destination-specific Transform, Protection, Classification, and Policy behavior is modeled through Routes rather than duplicated Streams.
- Route Processing is the only supported product runtime path. Do not reintroduce a parallel legacy runtime as a first-class path.
- Checkpoint advancement occurs only after successful delivery according to the current runtime/delivery contract.
- Connector, Source, Stream, Route, and Destination remain distinct product/runtime concepts.
- Mapping and Enrichment remain distinct implementation concerns even when UX presents them through a unified Transform workflow.
- Runtime extensions reuse the existing orchestration and adapter/registry boundaries; do not create duplicate delivery/governance engines.
- Production/development database behavior targets PostgreSQL; do not introduce SQLite fallback semantics.
- Preserve operator-created configuration and data unless an explicit destructive operation is requested.

## Specification system

Current implementation specifications live under `specs/*/spec.md`.

`.specify/specs-index.md` is navigation only. It does not create authority by listing a document and it must not contain appended product policy.

A spec is subordinate to the Product Charter and the current Source-of-Truth documents for its domain. A superseded/historical spec or audit must not override a current requirement.

## Repository language

New repository artifacts are English by default as defined in `AGENTS.md`. Existing designated Source-of-Truth documents may retain their original language; do not rewrite their substantive content merely to satisfy the default language rule.
