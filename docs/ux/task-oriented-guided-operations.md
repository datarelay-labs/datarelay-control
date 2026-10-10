# Task-Oriented UX and Guided Operations

Status: Derived, non-normative implementation guidance for roadmap #354 / packet #355.

Authority remains with `docs/architecture/source-of-truth-index.md` and the current documents it designates, especially the Product Charter, Data Relay UX Charter, Stream Wizard UX Charter, Governance UX Charter, and Governance Workspace contracts. This note summarizes the accepted implementation direction and must not override those authorities; any conflict fails closed and is resolved in the authoritative sources first.

## Current owner-approved Flow-First IA (2026-10-09, #354)

The existing A–G source integrations remain historical implementation accomplishments, but the owner has **not accepted the earlier NOC-like task usability**. The approved correction is **Data Flows** (existing Routes overview, not a new runtime entity) as the primary graph of real Stream → Route Processing → Destination paths and their metrics. Streams own collection/execution; Connections groups reusable Connectors/Destinations; the global entry is **New Data Flow**. Existing Wizard stages and permissions stay canonical, with Connector/Destination created contextually if missing and the exact draft/step preserved. No invented delivery acknowledgment or capacity ratio.

Authoritative UX changes are in the designated UX Charter and Stream Wizard Charter; detailed acceptance and code entry points: [`DATA-RELAY-FLOW-FIRST-IA-IMPLEMENTATION-CONTRACT.md`](DATA-RELAY-FLOW-FIRST-IA-IMPLEMENTATION-CONTRACT.md). #362 Governance top-level exception remains in force. The goal is a visually meaningful operating console, not extra cards or a second Stream creation flow.

## Product intent

DataRelay Control is a Data Delivery Gateway with optional Data Protection.

The current authority-derived user flow used by this implementation is:

```text
Collect Data
-> Select Destinations
-> Configure Route Processing
-> Deploy
```

The operational mental model is:

```text
What happened?
-> Where?
-> Why?
-> What should I do?
```

The UI must teach this model through tasks and runtime truth instead of requiring users to learn internal engines first.

## Competitive patterns adopted

| Product | Pattern | DataRelay application |
| --- | --- | --- |
| Cribl Stream | QuickConnect visual Source-to-Destination composition; self-documenting introduction; live capture; IN/OUT Data Preview | Streams/Routes show the delivery path visually; Source/Route configuration exposes sample/live preview; Route Processing exposes before/after results |
| Datadog Observability Pipelines | Use-case templates before blank pipeline configuration | Stream Wizard entry starts from operator intent/template where useful instead of a blank technical form |
| Splunk Edge Processor | Guided steps and "Preview up to this action" | Route Processing can preview the effective result through a selected processing stage |
| Confluent Cloud | Action Needed, recent/favorite context, visual lineage | Dashboard leads with actionable problems; later add truthful recent/favorite context; Route/Stream details visualize lineage |
| Elastic/Kibana | Stable page chrome, contextual flyouts, Help menu | Shared page-purpose header and right-side contextual Help drawer without losing current page context |
| Mezmo Telemetry Pipelines | Working demo pipeline and taps | Optional isolated demo/sample path after core clarity is stable |

## UX invariants

1. A primary page must answer within seconds:
   - Why am I here?
   - What am I looking at?
   - What needs attention?
   - What can I do here?
   - How do I know it worked?
   - Where do I go next?
   - Where do I get help?
2. User task terms precede engine terms.
3. Runtime Is Truth.
4. Destination First, Route Processing Second.
5. One Stream -> Many Routes -> Many Destinations remains visible as the delivery mental model.
6. Configuration and operations must not be mixed without a clear ownership reason.
7. Progressive disclosure is preferred over exposing every advanced workspace at once.

## Page-by-page target

### Dashboard
- Primary question: "What needs my attention?"
- Keep overall health, traffic, delivery success, and operational issue counts.
- Add a clear Action Needed section and direct drill-down.
- Add recent/favorite context only when backed by truthful persisted state.

### Streams
- Primary question: "Which source product / stream needs attention?"
- Default grouping remains Source Product / Stream Group.
- Make Stream role explicit: collection/configuration/execution ownership.
- Provide next action and direct diagnosis from unhealthy rows.

### Destinations
- Primary question: "Can I safely deliver here?"
- Lead with current EPS, authoritative capacity/limit if available, connected paths, recent delivery issues, and test/diagnose actions.
- Never fabricate utilization where no authoritative limit exists.

### Data Flows (successor to Routes overview)
- Primary question: "Where does data go, on which path, and what are the actual current delivery outcomes?"
- Make Connector/source access -> Stream collection -> one/many Route Processing -> Destination edges the main operator viewport; keep a filtered expert Route table fallback.
- Show real Route EPS, delivery success/failure/retry, freshness and Destination capacity **only** with compatible source-provided values. Distinguish unknown, IDLE, preview, send and acknowledged reception.
- Route Edit remains the destination-specific Transform/Protection/Classification/Policy configuration screen, reached from the selected path's inspector. The Data Flows graph itself is read-only.

### New Data Flow (existing Stream Wizard)
- Primary question: "What data do you need to collect, and where should each delivery path go?"
- Start from useful intent and available Connector/Destination prerequisites; create missing ones in the setup context and restore the draft after return.
- Preserve Source -> Sample Data -> Select Destinations -> Route Processing -> Deploy, explicit validations, permissions and actual post-deploy runtime verification.
- Do not expose superficial template choices that merely rename the same flow without useful defaults. Keep expert Start from scratch.

### Governance Dashboard
- Primary question: "Is governance healthy, and what needs attention?"
- Operations/current-state only.
- No policy creation/edit/list configuration block on the Dashboard.
- Lead with posture, prioritized next actions, investigation targets, operational/protection/delivery signals, then investigation shortcuts.
- Configuration remains owned by Stream/Route configuration or an explicitly advanced workspace.

### Logs / investigations
- Preserve context through right-side detail flyouts where practical.
- Deep-link from issue -> evidence -> corrective action without forcing users to reconstruct filters.

### Administration
- Keep task-group model.
- Apply shared page-purpose/help pattern and explain high-risk/restart/reconnect effects before actions.

## Contextual help model

Layer 1: inline page purpose and next action.

Layer 2: Help drawer on the current page:
- What this page is for
- What to look at first
- Typical workflow
- Key concepts
- Troubleshooting / where to go next

Layer 3: full documentation link when a published page-specific document exists.

Do not invent broken documentation URLs. Full-documentation links are added only when the target page exists.

## Navigation authority resolution

Governance had an equal-authority conflict between the general UX Charter and Governance UX Charter. The owner resolved it with **Option A (#362, 2026-10-09)**: a single Governance primary group, with Governance Dashboard as entry and authorized investigation paths retained. The newly approved Data Flows / Connections navigation does not replace or override that separate Governance decision.

## Current implementation order (owner-approved correction)

Previous foundation A–G implementation batches are source history, **not owner-visible UX acceptance**. New P0 order is:

1. **Data Flows** primary operational graph/selected Route inspector using real runtime truth and expert table fallback.
2. **New Data Flow** prerequisite-aware contextual Connector/Destination creation with draft-safe return; same existing five-stage Wizard.
3. **Navigation**: Dashboard / Data Flows / Streams / Connections (Connectors and Destinations) / Governance / Administration and truthful status messaging.
4. Real owner-visible authenticated visual acceptance at 1440/375/320; only then full mandatory Browser reconciliation (20 BFS / 97 capability-control census) and same-HEAD two-user Full User E2E.

Search/Recent/Favorites remain ROI-deferred. No automatic merge or release.
