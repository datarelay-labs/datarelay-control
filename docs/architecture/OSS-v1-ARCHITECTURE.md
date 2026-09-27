# Data Relay OSS v1 — Architecture Overview

**Audience:** Operators, integrators, and contributors  
**Authority:** [`PRODUCT-CHARTER`](../source-of-truth/PRODUCT-CHARTER-Version-1.2.1-FINAL.txt), [`source-of-truth-index.md`](source-of-truth-index.md)  
**Scope:** Current architecture explanation — Route Processing is the only supported runtime (`GDC_ROUTE_PROCESSING_ENABLED=true`)

---

## Data Relay Mental Model

Data Relay is a **Data Delivery Gateway** with **optional data protection**.

Operators think in terms of:

1. Data **comes in** (source)
2. Data is **transformed** (mapping, enrichment)
3. Data **goes out** (destinations)
4. **Problems** are visible on Dashboard and Streams
5. **Protection** is applied when rules require it

Operators do **not** need to understand internal engine names (Schema Drift Engine, Policy Engine, etc.) for day-to-day use.

---

## Configuration Hierarchy

```
Connector
   ↓
Stream  (execution unit: fetch, extract, observe, detect, checkpoint)
   ↓
Route  (processing unit: transform, protection, classification, policy, delivery)
   ↓
Destination  (delivery endpoint)
```

### Entity roles

| Entity | Role |
|--------|------|
| **Connector** | Source product connection (credentials, base URL, product group) |
| **Stream** | Execution unit — one source, shared fetch/extract/observation/detection, one checkpoint, many routes. Holds inherited mapping, enrichment, and governance defaults |
| **Route** | Processing unit — applies transform and governance per destination (inherit those defaults or override), then delivers |
| **Destination** | Reusable delivery target (webhook, syslog, etc.) |

### Charter rule

> One Stream → Many Routes → Many Destinations  
> Do **not** duplicate streams for per-destination processing differences — use **routes**.

---

## Optional Governance

Governance layers sit on the core pipeline. All are **optional** — streams deliver without governance rules configured.

| Layer | Purpose | Operator surface |
|-------|---------|------------------|
| **Schema Drift** | Detect structural changes in source data | Stream config, runtime logs |
| **Sensitive Detection** | Find PII/secrets in payloads | Protection wizard, runtime |
| **Protection** | Mask, hash, or block sensitive fields | Data protection intents, Route Edit |
| **Classification** | Label data sensitivity | Classification rules, Route Edit |
| **Policy** | Gate delivery (audit, quarantine) | Policy rules, Violations, Quarantine |
| **Quarantine** | Hold events that fail policy | Quarantine Center |
| **Replay** | Re-deliver stored protected payloads | Replay Center |
| **Audit & Notifications** | Immutable trail, alerts | Audit, Notifications |

Governance nav appears only when RBAC grants `governance_read`.

---

## Runtime Architecture (current)

**Execution path:** Route Processing only. One Stream → Many Routes → Many Destinations.

```
Source Adapter
  Phase A–D Charter: HTTP API, Database Source, Webhook Receiver
  Supported extensions: S3 Object Polling, Remote File Polling
        ↓
Fetch → Extract → Schema Observation → Sensitive Detection
        ↓
SharedBatchContext
        ↓
Per-route pipeline
  Transform (mapping/enrichment) → Protection → Classification → Policy → Delivery
        ↓
Shared checkpoint decision (after successful delivery)
```

**Code entry:** `app/runners/stream_runner.py`  
**Spec:** `specs/002-runtime-pipeline/spec.md`, `specs/004-delivery-routing/spec.md`, `specs/091-route-processing-architecture/spec.md` (Current contract section only)

### Supported path (Route Processing)

When `GDC_ROUTE_PROCESSING_ENABLED=true` (product default and the only supported path):

- Per-route pipeline loop (`process_route_pipeline`)
- Stream-level mapping/enrichment applied per route (inherit or override)
- Delivery, Failover, and Replay recording reuse the shared StreamRunner primitive (`_send_route_events`)

### Retired flag-OFF path

`GDC_ROUTE_PROCESSING_ENABLED=false` is not a live runtime:

- The dual stream-scoped runtime was removed (Product Charter: No Parallel Pipeline).
- Explicit `false` is rejected at settings load (no silent coercion / no dual runtime).
- Emergency rollback uses a previous release image, not an in-process flag.


## Checkpoint

| Rule | Behavior |
|------|----------|
| **When updated** | Only after **successful destination delivery** |
| **On failure** | Checkpoint not advanced (retry on next poll/run) |
| **Partial success** | Depends on route `failure_policy` (e.g. LOG_AND_CONTINUE) |
| **Quarantine** | Event skipped for delivery; checkpoint not updated for quarantined events |

Checkpoint stores source position (HTTP offset, DB cursor, file mtime, S3 key, etc.) per stream.

---

## Replay

**Purpose:** Re-deliver a previously recorded **protected payload** without re-running mapping/enrichment/policy.

| Aspect | Detail |
|--------|--------|
| **Recording** | On final destination failure on the Route Processing delivery path |
| **Storage** | `stream_replay_events` table |
| **Re-execution** | Protected payload only — not full pipeline re-run |
| **Operator UI** | Governance → Replay Center |
| **Spec** | `specs/068-replay-engine/spec.md` |

---

## Quarantine

**Purpose:** Hold events that match a **quarantine** policy action instead of delivering to destination.

| Aspect | Detail |
|--------|--------|
| **Trigger** | Policy engine `action_type=quarantine` |
| **Effect** | Destination skip; checkpoint not updated |
| **Release** | Operator releases from Quarantine Center — stored protected payload re-sent |
| **Auto-release** | Not in MVP scope |
| **Spec** | `specs/069-quarantine-mvp/spec.md` |

---

## Failover

**Purpose:** Active/standby destination pairs — if primary delivery fails, attempt secondary.

| Aspect | Detail |
|--------|--------|
| **Model** | Active/standby routes per stream |
| **Eligibility** | HTTP errors (not 429) on primary |
| **Checkpoint** | Success on secondary counts as delivery success |
| **Configuration** | `stream_failover_routes` DB records |
| **Spec** | `specs/067-failover-routing/spec.md` |

Failover uses the Active/Standby engine on the Route Processing delivery path.

---

## Route Processing Model

```
Shared phase (once per batch) → SharedBatchContext
├── Fetch
├── Extract
├── Schema Observation
└── Sensitive Detection

Route (per destination; inherit stream config or override)
├── Transform (mapping/enrichment)
├── Protection
├── Classification
├── Policy
└── Delivery

Then: shared checkpoint decision
```

Stream mapping, enrichment, protection, classification, and policy rules are inherited configuration. They are resolved and executed inside the per-route pipeline, not as a shared processing phase.

**Effective Status:** Each route exposes Inherited / Overridden / Mixed via Effective API — used in Route Edit and Governance Workspace.

**Persist kinds (current wizard deploy):** Complete Transform override → `route_transform`; complete Protection override → `route_protection`; Policy / field-level governance → `governance`. Incomplete classification or protection override without payload may still be **Intent only**. See [Known Limitations](../release/KNOWN-LIMITATIONS.md).

---

## Frontend Architecture (Operator UI)

| Surface | Path | Purpose |
|---------|------|---------|
| Dashboard | `/monitoring` | Operational health, drill-down |
| Streams | `/streams` | Group-based stream operations |
| Stream Runtime | `/streams/:id/runtime` | Per-stream monitoring and control |
| Routes | `/routes` | Route list and edit (deep-link; not primary sidebar) |
| Governance | `/governance/*` | Optional control plane (RBAC deep-link; not primary sidebar) |

**OSS release mode:** Internal surfaces (validation lab, connector catalog, templates) hidden via `VITE_OSS_RELEASE_MODE` and route guards.

---

## Data Flow Diagram

```
┌─────────────┐     ┌──────────────────────────┐
│  Connector  │────▶│          Stream          │
│  (source)   │     │ fetch · extract · observe│
└─────────────┘     │ · detect · checkpoint    │
                    └────────────┬─────────────┘
                                 │
       ┌─────────────────────────┼─────────────────────────┐
       ▼                         ▼                         ▼
┌────────────┐           ┌────────────┐           ┌────────────┐
│  Route A   │           │  Route B   │           │  Route C   │
│ transform ·│           │ transform ·│           │ transform ·│
│ governance │           │ governance │           │ governance │
│  override  │           │  inherited │           │  override  │
└─────┬──────┘           └─────┬──────┘           └─────┬──────┘
      ▼                        ▼                        ▼
┌────────────┐           ┌────────────┐           ┌────────────┐
│ Destination│           │ Destination│           │ Destination│
│     1      │           │     2      │           │     3      │
└────────────┘           └────────────┘           └────────────┘
```

---

## Related documentation

| Document | Topic |
|----------|-------|
| [Source of Truth Index](source-of-truth-index.md) | Reading order and classification |
| [master-design.md](../master-design.md) | Historical design (SUPERSEDED) |
| [Route Processing UX Spec](../ux/DATA-RELAY-ROUTE-PROCESSING-UX-SPEC.md) | Inherit/override UX |
| [Route Persist Roadmap](./route-processing-persist-roadmap.md) | Persist kinds and remaining gaps |
| [Runtime Capability Matrix](../runtime/runtime-capability-matrix.md) | Feature matrix |
| [Getting Started](../getting-started/GETTING-STARTED.md) | First pipeline walkthrough |

---

*Data Relay OSS v1.0 — Architecture overview for GA.*
