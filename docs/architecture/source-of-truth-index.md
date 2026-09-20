# Data Relay Control Authority Map

**Role:** Canonical registry of repository authority; this file is not itself a replacement Product Charter.
**Last reviewed:** 2026-09-20
**Canonical product-document directory:** `docs/source-of-truth/`

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

## Current architecture entry points

| Purpose | Document | Authority role |
|---|---|---|
| Current architecture overview | [`OSS-v1-ARCHITECTURE.md`](OSS-v1-ARCHITECTURE.md) | Derived current architecture explanation; links to normative sources/specs |
| Core architecture contract | [`specs/001-core-architecture/spec.md`](../../specs/001-core-architecture/spec.md) | Implementation contract |
| Runtime pipeline contract | [`specs/002-runtime-pipeline/spec.md`](../../specs/002-runtime-pipeline/spec.md) | Implementation contract |
| Delivery / routing contract | [`specs/004-delivery-routing/spec.md`](../../specs/004-delivery-routing/spec.md) | Implementation contract |
| Route Processing architecture | [`specs/091-route-processing-architecture/spec.md`](../../specs/091-route-processing-architecture/spec.md) | Current Route Processing contract |
| Route Processing UX | [`specs/097-route-processing-ux/spec.md`](../../specs/097-route-processing-ux/spec.md) | Current Route Processing UX contract |

Route Processing is the only supported product runtime. An explicit `GDC_ROUTE_PROCESSING_ENABLED=false` is rejected; rollback uses a previous release image rather than a parallel in-process runtime.

## Conflict-resolution rule

1. Confirm that both artifacts are current, not archived/superseded.
2. Apply the authority layers above; a lower layer cannot expand or contradict a higher layer.
3. Treat code/runtime divergence as implementation drift, not an automatic requirement rewrite.
4. If two artifacts at the same authority layer conflict, fail closed and create an explicit product/specification decision.
5. Do not resolve conflicts from filename version, commit date, or AI inference alone.

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
