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

ensure_fixtures() {
  for c in gdc-postgres-test gdc-wiremock-test gdc-webhook-receiver-test gdc-minio-test gdc-postgres-query-test gdc-sftp-test; do
    if docker inspect "$c" >/dev/null 2>&1; then
      docker start "$c" >/dev/null 2>&1 || true
    else
      echo "WARN: missing fixture container $c" >&2
    fi
  done
  for _ in $(seq 1 60); do
    if curl -sf "$WIREMOCK_BASE_URL/__admin/mappings" >/dev/null; then
      return 0
    fi
    sleep 1
  done
}

ensure_db() {
  export PGPASSWORD=gdc
  local exists
  exists="$(psql -h 127.0.0.1 -p 55441 -U gdc -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'")"
  if [[ "$exists" != "1" ]]; then
    psql -h 127.0.0.1 -p 55441 -U gdc -d postgres -c "CREATE DATABASE \"${DB_NAME}\" OWNER gdc" >/dev/null
  fi
  alembic upgrade head >"$GDC_E2E_LOG_DIR/alembic_${RUN_ID}.log" 2>&1
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

if [[ "$SKIP_UP" != "1" ]]; then
  ensure_fixtures
  ensure_db
  start_api
  if [[ "$MODE" != "cleanup" ]]; then
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
exit "$EC"
