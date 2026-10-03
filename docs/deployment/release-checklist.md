# Release candidate checklist

Use this list before tagging a release candidate or promoting a build to staging/production.

## Pre-candidate user closure

After the product feature roadmap is complete, do **not** freeze a candidate or start full release qualification first. Execute the user-facing closure loop on an exact audit HEAD:

1. Browser Feature Scenario Reconciliation.
2. Batch bounded findings into fixes, merge them, and rerun Browser reconciliation until final PASS.
3. Full User E2E.
4. Batch bounded findings into fixes and rerun Full User E2E; if a fix changes browser-visible/product behavior, re-establish the affected Browser reconciliation gate first.
5. Require the final Browser PASS and final Full User E2E PASS on the same HEAD.
6. Only then freeze that HEAD as the release candidate and run the build/test/release qualification below.

A qualification failure that requires product changes unfreezes the candidate and returns execution to the affected user-test loop before a new candidate can be frozen.

## Build and tests

- [ ] Full backend CI entrypoint (matches GitHub Actions):  
      `GDC_BACKEND_FULL_TEST_RESET_CONFIRM=YES_I_RESET_GDC_TEST_ONLY bash scripts/test/run-backend-full.sh --fresh-schema`  
      (PostgreSQL-only lab on `127.0.0.1:55432`; see `docs/testing/backend-full-test.md`).
- [ ] `python3 -m pytest tests/ -q` when iterating without the compose bootstrap (still PostgreSQL-only).
- [ ] `cd frontend && npm ci && npm test -- --run && npm run build`.
- [ ] `docker compose config -q`, `docker compose -f docker-compose.platform.yml config -q`, and `docker compose -f deploy/docker-compose.https.yml config -q` succeed from a clean shell with production-like `.env` (no secrets committed).
- [ ] Optional RC hardening: full dev E2E lab (`docs/testing/full-e2e-dev-validation.md`) — **not** required on every PR.

## Configuration and secrets

- [ ] `.env` derived from `.env.example`; **no real secrets** in git.
- [ ] `JWT_SECRET_KEY`, `SECRET_KEY`, `ENCRYPTION_KEY`, `GDC_PROXY_RELOAD_TOKEN`, and `POSTGRES_PASSWORD` (HTTPS / platform compose) are strong and unique per environment.
- [ ] `REQUIRE_AUTH=true` for any externally reachable deployment.
- [ ] `ENABLE_DEV_VALIDATION_LAB=false` (and related `ENABLE_DEV_VALIDATION_*` flags false) on production-facing hosts.

## TLS (browser entry)

- [ ] PEM material present under `deploy/tls/` for HTTPS compose, or nginx/API volume strategy documented for `docker-compose.platform.yml`.
- [ ] `GDC_TRUST_PROXY_HEADERS` and public port hints (`GDC_PUBLIC_HTTPS_PORT`, `GDC_ENTRY_*`) match the operator network path (`docs/deployment/https-reverse-proxy.md`).

## Database

- [ ] Alembic at `head` on the target database (`docker compose ... run --rm api alembic upgrade head`).
- [ ] Backup policy in place (`scripts/release/backup-before-upgrade.sh` or enterprise backup) and restore drill documented (`docs/deployment/backup-restore.md`).
- [ ] Confirm **no** automated production DB reset scripts in deployment automation.

## Architecture guardrails (regression mindset)

- [ ] Connector ≠ Stream; Source ≠ Destination; Route is the only Stream → Destination path.
- [ ] Mapping before Enrichment; checkpoint only after successful delivery; delivery failures logged structurally in `delivery_logs`.
- [ ] StreamRunner remains the sole transaction owner for runtime writes.

## Post-deploy smoke

- [ ] `/health` via nginx HTTP and (if enabled) HTTPS.
- [ ] Authenticated session login and RBAC spot-check (Administrator vs Operator vs Viewer).
- [ ] One controlled stream dry-run or preview-only validation in a non-production workspace if available.

## Rollback readiness

- [ ] Last known-good image tag or Git SHA recorded.
- [ ] Recent `deploy/backups/*.sql.gz` retained off-host if required by policy.

## Documentation pointers

- Install: `docs/deployment/install-guide.md`
- Upgrade: `docs/deployment/upgrade-guide.md`
- TLS: `docs/deployment/https-reverse-proxy.md`
- Full dev E2E (optional, not per-PR CI): `docs/testing/full-e2e-dev-validation.md`
