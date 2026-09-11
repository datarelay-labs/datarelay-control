# Continuous E2E Lab

Long-lived, curated operational profile for Dashboard / Streams / Routes /
Destinations visibility. **Not** a substitute for the 332 scenario matrix or
the Full Cross-Product suite.

## Purpose separation

| Mode | Scope | Lifecycle |
|------|-------|-----------|
| Regression / Release | 332 matrix + release gates | ephemeral create → test → cleanup |
| Continuous Lab (this) | 8–15 representative streams | ensure → keep alive → reset state → reuse |
| Real Application E2E | live SaaS when credentials present | on-demand; see `e2e/real-apps/` |
| Local coverage expansion | Keycloak / shared business / WireMock stateful / DNS / TLS | on-demand scripts under `e2e/lab` + `e2e/real-apps/keycloak` |

## Ownership

- Ownership tag: `continuous-e2e-lab`
- Name prefix: `[CONTINUOUS E2E]`
- Ordinary Full E2E cleanup (`full-e2e-lab`) **never** deletes these resources
- Explicit teardown: `npm run continuous:teardown` or
  `./e2e/run-full-e2e-lab.sh continuous teardown`

## Quick start — continuous lab

```bash
cd e2e && npm run continuous:validate

GDC_E2E_API_BASE_URL=http://127.0.0.1:8000 \
GDC_CONTINUOUS_LIVE_ENSURE=1 \
  npm run continuous:ensure

npm run continuous:live-validation
npm run continuous:reset
GDC_CONTINUOUS_LIVE_ENSURE=1 npm run continuous:teardown -- --live
```

## Local coverage expansion (no external SaaS)

```bash
cd e2e

# 1) Start local real-auth labs (Frappe/WordPress continuous; Keycloak ON_DEMAND)
npm run real-apps:up
npm run real-apps:keycloak:up
# wait ~2–4 min cold start:
curl -sf http://127.0.0.1:8089/realms/gdc-e2e/.well-known/openid-configuration

# 2) Seed shared deterministic business dataset across HTTP/PG/S3/SFTP/Webhook
npm run lab:business-data:seed

# 3) Targeted validation
npm run real-apps:keycloak:test
npm run real-apps:keycloak:recovery
npm run lab:local-coverage:test   # includes SSH private-key SFTP REAL
npm run lab:sftp-key:test         # REMOTE_FILE private_key only (no password)
npm run lab:dns:test
npm run lab:tls:test
npm run lab:toxiproxy-expand      # latency/timeout/tcp_reset PASS; bandwidth=MANUAL_ONLY

# 4) Teardown on-demand Keycloak when finished
npm run real-apps:keycloak:down
```

Ephemeral Keycloak/DNS proof streams use the `[E2E LAB EPHEMERAL]` name prefix and
self-delete so they never pollute Continuous Lab ownership (`[CONTINUOUS E2E]`).

### Inject network / DNS / TLS failure

```bash
# Toxiproxy (latency | timeout | reset | bandwidth)
# bandwidth is MANUAL_ONLY — do not CI-gate
./lab/fault-toxiproxy.sh start latency wiremock 2000
./lab/fault-toxiproxy.sh start reset wiremock
./lab/fault-toxiproxy.sh stop wiremock
./lab/fault-toxiproxy.sh reset

# DNS NXDOMAIN + recovery (uses OS resolver; no CoreDNS)
npm run lab:dns:test

# TLS negatives (existing syslog TLS pytest) + collector stop/recover
npm run lab:tls:test
```

### Reset / teardown

```bash
npm run continuous:reset
npm run real-apps:keycloak:down
npm run real-apps:down
# platform continuous resources:
GDC_CONTINUOUS_LIVE_ENSURE=1 npm run continuous:teardown -- --live
```

## Resource limits

See `profile.yaml` → `resource_limits` and `retention.yaml`.

| Service | Lifecycle | Observed memory |
|---------|-----------|-----------------|
| Frappe harness | continuous | ~17MiB / 128MiB |
| WordPress harness | continuous | ~17MiB / 128MiB |
| Keycloak + resource | **ON_DEMAND** | ~346–384MiB / 768MiB |
| Toxiproxy | continuous lab infra | ~11MiB / 256MiB |

## Related

- Lab compose: `e2e/lab/docker-compose.full-e2e.yml`
- Toxiproxy: `e2e/lab/docker-compose.toxiproxy.yml`
- Business data: `e2e/lab/business-data/README.md`
- Keycloak: `e2e/real-apps/keycloak/README.md`
- PocketBase decision: `e2e/lab/POCKETBASE_DECISION.md` → **REJECT_REDUNDANT**
- Real SaaS candidates (out of this phase): `e2e/real-apps/candidates.yaml`
