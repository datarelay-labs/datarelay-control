#!/usr/bin/env bash
# Create a compressed PostgreSQL logical dump before upgrades. Never deletes volumes.
set -euo pipefail
# Treat backup archives, digest receipts and logs as secrets.
umask 077
set -C  # Bash noclobber protects against a race after the collision preflight.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=scripts/release/_release_postgres_catalog.sh
source "$SCRIPT_DIR/_release_postgres_catalog.sh"
COMPOSE_REL="${GDC_RELEASE_COMPOSE_FILE:-docker-compose.platform.yml}"
COMPOSE="$ROOT/$COMPOSE_REL"
BACKUP_ROOT="${GDC_BACKUP_DIR:-$ROOT/deploy/backups}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_NAME="gdc_pg_${TS}.sql.gz"
DUMP_PATH="$BACKUP_ROOT/$DUMP_NAME"
LOG_PATH="$BACKUP_ROOT/backup_${TS}.log"
DIGEST_PATH="${DUMP_PATH}.sha256"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG_PATH"; }

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose (v2 plugin) is required." >&2
  exit 1
fi

if [[ ! -f "$COMPOSE" ]]; then
  echo "Compose file not found: $COMPOSE" >&2
  exit 1
fi

# Backup directory must stay under repository root (refuse production-dangerous host paths).
mkdir -p "$BACKUP_ROOT"
BACKUP_RESOLVED="$(cd "$BACKUP_ROOT" && pwd)"
ROOT_RESOLVED="$(cd "$ROOT" && pwd)"
if [[ "$BACKUP_RESOLVED" != "$ROOT_RESOLVED"/* ]]; then
  echo "Refusing: GDC_BACKUP_DIR / deploy/backups must resolve under repository root." >&2
  echo "  ROOT=$ROOT_RESOLVED" >&2
  echo "  BACKUP_ROOT=$BACKUP_RESOLVED" >&2
  exit 3
fi

case "$BACKUP_RESOLVED" in
  /|/bin|/boot|/dev|/etc|/lib|/lib64|/proc|/sys|/usr|/var)
    echo "Refusing: backup path looks like a system root path." >&2
    exit 3
    ;;
  /tmp|/tmp/*|/var/tmp|/var/tmp/*)
    echo "Refusing: backup path under /tmp or /var/tmp is not allowed." >&2
    exit 3
    ;;
esac

# Refuse both ordinary files and dangling symlinks with this UTC timestamp.
for artifact in "$DUMP_PATH" "$DIGEST_PATH" "$LOG_PATH"; do
  if [[ -e "$artifact" || -L "$artifact" ]]; then
    echo "Refusing overwrite of existing backup artifact: $artifact" >&2
    exit 3
  fi
done
: > "$LOG_PATH"  # Exclusive create, no pre-existing log append across runs.

cd "$ROOT"
PG_CID="$(docker compose -f "$COMPOSE_REL" ps -q postgres 2>/dev/null | head -n1 || true)"
if [[ -z "$PG_CID" ]]; then
  log "ERROR: postgres service is not running. Start the stack before backup, or run pg_dump manually."
  exit 4
fi

DB_NAME="$(gdc_release_resolve_postgres_db_name "$ROOT" "$COMPOSE_REL" "${GDC_BACKUP_DB_NAME:-}")"
DB_USER="${GDC_BACKUP_DB_USER:-$(gdc_release_resolve_postgres_user "$ROOT" "$COMPOSE_REL")}"

if [[ ! "$DB_NAME" =~ ^[a-zA-Z0-9_]+$ ]]; then
  echo "Refusing: database name must be alphanumeric/underscore only (unsafe name)." >&2
  exit 3
fi

_compose_catalog="$(gdc_release_resolve_postgres_db_name "$ROOT" "$COMPOSE_REL" "")"
log "Compose postgres catalog (inferred): $_compose_catalog"
log "pg_dump target: database=$DB_NAME user=$DB_USER container=$PG_CID"

if ! docker exec "$PG_CID" psql -U "$DB_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" 2>/dev/null | grep -qx 1; then
  log "ERROR: database '$DB_NAME' does not exist in this cluster (pg_database lookup failed)."
  log "  Compose file: $COMPOSE_REL — expected catalog was '$_compose_catalog'."
  log "  Fix: export GDC_BACKUP_DB_NAME to match POSTGRES_DB, or bootstrap the database before backup."
  exit 4
fi

docker exec "$PG_CID" pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl | gzip -c >"$DUMP_PATH"
if [[ ! -s "$DUMP_PATH" ]]; then
  log "ERROR: archive output is empty; no successful receipt was created."
  exit 4
fi
(cd "$BACKUP_RESOLVED" && sha256sum "$DUMP_NAME" > "${DUMP_NAME}.sha256")
log "Wrote $DUMP_PATH ($(du -h "$DUMP_PATH" | cut -f1))"
log "SHA256: $DIGEST_PATH (integrity only; NOT encrypted or signed)"
log "Done."
