# HTTPS reverse proxy deployment

This guide describes a **production-style** deployment path for the Generic Data Connector Platform using the **existing nginx reverse proxy** (see `docker/reverse-proxy/`, `docker-compose.platform.yml`, `deploy/docker-compose.https.yml`, and spec `specs/021-https-reverse-proxy/spec.md`). The FastAPI process stays on **plain HTTP** inside the Docker network; TLS is terminated at nginx.

## Host port policy

| Environment | Compose file | HTTP (host → :80) | HTTPS (host → :443) | Notes |
|-------------|----------------|-------------------|----------------------|--------|
| **Development** | `docker-compose.platform.yml` | **18080** (default) | **18443** (default) | Avoids common **8080** conflicts on developer workstations. Set `GDC_PUBLIC_HTTPS_PORT` to **18443** (default in compose) so redirects match. |
| **Production** | `deploy/docker-compose.https.yml` | **80** (default) | **443** (default) | Requires host ports 80/443 free; firewall must allow inbound HTTP/HTTPS to the Docker host. |

For the platform stack on labs or shared hosts, set e.g. `GDC_HTTP_PORT=18080`, `GDC_HTTPS_PORT=18443`, and `GDC_PUBLIC_HTTPS_PORT=18443` before `docker compose up`.

> **Note:** Browser-facing HTTPS here is separate from **`SYSLOG_TLS`** destinations (`specs/024-syslog-tls-destination/spec.md`, `specs/004-delivery-routing/spec.md`), which terminate TLS on outbound syslog delivery from the platform to your SIEM listeners.

## Why nginx

The platform already ships an nginx sidecar, Admin HTTPS settings that render nginx config, and an in-container reload hook. Adding a second proxy (Caddy) would duplicate behavior without benefit for this repository.

## Routing (single browser entrypoint)

| Path | Upstream |
|------|-----------|
| `/api/` | API (`API_PREFIX` default `/api/v1/...`) |
| `/health` | API liveness |
| `/` | API (serves built SPA from `frontend/dist` in the API image, plus SPA fallback) |

Forwarded headers: `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Real-IP`. The API enables `ProxyHeadersMiddleware` when `GDC_TRUST_PROXY_HEADERS=true` (set in compose).

WebSocket-ready headers: `Upgrade` and `Connection` are passed using the standard nginx `map` pattern (`docker/reverse-proxy/nginx.conf`).

## Stacks

| File | Use case |
|------|-----------|
| `docker-compose.yml` | Local dev: PostgreSQL (and optional WireMock `test` profile). Ports unchanged. |
| `docker-compose.platform.yml` | Full stack: DB + API + nginx; default HTTP **:18080**, optional HTTPS **:18443** after TLS is enabled; API also published on host `${GDC_API_HOST_PORT:-8000}` bound to **127.0.0.1** by default (`GDC_API_BIND` / `GDC_PROXY_BIND=0.0.0.0` for remote lab). Mounts Docker socket for Admin reverse-proxy port apply (lab only). |
| `deploy/docker-compose.https.yml` | **Production-style**: DB not on host, API not on host, **no Docker socket**, default HTTP **:80** / HTTPS **:443**, TLS PEM bind-mounted from `deploy/tls/`. Secrets required via env (no `change-me` / `devtoken` / `gdc` defaults). |

## Self-signed TLS material

Generate a private key and certificate **on the operator machine** (do not commit them). Example (adjust `CN` / SAN for your DNS name or NAT IP):

```bash
mkdir -p deploy/tls
openssl req -x509 -nodes -days 825 -newkey rsa:2048 \
  -keyout deploy/tls/server.key \
  -out deploy/tls/server.crt \
  -subj "/CN=gdc.example.local" \
  -addext "subjectAltName=DNS:gdc.example.local,DNS:localhost,IP:127.0.0.1,IP:10.0.0.5"
```

Mount layout (handled by `deploy/docker-compose.https.yml`):

- `deploy/tls/server.crt` → `/var/gdc/tls/server.crt` (API + nginx read)
- `deploy/tls/server.key` → `/var/gdc/tls/server.key` (API + nginx read)

File modes on the **host** copy: keep `server.key` private to operators (`chmod 600 deploy/tls/server.key`). The reverse-proxy container **entrypoint** relaxes read bits on the mounted PEMs under `/var/gdc/tls` at startup so the `nginx` worker (non-root) can read them; without that, TLS handshakes can fail with abrupt disconnects (`SSL_ERROR_SYSCALL` in Firefox, `connection reset` in curl).

### Browser trust warnings

Self-signed certificates are **not** chained to a public CA. Browsers show a warning (name mismatch, untrusted issuer, or both) until the user proceeds once or the organization installs the CA / server cert in a trust store. This is expected for labs and private NAT deployments.

### DNS vs private NAT IP

- **DNS**: Put an A/AAAA record for your hostname to the host’s public or private IP; generate the cert with matching `CN` / `subjectAltName`.
- **NAT only**: Use the host’s **internal** IP in SAN (see `IP:10.0.0.5` above). Operators reach `https://<internal-ip>:443` with default production mapping, or `https://<internal-ip>:18443` when using non-default `GDC_HTTPS_PORT` on the platform stack. Ensure corporate DNS or split-horizon DNS matches if you use a hostname.

Set `GDC_PUBLIC_HTTPS_PORT` to the **host** HTTPS port browsers use (default **18443** in `docker-compose.platform.yml`, default **443** in `deploy/docker-compose.https.yml`) so Admin-driven HTTP→HTTPS redirects match reality.

## First-time sign-in (platform install)

When no `admin` user exists yet, production seeding creates **`admin/admin`** unless **`GDC_SEED_ADMIN_PASSWORD`** is explicitly set. First login requires a password change. Existing production `admin` credentials are never silently overwritten; password reconciliation requires an explicit recovery command such as `python -m app.db.seed --platform-admin-only --reconcile-admin-password` with `GDC_SEED_ADMIN_PASSWORD` set.

## Environment

Copy root `.env.example` to `.env` and set at least:

- `POSTGRES_PASSWORD` — required for production HTTPS/offline compose (no default).
- `JWT_SECRET_KEY` — strong random secret (required; production startup fail-closes on placeholders).
- `SECRET_KEY` / `ENCRYPTION_KEY` — unique production values (required in production compose).
- `GDC_PROXY_RELOAD_TOKEN` — long random string shared by API and nginx reload hook (required; never leave as `devtoken`).
- `REQUIRE_AUTH=true` with `APP_ENV=production` (compose pins these for HTTPS/offline).

Lab / platform compose (`docker-compose.platform.yml`) may keep development defaults and `REQUIRE_AUTH=false` for continuous E2E. Browser and API ports default to loopback; for remote lab access set `GDC_API_BIND=0.0.0.0` and `GDC_PROXY_BIND=0.0.0.0` explicitly.

Root `docker-compose.yml` **dev ports** (e.g. `5432:5432`) are unaffected by the HTTPS deploy file.

## Compose commands

For scripted install, upgrade, and backup workflows (release candidate), see `docs/deployment/install-guide.md`, `docs/deployment/upgrade-guide.md`, and `docs/deployment/backup-restore.md`.

Validate configuration (no containers started):

```bash
cd /path/to/gdc-platform
docker compose -f deploy/docker-compose.https.yml config -q
```

Build and start:

```bash
docker compose -f deploy/docker-compose.https.yml --env-file .env up -d --build
```

Optional: override published ports for `docker-compose.platform.yml` (defaults are **18080→80** and **18443→443**):

```bash
# Platform stack on alternate host ports (e.g. when 80/443 are already in use)
export GDC_HTTP_PORT=18080
export GDC_HTTPS_PORT=18443
export GDC_PUBLIC_HTTPS_PORT=18443
docker compose -f docker-compose.platform.yml --env-file .env up -d
```

The platform variables are numeric host ports only. To apply changes after editing `.env`, recreate the reverse proxy:

```bash
docker compose -f docker-compose.platform.yml up -d --force-recreate reverse-proxy
```

## Enabling HTTPS inside nginx

The bundled `docker-compose.platform.yml` reverse proxy always listens on container port `80`. Publishing
`GDC_HTTPS_PORT` to container port `443` does not enable HTTPS by itself; the **Admin → HTTPS** toggle is authoritative.
When HTTPS is disabled, nginx should have no `listen 443 ssl` server block and `curl -k
https://<host>:<GDC_HTTPS_PORT>/health` should fail.

When HTTPS is enabled and the rendered nginx config contains a `443 ssl` listener, the reverse-proxy entrypoint will make
the mounted PEM files readable by nginx. If the TLS config exists but PEM files are missing, it creates a deterministic
development self-signed certificate as a last-resort startup fallback.

For production-style HTTPS:

1. Start the stack with valid PEM files under `deploy/tls/`.
2. Use **Admin → HTTPS** in the UI (or the documented admin API) to render nginx config and trigger reload via `GDC_PROXY_RELOAD_URL`.

If reload fails, the API falls back to HTTP-only nginx config so the operator is not locked out (see `apply_nginx_runtime`).

## Verification

### Compose validation

```bash
docker compose -f deploy/docker-compose.https.yml config -q
```

### curl (HTTP through proxy)

```bash
curl -fsS "http://127.0.0.1:18080/health"
curl -fsS "http://127.0.0.1:18080/api/v1/..." # replace with a real route when authenticated
```

### curl (HTTPS, self-signed)

```bash
# This succeeds only after Admin HTTPS is enabled.
curl -fsSk "https://127.0.0.1:18443/health"
```

### Browser

- HTTP UI: `http://<host>:18080/` (or your `GDC_HTTP_PORT`)
- HTTPS UI: `https://<host>:18443/` (or your `GDC_HTTPS_PORT`; production: `https://<host>/` on **443**)

## Troubleshooting checklist

1. **`docker compose config` fails** — Run from repository root; check env syntax and that `deploy/docker-compose.https.yml` paths resolve.
2. **502 / empty from nginx** — Confirm API health: `docker compose -f deploy/docker-compose.https.yml exec api wget -qO- http://127.0.0.1:8000/health`.
3. **HTTPS not listening** — Confirm Admin HTTPS is enabled, then rebuild/recreate the reverse proxy and inspect `nginx -T`; enabled config should show `listen 443 ssl` and `/var/gdc/tls/server.crt`. If HTTPS is disabled, absence of `listen 443 ssl` is expected.
4. **TLS handshake resets right after enabling HTTPS** — Often **key file mode**: API wrote `server.key` as root with `0600`; confirm the reverse-proxy entrypoint ran (image rebuild may be required) or temporarily `chmod`/`chown` on the volume/bind mount so user `nginx` can read PEMs.
5. **Redirect loop** — `GDC_PUBLIC_HTTPS_PORT` must match the port clients use; `GDC_TRUST_PROXY_HEADERS` must be true when behind nginx.
6. **Certificate warnings** — Expected for self-signed; fix SAN/CN or install trust.
7. **Permission denied on `server.key`** — Check host file permissions and SELinux/AppArmor labels for bind mounts.

## See also: upstream and worker timeouts

Align nginx `proxy_read_timeout` / `proxy_send_timeout` (and any load balancer idle timeout) with Gunicorn/Uvicorn worker timeouts and bounded DB `statement_timeout` values so clients receive deterministic errors instead of hung sockets. See **`docs/deployment/uvicorn-gunicorn-production.md`**.

## Rollback to HTTP dev mode

1. Stop the HTTPS stack: `docker compose -f deploy/docker-compose.https.yml down`.
2. Use **`docker-compose.yml`** for PostgreSQL-only local work, or **`docker-compose.platform.yml`** for the standard HTTP entry on port **18080** (or your `GDC_HTTP_PORT`) without publishing the DB to the internet by default.
3. For day-to-day UI development with Vite, continue using `frontend/README.md` (dev server) and a local API; no change to frontend runtime logic is required.

## Migration from older 8080 / 8443 defaults

Earlier revisions published **8080** / **8443**. Set explicit overrides if you need the old mapping:

```bash
export GDC_HTTP_PORT=8080
export GDC_HTTPS_PORT=8443
export GDC_PUBLIC_HTTPS_PORT=8443
```

Or adopt the new defaults and update bookmarks, `GDC_PUBLIC_URL`, and firewall rules accordingly.

## Production exposure (design checklist)

- **Ports**: Operators expect **80** and **443** on the Docker host (defaults in `deploy/docker-compose.https.yml`). Load balancers may terminate TLS upstream; if so, this stack’s nginx TLS section may be disabled in favor of plain HTTP to the proxy—document any such split separately.
- **Firewall**: Allow inbound TCP **80**/**443** to the host (or to the LB in front). Do not expose PostgreSQL (**5432**) publicly; that service has no host mapping in the HTTPS compose file.
- **Certificates**: Production should use a CA-trusted certificate (corporate CA or public CA). PEM paths remain `deploy/tls/server.crt` and `server.key` on the host unless you customize mounts.
- **Migration path dev → prod**: Generate or obtain PEMs; set `GDC_RELEASE_COMPOSE_FILE=deploy/docker-compose.https.yml`; align `GDC_PUBLIC_HTTPS_PORT=443`; run `install.sh` / `upgrade.sh`; re-enable HTTPS in Admin if config was reset; verify `curl` to `https://<host>/health`.

## Limitations

- No ACME / Let’s Encrypt automation in this guide (bring your own PEM or use a corporate CA).
- No Kubernetes manifests.
- Syslog TLS to destinations is separate (see `specs/024-syslog-tls-destination/spec.md`); this document covers **browser → platform** TLS only.
