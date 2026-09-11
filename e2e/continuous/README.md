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

## Ownership

- Ownership tag: `continuous-e2e-lab`
- Name prefix: `[CONTINUOUS E2E]`
- Ordinary Full E2E cleanup (`full-e2e-lab`) **never** deletes these resources
- Explicit teardown: `npm run continuous:teardown` or
  `./e2e/run-full-e2e-lab.sh continuous teardown`

## Quick start

```bash
# Profile validation + dry-run state machine (no platform required)
cd e2e && npm run continuous:validate

# Health/report from current state file (after ensure)
npm run continuous:report

# Advance one state-machine tick (lab faults / toxiproxy if available)
npm run continuous:tick

# Optional: ensure streams against a running lab API (requires lab up)
GDC_E2E_API_BASE_URL=http://127.0.0.1:18000 npm run continuous:ensure
```

## Resource limits

See `profile.yaml` → `resource_limits` and `retention.yaml`.

Targets: ≤1 EPS/stream (default ~0.2), bounded collectors, bounded Docker logs,
bounded fixture growth. Continuous resources are tagged and isolated from
`[DEV VALIDATION]` and `[FULL E2E]` assets.

## State machines

The controller manipulates **real** source/destination/fault conditions
(WireMock stubs, lab `fault-inject.sh`, optional Toxiproxy). UI status labels
come from product-observed runtime state — not forced UI strings.

## Related

- Lab compose: `e2e/lab/docker-compose.full-e2e.yml`
- Optional network faults: `e2e/lab/docker-compose.toxiproxy.yml`
- Real SaaS candidates: `e2e/real-apps/candidates.yaml`
