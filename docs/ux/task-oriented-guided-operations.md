# Task-Oriented UX and Guided Operations

Status: Derived, non-normative implementation guidance for roadmap #354 / packet #355.

Authority remains with `docs/architecture/source-of-truth-index.md` and the current documents it designates, especially the Product Charter, Data Relay UX Charter, Stream Wizard UX Charter, Governance UX Charter, and Governance Workspace contracts. This note summarizes the accepted implementation direction and must not override those authorities; any conflict fails closed and is resolved in the authoritative sources first.

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

### Routes
- Primary question: "How is this Stream delivered to this Destination?"
- Visualize Stream -> Route Processing -> Destination.
- Treat Transform / Protection / Classification / Policy as destination-specific Route Processing.
- Provide before/after sample preview and stage-specific preview where supported.

### Stream Wizard
- Primary question: "What are you trying to collect and where should it go?"
- Add intent/template entry where it reduces blank-form complexity.
- Preserve Source -> Sample Data -> Select Destinations -> Route Processing -> Deploy.
- Verify effective delivery after deploy.

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

## Navigation conflict

The general UX Charter says Governance should not be a top-level menu, while the Governance UX charters define a dedicated Governance operations surface. They have equal authority in the current authority map. Do not silently remove or relocate Governance navigation until an explicit product decision resolves this conflict.

## Delivery order

1. Shared page-purpose/help foundation + Governance clarity.
2. Dashboard + Streams task-oriented operations.
3. Destinations + Routes visual delivery path.
4. Wizard intent/templates + processing preview.
5. Cross-page contextual help content and published documentation links.
6. Optional isolated demo/sample learning path.
7. Fresh Browser Feature Scenario Reconciliation.
8. Full User E2E and release closure.
