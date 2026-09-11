# Frappe / ERPNext session_login lab (TEST-ONLY)

Lightweight Frappe API-compatible harness for Continuous / Real-App E2E.

## Why not full ERPNext Docker?

Host memory/swap was already saturated during this phase. Full `frappe_docker`
(ERPNext + MariaDB/Postgres + Redis + workers) typically needs multiple GB.
This harness stays under ~128MiB and still exercises the real Data Relay
`session_login` path against Frappe's login contract:

- `POST /api/method/login` with `usr`/`pwd` (form) → `Set-Cookie: sid=...`
- Authenticated `GET /api/resource/<Doctype>`
- Wrong password, expired sid, empty result, checkpoint-style `modified_after`

## Start

```bash
docker compose -f e2e/real-apps/frappe/docker-compose.yml up -d
```

Defaults: `Administrator` / `frappe-e2e-pass` on `127.0.0.1:8087`.
