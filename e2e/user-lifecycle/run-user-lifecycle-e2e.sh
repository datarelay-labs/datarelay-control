#!/usr/bin/env bash
# Real Browser Operator E2E — disposable DB/API/UI only (never live platform DB).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG="$ROOT/e2e/user-lifecycle"
cd "$ROOT"

# shellcheck disable=SC1091
set -a
# shellcheck source=config/defaults.env
source "$PKG/config/defaults.env"
set +a

[[ "${GDC_E2E_PID_DIR}" = /* ]] || GDC_E2E_PID_DIR="$ROOT/${GDC_E2E_PID_DIR}"
[[ "${GDC_E2E_LOG_DIR}" = /* ]] || GDC_E2E_LOG_DIR="$ROOT/${GDC_E2E_LOG_DIR}"
export GDC_E2E_PID_DIR GDC_E2E_LOG_DIR
mkdir -p "$GDC_E2E_PID_DIR" "$GDC_E2E_LOG_DIR"

MODE="all"
RUN_ID="${ULC_RUN_ID:-}"
OBSERVE_MINUTES="${ULC_OBSERVE_MINUTES:-30}"
SKIP_UP=0
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --smoke) MODE="smoke"; EXTRA_ARGS+=(--smoke); shift ;;
    --all) MODE="all"; EXTRA_ARGS+=(--all); shift ;;
    --headed) EXTRA_ARGS+=(--headed); shift ;;
    --headless) EXTRA_ARGS+=(--headless); shift ;;
    --scenario) MODE="scenario"; EXTRA_ARGS+=(--scenario "$2"); shift 2 ;;
    --tag) EXTRA_ARGS+=(--tag "$2"); shift 2 ;;
    --resume) MODE="resume"; RUN_ID="$2"; EXTRA_ARGS+=(--resume "$2"); shift 2 ;;
    --cleanup-only) MODE="cleanup"; RUN_ID="$2"; EXTRA_ARGS+=(--cleanup-only "$2"); shift 2 ;;
    --run-id) RUN_ID="$2"; EXTRA_ARGS+=(--run-id "$2"); shift 2 ;;
    --observe-minutes) OBSERVE_MINUTES="$2"; EXTRA_ARGS+=(--observe-minutes "$2"); shift 2 ;;
    --skip-up) SKIP_UP=1; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$RUN_ID" ]]; then
  RUN_ID="ulc-$(date -u +%Y%m%d%H%M%S)-$(openssl rand -hex 3)"
fi
export ULC_RUN_ID="$RUN_ID"
export ULC_OBSERVE_MINUTES="$OBSERVE_MINUTES"
export ULC_ARTIFACT_DIR="${ULC_ARTIFACT_DIR:-/tmp/data-relay-real-browser-e2e}"
ARTIFACT="$ULC_ARTIFACT_DIR/$RUN_ID"
mkdir -p "$ARTIFACT" "$GDC_E2E_PID_DIR" "$GDC_E2E_LOG_DIR" "${GDC_STREAM_RUN_LOCK_DIR:-/tmp/gdc-stream-run-locks-user-lifecycle}"

DB_NAME="datarelay_rue2e_${RUN_ID//-/_}"
DB_NAME="${DB_NAME:0:63}"
export DATABASE_URL="postgresql://gdc:gdc@127.0.0.1:55441/${DB_NAME}"
export TEST_DATABASE_URL="$DATABASE_URL"
export PLAYWRIGHT_API_BASE_URL="http://127.0.0.1:${GDC_E2E_API_PORT}"
export PLAYWRIGHT_BASE_URL="http://127.0.0.1:${GDC_E2E_UI_PORT}"
export GDC_E2E_API_BASE_URL="$PLAYWRIGHT_API_BASE_URL"
export GDC_E2E_UI_BASE_URL="$PLAYWRIGHT_BASE_URL"
export PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}"
export REQUIRE_AUTH="${REQUIRE_AUTH:-false}"
export GDC_ROUTE_PROCESSING_ENABLED=true
export GDC_ENABLE_IN_PROCESS_SCHEDULER=false

echo "RUN_ID=$RUN_ID"
echo "DB=$DB_NAME"
echo "API=$PLAYWRIGHT_API_BASE_URL UI=$PLAYWRIGHT_BASE_URL"
echo "ARTIFACT=$ARTIFACT"

LOCK="$GDC_E2E_PID_DIR/runner.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "ERROR: another user-lifecycle runner holds $LOCK" >&2
  exit 3
fi
# Prevent child processes (API/UI) from inheriting the lock FD.
python3 -c 'import fcntl, os; fcntl.fcntl(9, fcntl.F_SETFD, fcntl.FD_CLOEXEC)'

port_in_use() {
  python3 - "$1" <<'PY'
import socket
import sys

port = int(sys.argv[1])
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.settimeout(0.25)
try:
    rc = sock.connect_ex(("127.0.0.1", port))
finally:
    sock.close()
raise SystemExit(0 if rc == 0 else 1)
PY
}

tracked_process_matches() {
  local pid_file="$1" expected_cwd="$2"
  [[ -f "$pid_file" ]] || return 1
  local pid actual_cwd
  pid="$(tr -d '[:space:]' <"$pid_file" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  actual_cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  [[ "$actual_cwd" == "$expected_cwd" ]]
}

terminate_tracked_process_group() {
  local pid_file="$1" expected_cwd="$2"
  [[ -f "$pid_file" ]] || return 0
  local pid
  pid="$(tr -d '[:space:]' <"$pid_file" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || { rm -f "$pid_file"; return 0; }
  if ! tracked_process_matches "$pid_file" "$expected_cwd"; then
    echo "WARN: refusing to terminate unowned/stale tracked PID $pid from $pid_file" >&2
    rm -f "$pid_file"
    return 0
  fi
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  rm -f "$pid_file"
}

require_free_untracked_port() {
  local name="$1" port="$2" tracked_alive="$3"
  if [[ "$tracked_alive" -eq 0 ]] && port_in_use "$port"; then
    echo "ERROR: $name port 127.0.0.1:$port is already in use, but this harness has no live owned process for it." >&2
    echo "       Refusing to reuse or terminate an unowned listener; choose an isolated port." >&2
    return 1
  fi
}

preflight_api_tracked=0
preflight_ui_tracked=0
tracked_process_matches "$GDC_E2E_PID_DIR/api.pid" "$ROOT" && preflight_api_tracked=1
tracked_process_matches "$GDC_E2E_PID_DIR/ui.pid" "$ROOT/frontend" && preflight_ui_tracked=1
require_free_untracked_port "API" "$GDC_E2E_API_PORT" "$preflight_api_tracked"
require_free_untracked_port "UI" "$GDC_E2E_UI_PORT" "$preflight_ui_tracked"

python_runtime_cache_root() {
  readlink -m "${GDC_E2E_PYTHON_CACHE_DIR:-/tmp/datarelay-control-e2e-python}"
}

python_runtime_token() {
  local safe digest
  safe="$(printf '%s' "$RUN_ID" | tr -c 'A-Za-z0-9._-' '_')"
  safe="${safe:0:40}"
  digest="$(printf '%s' "$RUN_ID" | sha256sum | awk '{print substr($1, 1, 12)}')"
  printf '%s-%s\n' "$safe" "$digest"
}

python_runtime_run_root() {
  printf '%s/runs/%s\n' "$(python_runtime_cache_root)" "$(python_runtime_token)"
}

python_runtime_path_file() {
  printf '%s/python-runtime-%s.path\n' "$GDC_E2E_PID_DIR" "$(python_runtime_token)"
}

validated_python_runtime_path() {
  local candidate="$1" run_root="$2" canonical
  [[ -n "$candidate" ]] || return 1
  canonical="$(readlink -m "$candidate")"
  case "$canonical" in
    "$run_root/"*)
      [[ -x "$canonical/bin/python" ]] || return 1
      printf '%s\n' "$canonical"
      ;;
    *) return 1 ;;
  esac
}

recorded_python_runtime() {
  local run_root="$1" path_file="$2" raw
  [[ -f "$path_file" ]] || return 1
  raw="$(tr -d '[:space:]' <"$path_file")"
  validated_python_runtime_path "$raw" "$run_root"
}

discover_python_runtime() {
  local system_python="$1" run_root="$2" candidate
  [[ -d "$run_root" ]] || return 1
  candidate="$($system_python - "$run_root" <<'PY2'
import subprocess
import sys
from pathlib import Path
root = Path(sys.argv[1])
try:
    candidates = [p for p in root.iterdir() if p.is_dir() and (p / 'bin' / 'python').is_file()]
except OSError:
    raise SystemExit(1)
candidates.sort(key=lambda p: p.stat().st_mtime_ns, reverse=True)
for candidate in candidates:
    try:
        rc = subprocess.run(
            [str(candidate / 'bin' / 'python'), '-c', 'import fastapi, jsonata, psycopg2, sqlalchemy'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
            check=False,
        ).returncode
    except (OSError, subprocess.TimeoutExpired):
        continue
    if rc == 0:
        print(candidate)
        raise SystemExit(0)
raise SystemExit(1)
PY2
  )" || return 1
  validated_python_runtime_path "$candidate" "$run_root"
}

activate_python_runtime() {
  local runtime_dir="$1"
  "$runtime_dir/bin/python" -c 'import fastapi, jsonata, psycopg2, sqlalchemy' >/dev/null 2>&1 || return 1
  export VIRTUAL_ENV="$runtime_dir"
  export PATH="$runtime_dir/bin:$PATH"
  export GDC_E2E_PYTHON_RUNTIME="$runtime_dir"
  export GDC_E2E_PYTHON_RUNTIME_OWNED="$runtime_dir"
}

ensure_python_runtime() {
  local system_python requirements_hash python_tag cache_root runtime_token run_root runtime_dir lock_file marker
  local runtime_path_file record_tmp recorded_runtime
  system_python="$(command -v python3)"
  requirements_hash="$(sha256sum "$ROOT/requirements.txt" | awk '{print $1}')"
  python_tag="$($system_python -c 'import sys; print(f"py{sys.version_info.major}{sys.version_info.minor}")')"
  cache_root="$(python_runtime_cache_root)"
  runtime_token="$(python_runtime_token)"
  run_root="$cache_root/runs/$runtime_token"
  runtime_path_file="$(python_runtime_path_file)"
  lock_file="$cache_root/locks/${runtime_token}.lock"
  mkdir -p "$run_root" "$cache_root/locks"

  exec 8>"$lock_file"
  flock 8
  terminate_tracked_process_group "$GDC_E2E_PID_DIR/lab-scheduler.pid" "$ROOT"
  terminate_tracked_process_group "$GDC_E2E_PID_DIR/api.pid" "$ROOT"

  recorded_runtime="$(recorded_python_runtime "$run_root" "$runtime_path_file" 2>/dev/null || true)"
  runtime_dir="$(mktemp -d "$run_root/${python_tag}-${requirements_hash:0:16}-gen-XXXXXXXX")"
  marker="$runtime_dir/.requirements-sha256"

  # Each generation is immutable and unique. The prior recorded generation remains
  # valid until the new generation is fully installed/validated and the run-scoped
  # identity file is atomically renamed. A crash on either side of that rename leaves
  # at least one usable cleanup runtime. Cleanup removes every generation under this
  # RUN_ID-specific cache root only after resource cleanup is proven.
  if ! "$system_python" -m venv "$runtime_dir"; then
    rm -rf -- "$runtime_dir"
    flock -u 8
    exec 8>&-
    return 1
  fi
  if ! "$runtime_dir/bin/python" -m pip install --disable-pip-version-check --no-input -r "$ROOT/requirements.txt" \
    >"$GDC_E2E_LOG_DIR/python_runtime_${RUN_ID}.log" 2>&1; then
    rm -rf -- "$runtime_dir"
    echo "ERROR: failed to install isolated browser-runtime dependencies; preserved runtime remains available for cleanup: ${recorded_runtime:-<none>}" >&2
    flock -u 8
    exec 8>&-
    return 1
  fi
  printf '%s\n' "$requirements_hash" >"$marker"
  "$runtime_dir/bin/python" -m pip freeze >"$GDC_E2E_LOG_DIR/python_runtime_${RUN_ID}.freeze.txt"
  if [[ "$(tr -d '[:space:]' <"$marker")" != "$requirements_hash" ]] || \
     ! "$runtime_dir/bin/python" -c 'import fastapi, jsonata, psycopg2, sqlalchemy' >/dev/null 2>&1; then
    rm -rf -- "$runtime_dir"
    echo "ERROR: staged browser-runtime validation failed; preserved runtime remains available for cleanup" >&2
    flock -u 8
    exec 8>&-
    return 1
  fi

  record_tmp="${runtime_path_file}.tmp.$$"
  printf '%s\n' "$runtime_dir" >"$record_tmp"
  mv -f -- "$record_tmp" "$runtime_path_file"

  if [[ -n "$recorded_runtime" && "$recorded_runtime" != "$runtime_dir" ]]; then
    rm -rf -- "$recorded_runtime"
  fi

  flock -u 8
  exec 8>&-

  activate_python_runtime "$runtime_dir" || {
    echo "ERROR: committed browser-runtime activation failed: $runtime_dir" >&2
    return 1
  }
  echo "PYTHON_RUNTIME=$runtime_dir REQUIREMENTS_SHA256=$requirements_hash RESOLUTION=fresh-per-run"
}

ensure_cleanup_database_fixture() {
  local container="gdc-postgres-test"
  if ! docker inspect "$container" >/dev/null 2>&1; then
    echo "ERROR: local PostgreSQL fixture is missing: $container" >&2
    return 1
  fi
  docker start "$container" >/dev/null
  for _ in $(seq 1 60); do
    if pg_isready -h 127.0.0.1 -p 55441 -U gdc >/dev/null 2>&1; then
      echo "CLEANUP_DB_FIXTURE=$container READY=YES"
      return 0
    fi
    sleep 1
  done
  echo "ERROR: cleanup PostgreSQL fixture did not become ready: $container" >&2
  return 1
}

ensure_cleanup_python_runtime() {
  local system_python cache_root runtime_token run_root runtime_path_file runtime_dir have_db
  system_python="$(command -v python3)"
  cache_root="$(python_runtime_cache_root)"
  runtime_token="$(python_runtime_token)"
  run_root="$cache_root/runs/$runtime_token"
  runtime_path_file="$(python_runtime_path_file)"
  runtime_dir="$(recorded_python_runtime "$run_root" "$runtime_path_file" 2>/dev/null || true)"
  if [[ -z "$runtime_dir" ]]; then
    runtime_dir="$(discover_python_runtime "$system_python" "$run_root" 2>/dev/null || true)"
  fi
  have_db="$(tr -d '[:space:]' <"$GDC_E2E_PID_DIR/api-database-url.txt" 2>/dev/null || true)"

  if tracked_process_matches "$GDC_E2E_PID_DIR/api.pid" "$ROOT" && [[ "$have_db" == "$DATABASE_URL" ]]; then
    if [[ -n "$runtime_dir" ]] && activate_python_runtime "$runtime_dir"; then
      echo "CLEANUP_RUNTIME=$runtime_dir RESOLUTION=surviving-api-reuse-existing"
      return 0
    fi
    if "$system_python" -c 'import fastapi, jsonata, psycopg2, sqlalchemy' >/dev/null 2>&1; then
      echo "CLEANUP_RUNTIME=$system_python RESOLUTION=surviving-api-local-existing"
      return 0
    fi
    echo "ERROR: surviving cleanup API exists but no offline-capable Python runtime is available for cleanup helpers" >&2
    return 1
  fi
  if [[ -n "$runtime_dir" ]] && activate_python_runtime "$runtime_dir"; then
    echo "CLEANUP_RUNTIME=$runtime_dir RESOLUTION=reuse-existing"
    return 0
  fi
  if "$system_python" -c 'import fastapi, jsonata, psycopg2, sqlalchemy' >/dev/null 2>&1; then
    echo "CLEANUP_RUNTIME=$system_python RESOLUTION=local-existing"
    return 0
  fi
  echo "ERROR: cleanup-only requires a preserved run runtime or an already-installed local runtime; refusing network dependency resolution" >&2
  return 1
}

ensure_fixtures() {
  local syslog_fixture_present=0
  for c in gdc-postgres-test gdc-wiremock-test gdc-webhook-receiver-test gdc-minio-test gdc-postgres-query-test gdc-sftp-test gdc-syslog-test; do
    if docker inspect "$c" >/dev/null 2>&1; then
      docker start "$c" >/dev/null 2>&1 || true
      [[ "$c" == "gdc-syslog-test" ]] && syslog_fixture_present=1
    else
      if [[ "$c" == "gdc-syslog-test" ]]; then
        echo "Starting missing Syslog fixture from docker-compose.test.yml" >&2
        docker compose -f "$ROOT/docker-compose.test.yml" --profile e2e up -d syslog-test >/dev/null
        docker inspect "$c" >/dev/null 2>&1 || {
          echo "ERROR: unable to create Syslog fixture $c" >&2
          return 1
        }
        syslog_fixture_present=1
      else
        echo "WARN: missing fixture container $c" >&2
      fi
    fi
  done
  local syslog_plain_port="${GDC_TEST_SYSLOG_HOST_PORT:-15514}"
  local syslog_tls_port="${GDC_TEST_SYSLOG_TLS_HOST_PORT:-16514}"
  for _ in $(seq 1 60); do
    local wiremock_ready=0 syslog_ready=1
    curl -sf "$WIREMOCK_BASE_URL/__admin/mappings" >/dev/null && wiremock_ready=1 || true
    if [[ "$syslog_fixture_present" -eq 1 ]]; then
      python3 - "$syslog_plain_port" "$syslog_tls_port" <<'PY' >/dev/null 2>&1 || syslog_ready=0
import socket, sys
for raw in sys.argv[1:]:
    with socket.create_connection(("127.0.0.1", int(raw)), timeout=1.0):
        pass
PY
    fi
    if [[ "$wiremock_ready" -eq 1 && "$syslog_ready" -eq 1 ]]; then
      return 0
    fi
    sleep 1
  done
  echo "ERROR: required browser E2E fixtures did not become ready" >&2
  return 1
}

ensure_db() {
  export PGPASSWORD=gdc
  local exists
  exists="$(psql -h 127.0.0.1 -p 55441 -U gdc -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'")"
  if [[ "$exists" != "1" ]]; then
    psql -h 127.0.0.1 -p 55441 -U gdc -d postgres -c "CREATE DATABASE \"${DB_NAME}\" OWNER gdc" >/dev/null
  fi
  python3 -m alembic upgrade head >"$GDC_E2E_LOG_DIR/alembic_${RUN_ID}.log" 2>&1
  unset GDC_SEED_ADMIN_PASSWORD || true
  python3 -m app.db.seed --platform-admin-only --reset-platform-admin-password \
    >"$GDC_E2E_LOG_DIR/admin_seed_${RUN_ID}.log" 2>&1 || true
  python3 -c "
from sqlalchemy import text
from app.database import SessionLocal
db = SessionLocal()
try:
    db.execute(text(\"UPDATE platform_users SET must_change_password = false WHERE username = 'admin'\"))
    db.commit()
finally:
    db.close()
" >>"$GDC_E2E_LOG_DIR/admin_seed_${RUN_ID}.log" 2>&1 || true
}

launch_api() {
  (
    exec 9>&-
    cd "$ROOT"
    export GDC_ENABLE_IN_PROCESS_SCHEDULER=false
    nohup setsid python3 -m uvicorn app.main:app --host 127.0.0.1 --port "$GDC_E2E_API_PORT" --workers "${GDC_E2E_API_WORKERS:-2}" \
      >"$GDC_E2E_LOG_DIR/api_${RUN_ID}.log" 2>&1 &
    echo $! >"$GDC_E2E_PID_DIR/api.pid"
  )
  echo "$DATABASE_URL" >"$GDC_E2E_PID_DIR/api-database-url.txt"
}

start_api() {
  local want_db="$DATABASE_URL"
  local have_db=""
  if [[ -f "$GDC_E2E_PID_DIR/api-database-url.txt" ]]; then
    have_db="$(tr -d '[:space:]' <"$GDC_E2E_PID_DIR/api-database-url.txt")"
  fi
  local running=0
  if tracked_process_matches "$GDC_E2E_PID_DIR/api.pid" "$ROOT"; then
    running=1
  fi
  if [[ $running -eq 1 && "$have_db" == "$want_db" && "${GDC_E2E_FORCE_API_RESTART:-0}" != "1" ]]; then
    echo "API already running pid=$(cat "$GDC_E2E_PID_DIR/api.pid")"
  else
    if [[ $running -eq 1 ]]; then
      echo "Restarting API for disposable DB bind"
      terminate_tracked_process_group "$GDC_E2E_PID_DIR/api.pid" "$ROOT"
    fi
    require_free_untracked_port "API" "$GDC_E2E_API_PORT" 0
    launch_api
  fi
  for _ in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:${GDC_E2E_API_PORT}/health" >/dev/null; then
      echo "API ready"
      return 0
    fi
    sleep 1
  done
  echo "ERROR: API failed to start; see $GDC_E2E_LOG_DIR/api_${RUN_ID}.log" >&2
  return 1
}

start_scheduler() {
  local want_db="$DATABASE_URL"
  local have_db=""
  if [[ -f "$GDC_E2E_PID_DIR/scheduler-database-url.txt" ]]; then
    have_db="$(tr -d '[:space:]' <"$GDC_E2E_PID_DIR/scheduler-database-url.txt")"
  fi
  local running=0
  if tracked_process_matches "$GDC_E2E_PID_DIR/lab-scheduler.pid" "$ROOT"; then
    running=1
  fi
  if [[ $running -eq 1 && "$have_db" == "$want_db" && "${GDC_E2E_FORCE_API_RESTART:-0}" != "1" ]]; then
    echo "scheduler already running"
    return 0
  fi
  if [[ $running -eq 1 ]]; then
    terminate_tracked_process_group "$GDC_E2E_PID_DIR/lab-scheduler.pid" "$ROOT"
  fi
  (
    exec 9>&-
    cd "$ROOT"
    export GDC_ENABLE_IN_PROCESS_SCHEDULER=false
    nohup setsid python3 -m app.scheduler.standalone >"$GDC_E2E_LOG_DIR/scheduler_${RUN_ID}.log" 2>&1 &
    echo $! >"$GDC_E2E_PID_DIR/lab-scheduler.pid"
  )
  echo "$want_db" >"$GDC_E2E_PID_DIR/scheduler-database-url.txt"
  echo "scheduler started pid=$(cat "$GDC_E2E_PID_DIR/lab-scheduler.pid")"
}

start_ui() {
  local proxy="http://127.0.0.1:${GDC_E2E_API_PORT}"
  local have=""
  if [[ -f "$GDC_E2E_PID_DIR/ui-api-proxy.txt" ]]; then
    have="$(tr -d '[:space:]' <"$GDC_E2E_PID_DIR/ui-api-proxy.txt")"
  fi
  local running=0
  if tracked_process_matches "$GDC_E2E_PID_DIR/ui.pid" "$ROOT/frontend"; then
    running=1
  fi
  local candidate_head
  candidate_head="$(git -C "$ROOT" rev-parse HEAD)"
  local recorded_build_head=""
  if [[ -f "$GDC_E2E_PID_DIR/ui-build-head.txt" ]]; then
    recorded_build_head="$(tr -d '[:space:]' <"$GDC_E2E_PID_DIR/ui-build-head.txt")"
  fi
  local reuse_running_ui=0
  if [[ "${ULC_REUSE_UI_DIST:-0}" == "1" && $running -eq 1 && "$have" == "$proxy" && -d "$ROOT/frontend/dist" && "$recorded_build_head" == "$candidate_head" ]]; then
    reuse_running_ui=1
  fi
  if [[ $reuse_running_ui -eq 1 ]]; then
    echo "UI already running exact candidate=$candidate_head proxy=$have"
  else
    if [[ $running -eq 1 ]]; then
      terminate_tracked_process_group "$GDC_E2E_PID_DIR/ui.pid" "$ROOT/frontend"
    fi
    require_free_untracked_port "UI" "$GDC_E2E_UI_PORT" 0
    (
      exec 9>&-
      cd "$ROOT/frontend"
      if [[ ! -x node_modules/.bin/tsc || ! -x node_modules/.bin/vite ]]; then
        npm ci >"$GDC_E2E_LOG_DIR/frontend_npm_ci_${RUN_ID}.log" 2>&1
      fi
      if [[ "${ULC_REUSE_UI_DIST:-0}" != "1" || ! -d dist || "$recorded_build_head" != "$candidate_head" ]]; then
        npm run build >"$GDC_E2E_LOG_DIR/ui_build_${RUN_ID}.log" 2>&1
        printf '%s\n' "$candidate_head" >"$GDC_E2E_PID_DIR/ui-build-head.txt"
      fi
      export VITE_DEV_API_PROXY_TARGET="$proxy"
      nohup setsid npx --yes vite preview --host 127.0.0.1 --port "$GDC_E2E_UI_PORT" --strictPort \
        >"$GDC_E2E_LOG_DIR/ui_${RUN_ID}.log" 2>&1 &
      echo $! >"$GDC_E2E_PID_DIR/ui.pid"
    )
    echo "$proxy" >"$GDC_E2E_PID_DIR/ui-api-proxy.txt"
  fi
  for _ in $(seq 1 40); do
    if curl -sf "http://127.0.0.1:${GDC_E2E_UI_PORT}/" >/dev/null; then
      echo "UI ready"
      return 0
    fi
    sleep 1
  done
  echo "WARN: UI not ready" >&2
}

cleanup_owned_services() {
  terminate_tracked_process_group "$GDC_E2E_PID_DIR/ui.pid" "$ROOT/frontend"
  terminate_tracked_process_group "$GDC_E2E_PID_DIR/lab-scheduler.pid" "$ROOT"
  terminate_tracked_process_group "$GDC_E2E_PID_DIR/api.pid" "$ROOT"
}

cleanup_python_runtime() {
  local cache_root runtime_token run_root runtime_path_file lock_file
  cache_root="$(python_runtime_cache_root)"
  runtime_token="$(python_runtime_token)"
  run_root="$cache_root/runs/$runtime_token"
  runtime_path_file="$(python_runtime_path_file)"
  lock_file="$cache_root/locks/${runtime_token}.lock"
  mkdir -p "$cache_root/locks"
  exec 8>"$lock_file"
  flock 8
  rm -rf -- "$run_root"
  rm -f -- "$runtime_path_file"
  find "$GDC_E2E_PID_DIR" -maxdepth 1 -type f -name "python-runtime-${runtime_token}.path.tmp.*" -delete
  flock -u 8
  exec 8>&-
}

if [[ "$SKIP_UP" != "1" ]]; then
  trap cleanup_owned_services EXIT
  if [[ "$MODE" == "cleanup" ]]; then
    ensure_cleanup_database_fixture
    ensure_cleanup_python_runtime
    start_api
  else
    ensure_python_runtime
    ensure_fixtures
    ensure_db
    start_api
    start_scheduler
    start_ui
  fi
fi

if [[ ! -d "$ROOT/e2e/node_modules/@playwright/test" ]]; then
  (cd "$ROOT/e2e" && npm ci)
fi
(cd "$ROOT/e2e" && npx playwright install chromium >/dev/null 2>&1 || true)

echo "==> running operator CLI mode=$MODE"
set +e
(cd "$ROOT/e2e" && npx --yes tsx "$PKG/cli/main.ts" "${EXTRA_ARGS[@]}" --run-id "$RUN_ID" --observe-minutes "$OBSERVE_MINUTES")
EC=$?
set -e

echo "EXIT=$EC ARTIFACT=$ARTIFACT"
if [[ -f "$ARTIFACT/final-summary.txt" ]]; then
  echo "SUMMARY=ok"
else
  echo "SUMMARY=missing"
fi
if [[ -f "$ARTIFACT/final-summary.txt" ]] && grep -qx 'CLEANUP=PASS' "$ARTIFACT/final-summary.txt"; then
  cleanup_owned_services
  cleanup_python_runtime
else
  if [[ -n "${GDC_E2E_PYTHON_RUNTIME_OWNED:-}" ]]; then
    echo "PYTHON_RUNTIME_PRESERVED=$GDC_E2E_PYTHON_RUNTIME_OWNED REASON=cleanup-not-proven"
  fi
fi
exit "$EC"
