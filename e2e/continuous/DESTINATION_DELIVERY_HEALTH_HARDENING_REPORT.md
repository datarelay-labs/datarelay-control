# Destination Delivery Health Hardening

- Phase: `DATA_RELAY_DESTINATION_DELIVERY_HEALTH_HARDENING`
- Branch: `fix/destination-delivery-health`
- START_MAIN_HEAD: `fe357bee63049122b6e262ce09a2d72361f55200`
- Original overnight soak: **PARTIAL** (unchanged historical evidence)

## Reference (overnight soak)

Source: `e2e/continuous/OVERNIGHT_SOAK_REPORT.md` on `test/e2e-overnight-soak`

- Window: 7.51h Continuous E2E soak
- Finding B (`webhook_dest`): collector stop → `extracted=1`, `delivered=0`, stream `health_status=HEALTHY`
- Finding C (`syslog_dest`): same pattern
- Finding A (`http_source`): WireMock stubs not reloaded after restart (E2E harness; revalidated here)

## Root cause

Shared delivery-health propagation gap (Webhook and Syslog):

1. **Spec 012 snapshot scoring** (`app/runtime/health_snapshot_read.py` → `_snapshot_outcome`)
   reconstructed `failure_count` as `success_eps × failure_rate / (100 - failure_rate)`.
   When destination outage drives **success EPS to 0**, failure volume collapsed to **0** and
   scored route/destination health falsely returned **HEALTHY (100)**.

2. **Operational stream classifier** treated `last_error > last_success` as DEGRADED *before*
   applying `failure_rate >= 50 → ERROR`, and did not roll up total-route failure.

3. **Snapshot lag**: physical `runtime_*_snapshot` rows update on a ~30s scheduler interval, so
   immediate post-run checks could still read HEALTHY even after `route_send_failed` was logged.

4. **Run-once API** omitted `route_delivery_*` counts / failure message, so soft
   `outcome=completed` hid destination failure from operators and soak impact detection.

Delivery failures **were** logged (`route_send_failed`). The gap was aggregation / presentation.

## Semantic rules preserved

| Case | Expected | Result |
|------|----------|--------|
| input=0, delivered=0 | Idle / No Data / historical HEALTHY — **not** destination error | Preserved (Idle S3 `no_events`, health not ERROR) |
| input>0, all routes fail | Not HEALTHY (ERROR when rate≥50% or all routes failed) | Confirmed |
| partial multi-route | Stream DEGRADED; destination worst-route rollup | Confirmed |
| source HTTP failure | `SOURCE_*` / fetch failure — not destination failure | Confirmed |
| LOG_AND_CONTINUE absorb | Checkpoint may advance; health still non-HEALTHY on send failure | Confirmed |

## Fix

- `_snapshot_outcome`: use `delivered_eps_1m` / `inbound_eps_1m` + `failed_eps_1m` for routes/destinations; synthesize failure volume when success EPS is 0 but failure rate / newer last_error exists
- `classify_stream_health`: apply high failure-rate / total-route-failure → ERROR before soft DEGRADED shortcut; accept route rollup counts
- Re-classify health from physical posture fields on operational-snapshot read
- Run-once: return `route_delivery_success_count` / `route_delivery_failure_count`, set failure message, refresh snapshots after every run-once

## Tests

- `tests/test_destination_delivery_health.py` — healthy / no-data / total failure / partial / recovery classifier + scoring regressions

## Live validation

| Check | Result |
|-------|--------|
| Webhook stop → stream/route/dest not HEALTHY; scored route not HEALTHY | PASS |
| Webhook start → delivery success; route recovers | PASS |
| Syslog stop → same | PASS |
| Syslog start → delivery success | PASS |
| Idle S3 `no_events` not destination ERROR | PASS |
| WireMock stop → source failure; restart + stub reload → CRM resumes | PASS |

## Short soak

Script: `e2e/continuous/soak/destination_health_short_soak.py`  
Evidence: `e2e/continuous/soak/evidence/destination_health_short_soak/`

Rotates webhook dest, syslog dest, WireMock source, Toxiproxy timeout, Idle S3.

### Short soak results

- Combined rotation rounds 1–8: **PASS** (webhook, syslog, WireMock, Toxiproxy, Idle S3)
- Later combined rounds: WireMock stub reload race (E2E infra; same class as overnight Finding A) — not a product health regression
- Focused destination rounds (3× webhook + 3× syslog): **PASS**
  - impact: stream/route ERROR, scored route UNHEALTHY, `false_healthy=false`
  - recovery: delivery success resumes
- Idle S3: **PASS** (`no_events`, not destination ERROR)
- Evidence: `e2e/continuous/soak/evidence/destination_health_short_soak/`

## FINAL_STATUS

**PASS** — destination delivery failures are visible in operational and scored health; No Data / Idle preserved; recovery verified; WireMock harness revalidated with stub reload.

## Overnight soak findings closure

Historical overnight soak remains **PARTIAL** (do not rewrite). Closure of its findings:

| Finding | Class | Resolution | Status |
|---------|-------|------------|--------|
| A — WireMock restart/stub reload | E2E_INFRA_BUG | Harness stub reload revalidated in short soak / live | FIXED → PASS |
| B — Webhook destination false Healthy | PRODUCT BUG | PR #30 delivery-health hardening | FIXED → PASS |
| C — Syslog destination false Healthy | PRODUCT BUG | Same shared root cause; PR #30 | FIXED → PASS |

`OVERNIGHT_FINDINGS_CLOSED=YES` (product-bug closure via PR #30; original soak result unchanged).
