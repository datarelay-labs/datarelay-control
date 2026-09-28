# Installation Validation — OSS v1.0.2 GA

**Purpose:** Verify the path `git clone` → `docker compose up` → login → stream → delivery for Open Source users.

**Validation date:** 2026-06-09  
**Target:** Enterprise Data Control Gateway GA v1.0.2

---

## Prerequisites

- Docker Engine 24+ with Compose v2
- Ports **18080** (HTTP) and **18443** (HTTPS) available
- 4 GB RAM minimum for full stack

---

## Step 1 — Clone and configure

```bash
git clone https://github.com/datarelay-labs/datarelay-control.git data-relay
cd data-relay
cp .env.example .env
# Edit .env: set JWT_SECRET_KEY, SECRET_KEY, ENCRYPTION_KEY, POSTGRES_PASSWORD
```

**Required env keys:** `DATABASE_URL`, `JWT_SECRET_KEY`, `SMTP_ENABLED`, `WEBHOOK_TIMEOUT`

---

## Step 2 — Start the selected install contract

For repository/local qualification:

```bash
GDC_RELEASE_COMPOSE_FILE=docker-compose.platform.yml ./scripts/release/install.sh --build
```

This profile is intentionally development-only and loopback-oriented. It is not the externally reachable production security profile.

For the release public-smoke gate, use the disposable wrapper:

```bash
bash scripts/release/public-smoke.sh
```

The wrapper requires a clean worktree, selects isolated loopback ports, uses a unique Compose project/container prefix and networks, writes a dedicated ignored env file, verifies the baked Git SHA/clean provenance through `/health`, and removes its containers/volumes/network/env file afterward. It does not reuse or replace the normal `gdc-platform-*` stack.

For production-style HTTPS deployment:

```bash
export GDC_RELEASE_COMPOSE_FILE=deploy/docker-compose.https.yml
export GDC_INSTALL_GENERATE_TLS=1
export GDC_PUBLIC_HTTPS_PORT=443
# Optional non-privileged rehearsal ports (keep public HTTPS aligned):
# export GDC_ENTRY_HTTP_PORT=18080
# export GDC_ENTRY_HTTPS_PORT=18443
# export GDC_PUBLIC_HTTPS_PORT=18443
./scripts/release/install.sh --build
```

**Expected for either selected contract:**

- `postgres`, `api`, `frontend`, `reverse-proxy` containers healthy
- Alembic migrations applied
- Default admin user created when missing (`admin` / `admin`, password change required)
- host `/health` and administrator login smoke succeed through the selected reverse-proxy entry port

---

## Step 3 — DB migration verification

```bash
docker compose -f docker-compose.platform.yml exec api alembic current
```

**Expected:** Head revision printed (no pending migrations).

Static pre-check (no Docker):

```bash
bash scripts/release/validate-clean-install.sh
```

---

## Step 4 — Admin login

1. Open `https://localhost:18443/` (or `http://localhost:18080/`)
2. Login: `admin` / `admin` (unless `GDC_SEED_ADMIN_PASSWORD` is set)
3. Change password when prompted

**API check:**

```bash
curl -sk -X POST https://localhost:18443/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<your-password>"}'
```

**Expected:** `access_token` in JSON response.

---

## Step 5 — Create stream (UI)

1. Navigate to **Streams** → **Create First Stream**
2. Wizard steps:
   - **Connect** — HTTP API polling (see `samples/http/example-api.json`)
   - **Mapping** — import field paths from `samples/mappings/example-mapping.json`
   - **Destination** — create webhook or syslog from `samples/destinations/`
   - **Review** — enable and save

---

## Step 6 — API test

In the stream wizard **API Test** step, run a sample fetch against the configured source.

**Expected:** Sample events returned; no auth errors.

---

## Step 7 — Mapping & enrichment

Apply JSONPath mappings and optional enrichment from sample pack files.

**Expected:** Transform preview shows mapped output fields.

---

## Step 8 — Destination & route

Create destination (Administration → Destinations) and link via Routes or wizard.

**Expected:** Route shows ENABLED; connectivity test available for webhook/syslog.

---

## Step 9 — Run stream

Start the stream from Streams console or runtime panel.

**Expected:**

- Stream status → RUNNING
- Delivery logs appear under Logs
- Checkpoint updates after successful delivery

---

## Step 10 — Governance & RBAC smoke

| Check | Path | Expected |
|-------|------|----------|
| Governance Dashboard | `/governance` | KPI cards render; empty state on fresh install |
| Operations | `/governance/operations` | Page loads for authorized role |
| RBAC | Login as VIEWER | Governance sidebar hidden without `governance_read` |
| Notifications | `/governance/notifications` | Config page loads |

---

## Validation results (M20.4)

| Step | Result | Notes |
|------|--------|-------|
| Static clean-install checks | ✅ PASS | `validate-clean-install.sh` |
| Compose / installer contracts | ✅ PASS | Local public-smoke and production HTTPS profiles are explicitly separated and statically guarded |
| OSS UI surface | ✅ PASS | Internal routes gated |
| Sample pack | ✅ PASS | `samples/` created |
| Full Docker E2E | ⚠️ Manual | Run on target host with Docker; steps documented above |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Blank UI after upgrade | Rebuild frontend: `scripts/frontend-redeploy.sh` |
| Auth 401 | Set `JWT_SECRET_KEY`; ensure `REQUIRE_AUTH=true` |
| Migration error on fresh DB | Run `docker compose ... exec api alembic upgrade head` |
| Empty streams after install | Expected on fresh install — use Create First Stream CTA |

See also: [docs/deployment/install-guide.md](../deployment/install-guide.md), [CHANGELOG.md](../../CHANGELOG.md)
