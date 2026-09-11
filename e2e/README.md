# Full E2E Lab (Phase 2 Smoke + Phase 3 Matrix + Phase 4 Release Gate)

Unified lab + Playwright framework for connector → runtime → collector delivery.

## Purpose separation

| Purpose | Entry |
|---------|-------|
| Regression / Release (332 + XP) | `./e2e/run-full-e2e-lab.sh` smoke / matrix / release-gate |
| Continuous operational lab | `e2e/continuous/` — `npm run continuous:validate` |
| Real SaaS E2E candidates | `e2e/real-apps/` |

See `e2e/continuous/PHASE_REPORT.md` for the tool-validation phase report.

## Quick start

```bash
# Phase 2 smoke
./e2e/run-full-e2e-lab.sh all --route-processing=off
./e2e/run-full-e2e-lab.sh all --route-processing=on

# Phase 3 full matrix
./e2e/run-full-e2e-lab.sh all-matrix --route-processing=off
./e2e/run-full-e2e-lab.sh all-matrix --route-processing=on

# Shard optional
GDC_E2E_SHARD=authentication ./e2e/run-full-e2e-lab.sh all-matrix --route-processing=off

# Merge + validate execution completeness
./e2e/run-full-e2e-lab.sh merge-results
./e2e/run-full-e2e-lab.sh validate-results

# Phase 4 Release Gate
./e2e/run-full-e2e-lab.sh release-gate evaluate --run-id phase33_final
./e2e/run-full-e2e-lab.sh release-gate compare-baseline
./e2e/run-full-e2e-lab.sh release-gate validate-evidence --commit "$(git rev-parse HEAD)" --run-id phase33_final
./e2e/run-full-e2e-lab.sh release-gate rc --run-id <a> --run-id <b>

# Fault injection (test fixtures / lab API only)
./e2e/run-full-e2e-lab.sh fault start database
./e2e/run-full-e2e-lab.sh fault stop database
./e2e/run-full-e2e-lab.sh fault reset
```

Commands: `up` | `reset` | `test` | `matrix` | `collect` | `cleanup` | `cleanup-stale` | `validate-cleanup` | `down` | `all` | `all-matrix` | `fault` | `merge-results` | `validate-results` | `release-gate`

## When Full E2E runs (developers)

You do **not** need to run the Full Matrix (332) or Cross-Product (32,184) for routine PR work.

| Cadence | Who runs it | Scope |
| ------- | ----------- | ----- |
| PR | GitHub Actions (path-filtered) | Cheap/unit checks — see **CI** below. Does **not** run Full Matrix 332 or XP 32k. |
| Nightly (cron) | `e2e-regression.yml` | WireMock/syslog **pytest** regression (`e2e_regression`) — **not** the Playwright Full Matrix. |
| Full Matrix 332 / XP / Release Gate / Continuous / Keycloak | **Manual** (`./e2e/run-full-e2e-lab.sh`, `npm` scripts under `e2e/`) | Explicit local or operator runs; **not** normal PR CI. |
| Toxiproxy bandwidth | Manual only | Latency / timeout / TCP reset are automated locally; bandwidth is `MANUAL_ONLY`. |

Local use: smoke, a single scenario, an affected shard, Continuous Lab, or real-apps auth when debugging.

## Automatic resource cleanup

Every Full E2E run tracks created resource **IDs** in:

`e2e/reports/<run-id>/created-resources.json`

Lifecycle (success, failure, timeout, SIGINT/CI cancel best-effort):

```text
E2E execution
→ evidence collect
→ cleanup registered IDs (API-first)
→ validate cleanup
→ return original test exit code
```

Rules:

- Delete by **recorded IDs** only — never by `[FULL E2E]` name prefix alone.
- Do **not** delete general developer resources or `[DEV VALIDATION]` assets.
- Evidence is collected **before** cleanup; evidence files are retained.
- Cleanup success never upgrades a scenario FAIL to PASS.

### Manual cleanup commands

```bash
# Cleanup one run's registry
./e2e/run-full-e2e-lab.sh cleanup --run-id <run-id>
./e2e/run-full-e2e-lab.sh validate-cleanup --run-id <run-id>

# Inventory evidence-correlated leftovers, then cleanup owned registries only
./e2e/run-full-e2e-lab.sh cleanup-stale

# Inspect leftovers without deleting
cd e2e && npm run cleanup:inventory -- --write-run-id inspect-$(date -u +%Y%m%d_%H%M%S)
# Review e2e/reports/inspect-*/ownership-inventory.json (unowned listed, not deleted)
```

## Scenario generation

```bash
cd e2e
npm run scenarios:generate
npm run scenarios:validate
npm run results:merge
npm run results:validate
```

Source of truth: `e2e/capabilities/data-relay-capabilities.yaml`  
Generated: `e2e/scenarios/generated/*.json`

## Release Gate pipeline

Release Gate tooling lives under `e2e/release-gate/` and is invoked **manually** (or via `./e2e/run-full-e2e-lab.sh release-gate …`). There is **no** GitHub Actions workflow that runs Full Matrix → merge → Release Gate on a schedule.

```text
PR CI            → path-filtered backend/frontend + release-gate-unit (+ optional path E2E)
Manual Full Lab  → smoke / matrix / merge / release-gate evaluate (operator-driven)
Nightly CI       → WireMock pytest regression only (e2e-regression.yml)
Full 332 / XP    → not automatically executed by normal PR CI
```

Release PASS (when evaluating local evidence) requires:

- FAIL / BLOCKED / GAP / Missing = 0
- Browser / route-off / route-on complete
- Smoke PASS + Coverage Validation PASS
- NOT_IMPLEMENTED not increased beyond baseline (current expected: 20 with Manifest PARTIAL evidence)
- Evidence commit matches release target; result age within policy

Gate statuses: `PASS` | `FAIL` | `STALE` | `INCOMPLETE`

### Local Release Gate commands

```bash
./e2e/run-full-e2e-lab.sh release-gate evaluate --run-id <run-id>
./e2e/run-full-e2e-lab.sh release-gate validate-evidence --commit <sha> --run-id <run-id>
./e2e/run-full-e2e-lab.sh release-gate compare-baseline
./e2e/run-full-e2e-lab.sh release-gate rc --run-id <attempt1> --run-id <attempt2>
./e2e/run-full-e2e-lab.sh release-gate detect-shards --base origin/main-v2
```

### Baseline refresh (manual only — never auto in CI)

```bash
cd e2e
npm run scenarios:generate
npm run release-gate:build-baseline -- --run-id <latest-pass-run>
# Review diffs under e2e/release-gate/baseline/ then commit intentionally
```

### NOT_IMPLEMENTED change procedure

1. Update Capability Manifest status / limitations / evidence.
2. Regenerate scenarios (`npm run scenarios:generate`).
3. Re-run affected matrix; confirm NI count change is intentional.
4. Refresh `not-implemented-baseline.json` via `release-gate:build-baseline`.
5. Document rationale in PR — CI will fail on unexplained NI increase.

### Failure evidence

- Per scenario: `e2e/reports/<run-id>/<scenario-id>/`
- Merged: `e2e/reports/<run-id>/final/` (`matrix-summary.json`, `scenario-results.json`, `release-gate.json`, `flake-report.json`, `artifact-checksums.json`)

## Layout

| Path | Role |
| ---- | ---- |
| `e2e/lab/` | Compose, fixtures, collectors, reset, fault-inject |
| `e2e/framework/` | Driver, fixtures, evidence, resource registry/cleanup, matrix executor, merge |
| `e2e/scenarios/` | Matrix generator + coverage / execution validation |
| `e2e/release-gate/` | Phase 4 gate evaluation, baseline, flake, checksums |
| `e2e/smoke/` | Phase 2 smoke |
| `e2e/matrix/` | Phase 3 full matrix runner |
| `e2e/reports/` | Evidence + coverage + `final/` merged reports |

## CI

Actual workflows under `.github/workflows/` (there are **no** `full-e2e-*.yml` files):

| Workflow | When | Scope |
| -------- | ---- | ----- |
| `backend-tests.yml` | PR/push `main-v2` + dispatch | Path-filtered `detect-paths` → conditional `migration-validation` / `pytest-full` |
| `frontend-tests.yml` | PR/push `main-v2` + dispatch | Path-filtered `detect-paths` → conditional Vitest + build |
| `oss-v1-release-validation.yml` | PR/push `main-v2` + dispatch | Always-on cheap `release-gate-unit` (OSS gate + route-compare unit tests) |
| `e2e-smoke.yml` | PR (path-filtered) | WireMock + syslog pytest smoke |
| `e2e-regression.yml` | Push `main`/`main-v2` + nightly cron + dispatch | WireMock pytest full regression |
| `source-adapter-e2e.yml` | PR (path-filtered) + dispatch | Optional S3/DB/remote-file adapter E2E |
| `external-runtime-e2e.yml` | PR (path-filtered) + dispatch | Optional StreamRunner external runtime E2E |
| `docker-validate.yml` | PR/push (compose/script paths) + dispatch | Compose config, ShellCheck, lightweight secret scan |
| `backend-focused.yml` / `frontend-focused.yml` | PR (narrow paths) | Focused pytest / frontend build |

**Not automated by normal PR CI** (available as explicit/manual E2E tooling):

- Full Matrix 332 (`./e2e/run-full-e2e-lab.sh all-matrix …`)
- Cross-Product 32,184 runtime
- Continuous E2E Lab (`e2e/continuous/`, `npm run continuous:*`)
- Keycloak / real-apps auth stacks (`e2e/real-apps/` — Keycloak is ON_DEMAND)
- Full Release Gate evaluate / RC consecutive Full Matrix PASS
- Toxiproxy bandwidth faults (`MANUAL_ONLY`)

## Notes

- Product `GDC_ROUTE_PROCESSING_ENABLED` default is **not** changed; only the lab uvicorn process uses the env file.
- API-seeded paths do not replace required Browser E2E coverage.
- Phase 1 mismatches remain `NOT_IMPLEMENTED` / `KNOWN_PRODUCT_GAP` — product code is out of scope.
- Outcomes: `PASS` | `FAIL` | `BLOCKED` | `NOT_APPLICABLE` | `NOT_IMPLEMENTED` | `KNOWN_PRODUCT_GAP` (no silent skips).
- Infra-only retries are recorded in matrix results; product failures are never retried.
- CI never auto-updates baselines.
