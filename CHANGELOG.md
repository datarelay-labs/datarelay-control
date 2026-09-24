# Changelog

All notable changes to Data Relay are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.2] - 2026-06-09

### Release Hardening (OSS v1.0.2)

Operational validation unblock — no new product features.

- **Deployment drift:** API/frontend images rebuilt; Alembic head `20260609_0052_replay_idx` aligned across repo, container, and database.
- **Replay performance:** Sprint 8 list-query indexes (`stream_replay_events` created_at/status).
- **Operational hardening:** Sprint 9 cumulative KPI cache and replay destination rate limiter.
- **Alert monitor tests:** Full-suite isolation for `stream_paused` and `high_retry_count` detection.
- **Release tooling:** `scripts/ops/collect-soak-metrics.sh`, `scripts/ops/explain-delivery-logs-slow-query.sh`, `scripts/ops/run-ai-wiremock-soak.sh`.

### Known operational notes (v1.0.2)

- Large `delivery_logs` forensic scans (>3M rows) can exceed 5s on operational snapshot paths; use `runtime_*_snapshot` and analytics buckets for dashboards (see `docs/performance/high-scale-runtime-analytics-phase-6.md`).
- Full 24h soak artifact: run `scripts/ops/collect-soak-metrics.sh --duration 24h --interval 15m` on the target host.

## [1.0.1] - 2026-06-08

### OSS stabilization sprints (v1.0.0 → v1.0.1)

- Sprint 1–7: scheduler rate-limit lifecycle, observability, sensitive-detection batch, performance guards.
- Sprint 8: replay list N+1 removal and index migration.
- Sprint 9: cumulative KPI cache warm path and replay rate limiter hardening.

## [1.0.0] - 2026-06-08

# Data Relay v1.0.0

First General Availability (GA) release of the Enterprise Data Control Gateway.

Tagged release candidate: `v1.0.0-rc.1`

## Highlights

### Runtime

- Stream-scoped pipeline execution with polling, checkpointing, and delivery logging.
- HTTP API polling, webhook receiver, S3 object polling, database query, and remote file sources.
- Syslog (UDP/TCP/TLS) and webhook POST destinations with route fan-out and failure policies.
- Monitoring console: stream status, delivery logs, checkpoint trace, and route failure visibility.
- Docker Compose platform stack with one-command install (`scripts/release/install.sh`).

### Mapping

- Basic JSONPath field mapping (default click/menu UX).
- Advanced JSONata expressions and default/fallback values (Safe Expression Engine).
- Expert `regex_extract` for string extraction from message fields.
- Transform preview on sample events (same engine as runtime).
- Separate Mapping stage before Enrichment; checkpoint updates only after successful delivery.

### Enrichment

- Static field injection and calculated expressions via the Safe Expression Engine.
- Lookup tables and enrichment rules stored per stream.
- Field-level failure defaults; structural logging on enrichment errors.

### Schema Drift

- Runtime schema drift detection against configured expectations.
- Operator-visible drift signals in the governance and runtime surfaces.

### Sensitive Detection

- Pattern-based sensitive data detection in the pipeline.
- Detection results feed protection, classification, and policy stages.

### Protection

- Tokenization and masking actions applied before delivery when policies require it.
- Protection outcomes visible in governance violation and quarantine workflows.

### Classification

- Event classification labels (e.g. PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED).
- Classification drives policy evaluation and routing decisions.

### Policy

- Stream-scoped governance policies with violation logging.
- Policy catalog, evaluation at runtime, and triage in the Violations center.

### Dynamic Routing

- Multi-destination routes with per-route failure policies (skip, retry, quarantine, etc.).
- Route-level delivery preview and connectivity tests for webhook/syslog destinations.

### Failover

- Destination failover behavior within configured route policies.
- Structured `delivery_logs` entries for retry and failure outcomes.

### Replay

- Governance replay center for re-processing quarantined or failed events.
- Audit trail for replay actions.

### Quarantine

- Quarantine center for held events pending review and release.
- Integration with policy violations and replay workflows.

## OSS Scope

This GA release ships the **OSS operator surface** enforced by `VITE_OSS_RELEASE_MODE=true` and production environment gates:

- **Streams wizard:** connect → mapping → destination → review.
- **Administration:** Connectors, Destinations, Routes, Settings (users/roles/credentials), Backup & Import.
- **Governance:** Dashboard, Operations, Violations, Quarantine, Replay, Approvals, Audit, Notifications.
- **RBAC:** role-based sidebar and API access (`governance_read`, Administrator / Operator / Viewer personas).
- **Sample pack:** `samples/` reference JSON for first-stream setup.
- **Release tooling:** install, upgrade, backup, restore, and clean-install validation scripts under `scripts/release/`.

**Not included in OSS UI** (hidden or redirected in production OSS builds):

- Dev validation lab (`/validation/*`).
- Connector catalog registry and template marketplace surfaces.
- AI Governance hub and internal data-protection hub pages.
- Persona switcher and internal alerting settings UI.

Enterprise-only or post-MVP capabilities remain out of scope for OSS v1.0.0.

## Known Limitations

These are deliberate v1 OSS limitations — not release blockers:

- **Single-node runtime** — no distributed delivery worker or persistent queue by default.
- **RBAC-lite** — no per-field RBAC or advanced approval workflows beyond shipped governance approvals.
- **No semantic inference** — no automatic schema inference or ML-based field classification.
- **Read-only topology** — runtime topology view only; no large pipeline editor.
- **Manual templates** — no remote template registry or marketplace.
- **Single tenant** — one platform instance, one admin hierarchy.
- **Basic mapping UX** — no drag-and-drop mapping (planned for a future phase).
- **No AI transforms** — no AI-assisted mapping/enrichment or arbitrary code execution in transforms.
- **Regex replace excluded** — Expert mode supports `regex_extract` only; `regex_replace` is post-MVP.
- **SMTP optional** — governance email requires operator SMTP configuration; default install has `SMTP_ENABLED=false`.
- **Bundled Postgres for evaluation** — production deployments should use managed PostgreSQL.

See also `docs/v1-readiness-checklist.md` section 8.

## Release Notes

- **Install:** `git clone https://github.com/datarelay-labs/datarelay-control.git` → `cp .env.example .env` → `docker compose -f docker-compose.platform.yml up -d` or `./scripts/release/install.sh`.
- **Default login:** `admin` / `admin` with mandatory password change on first login.
- **Production checklist:** `docs/release/production-checklist.md`.
- **Install verification:** `docs/release/installation-validation.md`.
- **License:** Data Relay Source Available License 1.0 — see [LICENSE](LICENSE).

[1.0.2]: https://github.com/datarelay-labs/datarelay-control/releases/tag/v1.0.2
[1.0.1]: https://github.com/datarelay-labs/datarelay-control/releases/tag/v1.0.1
[1.0.0]: https://github.com/datarelay-labs/datarelay-control/releases/tag/v1.0.0
