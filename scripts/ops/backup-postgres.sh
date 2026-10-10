#!/usr/bin/env bash
# Read-only PostgreSQL backup using pg_dump (custom format).
# Does not modify checkpoints, truncate data, or write to the database.
#
# Usage:
#   DATABASE_URL=postgresql://... ./scripts/ops/backup-postgres.sh
#   GZIP_BACKUP=1 DATABASE_URL=... ./scripts/ops/backup-postgres.sh
#   DATABASE_URL=... ./scripts/ops/backup-postgres.sh --gzip
#
# Env:
#   DATABASE_URL   (required) PostgreSQL connection URL.
#   BACKUP_DIR     Output directory (default: <repo>/var/backups/postgres).
#   GZIP_BACKUP    If set to 1, compress the .dump file to .dump.gz (after dump completes).
#
# Logs: never prints the full DATABASE_URL (passwords stay out of this script's stdout/stderr).
set -euo pipefail
# pg_dump archives contain credentials and application data; restrict both
# completed artifacts and partial outputs from the moment they are created.
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

usage() {
  sed -n '1,25p' "$0" | tail -n +2
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

GZIP_WANTED="${GZIP_BACKUP:-0}"
if [[ "${1:-}" == "--gzip" ]]; then
  GZIP_WANTED=1
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set or is empty." >&2
  echo "Set DATABASE_URL to a PostgreSQL connection string before running this script." >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "ERROR: pg_dump not found in PATH. Install PostgreSQL client tools." >&2
  exit 1
fi
if ! command -v sha256sum >/dev/null 2>&1; then
  echo "ERROR: sha256sum not found in PATH; cannot produce a verifiable archive digest." >&2
  exit 1
fi

python3 - <<'PY' || exit 1
import os
import sys
from urllib.parse import urlparse

raw = (os.environ.get("DATABASE_URL") or "").strip()
u = urlparse(raw)
if u.scheme not in ("postgresql", "postgres"):
    print("ERROR: DATABASE_URL must use postgresql:// or postgres:// scheme.", file=sys.stderr)
    sys.exit(1)
path = (u.path or "").strip("/")
db = path.split("/")[0] if path else ""
if not db:
    print("ERROR: DATABASE_URL must include a database name.", file=sys.stderr)
    sys.exit(1)
host = u.hostname or "(local socket)"
print(f"  Target (sanitized): host={host!s} port={u.port!s} db={db!s} user={(u.username or '')!s}")
PY

BACKUP_DIR="${BACKUP_DIR:-$ROOT/var/backups/postgres}"
mkdir -p "$BACKUP_DIR"

TS="$(date -u +"%Y%m%dT%H%M%SZ")"
OUT_FILE="$BACKUP_DIR/gdc-postgres-${TS}.dump"
# Refuse same-second collisions: never overwrite another valid or partial
# backup, even if its digest sidecar is absent.
if [[ -e "$OUT_FILE" || -e "${OUT_FILE}.gz" ||
      -e "${OUT_FILE}.sha256" || -e "${OUT_FILE}.gz.sha256" ]]; then
  echo "ERROR: Backup artifact for this timestamp already exists; refusing overwrite." >&2
  exit 1
fi

echo "================================================================"
echo "  GDC PostgreSQL backup (read-only pg_dump)"
echo "================================================================"
echo "  Started: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "  Output:  $OUT_FILE"
echo "  Format:  custom (-Fc), restore with pg_restore"
echo "================================================================"

set +e
pg_dump --format=custom --file="$OUT_FILE" --no-password --dbname="$DATABASE_URL"
DUMP_RC=$?
set -e

if [[ "$DUMP_RC" -ne 0 ]]; then
  echo "----------------------------------------------------------------"
  echo "  RESULT: FAILURE (pg_dump exit $DUMP_RC)"
  echo "  Output: (partial file may exist) $OUT_FILE"
  echo "----------------------------------------------------------------"
  exit "$DUMP_RC"
fi

FINAL_PATH="$OUT_FILE"
if [[ "$GZIP_WANTED" == "1" ]]; then
  gzip -n "$OUT_FILE"
  FINAL_PATH="${OUT_FILE}.gz"
fi

BYTES="$(wc -c <"$FINAL_PATH" | tr -d ' ')"
if [[ "$BYTES" -le 0 ]]; then
  echo "ERROR: Empty PostgreSQL archive; cannot report backup success." >&2
  exit 1
fi
chmod 600 -- "$FINAL_PATH"
# Integrity evidence only. SHA256 is NOT encryption, publisher proof or
# independent evidence that a clean restore completed.
SHA256="$(sha256sum -- "$FINAL_PATH" | cut -c 1-64)"
DIGEST_FILE="${FINAL_PATH}.sha256"
printf '%s  %s\n' "$SHA256" "$(basename -- "$FINAL_PATH")" > "$DIGEST_FILE"
chmod 600 -- "$DIGEST_FILE"
echo "----------------------------------------------------------------"
echo "  RESULT: SUCCESS"
echo "  Bytes:  $BYTES"
echo "  SHA256: $SHA256"
echo "  Digest: $DIGEST_FILE"
echo "  Encryption: NOT PROVIDED by this script"
echo "  File:   $FINAL_PATH"
echo "  Finished: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "----------------------------------------------------------------"
