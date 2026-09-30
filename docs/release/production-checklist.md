# Production Checklist — Data Relay OSS v1.0.2 GA

Use this checklist before exposing Data Relay to production traffic.

---

## Security & transport

- [ ] **HTTPS enabled** — terminate TLS at reverse proxy or platform nginx (`docs/deployment/https-reverse-proxy.md`)
- [ ] **Reverse proxy** configured with trusted headers (`GDC_TRUST_PROXY_HEADERS=true`)
- [ ] Default **admin password changed** on first login
- [ ] **JWT_SECRET_KEY** (JWT signing secret) set to a strong random value (≥ 32 characters; not a known placeholder)
- [ ] **SECRET_KEY** and **ENCRYPTION_KEY** set to unique production values (≥ 32 characters)
- [ ] **POSTGRES_PASSWORD** set explicitly (never ship default `gdc`)
- [ ] **GDC_PROXY_RELOAD_TOKEN** set to a unique value (never ship `devtoken`)
- [ ] **REQUIRE_AUTH=true** and **AUTH_DEV_HEADER_TRUST=false** (`APP_ENV=production` fail-closes otherwise)
- [ ] Production compose (`deploy/docker-compose.https.yml` / offline) requires the secrets above via `${VAR:?...}` — no silent insecure defaults

Required production env (HTTPS / offline compose interpolation):

| Variable | Notes |
|----------|--------|
| `POSTGRES_PASSWORD` | Also interpolated into `DATABASE_URL` |
| `JWT_SECRET_KEY` | HS256 signing material |
| `SECRET_KEY` | Platform secret fallback / general signing |
| `ENCRYPTION_KEY` | Credential encryption material |
| `GDC_PROXY_RELOAD_TOKEN` | Shared by API and nginx reload hook |

`install.sh` / offline install replace known placeholders (`change-me-in-production`, `devtoken`, `gdc`, …) with generated secrets.
---

## Database

- [ ] **PostgreSQL recommended** — bundled compose Postgres is suitable for evaluation; use managed PostgreSQL for production
- [ ] **Backup schedule** defined (`scripts/release/backup.sh`, `docs/deployment/backup-restore.md`)
- [ ] **Restore tested** on a non-production instance
- [ ] Host pytest catalog **`gdc_pytest`** never used as production `DATABASE_URL`

---

## Email & notifications

- [ ] **SMTP_ENABLED** set according to deployment policy (`false` until SMTP backend is configured)
- [ ] Governance notification channels configured under **Governance → Notifications**
- [ ] Email recipients verified in non-production first

---

## Webhook delivery

- [ ] **WEBHOOK_TIMEOUT** tuned for your network (default `10` seconds)
- [ ] Destination webhook URLs use HTTPS where possible
- [ ] Receiver endpoints accept platform payload format
- [ ] Credential rotation schedule for webhook auth headers / API keys

---

## Credential rotation

- [ ] Platform admin passwords rotated on schedule
- [ ] Connector source credentials stored encrypted; rotate per vendor policy
- [ ] Destination authentication tokens reviewed quarterly
- [ ] JWT secret rotation procedure documented (requires re-login for all sessions)

---

## Runtime & operations

- [ ] **ENABLE_DEV_VALIDATION_LAB=false** in production `.env`
- [ ] **APP_ENV=production**
- [ ] Log retention and partition maintenance reviewed (`GDC_DELIVERY_LOG_RETENTION_DAYS`)
- [ ] Monitoring access restricted via RBAC
- [ ] Support bundle procedure documented (`docs/admin/support-bundle.md`)

---

## OSS release surface

- [ ] Frontend built with **VITE_OSS_RELEASE_MODE=true** (default in `docker-compose.platform.yml`)
- [ ] Internal validation lab and connector catalog URLs not linked from operator docs

---

## Pre-release exhaustive user gates — mandatory

A release candidate is not ready for owner sign-off until all of the following are complete on the **same exact candidate HEAD**:

- [ ] Exact-head machine qualification is PASS.
- [ ] `docs/BROWSER_FEATURE_SCENARIO_RECONCILIATION.md` is executed by ChatGPT Chat and is PASS.
- [ ] `docs/FULL_USER_E2E_SCENARIOS.md` is executed by ChatGPT Chat and is PASS.
- [ ] Neither exhaustive user test contains required FAIL, PARTIAL, or BLOCKED scenarios.
- [ ] Actual delivery and failure/recovery evidence are retained.
- [ ] Destructive lifecycle and zero-orphan cleanup gates are PASS.
- [ ] Unresolved P0 / P1 / user-blocking P2 findings are zero.
- [ ] Evidence roots and Work Packet/run IDs for both exhaustive tests are recorded in the release decision.

Mandatory order:

~~~text
exact-head machine qualification
→ Browser Feature Scenario Reconciliation
→ Full User E2E
→ owner/manual acceptance
→ release authorization/publication
~~~

Machine Full Regression/operational E2E passes do not substitute for either exhaustive ChatGPT-executed user test.

Any relevant candidate change after either exhaustive user-test PASS invalidates affected evidence and requires the required same-head gates to be re-established.

---

## Sign-off

| Role | Name | Date |
|------|------|------|
| Platform operator | | |
| Security review | | |
