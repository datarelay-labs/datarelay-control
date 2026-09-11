# Real Application E2E

Live SaaS validation is a **third** purpose, separate from:

1. Regression / Release E2E (332 + Cross-Product)
2. Continuous E2E Lab (local fixtures, long-lived streams)

## Status when credentials missing

Do **not** mark real-service E2E as PASS without credentials.

Use:

- `UNCONFIGURED` — candidate documented, secrets not present
- `BLOCKED_CREDENTIALS` — enablement requested but env vars missing

Local harness validation (manifest parse, sanitize rules, capture→WireMock pipeline dry-run) may still PASS.

## Credentials

Copy `.env.real-apps.example` → a local untracked `.env.real-apps` (never commit).

```bash
set -a && source e2e/real-apps/.env.real-apps && set +a
cd e2e && npm run real-apps:validate
```

## Capture → sanitize → WireMock

Decision: **do not adopt Hoverfly** as a second mock framework.

Preferred path:

```text
Real SaaS validation
      +
optional WireMock proxy record / snapshot
      ↓
sanitize (sanitize-capture.ts + sanitization-rules.yaml)
      ↓
commit WireMock mapping under e2e/lab/fixtures or tests/wiremock
```

WireMock already provides record/playback and is the strategic HTTP mock asset.

## Recommended first accounts to create

1. HubSpot developer test account
2. Stripe test mode
3. Shopify Partner development store
4. Atlassian cloud developer instance (Jira)
5. Microsoft 365 Developer Program sandbox
6. GitHub dedicated e2e org (optional quick win)

See `candidates.yaml` for full inventory.
