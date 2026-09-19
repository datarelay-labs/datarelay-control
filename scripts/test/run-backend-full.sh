#!/usr/bin/env bash
# Deterministic full backend pytest: isolated gdc_pytest on the smoke PostgreSQL port + compose fixtures.
# PostgreSQL only (no SQLite). Never targets production catalogs or the API lab DB (gdc).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# shellcheck source=/dev/null
source "$ROOT/scripts/testing/_env.sh"

# Pytest-only catalog (API / validation lab stays on gdc on the same server).
export GDC_TEST_POSTGRES_HOST_PORT="${GDC_TEST_POSTGRES_HOST_PORT:-55441}"
CANONICAL_TEST_DB_URL="postgresql://gdc:gdc@127.0.0.1:${GDC_TEST_POSTGRES_HOST_PORT}/gdc_pytest"
# Always-present catalog on lab Postgres (used only to wait for TCP / init).
LAB_POSTGRES_GATEWAY_URL="postgresql://gdc:gdc@127.0.0.1:${GDC_TEST_POSTGRES_HOST_PORT}/gdc"
COMPOSE_FILE="${GDC_TEST_COMPOSE_FILE:-$ROOT/docker-compose.test.yml}"
export COMPOSE_PROFILES="${COMPOSE_PROFILES:-test}"
export COMPOSE_PROJECT_NAME="${GDC_TEST_COMPOSE_PROJECT:-gdc-platform-test}"

usage() {
  cat <<'USAGE'
Usage: ./scripts/test/run-backend-full.sh [options]

  1) Enforces TEST_DATABASE_URL and DATABASE_URL:
       postgresql://gdc:gdc@127.0.0.1:${GDC_TEST_POSTGRES_HOST_PORT:-55441}/gdc_pytest
  2) Starts or verifies dependencies via docker-compose.test.yml (when Docker is available)
  3) Ensures catalog gdc_pytest exists (CREATE DATABASE if missing; never touches gdc data)
  4) Optionally resets public schema on gdc_pytest (--fresh-schema; pytest catalog only)
  5) Runs: python3 -m alembic upgrade head
  6) Seeds source-adapter E2E fixtures (MinIO / fixture PG / SFTP)
  7) Runs: python3 -m pytest tests/ -q --tb=short

Options:
  --fresh-schema   DROP SCHEMA public CASCADE on gdc_pytest, then recreate public + grants.
                   Non-interactive (CI / scripts): set
                     GDC_BACKEND_FULL_TEST_RESET_CONFIRM=YES_I_RESET_GDC_PYTEST_CATALOG_ONLY
                   Interactive (local TTY, not CI): type RESET GDC PYTEST DB when prompted.

  -h, --help       Show this help.

Environment:
  WIREMOCK_BASE_URL   Default http://127.0.0.1:${GDC_TEST_WIREMOCK_HOST_PORT:-28080}
  GDC_TEST_COMPOSE_FILE   Override compose file path (default: docker-compose.test.yml)
  GDC_TEST_COMPOSE_PROJECT  Compose project name (default: gdc-platform-test)
  GDC_TEST_CONTAINER_PREFIX Container name prefix (default: gdc-smoke; avoids colliding with
                            full-e2e-lab containers named gdc-wiremock-test)
  GDC_TEST_WIREMOCK_HOST_PORT Host port for WireMock (default: 28080)
  GDC_TEST_WEBHOOK_ECHO_HOST_PORT Host port for webhook echo (default: 18091).
                            If that port is already serving (e.g. full-e2e-lab), the script
                            reuses it instead of recreating webhook-receiver-test.
  Fixture reuse            Also reuses Postgres/MinIO/SFTP/syslog when their canonical
                            host ports are already listening (avoids colliding with
                            gdc-full-e2e-lab).

If Docker cannot bind the smoke PostgreSQL port, start or free
the lab Postgres, then re-run.
USAGE
}

FRESH_SCHEMA=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fresh-schema) FRESH_SCHEMA=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1 (try --help)" >&2
      exit 1
      ;;
  esac
  shift
done

# Enforced catalog URL (overrides caller environment for this process tree).
export TEST_DATABASE_URL="$CANONICAL_TEST_DB_URL"
export DATABASE_URL="$CANONICAL_TEST_DB_URL"
export WIREMOCK_BASE_URL="${WIREMOCK_BASE_URL:-http://127.0.0.1:${GDC_TEST_WIREMOCK_HOST_PORT:-28080}}"
export GDC_TEST_WEBHOOK_ECHO_HOST_PORT="${GDC_TEST_WEBHOOK_ECHO_HOST_PORT:-18091}"
export E2E_WEBHOOK_ECHO_URL="${E2E_WEBHOOK_ECHO_URL:-http://127.0.0.1:${GDC_TEST_WEBHOOK_ECHO_HOST_PORT}}"

export SOURCE_E2E_MINIO_ENDPOINT="${SOURCE_E2E_MINIO_ENDPOINT:-http://127.0.0.1:59000}"
export SOURCE_E2E_MINIO_ACCESS_KEY="${SOURCE_E2E_MINIO_ACCESS_KEY:-gdcminioaccess}"
export SOURCE_E2E_MINIO_SECRET_KEY="${SOURCE_E2E_MINIO_SECRET_KEY:-gdcminioaccesssecret12}"
export SOURCE_E2E_MINIO_BUCKET="${SOURCE_E2E_MINIO_BUCKET:-gdc-source-e2e}"
export SOURCE_E2E_PG_FIXTURE_URL="${SOURCE_E2E_PG_FIXTURE_URL:-postgresql://gdc_fixture:gdc_fixture_pw@127.0.0.1:55433/gdc_query_fixture}"
export SOURCE_E2E_SFTP_HOST="${SOURCE_E2E_SFTP_HOST:-127.0.0.1}"
export SOURCE_E2E_SFTP_PORT="${SOURCE_E2E_SFTP_PORT:-22222}"

echo "==> Enforced TEST_DATABASE_URL / DATABASE_URL:"
echo "    $TEST_DATABASE_URL"
echo "==> Compose project: $COMPOSE_PROJECT_NAME (container prefix: ${GDC_TEST_CONTAINER_PREFIX})"

python3 - <<'PY' || exit 1
import os
import sys
from urllib.parse import urlparse

url = os.environ.get("TEST_DATABASE_URL", "")
u = urlparse(url)
if u.scheme not in ("postgresql", "postgres"):
    print("ERROR: URL must be postgresql.", file=sys.stderr)
    sys.exit(1)
host = (u.hostname or "").lower()
port = u.port
user = u.username or ""
password = u.password or ""
path = (u.path or "").strip("/")
db = path.split("/")[0] if path else ""

if db != "gdc_pytest":
    print(f"ERROR: database name must be exactly 'gdc_pytest' (got {db!r}).", file=sys.stderr)
    sys.exit(1)
if user != "gdc":
    print(f"ERROR: user must be 'gdc' (got {user!r}).", file=sys.stderr)
    sys.exit(1)
if password != "gdc":
    print(f"ERROR: password must match lab test user (refusing non-canonical URL).", file=sys.stderr)
    sys.exit(1)
expected_port = int(os.environ.get("GDC_TEST_POSTGRES_HOST_PORT", "55441"))
if port != expected_port:
    print(f"ERROR: port must be {expected_port} (got {port!r}).", file=sys.stderr)
    sys.exit(1)
if host != "127.0.0.1":
    print(f"ERROR: host must be 127.0.0.1 (got {host!r}).", file=sys.stderr)
    sys.exit(1)
print(f"  URL safety checks: OK (gdc_pytest @ 127.0.0.1:{expected_port}, user gdc).")
PY

wait_for_postgres_server() {
  echo "==> Waiting for PostgreSQL server (gdc gateway @ 127.0.0.1:${GDC_TEST_POSTGRES_HOST_PORT}) …"
  export LAB_POSTGRES_GATEWAY_URL="${LAB_POSTGRES_GATEWAY_URL}"
  python3 - <<'PY' || return 1
import os
import sys
import time

try:
    import psycopg2
except ImportError:
    print("ERROR: psycopg2 is required (pip install -r requirements.txt).", file=sys.stderr)
    sys.exit(1)

url = os.environ["LAB_POSTGRES_GATEWAY_URL"]
deadline = time.monotonic() + 180.0
last_err = None
while time.monotonic() < deadline:
    try:
        conn = psycopg2.connect(url, connect_timeout=3)
        conn.close()
        print("  PostgreSQL server is reachable.")
        sys.exit(0)
    except Exception as exc:
        last_err = str(exc).strip()
        time.sleep(1)

print("ERROR: could not connect to PostgreSQL before timeout.", file=sys.stderr)
if last_err:
    print(f"  Last error: {last_err}", file=sys.stderr)
sys.exit(1)
PY
}

wait_for_pytest_catalog() {
  echo "==> Waiting for pytest catalog $TEST_DATABASE_URL …"
  python3 - <<'PY' || return 1
import os
import sys
import time

try:
    import psycopg2
except ImportError:
    print("ERROR: psycopg2 is required.", file=sys.stderr)
    sys.exit(1)

url = os.environ["TEST_DATABASE_URL"]
deadline = time.monotonic() + 60.0
last_err = None
while time.monotonic() < deadline:
    try:
        conn = psycopg2.connect(url, connect_timeout=3)
        conn.close()
        print("  Pytest catalog is reachable.")
        sys.exit(0)
    except Exception as exc:
        last_err = str(exc).strip()
        time.sleep(0.5)

print("ERROR: could not connect to pytest catalog before timeout.", file=sys.stderr)
if last_err:
    print(f"  Last error: {last_err}", file=sys.stderr)
sys.exit(1)
PY
}

wiremock_already_healthy() {
  curl -sf "${WIREMOCK_BASE_URL}/__admin/mappings" >/dev/null 2>&1
}

webhook_echo_already_healthy() {
  # mendhak/http-https-echo answers GET / with JSON; any HTTP response means the port is owned.
  curl -sf -o /dev/null -w '' "http://127.0.0.1:${GDC_TEST_WEBHOOK_ECHO_HOST_PORT}/" >/dev/null 2>&1 \
    || curl -s -o /dev/null -w '' --max-time 2 "http://127.0.0.1:${GDC_TEST_WEBHOOK_ECHO_HOST_PORT}/" >/dev/null 2>&1
}

host_tcp_open() {
  local host="$1"
  local port="$2"
  python3 - "$host" "$port" <<'PY'
import socket, sys
host, port = sys.argv[1], int(sys.argv[2])
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(1.5)
try:
    s.connect((host, port))
except OSError:
    sys.exit(1)
finally:
    s.close()
sys.exit(0)
PY
}

postgres_already_healthy() {
  host_tcp_open 127.0.0.1 "${GDC_TEST_POSTGRES_HOST_PORT}"
}

minio_already_healthy() {
  local port="${GDC_TEST_MINIO_API_HOST_PORT:-59000}"
  curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${port}/minio/health/live" >/dev/null 2>&1 \
    || host_tcp_open 127.0.0.1 "$port"
}

pg_fixture_already_healthy() {
  host_tcp_open 127.0.0.1 "${GDC_TEST_PG_FIXTURE_HOST_PORT:-55433}"
}

sftp_already_healthy() {
  host_tcp_open 127.0.0.1 "${GDC_TEST_SFTP_HOST_PORT:-22222}"
}

syslog_already_healthy() {
  host_tcp_open 127.0.0.1 "${GDC_TEST_SYSLOG_HOST_PORT:-15514}"
}

compose_up() {
  docker compose -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" up -d "$@"
}

if command -v docker >/dev/null 2>&1; then
  echo "==> docker compose -p $COMPOSE_PROJECT_NAME up (postgres-test + fixtures) …"
  FIXTURE_SERVICES=()
  # Prefer reusing lab/e2e fixtures already bound on canonical host ports over killing them.
  if postgres_already_healthy; then
    echo "  Postgres already listening on 127.0.0.1:${GDC_TEST_POSTGRES_HOST_PORT} — reusing (not recreating container)."
  else
    FIXTURE_SERVICES+=(postgres-test)
  fi
  if syslog_already_healthy; then
    echo "  Syslog sink already listening on 127.0.0.1:${GDC_TEST_SYSLOG_HOST_PORT:-15514} — reusing."
  else
    FIXTURE_SERVICES+=(syslog-test)
  fi
  if minio_already_healthy; then
    echo "  MinIO already healthy at 127.0.0.1:${GDC_TEST_MINIO_API_HOST_PORT:-59000} — reusing."
  else
    FIXTURE_SERVICES+=(minio-test)
  fi
  if pg_fixture_already_healthy; then
    echo "  Postgres fixture already listening on 127.0.0.1:${GDC_TEST_PG_FIXTURE_HOST_PORT:-55433} — reusing."
  else
    FIXTURE_SERVICES+=(postgres-query-test)
  fi
  if sftp_already_healthy; then
    echo "  SFTP fixture already listening on 127.0.0.1:${GDC_TEST_SFTP_HOST_PORT:-22222} — reusing."
  else
    FIXTURE_SERVICES+=(sftp-test)
  fi
  if webhook_echo_already_healthy; then
    echo "  Webhook echo already healthy at http://127.0.0.1:${GDC_TEST_WEBHOOK_ECHO_HOST_PORT} — reusing (not recreating container)."
  else
    FIXTURE_SERVICES+=(webhook-receiver-test)
  fi
  if wiremock_already_healthy; then
    echo "  WireMock already healthy at $WIREMOCK_BASE_URL — reusing (not recreating container)."
  else
    FIXTURE_SERVICES+=(wiremock-test)
  fi
  if [[ "${#FIXTURE_SERVICES[@]}" -gt 0 ]]; then
    compose_up "${FIXTURE_SERVICES[@]}"
  else
    echo "  All fixture ports already healthy — skipping compose up."
  fi

  # When reusing full-e2e-lab containers (gdc-* prefix), point seed helpers at those names.
  if ! docker ps --format '{{.Names}}' | grep -qx "${GDC_TEST_CONTAINER_PREFIX}-sftp-test"; then
    if docker ps --format '{{.Names}}' | grep -qx "gdc-sftp-test"; then
      export SOURCE_E2E_SFTP_CONTAINER="gdc-sftp-test"
      echo "  Seed SFTP container override: $SOURCE_E2E_SFTP_CONTAINER"
    fi
  fi
  if ! docker ps --format '{{.Names}}' | grep -qx "${GDC_TEST_CONTAINER_PREFIX}-postgres-query-test"; then
    if docker ps --format '{{.Names}}' | grep -qx "gdc-postgres-query-test"; then
      export SOURCE_E2E_PG_FIXTURE_CONTAINER="gdc-postgres-query-test"
      echo "  Seed PG fixture container override: $SOURCE_E2E_PG_FIXTURE_CONTAINER"
    fi
  fi

  echo "==> Waiting for postgres-test container healthy (if present) …"
  for i in $(seq 1 90); do
    if postgres_already_healthy; then
      break
    fi
    if docker compose -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" ps postgres-test 2>/dev/null | grep -qE "(healthy|running)"; then
      if docker compose -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" ps postgres-test 2>/dev/null | grep -q "healthy"; then
        break
      fi
    fi
    sleep 1
    if [[ "$i" -eq 90 ]]; then
      echo "WARN: postgres-test health not reported; continuing with TCP checks." >&2
    fi
  done
else
  echo "WARN: docker not found; assuming PostgreSQL is already running on 127.0.0.1:${GDC_TEST_POSTGRES_HOST_PORT}." >&2
fi

export LAB_POSTGRES_GATEWAY_URL

if ! wait_for_postgres_server; then
  echo "" >&2
  echo "Install Docker and run this script again, or start the lab Postgres on 127.0.0.1:${GDC_TEST_POSTGRES_HOST_PORT}." >&2
  exit 1
fi

echo "==> Ensure pytest-only catalog exists …"
python3 "$ROOT/scripts/test/ensure_gdc_pytest_catalog.py"

if ! wait_for_pytest_catalog; then
  exit 1
fi

if [[ "$FRESH_SCHEMA" -eq 1 ]]; then
  echo "==> --fresh-schema: destructive reset of public schema on gdc_pytest only …"
  confirmed=0
  if [[ "${GDC_BACKEND_FULL_TEST_RESET_CONFIRM:-}" == "YES_I_RESET_GDC_PYTEST_CATALOG_ONLY" ]]; then
    confirmed=1
  elif [[ "${GDC_BACKEND_FULL_TEST_RESET_CONFIRM:-}" == "YES_I_RESET_GDC_TEST_ONLY" ]]; then
    echo "ERROR: obsolete confirm token YES_I_RESET_GDC_TEST_ONLY (would have targeted the old pytest DB)." >&2
    echo "       Use YES_I_RESET_GDC_PYTEST_CATALOG_ONLY for gdc_pytest." >&2
    exit 1
  elif [[ -t 0 ]] && [[ "${CI:-}" != "true" ]]; then
    read -r -p "Type RESET GDC PYTEST DB to confirm: " CONFIRM
    if [[ "$CONFIRM" == "RESET GDC PYTEST DB" ]]; then
      confirmed=1
    fi
  fi
  if [[ "$confirmed" -ne 1 ]]; then
    echo "ERROR: fresh-schema refused. Export GDC_BACKEND_FULL_TEST_RESET_CONFIRM=YES_I_RESET_GDC_PYTEST_CATALOG_ONLY" >&2
    echo "       for non-interactive runs, or type RESET GDC PYTEST DB on a TTY." >&2
    exit 1
  fi
  python3 - <<'PY' || exit 1
import os
import sys

try:
    import psycopg2
except ImportError:
    print("ERROR: psycopg2 is required.", file=sys.stderr)
    sys.exit(1)

url = os.environ["TEST_DATABASE_URL"]
conn = psycopg2.connect(url)
conn.autocommit = True
cur = conn.cursor()
cur.execute("DROP SCHEMA IF EXISTS public CASCADE")
cur.execute("CREATE SCHEMA public")
cur.execute("GRANT ALL ON SCHEMA public TO PUBLIC")
cur.execute("GRANT ALL ON SCHEMA public TO CURRENT_USER")
cur.execute("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO CURRENT_USER")
cur.execute("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO CURRENT_USER")
cur.close()
conn.close()
print("  DROP/CREATE SCHEMA public complete.")
PY
fi

echo "==> Alembic upgrade head …"
if ! DATABASE_URL="$TEST_DATABASE_URL" python3 -m alembic upgrade head; then
  echo "" >&2
  echo "Alembic failed. If the database has drift (tables without alembic_version), re-run with:" >&2
  echo "  GDC_BACKEND_FULL_TEST_RESET_CONFIRM=YES_I_RESET_GDC_PYTEST_CATALOG_ONLY $0 --fresh-schema" >&2
  exit 1
fi

echo "==> Waiting for WireMock …"
for i in $(seq 1 60); do
  if curl -sf "${WIREMOCK_BASE_URL}/__admin/mappings" >/dev/null 2>&1; then
    echo "  WireMock OK at $WIREMOCK_BASE_URL"
    break
  fi
  sleep 1
  if [[ "$i" -eq 60 ]]; then
    echo "ERROR: WireMock not reachable at $WIREMOCK_BASE_URL" >&2
    exit 1
  fi
done

echo "==> Seeding source E2E fixtures (MinIO / fixture PostgreSQL / SFTP) …"
bash "$ROOT/scripts/testing/source-e2e/seed-fixtures.sh"

echo "==> pytest tests/ -q --tb=short …"
# Avoid exec so CI wrappers (tee / step summary) can observe exit status reliably.
set +e
python3 -m pytest tests/ -q --tb=short
pytest_rc=$?
set -e
if [[ "$pytest_rc" -ne 0 ]]; then
  echo "==> pytest failed with exit code ${pytest_rc}" >&2
fi
exit "$pytest_rc"
