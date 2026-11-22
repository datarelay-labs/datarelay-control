# Stitch Skills Pilot — DataRelay Control Dashboard + Data Flows

Status: **STARTED — source/design baseline prepared; external Stitch generation pending owner-held Stitch credentials and asset approval.**
Tracked work: [Issue #413](https://github.com/datarelay-labs/datarelay-control/issues/413), [UX roadmap #354](https://github.com/datarelay-labs/datarelay-control/issues/354).
Repository/branch: `datarelay-labs/datarelay-control` / `feat/control-stitch-design-pilot-20261122` from `main-v2@d909b32ae61360bf7a34490cfab0d2803cc2b193`.

## Goal and boundaries

- Produce candidate improvements for the existing **Dashboard** and **Data Flows / Route Processing** surfaces with Google Stitch; improve hierarchy, legibility, and consistent styling without rewriting product behavior.
- Preserve the Foundation semantic design tokens, dark/light themes, operational snapshot truthfulness, the one-Stream/many-Routes/many-Destinations model, permissions, deep links and the five-stage Destination-First Wizard.
- **Non-goals:** replacing Foundation, merging an external component framework, creating a new DataFlow runtime/model, reworking other products, production deployment, publishing customer data, or changing auth/permissions.
- Public contract: presentation-only future candidate; no API/config/schema/migration change. Current work is documentation and design baseline only.

## Source-derived baseline

- `.stitch/DESIGN.md` contains the baseline semantics taken from the repository CSS and Tailwind theme.
- Dashboard: `frontend/src/components/dashboard/dashboard-overview.tsx`; snapshot selectors in `lib/operational-snapshot-selectors`; existing component tests `dashboard-overview.test.tsx` and live-flow tests.
- Data Flows: `frontend/src/components/routes/routes-architecture-workspace.tsx`, `runtime-flow-topology.tsx`, `routes-overview-page.tsx`, related visual-fidelity/motion/theme tests.
- Product UX authority: `docs/architecture/source-of-truth-index.md`, `docs/ux/DATA-RELAY-FLOW-FIRST-IA-IMPLEMENTATION-CONTRACT.md`, current UX Charter.
- Browser evidence is **not yet captured in this pilot**; source inspection does not imply visual E2E.

## Execution stages and evidence gates

1. **Baseline (source):** read CSS tokens, relevant Dashboard/Routes components, active product UX. Save faithful source-derived `.stitch/DESIGN.md`. [Prepared in this branch]
2. **Prerequisites:** verify a Stitch account/project, configure Stitch MCP authentication securely in an authorized AI client, and verify tool connectivity. No API key in repository or chat.
3. **Sanitized visual input:** capture the existing browser screens using **synthetic fixture data only**, or export static HTML without confidential configuration/telemetry. Review paths, size, contents, and hosted destination; obtain explicit approval before any upload.
4. **Stitch designs:** upload reviewed assets + DESIGN.md, produce Dashboard and Data Flows variations (light/dark; desktop + narrow). Record project/screen IDs, visual differences, known omissions, and source revision.
5. **Implement:** select the best approved variant, modify only existing relevant React components in a dedicated feature branch/worktree; no copying generated auth/API/runtime logic.
6. **Validate:** affected Vitest, `tsc -b && vite build`, changed-file lint, Playwright authentic browser screenshot comparisons at desktop/375px, keyboard focus, light/dark, navigation, operational snapshot unknown/stale/partial states, topology accuracy, saved Route selection/inspector, role gating. Preserve current BFS/FUE acceptance gates.
7. **Git gates:** commit/push a coherent, reviewed set; draft PR with source/screenshots and regression evidence. Do not claim product release or merge automatically.

## Skill and service setup

Reference: <https://github.com/google-labs-code/stitch-skills> (Apache-2.0).
Required server: <https://stitch.googleapis.com/mcp>; official setup: <https://stitch.withgoogle.com/docs/mcp/setup/>.
Target skills: `extract-design-md`, `code-to-design`, `manage-design-system`, `generate-design`, `react-components`. Install selectively rather than importing all 16 skills blindly. Review upstream skill scripts before execution.

**Owner actions required before Stage 3:** sign in at <https://stitch.withgoogle.com/>, open <https://stitch.withgoogle.com/settings> and generate an API key; make the key available **only** through an approved secret/credential mechanism in the AI execution environment (not pasted into a chat/Issue, committed in Git, or embedded in a tracked MCP config). Confirm the Stitch project or allow creation of a dedicated `DataRelay Control UX Pilot` project. Approve the specific sanitized files before they are uploaded to Google's external service.

**Current environment observation (2026-11-22 KST):** `dev-drcontrol` reachable over DRLink Server MCP; `node` installed, but `npm` and `npx` are not in the default execution PATH. Direct remote public Git access test timed out. These limit automated installer validation; neither prevents source extraction or a later direct authenticated Stitch MCP client.

## Completion evidence vs blockers

- Source/design extraction is not a claim that Stitch created screens.
- No Stitch API key, project validation, external upload, generated designs, React code merge, browser comparison or E2E PASS is asserted by this document.
- Stage 2/3 external authorization is a **real owner dependency**, while source-only design inventory can proceed independently.
- Other in-flight Control PRs and worktrees remain untouched; reconcile the latest integration HEAD before implementing generated UI.
