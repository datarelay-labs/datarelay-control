#!/usr/bin/env bash
# Test-only fault injection for Full E2E Lab fixtures / host API.
# Never targets production compose services.
#
# Usage:
#   ./e2e/lab/fault-inject.sh start <target>
#   ./e2e/lab/fault-inject.sh stop <target>
#   ./e2e/lab/fault-inject.sh reset
#   ./e2e/lab/fault-inject.sh status <target>
#
# Targets: database | s3 | sftp | api | runtime | webhook | syslog | syslog-tls

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LAB_DIR="$ROOT/e2e/lab"
COMPOSE_FILE="$LAB_DIR/docker-compose.full-e2e.yml"
ENV_FILE="${GDC_E2E_ENV_FILE:-$LAB_DIR/.env.route-off}"
# Honor isolated lab PID/log dirs (same contract as run-full-e2e-lab.sh).
PID_DIR="${GDC_E2E_PID_DIR:-$ROOT/e2e/reports/.pids}"
LOG_DIR="${GDC_E2E_LOG_DIR:-$ROOT/e2e/reports/lab-logs}"
STATE_DIR="${GDC_E2E_FAULT_STATE_DIR:-$ROOT/e2e/reports/.fault-state}"
PREFIX="${GDC_TEST_CONTAINER_PREFIX:-gdc}"

[[ "$PID_DIR" = /* ]] || PID_DIR="$ROOT/$PID_DIR"
[[ "$LOG_DIR" = /* ]] || LOG_DIR="$ROOT/$LOG_DIR"
[[ "$STATE_DIR" = /* ]] || STATE_DIR="$ROOT/$STATE_DIR"

ACTION="${1:-}"
TARGET="${2:-}"

mkdir -p "$STATE_DIR" "$LOG_DIR" "$PID_DIR"

compose() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

container_for() {
  case "$1" in
    database) echo "${PREFIX}-postgres-query-test" ;;
    s3) echo "${PREFIX}-minio-test" ;;
    sftp) echo "${PREFIX}-sftp-test" ;;
    webhook) echo "${PREFIX}-webhook-collector" ;;
    syslog|syslog-tls) echo "${PREFIX}-syslog-collector" ;;
    *) return 1 ;;
  esac
}

compose_service_for() {
  case "$1" in
    database) echo "postgres-query-test" ;;
    s3) echo "minio-test" ;;
    sftp) echo "sftp-test" ;;
    webhook) echo "webhook-collector" ;;
    syslog|syslog-tls) echo "syslog-collector" ;;
    *) return 1 ;;
  esac
}

wait_http() {
  local url="$1" name="$2" tries="${3:-60}"
  for _ in $(seq 1 "$tries"); do
    if curl -sf --connect-timeout 1 --max-time 2 "$url" >/dev/null 2>&1; then
      echo "    OK $name"
      return 0
    fi
    sleep 1
  done
  echo "ERROR: timeout waiting for $name at $url" >&2
  return 1
}

port_in_use() {
  local port="$1"
  python3 - "$port" <<'PY'
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

require_free_api_port() {
  local port="$1"
  if port_in_use "$port"; then
    echo "ERROR: API port 127.0.0.1:$port is occupied by an unowned/stale process." >&2
    return 1
  fi
}

api_port() {
  echo "${GDC_E2E_API_PORT:-18000}"
}

# Product tree used to (re)launch the lab API after api/runtime faults.
# Prefer an explicit pin so recovery worktrees cannot silently replace a
# healthier lab API with an incomplete checkout.
api_root() {
  local root="${GDC_E2E_API_ROOT:-}"
  if [[ -z "$root" && -n "${GDC_XP_COMMIT:-}" && -d "$ROOT/app" ]]; then
    root="$ROOT"
  fi
  if [[ -z "$root" ]]; then
    root="$ROOT"
  fi
  echo "$root"
}

api_env_file() {
  # Prefer caller-provided env; otherwise match ROUTE_ON XP runs.
  if [[ -n "${GDC_E2E_ENV_FILE:-}" && -f "${GDC_E2E_ENV_FILE}" ]]; then
    echo "${GDC_E2E_ENV_FILE}"
    return 0
  fi
  if [[ "${GDC_XP_ROUTE_RUNTIME:-${GDC_ROUTE_PROCESSING_ENABLED:-}}" =~ ^(ROUTE_ON|true|1|yes)$ ]]; then
    if [[ -f "$LAB_DIR/.env.route-on" ]]; then
      echo "$LAB_DIR/.env.route-on"
      return 0
    fi
  fi
  echo "$ENV_FILE"
}

wait_dedup_put_ready() {
  local port="$1" tries="${2:-30}"
  local url="http://127.0.0.1:${port}/api/v1/runtime/streams/1/deduplication"
  local code body
  for _ in $(seq 1 "$tries"); do
    body="$(curl -sS --connect-timeout 1 --max-time 3 -o /tmp/gdc-dedup-ready.body -w '%{http_code}' -X PUT "$url" \
      -H 'Content-Type: application/json' \
      -d '{"enabled":true,"key_field":"id","duplicate_handling":"skip_duplicate","scope":"current_run"}' \
      2>/dev/null || echo '000')"
    code="$body"
    # 200/404 are acceptable (route present); 405 means product/API tree is wrong.
    if [[ "$code" != "405" && "$code" != "000" ]]; then
      echo "    OK dedup PUT readiness (HTTP $code)"
      return 0
    fi
    sleep 1
  done
  echo "ERROR: PUT /deduplication not ready on port $port (last HTTP $code); API root=$(api_root)" >&2
  return 1
}

load_lab_env() {
  local env_file="$1"
  # shellcheck disable=SC1090
  set -a
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      val="${BASH_REMATCH[2]}"
      if [[ "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
      if [[ "$val" =~ ^\"(.*)\"$ ]]; then val="${BASH_REMATCH[1]}"; fi
      export "$key=$val"
    fi
  done <"$env_file"
  set +a
}

api_workers() {
  echo "${GDC_E2E_API_WORKERS:-2}"
}

start_lab_scheduler() {
  local api_code_root env_file git_head head_file have_head
  api_code_root="$(api_root)"
  env_file="$(api_env_file)"
  git_head="$(git -C "$api_code_root" rev-parse HEAD 2>/dev/null || printf 'unknown\n')"
  head_file="$PID_DIR/lab-scheduler-git-head.txt"
  have_head=""
  [[ -f "$head_file" ]] && have_head="$(tr -d '[:space:]' <"$head_file")"

  if tracked_process_matches "$PID_DIR/lab-scheduler.pid" "$api_code_root" && [[ "$have_head" == "$git_head" ]]; then
    echo "    lab scheduler already running pid=$(cat "$PID_DIR/lab-scheduler.pid") head=$have_head"
    return 0
  fi
  terminate_tracked_process_group "$PID_DIR/lab-scheduler.pid" "$api_code_root"
  if [[ ! -d "$api_code_root/app" ]]; then
    echo "ERROR: API root missing app/: $api_code_root" >&2
    return 1
  fi
  echo "    starting lab standalone scheduler from $api_code_root"
  (
    cd "$api_code_root"
    load_lab_env "$env_file"
    # Force out-of-process scheduling for the lab HTTP API tree.
    export GDC_ENABLE_IN_PROCESS_SCHEDULER=false
    export PYTHONPATH="$api_code_root${PYTHONPATH:+:$PYTHONPATH}"
    nohup setsid python3 -m app.scheduler.standalone \
      >"$LOG_DIR/lab_scheduler.log" 2>&1 &
    echo $! >"$PID_DIR/lab-scheduler.pid"
  )
  sleep 2
  if ! tracked_process_matches "$PID_DIR/lab-scheduler.pid" "$api_code_root"; then
    echo "ERROR: lab scheduler failed to start; see $LOG_DIR/lab_scheduler.log" >&2
    return 1
  fi
  echo "$git_head" >"$head_file"
  echo "    lab scheduler pid=$(cat "$PID_DIR/lab-scheduler.pid") head=$git_head"
}

stop_lab_scheduler() {
  local api_code_root
  api_code_root="$(api_root)"
  terminate_tracked_process_group "$PID_DIR/lab-scheduler.pid" "$api_code_root"
  rm -f "$PID_DIR/lab-scheduler-git-head.txt"
}

start_api() {
  local port api_code_root env_file workers git_head head_file have_head
  port="$(api_port)"
  api_code_root="$(api_root)"
  env_file="$(api_env_file)"
  git_head="$(git -C "$api_code_root" rev-parse HEAD 2>/dev/null || printf 'unknown\n')"
  head_file="$PID_DIR/api-git-head.txt"
  have_head=""
  [[ -f "$head_file" ]] && have_head="$(tr -d '[:space:]' <"$head_file")"

  if tracked_process_matches "$PID_DIR/api.pid" "$api_code_root" && [[ "$have_head" == "$git_head" ]]; then
    echo "    API already running pid=$(cat "$PID_DIR/api.pid") head=$have_head"
    wait_dedup_put_ready "$port" 5 || return 1
    start_lab_scheduler || return 1
    return 0
  fi
  terminate_tracked_process_group "$PID_DIR/api.pid" "$api_code_root"
  require_free_api_port "$port" || return 1
  if [[ ! -d "$api_code_root/app" ]]; then
    echo "ERROR: API root missing app/: $api_code_root" >&2
    return 1
  fi
  echo "    restarting API from $api_code_root (env=$(basename "$env_file"))"
  (
    cd "$api_code_root"
    load_lab_env "$env_file"
    # HTTP process must not embed the stream scheduler (API worker starvation).
    export GDC_ENABLE_IN_PROCESS_SCHEDULER=false
    export PYTHONPATH="$api_code_root${PYTHONPATH:+:$PYTHONPATH}"
    workers="$(api_workers)"
    nohup setsid python3 -m uvicorn app.main:app \
      --host 127.0.0.1 --port "$port" \
      --workers "$workers" \
      >"$LOG_DIR/api_fault_restart.log" 2>&1 &
    echo $! >"$PID_DIR/api.pid"
  )
  sleep 1
  if ! tracked_process_matches "$PID_DIR/api.pid" "$api_code_root"; then
    echo "ERROR: API process exited during recovery startup." >&2
    tail -n 80 "$LOG_DIR/api_fault_restart.log" >&2 || true
    return 1
  fi
  echo "$git_head" >"$head_file"
  wait_http "http://127.0.0.1:$port/health" "API" "${GDC_E2E_API_HEALTH_TRIES:-120}" || return 1
  wait_dedup_put_ready "$port" 45 || return 1
  start_lab_scheduler
}

stop_api() {
  local api_code_root port
  api_code_root="$(api_root)"
  port="$(api_port)"
  terminate_tracked_process_group "$PID_DIR/api.pid" "$api_code_root"
  rm -f "$PID_DIR/api-git-head.txt"
  if port_in_use "$port"; then
    echo "ERROR: API port 127.0.0.1:$port remains occupied by an unowned process; refusing cross-worktree kill." >&2
    return 1
  fi
  # Keep lab scheduler running across api/runtime fault injection so stream
  # processing resumes when the HTTP workers return.
}

fault_start() {
  local t="$1"
  echo "==> [fault start] $t"
  case "$t" in
    database|s3|sftp|webhook|syslog)
      local svc cname
      svc="$(compose_service_for "$t")"
      cname="$(container_for "$t")"
      # Prefer docker stop by stable container_name — fixtures may belong to
      # another compose project that shares GDC_TEST_CONTAINER_PREFIX.
      if docker inspect "$cname" >/dev/null 2>&1; then
        docker stop "$cname" >/dev/null
      else
        compose stop "$svc" || true
      fi
      echo "$t" >"$STATE_DIR/${t}.active"
      ;;
    syslog-tls)
      local cname
      cname="$(container_for syslog-tls)"
      if docker inspect "$cname" >/dev/null 2>&1; then
        docker stop "$cname" >/dev/null
      else
        compose stop syslog-collector || true
      fi
      echo "syslog-tls" >"$STATE_DIR/syslog-tls.active"
      echo '{"mode":"collector_down"}' >"$STATE_DIR/syslog-tls.json"
      ;;
    api|runtime)
      stop_api
      echo "$t" >"$STATE_DIR/${t}.active"
      ;;
    *)
      echo "Unknown fault target: $t" >&2
      echo "Supported: database s3 sftp api runtime webhook syslog syslog-tls" >&2
      exit 2
      ;;
  esac
  echo "    injected"
}

fault_stop() {
  local t="$1"
  echo "==> [fault stop] $t (recover)"
  case "$t" in
    database|s3|sftp|webhook|syslog)
      local svc cname
      svc="$(compose_service_for "$t")"
      cname="$(container_for "$t")"
      if docker inspect "$cname" >/dev/null 2>&1; then
        docker start "$cname" >/dev/null
      else
        compose start "$svc" || true
      fi
      rm -f "$STATE_DIR/${t}.active"
      case "$t" in
        webhook)
          wait_http "${GDC_E2E_WEBHOOK_COLLECTOR_URL:-http://127.0.0.1:18192}/health" "Webhook collector" 40
          ;;
        syslog)
          wait_http "${GDC_E2E_SYSLOG_COLLECTOR_API_URL:-http://127.0.0.1:18193}/health" "Syslog collector" 40
          ;;
        database)
          for _ in $(seq 1 40); do
            if docker exec "$cname" pg_isready -U gdc_fixture >/dev/null 2>&1; then break; fi
            sleep 1
          done
          ;;
        s3)
          for _ in $(seq 1 40); do
            if curl -sf "${SOURCE_E2E_MINIO_ENDPOINT:-http://127.0.0.1:59000}/minio/health/live" >/dev/null 2>&1; then break; fi
            sleep 1
          done
          ;;
        sftp)
          sleep 3
          ;;
      esac
      ;;
    syslog-tls)
      local cname
      cname="$(container_for syslog-tls)"
      if docker inspect "$cname" >/dev/null 2>&1; then
        docker start "$cname" >/dev/null
      else
        compose start syslog-collector || true
      fi
      wait_http "${GDC_E2E_SYSLOG_COLLECTOR_API_URL:-http://127.0.0.1:18193}/health" "Syslog collector" 40
      rm -f "$STATE_DIR/syslog-tls.active" "$STATE_DIR/syslog-tls.json"
      ;;
    api|runtime)
      start_api
      rm -f "$STATE_DIR/${t}.active"
      ;;
    *)
      echo "Unknown fault target: $t" >&2
      exit 2
      ;;
  esac
  echo "    recovered"
}

fault_status() {
  local t="$1"
  if [[ -f "$STATE_DIR/${t}.active" ]]; then
    echo "active"
    return 0
  fi
  echo "inactive"
}

fault_reset() {
  if [[ "${GDC_E2E_TEARDOWN:-0}" == "1" ]]; then
    rm -f "$STATE_DIR"/*.active "$STATE_DIR"/*.json 2>/dev/null || true
    echo "==> [fault reset] teardown mode: state cleared without restarting fixtures/API"
    return 0
  fi

  echo "==> [fault reset] recovering all injected faults"
  for t in database s3 sftp webhook syslog syslog-tls api runtime; do
    if [[ -f "$STATE_DIR/${t}.active" ]]; then
      fault_stop "$t" || true
    fi
  done
  # Ensure fixtures are up even if state files were lost
  for t in database s3 sftp webhook syslog; do
    cname="$(container_for "$t" 2>/dev/null || true)"
    [[ -n "${cname:-}" ]] || continue
    if docker inspect "$cname" >/dev/null 2>&1; then
      docker start "$cname" >/dev/null 2>&1 || true
    fi
  done
  compose start postgres-query-test minio-test sftp-test webhook-collector syslog-collector 2>/dev/null || true
  start_api || true
  rm -f "$STATE_DIR"/*.active "$STATE_DIR"/*.json 2>/dev/null || true
  echo "==> [fault reset] done"
}

case "$ACTION" in
  start)
    [[ -n "$TARGET" ]] || { echo "Usage: $0 start <target>" >&2; exit 2; }
    fault_start "$TARGET"
    ;;
  stop)
    [[ -n "$TARGET" ]] || { echo "Usage: $0 stop <target>" >&2; exit 2; }
    fault_stop "$TARGET"
    ;;
  reset)
    fault_reset
    ;;
  status)
    [[ -n "$TARGET" ]] || { echo "Usage: $0 status <target>" >&2; exit 2; }
    fault_status "$TARGET"
    ;;
  *)
    cat <<EOF
Usage: $0 {start|stop|reset|status} [target]
Targets: database s3 sftp api runtime webhook syslog syslog-tls
EOF
    exit 2
    ;;
esac
