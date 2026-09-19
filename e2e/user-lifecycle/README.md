# Real Browser Operator E2E (User Lifecycle)

Reusable package for **browser-first** Data Relay operator journeys.

```text
USER ACTION = Browser/UI first
VERIFICATION = API / runtime / database / actual destination
FORENSICS = API/log/DB only after user-visible path checked
```

## Purpose

Exercise the full operator lifecycle before release: create connectors and streams in the UI, configure routes/protection/transform, run actual delivery, diagnose failures from the UI, recover, edit, stop/start, and delete safely.

## Architecture

```text
run-user-lifecycle-e2e.sh
  → disposable DB + lab fixtures (never live DB)
  → uvicorn API (isolated port) + vite preview UI
  → cli/main.ts (Playwright operator + verification layer)
  → artifacts under /tmp/data-relay-real-browser-e2e/<RUN_ID>/
```

Reuses `e2e/framework/` (ui-helpers, fixture-client redaction patterns) and existing lab fixtures (WireMock, MinIO, SFTP, PG fixture, webhook echo).

## Prerequisites

- Docker fixtures already used by Full E2E Lab (or `./e2e/run-full-e2e-lab.sh up --route-processing=on` once)
- Node deps: `cd e2e && npm ci`
- Playwright browsers: `cd e2e && npx playwright install chromium`
- Host tools: `psql`, `alembic`, Python app importable from repo root

## Fixtures

| Family   | Fixture                         |
|----------|---------------------------------|
| HTTP     | WireMock `127.0.0.1:28080`      |
| DATABASE | PG fixture `55433`              |
| S3       | MinIO `59000`                   |
| SFTP     | `22222`                         |
| WEBHOOK  | inbound receiver + echo `18091` |
| Sink     | webhook echo receiver           |

Disposable platform DB: `postgresql://gdc:gdc@127.0.0.1:55441/<run_db>` (never live `55432`).

## How to run

```bash
# Smoke (package self-test)
./e2e/user-lifecycle/run-user-lifecycle-e2e.sh --smoke

# Full overnight operator run
./e2e/user-lifecycle/run-user-lifecycle-e2e.sh --all

# Targeted
./e2e/user-lifecycle/run-user-lifecycle-e2e.sh --scenario connector-http
./e2e/user-lifecycle/run-user-lifecycle-e2e.sh --tag smoke,browser

# Headed debug
./e2e/user-lifecycle/run-user-lifecycle-e2e.sh --smoke --headed
```

## Resume / cleanup

```bash
./e2e/user-lifecycle/run-user-lifecycle-e2e.sh --resume <RUN_ID>
./e2e/user-lifecycle/run-user-lifecycle-e2e.sh --cleanup-only <RUN_ID>
```

State: `/tmp/data-relay-real-browser-e2e/<RUN_ID>/state.json`

## Scenario groups

| ID | Group |
|----|-------|
| 00 | package smoke |
| 01 | connector onboarding |
| 02 | authentication |
| 03 | stream creation |
| 04 | sampling and schema |
| 05 | destinations and routes |
| 06 | processing (protection/transform) |
| 07 | deploy and runtime |
| 08 | failure and diagnosis |
| 09 | recovery |
| 10 | edit runtime config |
| 11 | stop / start |
| 12 | delete lifecycle |
| 13 | cleanup and orphans |

Tags: `smoke`, `browser`, `connector`, `stream`, `delivery`, `processing`, `failure`, `recovery`, `checkpoint`, `destructive`, `cleanup`, `overnight`.

## Evidence

Artifacts live **outside** the repo:

```text
/tmp/data-relay-real-browser-e2e/<RUN_ID>/
  final-summary.txt
  scenario-results.tsv
  issues.tsv
  resource-ledger.tsv
  browser-actions.tsv
  network-evidence.tsv
  delivery-evidence.tsv
  status-evidence.tsv
  checkpoint-evidence.tsv
  cleanup-results.tsv
  state.json
  screenshots/   # FAIL / unexpected only
  failures/
```

Each scenario records `EVIDENCE_LEVEL` (`BROWSER_E2E`, `API_INTEGRATION`, `RUNTIME_E2E`, `ACTUAL_DELIVERY`, …). `STATIC_ONLY` alone cannot PASS a user journey.

## Secret handling

Credentials are redacted in console, evidence JSON/TSV, screenshots metadata, and network captures. Never commit artifact directories.

## Known limitations

- Full Stream Wizard UI coverage depends on current wizard selectors; blocked steps are recorded as `PARTIAL` / issues, not forced via API user-action substitution.
- Overnight observation duration is configurable (`ULC_OBSERVE_MINUTES`, default 30).
- Live platform DB/runtime must remain untouched (`LIVE_DB_USED=NO`).
