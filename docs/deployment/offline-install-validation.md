# Offline install validation (operator checklist)

Use this document on a **fresh Ubuntu 24.04 VM** before promoting an offline package to production.
It matches `scripts/offline/templates/checks/verify-install.sh` in the repository (copied to `checks/` in the package).

## 1. New VM preparation

| Item | Requirement |
|------|-------------|
| OS | Ubuntu 24.04 LTS amd64 |
| CPU/RAM | ≥ 2 vCPU, ≥ 4 GiB RAM |
| Disk | ≥ 25 GiB free (`/` or install mount) |
| Network | **No internet** required on the VM after package transfer |
| Ports | 18080, 18443, 8000, 55432 free (or override in `configs/.env`) |
| Access | `sudo` for Docker install |
| Media | `offline-release-<version>.tar.gz` + `.sha256` from the build host |

Recommended VM path: `/opt/datarelay/offline-release`

## 2. Install procedure

```bash
# Transfer and extract
sha256sum -c offline-release-*.tar.gz.sha256
tar -xzf offline-release-*.tar.gz
cd offline-release

# Environment
cp configs/.env.production.template configs/.env
vi configs/.env

# Docker (when not installed)
sudo scripts/install-docker-offline.sh
docker --version
docker compose version

# DESTRUCTIVE: only on a verified fresh/empty VM or with separate authorized recovery plan
# Do NOT run when preserving any existing database/credentials
scripts/reset-production-data.sh

# Install platform
scripts/install-offline.sh
```

`install-offline.sh` ends with an **install summary** (URLs, admin account, container table, health, verification result).

## 3. Verification procedure

### Automated (required)

```bash
cd /opt/datarelay/offline-release
checks/verify-install.sh
```

Expected final line:

```text
Verification OK — N check(s) passed.
```

Exit code **0**.

### Manual spot checks

```bash
docker compose -f configs/docker-compose.offline.yml --env-file configs/.env ps
curl -fsS http://127.0.0.1:18080/health
curl -fsS -X POST http://127.0.0.1:18080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}'
```

Open `http://<vm-ip>:18080/` in a browser and sign in as **admin**.

## 4. Automated verification items

| # | Check | Pass criteria |
|---|--------|----------------|
| 1 | Container status | All four `gdc-platform-*` containers running; health not `unhealthy` |
| 2 | DB connectivity | `pg_isready` and `SELECT 1` succeed |
| 3 | Migration status | `alembic_version` row present; `alembic current` matches head; `validate_migrations --strict` exit 0 |
| 4 | API health | `/health` OK inside API container and via reverse proxy |
| 5 | Frontend | `GET /` and `/index.html` return HTTP 200 or 304 |
| 6 | Admin account | Row `platform_users.username=admin`, `status=ACTIVE` |
| 7 | Authentication | `POST /api/v1/auth/login` returns HTTP 200 |
| 8 | Runtime routing | `/api/v1/runtime/status`, `/streams`, `/connectors` return 200/401/403 |

On failure, `verify-install.sh` prints a **hint** line per failed check and troubleshooting commands.

## 5. Expected results after successful install

| Item | Expected value |
|------|----------------|
| Web UI | `http://<host>:18080/` loads login page |
| Health | `curl http://127.0.0.1:18080/health` returns JSON/body (HTTP 200) |
| Admin username | `admin` |
| Admin password | `admin` (unless `GDC_SEED_ADMIN_PASSWORD` set in `configs/.env`) |
| First login | Password change required when using default `admin` |
| Containers | `gdc-platform-postgres`, `-api`, `-frontend`, `-reverse-proxy` **Up (healthy)** |
| DB catalog | `gdc` (default) |
| Migrations | `alembic_version.version_num` equals repository head |

## 6. Failure troubleshooting

| Symptom | Where to look |
|---------|----------------|
| Container missing / not running | `docker compose … ps -a`; `docker logs <container>` |
| DB connection failed | `docker logs gdc-platform-postgres`; `POSTGRES_*` in `configs/.env` |
| Migration failed | `docker compose … exec api alembic current`; `docker logs gdc-platform-api` |
| Health 502/000 | `docker logs gdc-platform-reverse-proxy`; wait for API healthcheck (~90s) |
| Frontend 404/500 | `docker logs gdc-platform-frontend` |
| Login 401 | Default password `admin`; or `GDC_SEED_ADMIN_PASSWORD` in `.env` |
| Admin row missing | `docker compose … run --rm --no-deps api python -m app.db.seed --platform-admin-only` |
| Docker missing | `sudo scripts/install-docker-offline.sh` |

Log commands:

```bash
docker compose -f configs/docker-compose.offline.yml --env-file configs/.env logs -f api
docker compose -f configs/docker-compose.offline.yml --env-file configs/.env logs -f reverse-proxy
docker compose -f configs/docker-compose.offline.yml --env-file configs/.env logs -f postgres
```

## 7. `reset-production-data.sh` impact scope

Running `scripts/reset-production-data.sh` (or explicitly running `install-offline.sh --reset-existing-data` and typing `YES`) removes **only** the Data Relay compose project resources below. Normal `install-offline.sh` preserves existing volumes; `--skip-reset` is an optional compatibility flag.

### Deleted — containers

| Container name | Service |
|----------------|---------|
| `gdc-platform-postgres` | PostgreSQL |
| `gdc-platform-api` | FastAPI backend |
| `gdc-platform-frontend` | Static UI (nginx) |
| `gdc-platform-reverse-proxy` | Entry reverse proxy |

### Deleted — named volumes

| Volume | Content removed |
|--------|-----------------|
| `gdc_platform_postgres_data` | **All platform data** — users, connectors, streams, routes, delivery history |
| `gdc_platform_tls` | Generated / applied TLS material inside the stack |
| `gdc_platform_nginx` | Runtime nginx config written by the platform |

Docker Compose may prefix volumes with the project name (e.g. `gdc-platform_gdc_platform_postgres_data`); `docker compose down -v` removes both forms.

### Deleted — networks

| Network (typical) | Notes |
|-------------------|--------|
| `gdc-platform_default` | Default bridge network for the four services |

### Not deleted

| Resource | Notes |
|----------|--------|
| Docker images | `gdc-platform-api:offline`, `frontend:offline`, `reverse-proxy:offline`, `postgres:16-alpine` |
| `images/*.tar` | Image archives in the package |
| `packages/docker/debs/` | Docker Engine offline bundle |
| `configs/.env` | Operator secrets file (unless removed manually) |
| `app/`, `configs/`, scripts | Package files on disk |
| `gdc-platform-https` project | Separate HTTPS-only stack — reset separately |
| Other Docker containers/volumes | Unrelated projects on the same host |

**No backup is created.** Re-run `install-offline.sh` after reset to recreate an empty platform.

## 8. Sign-off checklist (operator)

- [ ] VM is Ubuntu 24.04 amd64 with sufficient disk/RAM
- [ ] Package checksum verified (`sha256sum -c`)
- [ ] Docker installed (`docker --version`, `docker compose version`)
- [ ] `scripts/install-offline.sh` completed without error
- [ ] `checks/verify-install.sh` exit 0
- [ ] Browser login as `admin` succeeds
- [ ] `configs/.env` backed up to secure storage
- [ ] Production connectors/streams re-created (after wipe reinstall)
