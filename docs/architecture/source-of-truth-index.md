# Data Relay Control Authority Map

**Role:** Canonical registry of repository authority; this file is not itself a replacement Product Charter.
**Last reviewed:** 2026-09-21
**Canonical product-document directory:** `docs/source-of-truth/`

## Current Data Relay Control product scope

Data Relay Control v1 current product scope includes:

- Phase A — Foundation
- Phase B — Data Control Runtime
- Phase C — Governance
- Phase D — OSS Release / closure
- approved Control-v1 core closure work recorded by the canonical roadmap

**Removed from Data Relay Control scope:** Phase E (AI Gateway). Existing AI code/specs may remain in-repo as separate-domain or historical material, but they are not Control product authority, completion work, release readiness, final E2E requirements, or delivery backlog.

**Outside Data Relay Control v1:** Phase F (Enterprise Edition).

**Post-v1 deferred:** Phase G / M29 Connector Marketplace & Ecosystem. Existing Marketplace foundations may remain when runtime-safe, but M29 does not contribute to Control v1 completion percentage or block release. Further Marketplace work requires an explicitly approved future final specification.

## Authority model

Data Relay Control separates **intended behavior** from **observed implementation state**.

### Intended product behavior

1. **Product Charter** — top-level product identity, scope, non-goals, architecture principles.
2. **Current subordinate Source-of-Truth documents** listed below — WBS, UX, governance, and domain product contracts.
3. **Current task-relevant implementation specification** under `specs/` — bounded engineering contract translating product intent into implementation requirements.
4. **ADR / runbook** — authority only for the durable architecture decision or operational procedure it explicitly owns.

### Observed system state

Actual code, schemas, configuration, runtime state, migrations, and deterministic tests are authoritative evidence of what the system does now. They do not override an explicit current product requirement merely because implementation has drifted.

### Engineering process

`AGENTS.md` and `.engineering/*` define engineering workflow, validation selection, and release evidence. They are not product-feature specifications.

### Derived / historical knowledge

`README.md`, architecture overviews, release notes, audit reports, Wiki/Athena, and archived documents explain or record state. They must not create a competing product contract.

## Current product / UX documents

| Priority | Role | Current designated document | Notes |
|---:|---|---|---|
| 1 | Product Charter | [`PRODUCT-CHARTER-Version-1.2.1-FINAL.txt`](../source-of-truth/PRODUCT-CHARTER-Version-1.2.1-FINAL.txt) | Top-level product authority |
| 2 | Master WBS | [`MASTER-WBS-Version-1.2.1-FINAL.txt`](../source-of-truth/MASTER-WBS-Version-1.2.1-FINAL.txt) | Planning/milestone authority; subordinate to Product Charter |
| 3 | UX Charter | [`DATA-RELAY-UX-CHARTER-v1.2.1-FINAL.txt`](../source-of-truth/DATA-RELAY-UX-CHARTER-v1.2.1-FINAL.txt) | Product UX authority |
| 3 | Stream Wizard UX Charter | [`DATA-RELAY-STREAM-WIZARD-UX-CHARTER-v5.2-FINAL.txt`](../source-of-truth/DATA-RELAY-STREAM-WIZARD-UX-CHARTER-v5.2-FINAL.txt) | Stream Wizard authority |
| 3 | Governance UX Charter | [`GOVERNANCE-UX-CHARTER-v1.1-FINAL.txt`](../source-of-truth/GOVERNANCE-UX-CHARTER-v1.1-FINAL.txt) | Governance surface UX |
| 3 | Governance Workspace UX Charter | [`DATA-RELAY-GOVERNANCE-WORKSPACE-UX-CHARTER-v1.1-FINAL.txt`](../source-of-truth/DATA-RELAY-GOVERNANCE-WORKSPACE-UX-CHARTER-v1.1-FINAL.txt) | Governance workspace UX |
| 3 | Governance Workspace Spec | [`DATA-RELAY-GOVERNANCE-WORKSPACE-v1.1-FINAL.txt`](../source-of-truth/DATA-RELAY-GOVERNANCE-WORKSPACE-v1.1-FINAL.txt) | Governance workspace product contract |
| 3 | Governance & Transform Policy | [`DATA-RELAY-GOVERNANCE-AND-TRANSFORM-POLICY-DRAFT-v1.1-FINAL.txt`](../source-of-truth/DATA-RELAY-GOVERNANCE-AND-TRANSFORM-POLICY-DRAFT-v1.1-FINAL.txt) | Designated current file; internal header still says Draft |
| 3 | Union Schema UX Spec | [`DATA-RELAY-UNION-SCHEMA-UX-SPEC-v1.1-FINAL.txt`](../source-of-truth/DATA-RELAY-UNION-SCHEMA-UX-SPEC-v1.1-FINAL.txt) | Union Schema UX/product contract |

Version/header inconsistencies are documented in [`docs/source-of-truth/README.md`](../source-of-truth/README.md). Do not infer or silently normalize those source-document versions.

## Implementation specification system

- Current implementation specifications live under [`specs/`](../../specs/).
- [`.specify/specs-index.md`](../../.specify/specs-index.md) is a complete navigation index generated from the tracked spec set.
- [`.specify/memory/constitution.md`](../../.specify/memory/constitution.md) is a small implementation-governance bridge and must remain subordinate to this authority model.
- A specific current spec owns its bounded implementation contract only when it does not conflict with higher product/UX authority.
- If a current spec conflicts with a higher current product document, stop and resolve the conflict explicitly rather than choosing whichever is newer or easier to implement.
- Phase E AI Gateway specs (`070-ai-gateway-mvp`, `081-ai-policy-enforcement`, `082-ai-audit-inspection`, `090-m31-2-ai-stream-ux`) remain tracked for navigation but are **Outside Data Relay Control** — separate-domain / historical reference only. They are not current Control implementation authority and must not drive Control delivery, completion accounting, release readiness, or final E2E requirements.

## Current architecture entry points

| Purpose | Document | Authority role |
|---|---|---|
| Current architecture overview | [`OSS-v1-ARCHITECTURE.md`](OSS-v1-ARCHITECTURE.md) | Derived current architecture explanation; links to normative sources/specs |
| Core architecture contract | [`specs/001-core-architecture/spec.md`](../../specs/001-core-architecture/spec.md) | Implementation contract |
| Runtime pipeline contract | [`specs/002-runtime-pipeline/spec.md`](../../specs/002-runtime-pipeline/spec.md) | Implementation contract |
| Delivery / routing contract | [`specs/004-delivery-routing/spec.md`](../../specs/004-delivery-routing/spec.md) | Implementation contract |
| Route Processing architecture | [`specs/091-route-processing-architecture/spec.md`](../../specs/091-route-processing-architecture/spec.md) | Normative authority is only the Current contract section. Sections 1 through the appendices are historical M13.1 foundation design and non-normative, including staged implementation, future, no-op, and pre-split statements |
| Route Processing UX | [`specs/097-route-processing-ux/spec.md`](../../specs/097-route-processing-ux/spec.md) | Current Route Processing UX contract |

Route Processing is the only supported product runtime. An explicit `GDC_ROUTE_PROCESSING_ENABLED=false` is rejected; rollback uses a previous release image rather than a parallel in-process runtime.

## Conflict-resolution rule

1. Confirm that both artifacts are current, not archived/superseded.
2. Apply the authority layers above; a lower layer cannot expand or contradict a higher layer.
3. Treat code/runtime divergence as implementation drift, not an automatic requirement rewrite.
4. If two artifacts at the same authority layer conflict, fail closed and create an explicit product/specification decision.
5. Do not resolve conflicts from filename version, commit date, or AI inference alone.

### Owner-approved Governance navigation exception (#362, 2026-10-09)

The owner expressly selected **Option A** to resolve the same-layer conflict between the general UX Charter and Governance UX Charter. In Data Relay Control, a single `Governance` primary group remains an approved operational exception to the general top-level navigation anti-pattern. `Governance Dashboard` is its entry point; Violations, Quarantine, Approvals, Audit, Replay and Notifications stay operational drill-downs. `Governance Workspace` is an advanced, contextual, read-only Stream/Route view rather than an equally prominent primary menu entry, with existing authorized routes preserved. Policy configuration stays in Stream/Route/Wizard ownership.

Decision: [GitHub #362](https://github.com/datarelay-labs/datarelay-control/issues/362). Implementation: [Draft PR #414](https://github.com/datarelay-labs/datarelay-control/pull/414). This decision does **not** confer Browser BFS, two-user Full User E2E, merge or release approval; both user-test gates remain required on one final HEAD. The Source-of-Truth charters retain their original text; this explicit owner disposition resolves the bounded navigation conflict without changing unrelated UX authority.

## Historical / superseded material

The following are retained only for history or old-link resolution and must not drive new implementation:

- [`docs/master-design.md`](../master-design.md) — pre-charter Generic Data Connector master design; retained with a SUPERSEDED banner so old section links still resolve.
- [`docs/v1-readiness-checklist.md`](../v1-readiness-checklist.md) — pre-GA readiness snapshot.
- `docs/architecture/m13-*` and `docs/archive/historical-audits/` — point-in-time M13 audits/reviews.
- historical GA/RC release notes and checklists — release snapshots, not current product authority.
- [`docs/archive/legacy-design/`](../archive/legacy-design/) — superseded constitutions, indexes, guardrails, and design material.
- [`archive/retired-doc-mutators/`](../../archive/retired-doc-mutators/) — retired one-shot scripts that previously appended policy into multiple documents.

## Staging policy

`docs/source-of-truth/_incoming/` is local/transient staging and must not be tracked. Promote a source document only after an explicit comparison/decision, then remove or archive the incoming copy.

---

## Marketplace future product direction

Phase G / M29 Connector Marketplace & Ecosystem is post-v1 deferred. Existing implemented foundations are preserved where they remain runtime-safe, but Marketplace is not a Data Relay Control v1 release dependency.

Do not resume Harvester, AI Builder, Git/remote acquisition, Marketplace UI expansion, or Remote/Public Registry work until a future final Marketplace specification is explicitly approved.

Current Marketplace future-architecture reference:

- `docs/architecture/DATA-RELAY-CONNECTOR-MARKETPLACE-ARCHITECTURE-CHARTER-v1.0-DRAFT.md`

Marketplace reading order:

1. Product Charter, including the Marketplace addendum.
2. This Source-of-Truth Index.
3. Marketplace Architecture Charter.
4. `specs/049-template-registry/spec.md` Source Pack contract.
5. Current Connector Registry / Credential / Stream / Route runtime code and tests.
6. Historical `feature/post-m29-development` work only as re-audited reference; it is not merge authority.

Marketplace implementation must preserve Runtime Is Truth, One Stream → Many Routes → Many Destinations, current Connected Credential handling, reliability/checkpoint semantics, and the no-parallel-runtime rule.

Historical Marketplace migrations are not migration authority. Any new Marketplace persistence must start from the current Alembic head.
