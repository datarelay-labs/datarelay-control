# DataRelay Control — Stitch Design System (Source-Extracted)

Status: Source-derived baseline for a **Stitch UI pilot**, not a shipped theme or approved visual redesign.
Extracted from: `main-v2` at `d909b32ae61360bf7a34490cfab0d2803cc2b193` (2026-11-22).
Scope: Dashboard and Data Flows / Route Processing. The shared Product Foundation and actual Control CSS remain the rendering authorities.

## Product language and composition

An information-dense, operator-first enterprise data-delivery console. It favors factual status, quick investigation, legible data tables, and clear actions over decorative charts. Retain the current control shell, navigation, reusable components, and compact desktop proportions. Rework visual hierarchy only within the two pilot surfaces. Never invent healthy systems, delivered events, EPS, throughput, incidents, or topology edges.

Hierarchy: overall operational state -> the concrete affected Stream/Route/Destination -> the reason/evidence -> authorized action. Dashboard prioritizes a useful next step. Data Flows exposes the actual Stream -> per-Route Processing -> Destination topology and contextual inspector.

## Canonical source files (read these before proposing new tokens)

- `frontend/src/foundation-semantic-tokens.css` — Foundation-compatible light/dark semantics, typography, spacing, control sizes.
- `frontend/tailwind.config.js` — active theme aliases and legacy utility compatibility.
- `frontend/src/index.css` — global rendering, focus, readability floor, scrollbars.
- `frontend/src/components/layout/sidebar.tsx` and `app-shell-layout.tsx` — shell/navigation.
- `frontend/src/components/dashboard/dashboard-overview.tsx` — current Dashboard.
- `frontend/src/components/routes/routes-architecture-workspace.tsx` and `runtime-flow-topology.tsx` — Data Flows / topology.
- `docs/ux/DATA-RELAY-FLOW-FIRST-IA-IMPLEMENTATION-CONTRACT.md` — approved operational information architecture.

Values below are an **extract**, not a newly mandated token system. If source values change, regenerate this file before exporting designs.

## Color and surface roles

| Semantic role | Light | Dark | Existing token |
| --- | --- | --- | --- |
| Page | `oklch(98.75% 0 0)` | `oklch(10% 0 0)` | `--dr-surface-page` |
| Card | `#ffffff` | `oklch(17% 0 0)` | `--dr-surface-card` |
| Section | `oklch(97% 0 0)` | `oklch(15% 0 0)` | `--dr-surface-section` |
| Standard border | `oklch(92.2% 0 0)` | `oklch(32% 0 0)` | `--dr-border-default` |
| Primary text | `oklch(21% 0.006 285.885)` | `oklch(97% 0 0)` | `--dr-text-primary` |
| Secondary text | `oklch(37.1% 0 0)` | `oklch(92.2% 0 0)` | `--dr-text-secondary` |
| Primary action | `oklch(54.6% 0.245 262.881)` | `oklch(52% 0.209 260)` | `--dr-action-primary` |
| Focus ring | `#1473e6` | `#1473e6` | `--dr-focus-ring` |
| Success | `#047857` | `#34d399` | `--dr-status-success` |
| Warning | `#92400e` | `#f59e0b` | `--dr-status-warning` |
| Critical | `#b42318` | `#f87171` | `--dr-status-critical` |

- Brand mark: `--dr-brand-mark: #00d084`. Brand relay is `#007e4f` in light and `#00d084` in dark. **Do not confuse brand green with the blue primary-action token.**
- `--dr-status-unknown` is a distinct operational status. Never render unknown as healthy green.
- Existing sky/violet Tailwind utility aliases converge onto the same blue interactive scale. Prefer the semantic aliases (`bg-accent`, `text-fg`, `bg-surface-card`, status variants) for new UI work.
- Preserve light **and** dark themes, contrast, and the current focus indicators. Avoid ungoverned gradients, glossy treatments, unrelated neon colors, or novel status meanings.

## Typography

- UI family: **Inter**, followed by system sans-serif fallback (`--dr-font-family-ui`).
- Core sizes: `12px` caption/technical metadata, `13px` supporting text, `14px` body and operable controls, `16px` section title, `20px` page title, `24px` metrics.
- Weights: `400` regular, `500` medium, `600` strong. Page title 20/28/600; metric 24/32/600; body 14/20/400; label 13/16/600.
- The existing readability contract enforces a minimum legible size for operational controls and table data. Do not introduce 9–11px primary table/interaction content.

## Spacing and geometry

- Foundation spacing steps: `4, 8, 12, 16, 20, 24, 32px` (`--dr-space-1` through `--dr-space-8`).
- Standard controls and cards: `8px` radius; pills `9999px`.
- Control heights: `32px` compact, `36px` default, `44px` touch minimum.
- Expanded sidebar: `--dr-layout-sidebar-expanded: 260px`; collapsed: `--dr-layout-sidebar-collapsed: 57px`; content max-width: `--dr-layout-content-max: 1440px`.
- Maintain information density: clear card grouping and section labels, not oversized decorative whitespace. Wide data tables must preserve scanability and overflow treatment.

## Reuse patterns / protected boundaries

- Reuse existing shell, navigation, cards, tables, filters, drawers, graphs and statuses; do not generate a competing UI framework or add shadcn/ui by default.
- The Dashboard shows real snapshot-backed health, incoming/outgoing events, delivery success, and actionable issues. Unknown, stale, partial and unavailable data must stay visually distinct.
- Data Flows is a presentation of existing Routes; it does not introduce a new DataFlow backend model. Each real Stream can branch into multiple real Route -> Destination paths. Route selection/inspection is non-mutating until the user explicitly edits/saves.
- Retain existing deep links, RBAC gates, theme switch, accessible keyboard navigation, and five-stage Stream Wizard: Connect -> Sample & Record Selection -> Destinations -> Route Processing -> Deploy.
- No API, authentication, runtime, database, persistence, checkpoint, or telemetry-contract changes in this pilot.

## Stitch iteration instructions

Produce **two independent desktop design variations per pilot surface**, using the same semantic tokens and data hierarchy. Include a dark-theme treatment and a narrow (375px) review state. Do not change feature scope. Identify each data point as observed, unknown, or illustrative. Use clearly labeled **synthetic** sample values in Stitch designs only.

Do not upload code, screenshots, fixtures, or HTML containing tokens, customer information, private hostnames/IP addresses, account identifiers, or live operational payloads. Review the sanitized export and obtain owner approval before sending it to Stitch.

Stitch generates **design candidates**. Generated React must be reviewed and selectively integrated into existing components, with source behavior preserved. An aesthetic rating or successful HTML export is not a functional or user acceptance pass.
