#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

MASTER_DESIGN="./docs/master-design.md"

echo "===== CHECK TARGET FILES ====="
test -f "$MASTER_DESIGN" || { echo "ERROR: $MASTER_DESIGN not found"; exit 1; }
test -f ".specify/memory/constitution.md" || { echo "ERROR: constitution.md not found"; exit 1; }
test -f ".specify/specs-index.md" || { echo "ERROR: specs-index.md not found"; exit 1; }

echo "===== BACKUP TARGET FILES ====="
mkdir -p .specify/backup-ui-ux-philosophy
cp "$MASTER_DESIGN" .specify/backup-ui-ux-philosophy/master-design.md.bak
cp .specify/memory/constitution.md .specify/backup-ui-ux-philosophy/constitution.md.bak
cp .specify/specs-index.md .specify/backup-ui-ux-philosophy/specs-index.md.bak

echo "===== PATCH MASTER DESIGN ====="
cat >> "$MASTER_DESIGN" <<'MASTER_APPEND'

---

# UI/UX Philosophy

The platform UI must follow a modern SaaS observability/security operations dashboard style.

Target UX direction:

- Webhook Relay inspired operational UX
- Datadog / Grafana Cloud / Vercel style spacing and layout
- Clean professional SaaS admin portal
- Minimal and operator-focused
- Runtime visibility first
- Dashboard-centric navigation
- Responsive layout
- Component-based frontend architecture

Preferred frontend stack:

- React
- Tailwind CSS
- shadcn/ui
- lucide-react
- recharts

Avoid:

- Legacy enterprise UI style
- Dense table-only layouts
- Bootstrap admin templates
- Heavy gradients
- Consumer/mobile-app styling

# Dashboard UX Principles

The dashboard is the operational center of the platform.

The first screen must provide:

- Runtime health overview
- Active/error stream visibility
- Delivery success/failure summary
- Recent runtime activity
- Connector health
- Stream execution visibility
- Route delivery visibility

Operators should understand platform health within 5 seconds.

# Global Navigation Structure

Primary sidebar navigation order:

- Dashboard
- Connectors
- Sources
- Streams
- Mappings
- Enrichments
- Destinations
- Routes
- Runtime
- Logs
- Settings

Sidebar must:

- remain persistent
- support collapse
- support active highlighting
- use icon-based navigation

# Mapping UI UX Policy

Mapping UI must prioritize usability for non-developers.

Preferred UX:

- JSON tree explorer
- Click-to-select fields
- Auto JSONPath generation
- Split preview layout
- Live event preview
- Drag-and-drop field mapping in future phase
- Interactive mapping workflow

Avoid:

- raw JSONPath-only workflow
- text-heavy configuration screens
MASTER_APPEND

echo "===== PATCH CONSTITUTION ====="
cat >> .specify/memory/constitution.md <<'CONSTITUTION_APPEND'

---

# UI/UX Philosophy

The platform UI must follow a modern SaaS observability/security operations dashboard style.

Target UX direction:

- Webhook Relay inspired operational UX
- Datadog / Grafana Cloud / Vercel style spacing and layout
- Clean professional SaaS admin portal
- Minimal and operator-focused
- Runtime visibility first
- Dashboard-centric navigation
- Responsive layout
- Component-based frontend architecture

Preferred frontend stack:

- React
- Tailwind CSS
- shadcn/ui
- lucide-react
- recharts

Forbidden UI direction:

- Legacy enterprise UI style
- Dense table-only layouts
- Bootstrap admin templates
- Heavy gradients
- Consumer/mobile-app styling

# Dashboard UX Principles

The dashboard is the operational center of the platform.

The first screen must provide:

- Runtime health overview
- Active/error stream visibility
- Delivery success/failure summary
- Recent runtime activity
- Connector health
- Stream execution visibility
- Route delivery visibility

Operators should understand platform health within 5 seconds.

# Global Navigation Structure

Primary sidebar navigation order:

- Dashboard
- Connectors
- Sources
- Streams
- Mappings
- Enrichments
- Destinations
- Routes
- Runtime
- Logs
- Settings

Sidebar must:

- remain persistent
- support collapse
- support active highlighting
- use icon-based navigation

# Mapping UI UX Policy Addendum

Mapping UI must prioritize usability for non-developers.

Preferred UX:

- JSON tree explorer
- Click-to-select fields
- Auto JSONPath generation
- Split preview layout
- Live event preview
- Drag-and-drop field mapping only in future phase
- Interactive mapping workflow

Forbidden:

- raw JSONPath-only workflow
- text-heavy configuration screens
- removing click-based JSONPath generation
- making drag-and-drop part of MVP
CONSTITUTION_APPEND

echo "===== PATCH SPECS INDEX ====="
cat >> .specify/specs-index.md <<'INDEX_APPEND'

---

## UI/UX Philosophy

The platform UI must follow a modern SaaS observability/security operations dashboard style.

Required UX direction:

- Webhook Relay inspired operational UX
- Datadog / Grafana Cloud / Vercel style spacing and layout
- clean professional SaaS admin portal
- runtime visibility first
- dashboard-centric navigation
- responsive component-based frontend

Preferred frontend stack:

- React
- Tailwind CSS
- shadcn/ui
- lucide-react
- recharts

## Dashboard UX Principles

Dashboard is the operational center of the platform.

The first screen must show:

- runtime health overview
- active/error stream visibility
- delivery success/failure summary
- recent runtime activity
- connector health
- stream execution visibility
- route delivery visibility

Operators should understand platform health within 5 seconds.

## Global Navigation Structure

Primary sidebar navigation order:

1. Dashboard
2. Connectors
3. Sources
4. Streams
5. Mappings
6. Enrichments
7. Destinations
8. Routes
9. Runtime
10. Logs
11. Settings

Sidebar must remain persistent, collapsible, icon-based, and active-highlighted.
INDEX_APPEND

echo "===== VALIDATION ====="
grep -RniE "UI/UX Philosophy|Dashboard UX Principles|Global Navigation Structure|Webhook Relay|Datadog|Grafana|Vercel|shadcn|Operators should understand platform health|Primary sidebar navigation order|raw JSONPath-only" \
  "$MASTER_DESIGN" \
  .specify/memory/constitution.md \
  .specify/specs-index.md

echo
echo "DONE: UI/UX philosophy, dashboard UX, sidebar structure, and mapping UX policy added."
