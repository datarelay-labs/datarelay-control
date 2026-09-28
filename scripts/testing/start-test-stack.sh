#!/usr/bin/env bash
# Start/reuse isolated test dependencies without stealing canonical fixture ports.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT/scripts/testing/_env.sh"
cd "$ROOT"

export COMPOSE_PROFILES=test
export GDC_ONTOLOGY_TEST_CONTAINER_PREFIX="${GDC_ONTOLOGY_TEST_CONTAINER_PREFIX:-gdc}"
export ONTOLOGY_TEST_DATABASE_URL="${ONTOLOGY_TEST_DATABASE_URL:-postgresql://gdc_ontology:gdc_ontology_pw@127.0.0.1:55440/gdc_ontology_test}"

PG_PORT="${GDC_TEST_POSTGRES_HOST_PORT:-55441}"
ONTOLOGY_PORT="${GDC_TEST_ONTOLOGY_POSTGRES_HOST_PORT:-55440}"
WIREMOCK_PORT="${GDC_TEST_WIREMOCK_HOST_PORT:-28080}"
WEBHOOK_PORT="${GDC_TEST_WEBHOOK_ECHO_HOST_PORT:-18091}"
SYSLOG_PORT="${GDC_TEST_SYSLOG_HOST_PORT:-15514}"
SYSLOG_TLS_PORT="${GDC_TEST_SYSLOG_TLS_HOST_PORT:-16514}"

host_tcp_open() {
  local host="$1" port="$2"
  python3 - "$host" "$port" <<'PY'
import socket
import sys

host, port = sys.argv[1], int(sys.argv[2])
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.settimeout(1.0)
try:
    sock.connect((host, port))
except OSError:
    raise SystemExit(1)
finally:
    sock.close()
PY
}

postgres_catalog_ready() {
  local url="$1" expected_db="$2"
  python3 - "$url" "$expected_db" <<'PY'
import sys
from sqlalchemy import create_engine, text

url, expected = sys.argv[1], sys.argv[2]
engine = create_engine(url, pool_pre_ping=True, connect_args={"connect_timeout": 2})
try:
    with engine.connect() as conn:
        actual = conn.execute(text("select current_database()")).scalar_one()
finally:
    engine.dispose()
raise SystemExit(0 if actual == expected else 1)
PY
}

smoke_postgres_ready() {
  postgres_catalog_ready "$TEST_DATABASE_URL" "gdc_pytest"
}

ontology_postgres_ready() {
  postgres_catalog_ready "$ONTOLOGY_TEST_DATABASE_URL" "gdc_ontology_test"
}

docker_fixture_port_owner() {
  local port="$1" suffix="$2" container_port="$3"
  local candidate mapping
  local -a matches=()

  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    [[ "$candidate" == *"$suffix" ]] || continue
    mapping="$(docker port "$candidate" "$container_port" 2>/dev/null || true)"
    if printf '%s\n' "$mapping" | grep -Eq ":${port}$"; then
      matches+=("$candidate")
    fi
  done < <(docker ps --filter "publish=$port" --format '{{.Names}}')

  if [[ "${#matches[@]}" -eq 1 ]]; then
    printf '%s\n' "${matches[0]}"
    return 0
  fi
  if [[ "${#matches[@]}" -gt 1 ]]; then
    echo "ERROR: multiple fixture containers match host port $port and suffix $suffix: ${matches[*]}" >&2
    return 2
  fi
  return 1
}

wiremock_ready() {
  local owner=""
  owner="$(docker_fixture_port_owner "$WIREMOCK_PORT" "-wiremock-test" "8080/tcp")" || return $?
  curl -fsS --connect-timeout 1 --max-time 2 "$WIREMOCK_BASE_URL/__admin/mappings" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); raise SystemExit(0 if isinstance(d.get("mappings"), list) else 1)' \
    >/dev/null
}

webhook_ready() {
  local owner=""
  owner="$(docker_fixture_port_owner "$WEBHOOK_PORT" "-webhook-receiver-test" "8080/tcp")" || return $?
  curl -fsS --connect-timeout 1 --max-time 2 "http://127.0.0.1:$WEBHOOK_PORT/" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); raise SystemExit(0 if d.get("method") == "GET" else 1)' \
    >/dev/null
}

syslog_ready() {
  local owner_tcp="" owner_tls=""
  owner_tcp="$(docker_fixture_port_owner "$SYSLOG_PORT" "-syslog-test" "5514/tcp")" || return $?
  owner_tls="$(docker_fixture_port_owner "$SYSLOG_TLS_PORT" "-syslog-test" "6514/tcp")" || return $?
  [[ "$owner_tcp" == "$owner_tls" ]] || return 1
  host_tcp_open 127.0.0.1 "$SYSLOG_PORT" && host_tcp_open 127.0.0.1 "$SYSLOG_TLS_PORT"
}

wait_ready() {
  local label="$1" readiness_fn="$2"
  local deadline=$((SECONDS + 90))
  while true; do
    if "$readiness_fn"; then
      return 0
    fi
    if (( SECONDS >= deadline )); then
      echo "ERROR: $label did not become ready on its canonical endpoint." >&2
      docker compose -p "$COMPOSE_PROJECT_NAME" -f "$GDC_TEST_COMPOSE_FILE" ps >&2 || true
      return 1
    fi
    sleep 2
  done
}

FIXTURE_SERVICES=()

plan_fixture() {
  local label="$1" service="$2" host_port="$3" readiness_fn="$4"

  if host_tcp_open 127.0.0.1 "$host_port"; then
    if "$readiness_fn"; then
      echo "  $label already healthy on 127.0.0.1:$host_port — reusing canonical fixture."
      return 0
    fi
    echo "ERROR: $label canonical port 127.0.0.1:$host_port is occupied but does not satisfy the expected fixture contract." >&2
    echo "       Refusing to recreate/replace a foreign or incompatible listener." >&2
    return 1
  fi

  FIXTURE_SERVICES+=("$service")
}

plan_syslog_fixture() {
  local tcp_open=0 tls_open=0
  host_tcp_open 127.0.0.1 "$SYSLOG_PORT" && tcp_open=1 || true
  host_tcp_open 127.0.0.1 "$SYSLOG_TLS_PORT" && tls_open=1 || true

  if [[ "$tcp_open" -eq 0 && "$tls_open" -eq 0 ]]; then
    FIXTURE_SERVICES+=(syslog-test)
    return 0
  fi

  if [[ "$tcp_open" -eq 1 && "$tls_open" -eq 1 ]] && syslog_ready; then
    echo "  Syslog already healthy on 127.0.0.1:$SYSLOG_PORT/$SYSLOG_TLS_PORT — reusing canonical fixture."
    return 0
  fi

  echo "ERROR: syslog canonical ports are partially occupied or are not owned by one *-syslog-test fixture." >&2
  echo "       Refusing to recreate/replace foreign listeners." >&2
  return 1
}

main() {
  echo "Planning canonical test-stack ownership..."
  plan_fixture "PostgreSQL smoke" postgres-test "$PG_PORT" smoke_postgres_ready
  plan_fixture "PostgreSQL ontology" postgres-ontology-test "$ONTOLOGY_PORT" ontology_postgres_ready
  plan_fixture "WireMock" wiremock-test "$WIREMOCK_PORT" wiremock_ready
  plan_fixture "Webhook echo" webhook-receiver-test "$WEBHOOK_PORT" webhook_ready
  plan_syslog_fixture

  if [[ "${#FIXTURE_SERVICES[@]}" -gt 0 ]]; then
    echo "Starting missing fixture services: ${FIXTURE_SERVICES[*]}"
    docker compose -p "$COMPOSE_PROJECT_NAME" -f "$GDC_TEST_COMPOSE_FILE" up -d "${FIXTURE_SERVICES[@]}"
  else
    echo "All canonical fixture endpoints are healthy — skipping compose up."
  fi

  echo "Waiting for canonical fixture readiness..."
  wait_ready "PostgreSQL smoke" smoke_postgres_ready
  wait_ready "PostgreSQL ontology" ontology_postgres_ready
  wait_ready "WireMock" wiremock_ready
  wait_ready "Webhook echo" webhook_ready
  wait_ready "Syslog" syslog_ready

  echo "Verifying pytest catalog connectivity (55440 ontology, 55441 smoke)..."
  ONTOLOGY_TEST_DATABASE_URL="$ONTOLOGY_TEST_DATABASE_URL" \
  TEST_DATABASE_URL="$TEST_DATABASE_URL" \
  python3 - <<'PY'
import os
import sys
from sqlalchemy import create_engine, text

checks = [
    ("ontology", os.environ.get("ONTOLOGY_TEST_DATABASE_URL", ""), "gdc_ontology_test"),
    ("smoke", os.environ.get("TEST_DATABASE_URL", ""), "gdc_pytest"),
]
for label, url, expected_db in checks:
    if not url:
        print(f"ERROR: missing URL for {label} catalog", file=sys.stderr)
        sys.exit(1)
    engine = create_engine(url, pool_pre_ping=True, connect_args={"connect_timeout": 2})
    try:
        with engine.connect() as conn:
            db_name = conn.execute(text("select current_database()")).scalar_one()
            if db_name != expected_db:
                raise SystemExit(f"{label}: connected to unexpected database {db_name!r}")
    finally:
        engine.dispose()
    print(f"  {label} catalog ({expected_db}): OK")
PY

  echo "Test stack ready."
  echo "  TEST_DATABASE_URL=$TEST_DATABASE_URL"
  echo "  ONTOLOGY_TEST_DATABASE_URL=$ONTOLOGY_TEST_DATABASE_URL"
  echo "  WIREMOCK_BASE_URL=$WIREMOCK_BASE_URL"
  echo "  Webhook echo: http://127.0.0.1:$WEBHOOK_PORT"
  echo "  Syslog: 127.0.0.1:$SYSLOG_PORT tcp/udp; TLS $SYSLOG_TLS_PORT/tcp"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
