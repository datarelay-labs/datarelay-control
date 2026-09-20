# Dashboard Operational Monitoring (P0)

Operational dashboard at `/monitoring` is the operator's first screen. This document describes the P0 UX surfaces added to close gaps identified in the Dashboard & Operational Monitoring UX Audit.

## Layout order

1. **Overall Health** — stream-level posture (Healthy / Warning / Critical counts).
2. **Group KPI strip** — Healthy / Warning / Critical **stream groups** (source product).
3. **Operational Issues** — No data, low volume, schema drift, destination capacity (existing APIs only).
4. **Group summary** — critical and warning groups with affected stream counts.
5. **Traffic KPI strip** — ingest/delivery rates, success rate, active alerts.
6. Charts and supporting panels (data flow, events over time, streams by status, top sources, recent alerts, system health).

## P0 surfaces

### Stream group KPI

- **Source:** `deriveStreamGroupHealth(streams, connectors)` in `dashboard-charter-metrics.ts` (same logic as Streams page grouping).
- **UI:** `DashboardGroupKpiStrip` — three cards: Healthy Groups, Warning Groups, Critical Groups.
- **Drill-down:** each card links to `/streams`.

### Operational issues

- **Source:** `deriveOperationalIssues(health, dashboard, streams)` — uses existing `runtime/dashboard/summary`.
- **UI:** `OperationalIssuesPanel` — four rows with counts and progress bars.
- **Schema Drift:** `schemaDriftCount` comes from `open_schema_field_drift_count` (OPEN `StreamSchemaFieldDrift` findings only). When that field is unavailable, the count is `null` (UI may render as `0`).

### Alert deep link

- **Recent alerts:** when `RuntimeAlertSummaryItem.stream_id` is a positive number, the alert row links to `/streams/{id}/runtime`.
- **Fallback:** invalid or missing `stream_id` keeps the previous behavior (`/streams`).

### Group summary

- **UI:** `DashboardGroupSummaryPanel` lists critical (`ERROR`) and warning (`DEGRADED`) source-product groups.
- **Drill-down:** group row links to `/streams?expand_group={productLabel}`.
- **Streams console:** reads `expand_group` from the query string and auto-expands the matching group row.

## Operator flow (target)

```
Dashboard → Group summary / Group KPI
         → Streams (group expanded)
         → Stream runtime
         → Action (routes, logs, mapping)
```

## Constraints (P0)

- No runtime engine changes.
- No new API endpoints.
- Dashboard / monitoring UX only; Route Processing untouched.

## Related files

| Area | File |
|------|------|
| Page layout | `frontend/src/components/dashboard/dashboard-overview.tsx` |
| Panels | `frontend/src/components/dashboard/dashboard-visual-panels.tsx` |
| Metrics | `frontend/src/components/dashboard/dashboard-charter-metrics.ts` |
| Paths | `frontend/src/config/nav-paths.ts` (`streamsExpandedGroupPath`) |
| Streams expand | `frontend/src/components/streams/streams-console.tsx` |
| Tests | `dashboard-overview.test.tsx`, `streams-console-expand.test.tsx`, `nav-paths.test.ts` |
