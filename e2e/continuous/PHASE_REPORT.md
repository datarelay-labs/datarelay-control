# DATA_RELAY_E2E_TOOL_VALIDATION_AND_CONTINUOUS_LAB

Branch: `test/e2e-continuous-lab`  
START_HEAD: `4c784cac7ccbade271d6f709485ba746e0e44a85` (origin/main-v2)

## 1. CURRENT_E2E_ARCHITECTURE

Three intentional purposes separated:

| Purpose | Location | Lifecycle |
|--------|----------|-----------|
| A. Regression / Release | `e2e/scenarios` (332), `e2e/cross-product` (32184), `e2e/release-gate`, smoke | ephemeral `full-e2e-lab` |
| B. Continuous Lab | `e2e/continuous/` | keep-alive `continuous-e2e-lab` |
| C. Real Application E2E | `e2e/real-apps/` | on-demand; UNCONFIGURED without secrets |

Existing stack reused: capability manifest, framework driver/registry/cleanup, lab compose + WireMock/Postgres/MinIO/SFTP/collectors, scenario + XP generators. Parallel systems not replaced: pytest WireMock, frontend Playwright, suite-validation.

## 2. CURRENT_CAPABILITY_AND_MATRIX_COUNTS

Regenerated/validated on this branch:

| Metric | Count |
|--------|------:|
| CURRENT_CAPABILITY_COUNT | **95** |
| CURRENT_332_MATRIX_COUNT | **332** |
| CURRENT_CROSS_PRODUCT_CANDIDATE_COUNT | **40428** |
| CURRENT_CROSS_PRODUCT_VALID_COUNT | **32184** |
| CURRENT_NOT_APPLICABLE_COUNT | **8244** |
| CURRENT_NOT_IMPLEMENTED_COUNT (combinations) | **0** |
| Supported capabilities with scenarios | 82 |
| Matrix NOT_IMPLEMENTED scenarios | 20 |

## 3. EXISTING_ASSETS_REUSED

Full E2E orchestrator, resource registry/cleanup, lab fault-inject, WireMock mappings, scenario/XP generators, release-gate + OSS v1 unit tests, FixtureClient / DataRelayDriver.

## 4. STALE_OR_BROKEN_E2E_ASSETS

1. Capability evidence paths stale (`validate_capabilities.py` FAIL on moved frontend/enricher paths; manifest pin 2026-07-16).
2. Documented Full E2E CI workflows missing from `.github/workflows/`.
3. Dual WireMock trees (`tests/wiremock` vs `e2e/lab/fixtures/http`).
4. Suite-validation recovery baselines reference other checkout absolute paths.
5. `.env.route-off|on` gitignored — clean checkouts only have committed `.env.oss-v1-route-*` unless local env created.

STALE_CAPABILITIES: evidence-path drift.  
NEW_UNCOVERED / under-split: `common_headers`; API key header vs query; SSH password vs key; webhook inbound modes; OAuth auth-code/PKCE correctly NOT_IMPLEMENTED.

## 5. AUTHENTICATION_COVERAGE

SUPPORTED in product+E2E: no_auth, basic, bearer, api_key header/query, oauth2_client_credentials, session_login, jwt_refresh_token, vendor_jwt_exchange (wizard gap), S3 keys, DB password, SSH password/key, webhook inbound shared-secret/bearer, syslog mTLS.  
PARTIAL: refresh lifecycle (no rotation/cache), custom headers, destination webhook headers (API-only).  
NOT_IMPLEMENTED: OAuth2 authorization code, PKCE.

## 6. GENERAL_DATA_COVERAGE

Added CRM/commerce/finance/ITSM/productivity/generic business WireMock + Postgres/S3/SFTP fixtures under `e2e/lab/fixtures/`. Continuous profile uses these; security fixtures remain but no longer dominate.

## 7. REAL_SAAS_E2E_CANDIDATES

`e2e/real-apps/candidates.yaml` — **14** candidates. Recommended: HubSpot, Stripe, Shopify, Atlassian Jira, Microsoft 365, GitHub. Live validated: **0** (UNCONFIGURED).

## 8. TOOL_EVALUATION

WireMock KEEP/extend. Toxiproxy ADOPT test-only. Hoverfly REJECT (use WireMock record + sanitize).

## 9. TOXIPROXY_DECISION

**ADOPT** — `docker-compose.toxiproxy.yml`, `fault-toxiproxy.sh`, continuous network degradation cycle. Not in production compose.

## 10. CAPTURE_REPLAY_DECISION

**REJECT Hoverfly**. Path: Real SaaS → WireMock record → `sanitize-capture.ts` → WireMock fixture.

## 11. CONTINUOUS_E2E_DESIGN

12 streams (8–15 band), ≤1 EPS each, ownership `continuous-e2e-lab`, ephemeral cleanup refuses continuous registries, state machines for idle/latency/destination/rate-limit/partial-route/schema-drift, retention bounds in `retention.yaml`. Live API ensure opt-in via `GDC_CONTINUOUS_LIVE_ENSURE=1`.

## 12. IMPLEMENTED_CHANGES

- `e2e/continuous/**`
- Toxiproxy lab overlay + fault CLI
- Business fixtures
- `e2e/real-apps/**`
- Registry ownership `continuous-e2e-lab` + cleanup refusal messaging
- Orchestrator `continuous` / `fault-toxi`
- gitignore for continuous state + real-apps secrets

PRODUCT_CODE_MODIFIED=NO

## 13. TEST_RESULTS

PASS: scenarios generate/validate, XP generate/validate, continuous tests, real-apps validate/sanitize, toxiproxy CLI test, compare-route, oss-v1 gate.  
Known FAIL (pre-existing): capability evidence path validator.  
NOT RUN: full 32k runtime, live browser/API lab smoke, live SaaS.  
FULL_32K_RUNTIME_EXECUTED=NO

## 14. PRODUCT_BUGS_DISCOVERED

1. Stream wizard omits `vendor_jwt_exchange`; unknown auth maps to `NO_AUTH`.

PRODUCT_BUGS_FOUND=1 (reported, not fixed here)

## 15. REMAINING_GAPS

Live continuous ensure; restore Full E2E CI workflows; refresh capability evidence; unify WireMock trees; SaaS credentials; Docker-up Toxiproxy recovery test.

## 16. RECOMMENDED_REAL_ACCOUNTS_TO_CREATE

HubSpot, Stripe, Shopify Partner store, Atlassian Jira cloud, M365 developer sandbox, GitHub e2e org.

## 17. NEXT_ACTIONS

1. Review/merge this branch  
2. Create SaaS accounts + local `.env.real-apps`  
3. Lab up + Toxiproxy overlay + live continuous ensure  
4. Manifest evidence refresh PR  
5. Re-add Full E2E CI workflow stubs
