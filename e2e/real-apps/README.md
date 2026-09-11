# Real Application E2E

Live SaaS / self-host validation is a **third** purpose, separate from:

1. Regression / Release E2E (332 + Cross-Product)
2. Continuous E2E Lab (local fixtures, long-lived streams)

## Priority model (v2)

Priorities in `candidates.yaml` use:

`AUTH_COVERAGE` · `DATA_GENERATION` · `LONG_TERM_AVAILABILITY` · `AUTOMATION` · `OPERATIONAL_COST`

Do **not** prioritize services merely because they are popular. Prefer self-hosted
real apps when they give better deterministic coverage.

| Priority | Candidates |
|----------|------------|
| P0 | Frappe/ERPNext session_login, WordPress Basic, Salesforce (supported OAuth only), Shopify token, OpenWeather query key, GitHub no-auth/bearer, Neon PostgreSQL |
| P1 | Atlassian, Okta Integrator Free, HubSpot |
| P2 | Stripe Sandbox, Microsoft 365 Developer (+ retained optionals) |

OAuth Authorization Code / PKCE remain **NOT_IMPLEMENTED** in product — never fake them.

## Self-host TEST-ONLY labs

```bash
# Lightweight Frappe API-compatible + WordPress REST-compatible harnesses
cd e2e
npm run real-apps:up

curl -s http://127.0.0.1:8087/health
curl -s http://127.0.0.1:8088/health
```

- Frappe lab: `e2e/real-apps/frappe/` — exercises Data Relay `session_login` (`usr`/`pwd` → `sid` cookie).
- WordPress lab: `e2e/real-apps/wordpress/` — exercises Data Relay `basic` against WP REST shapes.

Full ERPNext `frappe_docker` and full WordPress+MySQL are deferred when host memory/swap cannot absorb them; these harnesses remain real-application-shaped references (not WireMock protocol stubs).

## Status when credentials missing

- `UNCONFIGURED` — candidate documented, secrets not present
- `BLOCKED_CREDENTIALS` — enablement requested but env vars missing

## Credentials

Copy `.env.real-apps.example` → local untracked `.env.real-apps`.

```bash
cd e2e && npm run real-apps:validate
```
