#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

echo "===== BACKUP SPEC FILES ====="
mkdir -p .specify/backup-postgresql-only
cp .specify/memory/constitution.md .specify/backup-postgresql-only/constitution.md.bak
cp .specify/specs-index.md .specify/backup-postgresql-only/specs-index.md.bak
cp specs/003-db-model/spec.md .specify/backup-postgresql-only/003-db-model.spec.md.bak
cp specs/002-runtime-pipeline/spec.md .specify/backup-postgresql-only/002-runtime-pipeline.spec.md.bak

echo "===== PATCH CONSTITUTION ====="
cat >> .specify/memory/constitution.md <<'CONSTITUTION_APPEND'

## Database Policy

DB is PostgreSQL only in production and development.
SQLite is not supported.
SQLite must not be used as a fallback, local development database, test shortcut, or compatibility layer.
All database migrations, indexes, queries, and performance validations must target PostgreSQL.
CONSTITUTION_APPEND

echo "===== PATCH SPECS INDEX ====="
cat >> .specify/specs-index.md <<'INDEX_APPEND'

## Database Policy

All database implementations must target PostgreSQL.
SQLite must not be used as a fallback.
All migrations, indexes, and query validation rules are PostgreSQL-based.
INDEX_APPEND

echo "===== PATCH 003 DB MODEL SPEC ====="
cat >> specs/003-db-model/spec.md <<'DB_SPEC_APPEND'

---

# PostgreSQL-Only Database Policy

## Supported Database

Supported DB: PostgreSQL only.

SQLite support is removed and must not be used for:

- production
- development
- testing fallback
- local shortcut
- compatibility mode

## Implementation Requirements

All database implementations must target PostgreSQL.

Required:

- SQLAlchemy models must be compatible with PostgreSQL.
- Alembic migrations must be written for PostgreSQL.
- Indexes must be designed for PostgreSQL query planner behavior.
- JSON fields must use PostgreSQL-compatible JSON/JSONB behavior where applicable.
- Query performance must be validated against PostgreSQL.

Forbidden:

- SQLite fallback logic
- SQLite-specific migration branches
- SQLite-specific query behavior
- SQLite-only tests as acceptance evidence

## Performance Validation Standard

Performance validation must use PostgreSQL.

Required validation:

- PostgreSQL EXPLAIN ANALYZE required.
- Index usage must be verified.
- Sequential scan on large tables must be avoided.
- Delivery log, stream, route, destination, checkpoint, and runtime-state queries must be checked for index suitability.
- Any new query expected to run frequently must include index validation evidence.

Acceptance standard:

- Query plan shows intended index usage where applicable.
- Large table access must not depend on full sequential scans.
- Migration-created indexes must match actual filter/order/join patterns.
DB_SPEC_APPEND

echo "===== PATCH 002 RUNTIME PIPELINE SPEC ====="
cat >> specs/002-runtime-pipeline/spec.md <<'RUNTIME_APPEND'

---

# PostgreSQL Runtime Query Performance Rule

Delivery logs queries must be optimized for PostgreSQL index usage.

Runtime queries that read delivery logs, stream state, route state, destination state, or checkpoints must be validated with PostgreSQL EXPLAIN ANALYZE when performance-sensitive.
RUNTIME_APPEND

echo "===== VALIDATION ====="
echo
echo "===== PostgreSQL policy references ====="
grep -RniE "PostgreSQL|SQLite|EXPLAIN ANALYZE|Sequential scan|index usage" \
  .specify/memory/constitution.md \
  .specify/specs-index.md \
  specs/003-db-model/spec.md \
  specs/002-runtime-pipeline/spec.md

echo
echo "DONE: Spec Kit DB policy updated to PostgreSQL-only."
