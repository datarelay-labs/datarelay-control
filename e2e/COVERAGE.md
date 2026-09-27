# Data Relay E2E Coverage — Phase A-D Control Inventory

Source of truth: [`e2e/capabilities/data-relay-capabilities.yaml`](capabilities/data-relay-capabilities.yaml)  
Provenance commit: `9d5b6a652973e9580959561315f17820ef0d9bcf`
Generated: `2026-09-27T04:05:00Z`

This document inventories **current Phase A-D Control** capabilities. AI Proxy, AI Provider, and Phase E/F are out of current Control scope and are not Source or Destination support rows. It does **not** invent features.

Validate with:

```bash
python3 e2e/capabilities/validate_capabilities.py
```

---

## A. Current Support Scope Summary

| Area | Count | Notes |
| ---- | ----: | ----- |
| Authentication capabilities | 14 | 8 HTTP `AuthType` + S3 keys + DB password + SSH creds + webhook inbound + syslog mTLS + webhook headers (PARTIAL). AI provider auth is Phase E and excluded. |
| Source types | 5 | Charter core: HTTP API Polling, Database Query, Webhook Receiver. Release-qualified extensions: S3 Object Polling, Remote File Polling. |
| Destination types | 4 | Syslog UDP/TCP/TLS and Webhook POST. |
| Transform / processing | 12 | 8 enrichment rule types + 4 mapping/policy features |
| Wizard features / steps | 16 | 5 steps + feature capabilities, including Route Processing |
| Route capabilities | 6 | Architecture, global processing, per-route transform, per-route protection/classification/policy, delivery, metrics |
| Governance capabilities | 16 | Protection, delivery behaviors, ops surfaces |
| Runtime capabilities | 10 | Retry, checkpoint, dedup, failover, fault fixtures, etc. |
| Feature flags | 4 | Route Processing (default true, false rejected), protection, sensitive detection, classification |
| Test infrastructure | 5 | Playwright, WireMock pytest, source E2E, lab, auth fixtures |
| **Phase A-D capabilities** | **92** | Three Phase E rows remain in the manifest as `OUT_OF_SCOPE` and are excluded from this total. |

Product constraints confirmed in code:

- Database Query product `db_type` = **POSTGRESQL only** (MySQL/MariaDB are lab fixtures only).
- Route Processing is ON-only. `GDC_ROUTE_PROCESSING_ENABLED` defaults **true**, and explicit false is rejected.
- `SourceRateLimiter.allow` is a no-op (always `True`).

---

## B. Source Matrix

| Source | Auth | Connection Test | Sample | Checkpoint | Dedup | Existing E2E | Required E2E |
| ------ | ---- | --------------: | -----: | ---------: | ----: | -----------: | -----------: |
| HTTP_API_POLLING | 8 HTTP AuthTypes | Yes | Yes | Yes | Yes (stream) | WireMock pytest + Playwright record-selection (partial) | Full wizard create→delivery |
| S3_OBJECT_POLLING | access/secret key | Yes | Yes | Yes (mtime/key watermark) | Yes | `source_e2e` / external runtime / S3 checkpoint tests | Playwright S3 path |
| DATABASE_QUERY (PostgreSQL) | username/password | Yes | Yes | Yes (SQL checkpoint modes) | Yes | `source_e2e` / external runtime | Playwright DB path |
| REMOTE_FILE_POLLING | SSH password/key | Yes | Yes | Yes (mtime/path) | Yes | `source_e2e` / external runtime | Playwright remote-file path |
| WEBHOOK_RECEIVER | inbound no_auth / shared_secret / bearer | No (push) | Partial | Partial (observability hidden) | Yes | ingest unit + visible E2E seed | Playwright ingest→delivery |

---

## C. Destination Matrix

| Destination | Auth | Test Delivery | Retry | Failover | TLS | Existing E2E | Required E2E |
| ----------- | ---- | ------------: | ----: | -------: | --: | -----------: | -----------: |
| SYSLOG_UDP | none | Yes | Route-level | Yes | No | `test_e2e_syslog_delivery.py` | Playwright create + test |
| SYSLOG_TCP | none | Yes | Route-level | Yes | No | same | Playwright create + test |
| SYSLOG_TLS | optional mTLS client cert | Yes | Route-level | Yes | Yes | `test_syslog_tls_destination.py` | Playwright TLS path |
| WEBHOOK_POST | headers in config (UI missing) | Yes | Sender + route | Yes | Via HTTPS URL | WireMock matrix | Playwright payload modes + header auth |

---

## D. Feature Layer Matrix (selected)

| Feature | UI | API | Runtime | Existing Test | Status |
| ------- | -: | --: | ------: | ------------: | ------ |
| HTTP auth (8 types) | Y | Y | Y | connector auth + WireMock | SUPPORTED |
| S3 / DB / SSH credentials | Y | Y | Y | source adapter E2E | SUPPORTED |
| Webhook dest header auth | N | Y | Y | destination test endpoint | PARTIAL |
| Enrichment rules (8) | Y | Y | Y | enrichment + normalize/timestamp E2E | SUPPORTED (lookup PARTIAL UI) |
| Full-event JSONata/Regex | Y | Y | Y | mapping tests + Playwright full-event | SUPPORTED |
| Unmapped pass-through/drop | Y | Y | Y | mapping pipeline + drop-policy UI | SUPPORTED |
| Wizard Route Processing step | Y | Y | Y | wizard persist tests + per-route pytest | SUPPORTED |
| Per-route transform from wizard | Y | Y | Y | wizard persist + effective transform tests | SUPPORTED |
| Per-route protection / classification / policy | Y | Y | Y | per-route governance tests | SUPPORTED |
| Rare field badge | Y | N | N | unionSchema unit | UI_ONLY |
| Sensitive suggestion (wizard) | Y | N | N | evaluateUnionFieldSuggestion unit | UI_ONLY |
| Dedup | Y (config tab) | Y | Y | stream_dedup tests | SUPPORTED (not wizard step) |
| Incremental fetch | Y | Y | Y | incremental stream runner E2E | SUPPORTED |
| Checkpoint after delivery success | Y | Y | Y | S3 CP + syslog TLS fail CP | SUPPORTED |
| Source rate limit | Y (config) | Y | N (no-op) | — | PARTIAL |
| Dest rate limit max_events/per_seconds | partial UI | Y | Y | — | PARTIAL vs capacity/burst UI |
| Protection actions | Y | Y | Y | protection engine | SUPPORTED |
| Delivery continue/quarantine/block | Y | Y | Y | governance tests | SUPPORTED |
| require_review | partial | Y | Y | schema drift | PARTIAL vs wizard enum |
| Replay / Quarantine centers | Y | Y | Y | page + backend tests | SUPPORTED |
| Playwright in CI | — | — | — | local only | PARTIAL infra |

---

## E. Discovered Mismatches

| Item | UI | API | Runtime | Problem |
| ---- | -: | --: | ------: | ------- |
| Webhook destination auth headers | N | Y | Y | Destinations form stores `url` + `payload_mode` only; headers API/runtime supported |
| Rare field / sensitive suggestion | Y | N | N | Client-only heuristics; runtime sensitive detection is separate flag/engine |
| Lookup enrichment | Partial (excluded from some add menus) | Y | Y | `excludeRuleTypes={['lookup']}` on Charter transform panel |
| Source rate limiter | config present | stored | always allow | `SourceRateLimiter.allow` TODO / returns `True` |
| Destination capacity/burst UI | Y | stored | not consumed | Limiter only reads `max_events` / `per_seconds` |
| Wizard delivery behaviors vs `require_review` | continue/quarantine/block | require_review aliases | Y | Review used for drift/unknown fields, not wizard delivery enum |
| Preview vs runtime sensitive | suggestion heuristic | findings API | detector | Different implementations — not comparable 1:1 |
| Playwright browser E2E | local scripts | — | — | **Not in CI** (frontend-tests runs Vitest + build only) |
| WireMock port defaults | — | — | — | Some scripts default `:18080`; helpers/CI use `:28080` |
| MySQL/MariaDB | lab compose only | rejected by product | N | Lab fixtures ≠ product `db_type` support |

---

## F. E2E Priority

### P0 — Connector → Delivery core path

- HTTP connector create (no_auth / basic / bearer / api_key) → Sample (Record Path + Checkpoint) → Destination → Deploy → live delivery
- Webhook destination delivery + syslog UDP/TCP smoke
- Checkpoint advances only after delivery success (already partially covered in pytest; need browser/ops confirmation)

### P1 — Auth · Checkpoint · Dedup · Multi-route · Transform

- Remaining HTTP auth: oauth2_cc, session_login, jwt_refresh, vendor_jwt_exchange
- S3 / Database / Remote File create + checkpoint delivery (Playwright on top of existing `source_e2e`)
- Stream dedup configuration + runtime skip
- Incremental fetch config + live advance
- Multi-route delivery + route health from Runtime Snapshot
- Enrichment type_conversion / jsonata / calculated (normalize + timestamp already have Playwright)
- Full-event regex mapping Playwright

### P2 — Governance · Replay · Quarantine · Failover

- Protection mask/tokenize/hash/drop runtime vs preview
- Quarantine center release/discard
- Replay center dry-run + live
- Failover route activation
- Per-route transform, protection, classification, and policy on the Route-ON runtime
- Schema drift / require_review / auto_protect

### P3 — Fault injection · a11y · volume · browsers

- Expand fault matrix: HTTP 403, DB disconnect, object storage unavailable, connector TLS errors
- Admin a11y (partial: Retention dialog already)
- Large-volume / EPS lab visibility (reuse Dev Validation Lab; do not reduce 5–20 EPS)
- Cross-browser Playwright (currently Chromium-focused)

---

## G. Phase 2 Lab / Fixture Needs (do not implement now)

Priority-ordered inputs for the next phase:

1. **Unified browser E2E stack** — compose profile joining API + UI + WireMock + webhook-receiver + syslog + MinIO + PG query + SFTP; single env contract for Playwright (`REQUIRE_AUTH`, ports, credentials).
2. **Auth emulators (WireMock)** — already strong for HTTP auth; add missing **403** source fault; keep 401/429/500/retry scenarios.
3. **Destination auth fixture** — webhook with required Authorization header; optional Syslog TLS mTLS receiver already partially present via `syslog-test`.
4. **Per-source Playwright fixtures** — seeded or API-created connectors for S3 (MinIO), PostgreSQL query, SFTP; reuse `scripts/testing/source-e2e/seed-fixtures.sh`.
5. **Route Processing runtime** — test env uses the canonical ON path. Explicit false is rejected and is not a supported matrix axis.
6. **Governance fixtures** — quarantine events, replayable deliveries, policy packages for ops-page Playwright.
7. **CI Playwright job** — smoke subset first (record-selection + operator-auth + one deploy path); keep backend WireMock CI as-is.
8. **Do not** treat MySQL/MariaDB lab containers as product DB types unless product `db_type` is implemented.

Reusable today (do not rebuild):

- `docker-compose.test.yml` services
- `tests/wiremock/mappings/**`
- `tests/e2e_wiremock_helpers.py`, `tests/e2e_runtime_helpers.py`, `tests/e2e_syslog_helpers.py`
- Dev Validation Lab + `[DEV E2E]` visible seed (preserve 5–20 EPS)
- Playwright `frontend/e2e/helpers/auth-flow.ts`

Missing today:

- Playwright in CI
- Single create→deploy→runtime browser journey
- Governance / Destinations / Routes / Dashboard Playwright coverage
- Documented webhook header-auth UI path
- Product MySQL/MariaDB (intentionally absent)

---

## Existing Test Infrastructure Survey

### Playwright (`frontend/e2e/`)

| Spec | Coverage |
| ---- | -------- |
| `operator-auth-runtime-smoke.spec.ts` | Login / AppShell / Runtime / bearer API |
| `record-selection-smoke.spec.ts` | Wizard Record Selection + mapping + run control |
| `record-selection-workspace-validation.spec.ts` | CloudTrail sample, checkpoint, mapping tree |
| `wizard-full-event-mapping.spec.ts` | Full-event mapping preview/save |
| `wizard-v3-manual-validation.spec.ts` | Draft resume, API Test gates, deploy, protection |
| `normalize-fields-verify.spec.ts` | Normalize rule UI |
| `timestamp-conversion-timezone-restore.spec.ts` | Timestamp conversion restore |
| `a11y-keyboard-admin-modals.spec.ts` | Admin Retention a11y (opt-in) |
| screenshot specs | UX capture only |

Configs: `frontend/playwright.config*.ts` (9 configs). **Not run in GitHub Actions.**

### Backend / CI E2E

| Workflow | Scope |
| -------- | ----- |
| `e2e-smoke.yml` | WireMock + syslog smoke |
| `e2e-regression.yml` | Auth/data/routes/checkpoint matrix |
| `source-adapter-e2e.yml` | S3 / DB / remote-file → webhook/syslog |
| `external-runtime-e2e.yml` | StreamRunner vs real fixtures |
| `backend-tests.yml` | Full backend |
| `frontend-tests.yml` | Vitest + build (**no Playwright**) |

### Already covered vs gaps

| Scope | Status |
| ----- | ------ |
| HTTP source auth matrix (pytest/WireMock) | Strong |
| Syslog UDP/TCP delivery | Strong |
| Syslog TLS + checkpoint-not-on-fail | Strong (pytest) |
| S3/DB/SFTP source adapters | Strong (pytest CI); weak Playwright |
| Enrichment normalize/timestamp browser | Partial Playwright |
| Wizard full create→start→EPS | Missing Playwright |
| Governance ops browser | Missing Playwright |
| Multi-route + flag-on pipeline browser | Missing |
| Dedup / incremental browser | Missing |
| Dashboard / Runtime Snapshot browser | Missing (ops smoke only) |

---

## Remaining Investigation Limits

These need a live environment or product decision; inventory alone cannot close them:

1. Route Processing code default is true. Explicit false is rejected at settings load.
2. Whether AI destinations should appear in Destinations UI (product decision; currently API/runtime only via AI Providers).
3. End-to-end parity of every enrichment preview path vs runtime under route overrides with flag on (unit parity exists for classification/policy; wizard path incomplete).
4. Full fault-injection coverage for DB disconnect / object-storage outage / connector TLS beyond current partial tests.

---

## H. Phase 3 Full Matrix (implemented)

Scenario generation and coverage validation:

```bash
cd e2e && npm run scenarios:generate && npm run scenarios:validate
```

| Artifact | Path |
| -------- | ---- |
| Generator | `e2e/scenarios/generate-full-matrix.ts` |
| Coverage gate | `e2e/scenarios/validate-scenario-coverage.ts` |
| Generated matrices | `e2e/scenarios/generated/*.json` |
| Matrix runner | `e2e/matrix/full-matrix.spec.ts` |
| Manual runner | `./e2e/run-full-e2e-lab.sh all-matrix …` |
| Automated Full Matrix CI | **None** — no `full-e2e-*.yml` workflows in the repo |

Outcomes used (no silent skips): `PASS` | `FAIL` | `BLOCKED` | `NOT_APPLICABLE` | `NOT_IMPLEMENTED`.

`SUPPORTED` capabilities without scenarios fail coverage validation.

---

## I. Phase 4 Release Gate & Continuous Verification

Release Gate binds Full Matrix evidence to commits and blocks stale/incomplete/regressed releases.

Developers do **not** need to run Full Matrix (181) or Cross-Product for routine PR work. Those suites are **manual** (`./e2e/run-full-e2e-lab.sh`, `e2e/` npm scripts). Normal PR CI stays path-filtered and cheap.

| Gate | Mechanism | Scope |
| ---- | --------- | ----- |
| PR (required) | `backend-tests.yml` / `frontend-tests.yml` / `oss-v1-release-validation.yml` | Path-filtered backend/frontend + always-on `release-gate-unit` |
| PR (path-filtered E2E) | `e2e-smoke.yml`, optional `source-adapter-e2e.yml` / `external-runtime-e2e.yml` | WireMock smoke / adapter / runtime when paths match |
| Nightly (pytest) | `e2e-regression.yml` | WireMock/syslog pytest regression — **not** the Full Matrix |
| Full Matrix / XP / RC / Release evidence | Manual CLI | `release-gate evaluate` / `rc` / `validate-evidence` against local run evidence |
| Continuous Lab / Keycloak | Manual / ON_DEMAND | `e2e/continuous/`, `e2e/real-apps/` — not normal PR CI |

### Resource cleanup policy

- Track created IDs in `e2e/reports/<run-id>/created-resources.json`.
- Order: evidence → cleanup (API by ID) → validate; keep test exit code.
- Preserve `[DEV VALIDATION]` and non-owned developer resources; preserve evidence files.
- Manual: `./e2e/run-full-e2e-lab.sh cleanup --run-id <id>`, `cleanup-stale`, `validate-cleanup --run-id <id>`.

| Artifact | Path |
| -------- | ---- |
| Gate config | `e2e/release-gate/release-gate-config.yaml` |
| Baselines | `e2e/release-gate/baseline/*.json` |
| Evaluate | `e2e/release-gate/evaluate-release-gate.ts` |
| Evidence | `e2e/release-gate/validate-release-evidence.ts` |
| Baseline compare | `e2e/release-gate/compare-matrix-baseline.ts` |
| Affected shards | `e2e/release-gate/detect-affected-shards.ts` |
| Flake report | `e2e/release-gate/build-flake-report.ts` |

### Baseline refresh (manual)

```bash
cd e2e
npm run scenarios:generate
npm run release-gate:build-baseline -- --run-id <pass-run-id>
# Commit baseline diffs intentionally — CI never auto-updates baselines
```

### NOT_IMPLEMENTED policy

- Expected count tracked in `not-implemented-baseline.json` (Phase 3 final: **20**).
- Each NI scenario must map to Manifest `PARTIAL` / `UI_ONLY` / `RUNTIME_ONLY` with limitations or evidence.
- NI **increase** or unexplained NI fails the gate; NI **decrease** after real product support is allowed (refresh baseline).

### Local evaluation

```bash
./e2e/run-full-e2e-lab.sh release-gate evaluate --run-id phase33_final
./e2e/run-full-e2e-lab.sh release-gate compare-baseline
```

Gate statuses: `PASS` | `FAIL` | `STALE` | `INCOMPLETE`.

