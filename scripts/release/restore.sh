#!/usr/bin/env bash
# Restore PostgreSQL from a gzip-compressed pg_dump SQL file into the compose postgres service.
# Destructive: requires explicit confirmation. Never drops Docker volumes automatically.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=scripts/release/_release_postgres_catalog.sh
source "$SCRIPT_DIR/_release_postgres_catalog.sh"
COMPOSE_REL="${GDC_RELEASE_COMPOSE_FILE:-docker-compose.platform.yml}"

usage() {
  echo "Usage: RESTORE_CONFIRM=YES_I_UNDERSTAND $0 <path-to-dump.sql.gz>" >&2
  echo "Environment:" >&2
  echo "  GDC_RELEASE_COMPOSE_FILE  (default: docker-compose.platform.yml)" >&2
  echo "  GDC_RESTORE_DB_NAME       (default: POSTGRES_DB from compose; allowlist: gdc, datarelay)" >&2
  echo "  GDC_RESTORE_DB_USER       (default: gdc)" >&2
  echo "  ALLOW_UNVERIFIED_LEGACY_DUMP=yes  (only legacy archives without digest)" >&2
  exit 2
}

if [[ "${RESTORE_CONFIRM:-}" != "YES_I_UNDERSTAND" ]]; then
  echo "Refusing restore without RESTORE_CONFIRM=YES_I_UNDERSTAND" >&2
  usage
fi

DUMP="${1:-}"
if [[ -z "$DUMP" ]]; then
  echo "Dump file missing: ${DUMP:-}" >&2
  usage
fi
# Preserve the original operator path for symlink screening: realpath resolves links.
if [[ -L "$DUMP" ]]; then
  echo "Refusing restore: archive symlink is not trusted." >&2
  exit 6
fi
if command -v realpath >/dev/null 2>&1; then
  DUMP="$(realpath "$DUMP")"
fi
if [[ ! -f "$DUMP" ]]; then
  echo "Dump file missing or not a file: ${DUMP:-}" >&2
  usage
fi

# Validate the exact archive bytes before contacting Docker/PostgreSQL.
# A SHA256 receipt proves file integrity only, not encryption or signing.
DIGEST_FILE="${DUMP}.sha256"
if [[ -L "$DUMP" || -L "$DIGEST_FILE" ]]; then
  echo "Refusing restore: archive/checksum symlink is not trusted." >&2
  exit 6
fi
if [[ -f "$DIGEST_FILE" ]]; then
  if [[ ! -s "$DUMP" || ! -s "$DIGEST_FILE" || "$(wc -c < "$DIGEST_FILE")" -gt 256 ]]; then
    echo "Refusing restore: empty archive or invalid checksum receipt." >&2
    exit 6
  fi
  mapfile -t digest_lines < "$DIGEST_FILE"
  if [[ "${#digest_lines[@]}" -ne 1 ]]       || [[ ! "${digest_lines[0]}" =~ ^([0-9a-fA-F]{64})[[:space:]][[:space:]]([^/[:space:]]+)$ ]]; then
    echo "Refusing restore: malformed checksum receipt." >&2
    exit 6
  fi
  recorded_digest="${BASH_REMATCH[1]}"
  recorded_archive="${BASH_REMATCH[2]}"
  if [[ "$recorded_archive" != "$(basename "$DUMP")" ]]; then
    echo "Refusing restore: checksum receipt references a different archive." >&2
    exit 6
  fi
  actual_digest="$(sha256sum "$DUMP" | awk '{print $1}')"
  if [[ "${recorded_digest,,}" != "$actual_digest" ]]; then
    echo "Refusing restore: checksum mismatch; archive bytes have changed." >&2
    exit 6
  fi
  echo "Checksum verified for $(basename "$DUMP") (integrity only, not a signature)."
elif [[ "${ALLOW_UNVERIFIED_LEGACY_DUMP:-}" == "yes" ]]; then
  echo "WARNING: legacy restore lacks a SHA256 checksum; verification explicitly waived." >&2
else
  echo "Refusing restore: checksum receipt missing. Set ALLOW_UNVERIFIED_LEGACY_DUMP=yes only for an approved legacy archive." >&2
  exit 6
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose (v2 plugin) is required." >&2
  exit 1
fi

cd "$ROOT"
COMPOSE="$ROOT/$COMPOSE_REL"
if [[ ! -f "$COMPOSE" ]]; then
  echo "Compose file not found: $COMPOSE" >&2
  exit 1
fi

ALLOWED_DB="$(gdc_release_resolve_postgres_db_name "$ROOT" "$COMPOSE_REL" "${GDC_RESTORE_DB_NAME:-}")"
ALLOWED_USER="${GDC_RESTORE_DB_USER:-gdc}"

if [[ "$ALLOWED_DB" != "gdc" && "$ALLOWED_DB" != "datarelay" ]]; then
  echo "Refusing: resolved database name must be gdc or datarelay (unknown DB target guard)." >&2
  exit 3
fi

_compose_catalog="$(gdc_release_resolve_postgres_db_name "$ROOT" "$COMPOSE_REL" "")"
echo "Restore target database: $ALLOWED_DB (compose-inferred POSTGRES_DB: $_compose_catalog; compose: $COMPOSE_REL)"

PG_CID="$(docker compose -f "$COMPOSE_REL" ps -q postgres 2>/dev/null | head -n1 || true)"
if [[ -z "$PG_CID" ]]; then
  echo "postgres service is not running." >&2
  exit 4
fi

echo "This will replace data in database '$ALLOWED_DB' on the compose postgres service."
echo "  Dump: $DUMP"
echo "  Compose: $COMPOSE_REL"
read -r -p "Type the database name to proceed ($ALLOWED_DB): " typed
if [[ "$typed" != "$ALLOWED_DB" ]]; then
  echo "Confirmation mismatch; aborting." >&2
  exit 5
fi

log_restore() { echo "[restore] $*"; }

log_restore "Terminating connections to $ALLOWED_DB (if any)..."
docker exec "$PG_CID" psql -U "$ALLOWED_USER" -d postgres -v ON_ERROR_STOP=1 -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$ALLOWED_DB' AND pid <> pg_backend_pid();" \
  >/dev/null || true

log_restore "Dropping and recreating database $ALLOWED_DB..."
docker exec "$PG_CID" psql -U "$ALLOWED_USER" -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$ALLOWED_DB\";"
docker exec "$PG_CID" psql -U "$ALLOWED_USER" -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$ALLOWED_DB\" OWNER \"$ALLOWED_USER\";"

log_restore "Restoring from gzip SQL..."
gunzip -c "$DUMP" | docker exec -i "$PG_CID" psql -U "$ALLOWED_USER" -d "$ALLOWED_DB" -v ON_ERROR_STOP=1

log_restore "Restore finished. Run alembic upgrade head if schema drift is possible."
