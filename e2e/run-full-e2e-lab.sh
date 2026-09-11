#!/usr/bin/env bash
# Full E2E Lab orchestrator
#
# Usage:
#   ./e2e/run-full-e2e-lab.sh up --route-processing=off
#   ./e2e/run-full-e2e-lab.sh reset
#   ./e2e/run-full-e2e-lab.sh test
#   ./e2e/run-full-e2e-lab.sh matrix
#   ./e2e/run-full-e2e-lab.sh scenario --id <scenario-id> --route-processing=off
#   ./e2e/run-full-e2e-lab.sh triage
#   ./e2e/run-full-e2e-lab.sh all-matrix --route-processing=off
#   ./e2e/run-full-e2e-lab.sh all-matrix --route-processing=on
#   ./e2e/run-full-e2e-lab.sh fault start database
#   ./e2e/run-full-e2e-lab.sh fault stop database
#   ./e2e/run-full-e2e-lab.sh fault reset
#   ./e2e/run-full-e2e-lab.sh merge-results
#   ./e2e/run-full-e2e-lab.sh validate-results
#   ./e2e/run-full-e2e-lab.sh release-gate evaluate --run-id <id>
#   ./e2e/run-full-e2e-lab.sh release-gate validate-evidence --commit <sha> --run-id <id>
#   ./e2e/run-full-e2e-lab.sh release-gate compare-baseline
#   ./e2e/run-full-e2e-lab.sh release-gate rc --run-id <a> --run-id <b>
#   ./e2e/run-full-e2e-lab.sh collect
#   ./e2e/run-full-e2e-lab.sh cleanup --run-id <run-id>
#   ./e2e/run-full-e2e-lab.sh cleanup-stale
#   ./e2e/run-full-e2e-lab.sh validate-cleanup --run-id <run-id>
#   ./e2e/run-full-e2e-lab.sh down
#
# Does not change product defaults. Route flag applies only to this lab API process.
# Lifecycle: test → evidence collect → resource cleanup → validate cleanup → return test exit code.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAB_DIR="$ROOT/e2e/lab"
COMPOSE_FILE="$LAB_DIR/docker-compose.full-e2e.yml"
LOG_DIR="${GDC_E2E_LOG_DIR:-$ROOT/e2e/reports/lab-logs}"
PID_DIR="${GDC_E2E_PID_DIR:-$ROOT/e2e/reports/.pids}"
RUN_ID="${GDC_E2E_RUN_ID:-run_$(date -u +%Y%m%d_%H%M%S)}"
export GDC_E2E_RUN_ID="$RUN_ID"
FAULT_SCRIPT="$LAB_DIR/fault-inject.sh"
# Optional isolated lab profile → e2e/lab/.env.<profile>-route-<off|on>
LAB_PROFILE="${GDC_E2E_LAB_PROFILE:-}"

ROUTE_MODE="off"
SCENARIO_ID=""
CMD="${1:-}"
shift || true

# Fault subcommands: fault start|stop|reset|status [target]
FAULT_ACTION=""
FAULT_TARGET=""
if [[ "$CMD" == "fault" ]]; then
  FAULT_ACTION="${1:-}"
  shift || true
  FAULT_TARGET="${1:-}"
  shift || true
fi

# Release-gate subcommands + passthrough args
RG_ACTION=""
RG_ARGS=()
if [[ "$CMD" == "release-gate" ]]; then
  RG_ACTION="${1:-}"
  shift || true
  RG_ARGS=("$@")
  set --
fi

# Continuous E2E subcommands + passthrough
CONTINUOUS_ARGS=()
if [[ "$CMD" == "continuous" ]]; then
  CONTINUOUS_ARGS=("$@")
  set --
fi

# Toxiproxy fault subcommands + passthrough
TOXI_ARGS=()
if [[ "$CMD" == "fault-toxi" ]]; then
  TOXI_ARGS=("$@")
  set --
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --route-processing=off)
      ROUTE_MODE="off"
      shift
      ;;
    --route-processing=on)
      ROUTE_MODE="on"
      shift
      ;;
    --route-processing)
      ROUTE_MODE="${2:-}"
      shift 2
      ;;
    --route-processing=*)
      ROUTE_MODE="${1#*=}"
      shift
      ;;
    --id)
      SCENARIO_ID="${2:-}"
      shift 2
      ;;
    --id=*)
      SCENARIO_ID="${1#*=}"
      shift
      ;;
    --from)
      MERGE_FROM="${2:-}"
      shift 2
      ;;
    --from=*)
      MERGE_FROM="${1#*=}"
      shift
      ;;
    --run-id)
      export GDC_E2E_RUN_ID="${2:-}"
      RUN_ID="$GDC_E2E_RUN_ID"
      shift 2
      ;;
    --run-id=*)
      export GDC_E2E_RUN_ID="${1#*=}"
      RUN_ID="$GDC_E2E_RUN_ID"
      shift
      ;;
    --lab-profile)
      LAB_PROFILE="${2:-}"
      shift 2
      ;;
    --lab-profile=*)
      LAB_PROFILE="${1#*=}"
      shift
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -n "$LAB_PROFILE" ]]; then
  export GDC_E2E_LAB_PROFILE="$LAB_PROFILE"
  if [[ "$ROUTE_MODE" == "on" ]]; then
    ENV_FILE="$LAB_DIR/.env.${LAB_PROFILE}-route-on"
  else
    ENV_FILE="$LAB_DIR/.env.${LAB_PROFILE}-route-off"
    ROUTE_MODE="off"
  fi
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: lab profile env not found: $ENV_FILE" >&2
    exit 2
  fi
elif [[ "$ROUTE_MODE" == "on" ]]; then
  ENV_FILE="$LAB_DIR/.env.route-on"
else
  ENV_FILE="$LAB_DIR/.env.route-off"
  ROUTE_MODE="off"
fi
export GDC_E2E_ENV_FILE="$ENV_FILE"

# Continuous / toxiproxy CLI helpers do not require lab env files for dry validation.
if [[ "$CMD" == "continuous" ]]; then
  cmd_continuous() {
    (cd "$ROOT/e2e" && npx tsx continuous/cli.ts "${CONTINUOUS_ARGS[@]:-validate}")
  }
  cmd_continuous
  exit $?
fi
if [[ "$CMD" == "fault-toxi" ]]; then
  cmd_fault_toxi() {
    bash "$LAB_DIR/fault-toxiproxy.sh" "${TOXI_ARGS[@]}"
  }
  cmd_fault_toxi
  exit $?
fi

load_env_file() {
  local file="$1"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      local key="${BASH_REMATCH[1]}"
      local val="${BASH_REMATCH[2]}"
      # Strip surrounding single/double quotes
      if [[ "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
      if [[ "$val" =~ ^\"(.*)\"$ ]]; then val="${BASH_REMATCH[1]}"; fi
      export "$key=$val"
    fi
  done <"$file"
}

load_env_file "$ENV_FILE"
# Re-apply isolation paths after env load (env file may set dedicated PID/log/lock dirs).
LOG_DIR="${GDC_E2E_LOG_DIR:-$LOG_DIR}"
PID_DIR="${GDC_E2E_PID_DIR:-$PID_DIR}"
# Resolve relative paths against repo root (env files use e2e/reports/...).
[[ "$LOG_DIR" = /* ]] || LOG_DIR="$ROOT/$LOG_DIR"
[[ "$PID_DIR" = /* ]] || PID_DIR="$ROOT/$PID_DIR"
export GDC_E2E_LOG_DIR="$LOG_DIR"
export GDC_E2E_PID_DIR="$PID_DIR"
export GDC_E2E_API_PORT="${GDC_E2E_API_PORT:-18000}"
export GDC_E2E_API_WORKERS="${GDC_E2E_API_WORKERS:-2}"
export COMPOSE_PROFILES="${COMPOSE_PROFILES:-e2e}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-gdc-full-e2e-lab}"
export GDC_TEST_CONTAINER_PREFIX="${GDC_TEST_CONTAINER_PREFIX:-gdc}"
export GDC_ROUTE_PROCESSING_ENABLED
export REQUIRE_AUTH="${REQUIRE_AUTH:-false}"
export DATABASE_URL
export TEST_DATABASE_URL
export WIREMOCK_BASE_URL
export PLAYWRIGHT_API_BASE_URL="${PLAYWRIGHT_API_BASE_URL:-http://127.0.0.1:${GDC_E2E_API_PORT:-18000}}"
export PLAYWRIGHT_BASE_URL="${PLAYWRIGHT_BASE_URL:-http://127.0.0.1:${GDC_E2E_UI_PORT:-4173}}"
export GDC_E2E_WEBHOOK_COLLECTOR_URL
export GDC_E2E_SYSLOG_COLLECTOR_API_URL
export GDC_E2E_NAME_PREFIX
export GDC_STREAM_RUN_LOCK_DIR="${GDC_STREAM_RUN_LOCK_DIR:-}"
export PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}"

mkdir -p "$LOG_DIR" "$PID_DIR" "$ROOT/e2e/reports/$RUN_ID"
if [[ -n "$GDC_STREAM_RUN_LOCK_DIR" ]]; then
  mkdir -p "$GDC_STREAM_RUN_LOCK_DIR"
fi

compose() {
  docker compose -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

wait_http() {
  local url="$1" name="$2" tries="${3:-60}"
  for i in $(seq 1 "$tries"); do
    if curl -sf "$url" >/dev/null 2>&1; then
      echo "    OK $name ($url)"
      return 0
    fi
    sleep 1
  done
  echo "ERROR: timeout waiting for $name at $url" >&2
  return 1
}

print_matrix_summary() {
  local summary="$ROOT/e2e/reports/$RUN_ID/final/matrix-summary.json"
  if [[ ! -f "$summary" ]]; then
    summary="$ROOT/e2e/reports/$RUN_ID/matrix-summary.json"
  fi
  if [[ -f "$summary" ]]; then
    python3 - "$summary" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
bs = s.get("by_status") or {}
print("==> Matrix counts")
print(f"Total:              {s.get('total_generated') or s.get('scenario_counts',{}).get('total','?')}")
print(f"Executed:           {s.get('executed', '?')}")
print(f"PASS:               {bs.get('PASS', 0)}")
print(f"FAIL:               {bs.get('FAIL', 0)}")
print(f"BLOCKED:            {bs.get('BLOCKED', 0)}")
print(f"KNOWN_PRODUCT_GAP:  {bs.get('KNOWN_PRODUCT_GAP', 0)}")
print(f"NOT_IMPLEMENTED:    {bs.get('NOT_IMPLEMENTED', 0)}")
print(f"NOT_APPLICABLE:     {bs.get('NOT_APPLICABLE', 0)}")
print(f"Missing:            {s.get('missing', s.get('missing_executed_scenarios', '?'))}")
PY
  fi
}

cmd_up() {
  echo "==> [up] Full E2E Lab (route-processing=$ROUTE_MODE project=$COMPOSE_PROJECT_NAME prefix=$GDC_TEST_CONTAINER_PREFIX)"
  echo "    run_id=$RUN_ID env=$ENV_FILE api_port=${GDC_E2E_API_PORT:-18000}"

  # Prefer compose; if containers already exist under another compose project
  # (same GDC_TEST_CONTAINER_PREFIX names), reuse them instead of failing.
  set +e
  compose up -d --build \
    postgres-test wiremock-test \
    webhook-receiver-test syslog-test \
    minio-test postgres-query-test sftp-test \
    webhook-collector syslog-collector
  local up_ec=$?
  set -e
  if [[ $up_ec -ne 0 ]]; then
    echo "WARN: compose up returned $up_ec — ensuring required containers are running"
    for c in \
      "${GDC_TEST_CONTAINER_PREFIX:-gdc}-postgres-test" \
      "${GDC_TEST_CONTAINER_PREFIX:-gdc}-wiremock-test" \
      "${GDC_TEST_CONTAINER_PREFIX:-gdc}-webhook-receiver-test" \
      "${GDC_TEST_CONTAINER_PREFIX:-gdc}-syslog-test" \
      "${GDC_TEST_CONTAINER_PREFIX:-gdc}-minio-test" \
      "${GDC_TEST_CONTAINER_PREFIX:-gdc}-postgres-query-test" \
      "${GDC_TEST_CONTAINER_PREFIX:-gdc}-sftp-test" \
      "${GDC_TEST_CONTAINER_PREFIX:-gdc}-webhook-collector" \
      "${GDC_TEST_CONTAINER_PREFIX:-gdc}-syslog-collector"
    do
      if docker inspect "$c" >/dev/null 2>&1; then
        docker start "$c" >/dev/null 2>&1 || true
        echo "    reused $c"
      else
        echo "WARN: missing container $c" >&2
      fi
    done
    # Still try to build/start collectors under this project if names are free
    compose up -d --build webhook-collector syslog-collector 2>/dev/null || true
  fi

  wait_http "$WIREMOCK_BASE_URL/__admin/mappings" "WireMock" 60
  wait_http "${GDC_E2E_WEBHOOK_COLLECTOR_URL}/health" "Webhook collector" 40
  wait_http "${GDC_E2E_SYSLOG_COLLECTOR_API_URL}/health" "Syslog collector" 40

  # Wait postgres-test (optional if only fixture DB is used)
  for i in $(seq 1 60); do
    if compose ps postgres-test 2>/dev/null | grep -q healthy; then
      break
    fi
    if docker ps --format '{{.Names}}' | grep -q "${GDC_TEST_CONTAINER_PREFIX:-gdc}-postgres-test"; then
      break
    fi
    sleep 1
  done

  echo "==> [up] Alembic upgrade (lab DB)"
  (
    cd "$ROOT"
    alembic upgrade head
  ) >"$LOG_DIR/alembic_$RUN_ID.log" 2>&1

  # Ensure browser UI can sign in with the first-install default (admin/admin).
  # API may run with REQUIRE_AUTH=false, but the SPA still gates on platform login.
  echo "==> [up] Ensure platform admin for UI login"
  (
    cd "$ROOT"
    unset GDC_SEED_ADMIN_PASSWORD || true
    python3 -m app.db.seed --platform-admin-only --reset-platform-admin-password
    # Lab browser E2E uses admin/admin without an interactive password-change gate.
    python3 - <<'PY'
from sqlalchemy import text
from app.database import SessionLocal
db = SessionLocal()
try:
    db.execute(text("UPDATE platform_users SET must_change_password = false WHERE username = 'admin'"))
    db.commit()
finally:
    db.close()
PY
  ) >"$LOG_DIR/admin_seed_$RUN_ID.log" 2>&1 || echo "WARN: platform admin seed failed (browser UI login may fail)"

  echo "==> [up] Starting API (GDC_ROUTE_PROCESSING_ENABLED=$GDC_ROUTE_PROCESSING_ENABLED)"
  local want_flag="${GDC_ROUTE_PROCESSING_ENABLED:-false}"
  local have_flag=""
  local api_running=0
  local api_workers="${GDC_E2E_API_WORKERS:-2}"
  if [[ -f "$PID_DIR/api.pid" ]] && kill -0 "$(cat "$PID_DIR/api.pid")" 2>/dev/null; then
    api_running=1
  fi
  if [[ -f "$PID_DIR/api-route-flag.txt" ]]; then
    have_flag="$(tr -d '[:space:]' <"$PID_DIR/api-route-flag.txt")"
  fi
  # Restart when route flag changes so triage/scenario can flip route-off ↔ route-on.
  if [[ $api_running -eq 1 && "$have_flag" == "$want_flag" && "${GDC_E2E_FORCE_API_RESTART:-0}" != "1" ]]; then
    echo "    API already running pid=$(cat "$PID_DIR/api.pid") flag=$have_flag"
  else
    if [[ $api_running -eq 1 ]]; then
      echo "    Restarting API (flag $have_flag -> $want_flag)"
      kill "$(cat "$PID_DIR/api.pid")" 2>/dev/null || true
      sleep 1
      fuser -k "${GDC_E2E_API_PORT:-18000}/tcp" 2>/dev/null || true
      sleep 1
    fi
    (
      cd "$ROOT"
      # Isolate stream scheduling from HTTP workers (prevents POST /connectors starvation).
      export GDC_ENABLE_IN_PROCESS_SCHEDULER=false
      nohup python3 -m uvicorn app.main:app \
        --host 127.0.0.1 --port "${GDC_E2E_API_PORT:-8000}" \
        --workers "$api_workers" \
        >"$LOG_DIR/api_$RUN_ID.log" 2>&1 &
      echo $! >"$PID_DIR/api.pid"
    )
    echo "$want_flag" >"$PID_DIR/api-route-flag.txt"
  fi
  wait_http "http://127.0.0.1:${GDC_E2E_API_PORT:-8000}/health" "API" 60
  echo "$want_flag" >"$PID_DIR/api-route-flag.txt"

  echo "==> [up] Starting lab standalone scheduler (GDC_ENABLE_IN_PROCESS_SCHEDULER=false)"
  if [[ -f "$PID_DIR/lab-scheduler.pid" ]] && kill -0 "$(cat "$PID_DIR/lab-scheduler.pid")" 2>/dev/null; then
    echo "    lab scheduler already running pid=$(cat "$PID_DIR/lab-scheduler.pid")"
  else
    (
      cd "$ROOT"
      export GDC_ENABLE_IN_PROCESS_SCHEDULER=false
      nohup python3 -m app.scheduler.standalone \
        >"$LOG_DIR/lab_scheduler_$RUN_ID.log" 2>&1 &
      echo $! >"$PID_DIR/lab-scheduler.pid"
    )
    sleep 2
    if kill -0 "$(cat "$PID_DIR/lab-scheduler.pid")" 2>/dev/null; then
      echo "    lab scheduler pid=$(cat "$PID_DIR/lab-scheduler.pid")"
    else
      echo "WARN: lab scheduler failed to start; see $LOG_DIR/lab_scheduler_$RUN_ID.log"
    fi
  fi

  # Lightweight static UI for Playwright baseURL (optional; smoke is API-driven).
  # Preview proxies /api → lab API; must match GDC_E2E_API_PORT or browser Save Connector fails.
  local ui_proxy_want="http://127.0.0.1:${GDC_E2E_API_PORT:-18000}"
  local ui_proxy_have=""
  local ui_running=0
  if [[ -f "$PID_DIR/ui.pid" ]] && kill -0 "$(cat "$PID_DIR/ui.pid")" 2>/dev/null; then
    ui_running=1
  fi
  if [[ -f "$PID_DIR/ui-api-proxy.txt" ]]; then
    ui_proxy_have="$(tr -d '[:space:]' <"$PID_DIR/ui-api-proxy.txt")"
  fi
  if [[ $ui_running -eq 1 && "$ui_proxy_have" == "$ui_proxy_want" && "${GDC_E2E_FORCE_UI_RESTART:-0}" != "1" ]]; then
    echo "    UI already running pid=$(cat "$PID_DIR/ui.pid") proxy=$ui_proxy_have"
  else
    if [[ $ui_running -eq 1 ]]; then
      echo "    Restarting UI (proxy $ui_proxy_have -> $ui_proxy_want)"
      kill "$(cat "$PID_DIR/ui.pid")" 2>/dev/null || true
      sleep 1
      fuser -k "${GDC_E2E_UI_PORT:-4173}/tcp" 2>/dev/null || true
      sleep 1
    fi
    (
      cd "$ROOT/frontend"
      if [[ ! -d dist ]] || [[ "${GDC_E2E_FORCE_UI_BUILD:-0}" == "1" ]]; then
        npm run build >"$LOG_DIR/ui_build_$RUN_ID.log" 2>&1 || true
      fi
      export VITE_DEV_API_PROXY_TARGET="$ui_proxy_want"
      nohup npx --yes vite preview --host 127.0.0.1 --port "${GDC_E2E_UI_PORT:-4173}" \
        >"$LOG_DIR/ui_$RUN_ID.log" 2>&1 &
      echo $! >"$PID_DIR/ui.pid"
    )
    echo "$ui_proxy_want" >"$PID_DIR/ui-api-proxy.txt"
  fi
  wait_http "http://127.0.0.1:${GDC_E2E_UI_PORT:-4173}/" "UI" 40 || echo "WARN: UI preview not ready (API smoke still runs)"

  echo "$GDC_ROUTE_PROCESSING_ENABLED" >"$ROOT/e2e/reports/$RUN_ID/route-flag-used.txt"
  echo "==> [up] ready"
}

cmd_reset() {
  echo "==> [reset] fixtures"
  "$LAB_DIR/reset-fixtures.sh"
}

cmd_test() {
  echo "==> [test] Playwright smoke (route=$ROUTE_MODE run_id=$RUN_ID)"
  local ec=0
  (
    cd "$ROOT/e2e"
    if [[ ! -d node_modules/@playwright/test ]]; then
      npm install --no-fund --no-audit
    fi
    npx playwright test -c playwright.config.ts --project=smoke
  ) || ec=$?
  echo "$ec" >"$ROOT/e2e/reports/$RUN_ID/playwright-exit-code.txt"
  return "$ec"
}

cmd_matrix() {
  echo "==> [matrix] Playwright full matrix (route=$ROUTE_MODE shard=${GDC_E2E_SHARD:-all} run_id=$RUN_ID)"
  # Shard artifact subdir when running under CI matrix
  if [[ -n "${GDC_E2E_SHARD:-}" ]]; then
    export GDC_E2E_SHARD_ARTIFACT_DIR="${GDC_E2E_SHARD_ARTIFACT_DIR:-${GDC_E2E_SHARD}-${ROUTE_MODE}}"
  fi
  local ec=0
  (
    cd "$ROOT/e2e"
    if [[ ! -d node_modules/@playwright/test ]]; then
      npm install --no-fund --no-audit
    fi
    npx tsx scenarios/generate-full-matrix.ts
    npx tsx scenarios/validate-scenario-coverage.ts
    npx playwright test -c playwright.config.ts --project=matrix
  ) || ec=$?
  (
    cd "$ROOT/e2e"
    GDC_E2E_RUN_ID="$RUN_ID" npx tsx framework/build-coverage-report.ts "$RUN_ID" || true
  )
  echo "$ec" >"$ROOT/e2e/reports/$RUN_ID/matrix-exit-code.txt"
  return "$ec"
}

cmd_scenario() {
  [[ -n "$SCENARIO_ID" ]] || { echo "Usage: $0 scenario --id <scenario-id> --route-processing=off|on" >&2; exit 2; }
  echo "==> [scenario] id=$SCENARIO_ID route=$ROUTE_MODE run_id=$RUN_ID"
  export GDC_E2E_SCENARIO_IDS="$SCENARIO_ID"
  # Ensure lab is healthy, reset fixtures, run only the selected scenario.
  cmd_up
  cmd_reset
  local ec=0
  trap 'ec=130; post_run_evidence_and_cleanup "$ec"; exit 130' INT TERM
  (
    cd "$ROOT/e2e"
    if [[ ! -d node_modules/@playwright/test ]]; then
      npm install --no-fund --no-audit
    fi
    # Keep matrix generation for id resolution, but skip full coverage gate for single-id runs.
    npx tsx scenarios/generate-full-matrix.ts
    npx playwright test -c playwright.config.ts --project=matrix
  ) || ec=$?
  trap - INT TERM
  post_run_evidence_and_cleanup "$ec" || true
  echo "$ec" >"$ROOT/e2e/reports/$RUN_ID/scenario-exit-code.txt"
  echo "==> [scenario] finished exit=$ec id=$SCENARIO_ID route=$ROUTE_MODE run_id=$RUN_ID"
  return "$ec"
}

cmd_triage() {
  echo "==> [triage] Phase 3.2 failure triage run_id=$RUN_ID"
  (
    cd "$ROOT/e2e"
    if [[ ! -d node_modules ]]; then
      npm install --no-fund --no-audit
    fi
    npx tsx framework/run-failure-triage.ts --run-id "$RUN_ID"
  )
}

cmd_collect() {
  echo "==> [collect] evidence + service logs"
  local out="$ROOT/e2e/reports/$RUN_ID/service-logs"
  if [[ -n "${GDC_E2E_SHARD_ARTIFACT_DIR:-}" ]]; then
    out="$ROOT/e2e/reports/$RUN_ID/${GDC_E2E_SHARD_ARTIFACT_DIR}/service-logs"
  fi
  mkdir -p "$out"
  compose logs --no-color --tail=400 \
    wiremock-test webhook-collector syslog-collector postgres-query-test minio-test sftp-test \
    >"$out/compose-services.log" 2>&1 || true
  if [[ -f "$LOG_DIR/api_$RUN_ID.log" ]]; then
    cp "$LOG_DIR/api_$RUN_ID.log" "$out/api.log" || true
  fi
  if [[ -f "$LOG_DIR/ui_$RUN_ID.log" ]]; then
    cp "$LOG_DIR/ui_$RUN_ID.log" "$out/ui.log" || true
  fi
  # Snapshot collector counts
  curl -sf "${GDC_E2E_WEBHOOK_COLLECTOR_URL}/count" >"$ROOT/e2e/reports/$RUN_ID/webhook-count.json" || true
  curl -sf "${GDC_E2E_SYSLOG_COLLECTOR_API_URL}/count" >"$ROOT/e2e/reports/$RUN_ID/syslog-count.json" || true
  echo "    collected under e2e/reports/$RUN_ID"
}

cmd_cleanup() {
  echo "==> [cleanup] registered Full E2E resources run_id=$RUN_ID"
  (
    cd "$ROOT/e2e"
    if [[ ! -d node_modules ]]; then
      npm install --no-fund --no-audit
    fi
    npx tsx framework/cleanup-cli.ts cleanup --run-id "$RUN_ID"
  )
}

cmd_cleanup_stale() {
  echo "==> [cleanup-stale] registry-owned resources only"
  (
    cd "$ROOT/e2e"
    if [[ ! -d node_modules ]]; then
      npm install --no-fund --no-audit
    fi
    # Inventory evidence-correlated leftovers into a registry, then cleanup owned runs.
    npx tsx framework/cleanup-cli.ts inventory-owned --write-run-id "stale-owned-${RUN_ID}"
    npx tsx framework/cleanup-cli.ts cleanup-stale
  )
}

cmd_validate_cleanup() {
  echo "==> [validate-cleanup] run_id=$RUN_ID"
  (
    cd "$ROOT/e2e"
    if [[ ! -d node_modules ]]; then
      npm install --no-fund --no-audit
    fi
    npx tsx framework/cleanup-cli.ts validate-cleanup --run-id "$RUN_ID"
  )
}

# Evidence → cleanup → validate. Never masks the original test exit code.
post_run_evidence_and_cleanup() {
  local test_ec="${1:-0}"
  set +e
  cmd_collect
  cmd_cleanup
  local cleanup_ec=$?
  cmd_validate_cleanup
  local validate_ec=$?
  set -e
  echo "==> post-run: test_ec=$test_ec cleanup_ec=$cleanup_ec validate_ec=$validate_ec"
  # Preserve test failure; cleanup/validate failures are reported but do not upgrade PASS.
  if [[ "$test_ec" -ne 0 ]]; then
    return "$test_ec"
  fi
  if [[ "$cleanup_ec" -ne 0 || "$validate_ec" -ne 0 ]]; then
    echo "WARN: cleanup/validate reported issues (test was PASS)" >&2
    return 1
  fi
  return 0
}

cmd_down() {
  echo "==> [down] stopping lab API/UI + compose"
  # Clear any active fault injections first
  if [[ -x "$FAULT_SCRIPT" ]]; then
    GDC_E2E_ENV_FILE="$ENV_FILE" "$FAULT_SCRIPT" reset >/dev/null 2>&1 || true
  fi
  if [[ -f "$PID_DIR/api.pid" ]]; then
    kill "$(cat "$PID_DIR/api.pid")" 2>/dev/null || true
    rm -f "$PID_DIR/api.pid"
  fi
  if [[ -f "$PID_DIR/lab-scheduler.pid" ]]; then
    kill "$(cat "$PID_DIR/lab-scheduler.pid")" 2>/dev/null || true
    rm -f "$PID_DIR/lab-scheduler.pid"
  fi
  if [[ -f "$PID_DIR/ui.pid" ]]; then
    kill "$(cat "$PID_DIR/ui.pid")" 2>/dev/null || true
    rm -f "$PID_DIR/ui.pid"
  fi
  # Stop collectors + fixtures for this project (keep volumes by default)
  compose stop webhook-collector syslog-collector \
    wiremock-test webhook-receiver-test syslog-test \
    minio-test postgres-query-test sftp-test postgres-test \
    2>/dev/null || true
  if [[ "${GDC_E2E_DOWN_WITH_VOLUMES:-0}" == "1" ]]; then
    compose down -v || true
  fi
  echo "==> [down] done"
}

cmd_all() {
  local ec=0
  cmd_up
  cmd_reset
  trap 'ec=130; post_run_evidence_and_cleanup "$ec"; [[ "${GDC_E2E_KEEP_UP:-0}" != "1" ]] && cmd_down; exit 130' INT TERM
  set +e
  cmd_test
  ec=$?
  set -e
  trap - INT TERM
  post_run_evidence_and_cleanup "$ec" || true
  if [[ "${GDC_E2E_KEEP_UP:-0}" != "1" ]]; then
    cmd_down
  fi
  echo "==> [all] finished exit=$ec route=$ROUTE_MODE run_id=$RUN_ID"
  return "$ec"
}

cmd_all_matrix() {
  local ec=0
  cmd_up
  cmd_reset
  trap 'ec=130; post_run_evidence_and_cleanup "$ec"; [[ "${GDC_E2E_KEEP_UP:-0}" != "1" ]] && cmd_down; exit 130' INT TERM
  set +e
  cmd_matrix
  ec=$?
  set -e
  trap - INT TERM
  post_run_evidence_and_cleanup "$ec" || true
  # Merge + summarize this run (single shard or full local)
  set +e
  cmd_merge_results
  set -e
  print_matrix_summary
  if [[ "${GDC_E2E_KEEP_UP:-0}" != "1" ]]; then
    cmd_down
  fi
  echo "==> [all-matrix] finished exit=$ec route=$ROUTE_MODE shard=${GDC_E2E_SHARD:-all} run_id=$RUN_ID"
  return "$ec"
}

cmd_fault() {
  chmod +x "$FAULT_SCRIPT"
  export GDC_E2E_ENV_FILE="$ENV_FILE"
  case "$FAULT_ACTION" in
    start|stop|status)
      [[ -n "$FAULT_TARGET" ]] || { echo "Usage: $0 fault $FAULT_ACTION <target>" >&2; exit 2; }
      "$FAULT_SCRIPT" "$FAULT_ACTION" "$FAULT_TARGET"
      ;;
    reset)
      "$FAULT_SCRIPT" reset
      ;;
    *)
      echo "Usage: $0 fault {start|stop|reset|status} [target]" >&2
      echo "Targets: database s3 sftp api runtime webhook syslog syslog-tls" >&2
      exit 2
      ;;
  esac
}

cmd_merge_results() {
  echo "==> [merge-results] run_id=$RUN_ID"
  (
    cd "$ROOT/e2e"
    if [[ ! -d node_modules ]]; then
      npm install --no-fund --no-audit
    fi
    local args=(--run-id "$RUN_ID")
    if [[ -n "${MERGE_FROM:-}" ]]; then
      args+=(--from "$MERGE_FROM")
    fi
    npx tsx framework/merge-matrix-results.ts "${args[@]}"
  )
  print_matrix_summary
}

cmd_validate_results() {
  echo "==> [validate-results] run_id=$RUN_ID"
  (
    cd "$ROOT/e2e"
    if [[ ! -d node_modules ]]; then
      npm install --no-fund --no-audit
    fi
    # Ensure merged results exist
    if [[ ! -f "$ROOT/e2e/reports/$RUN_ID/final/scenario-results.json" ]]; then
      npx tsx framework/merge-matrix-results.ts --run-id "$RUN_ID"
    fi
    npx tsx scenarios/validate-execution-results.ts --run-id "$RUN_ID"
  )
}

cmd_release_gate() {
  echo "==> [release-gate] action=${RG_ACTION:-?} run_id=${GDC_E2E_RUN_ID:-$RUN_ID}"
  (
    cd "$ROOT/e2e"
    if [[ ! -d node_modules ]]; then
      npm install --no-fund --no-audit
    fi
    case "${RG_ACTION}" in
      evaluate|validate-evidence|compare-baseline|rc|detect-shards|flake|checksums|build-baseline|write-metadata)
        npx tsx release-gate/cli.ts "$RG_ACTION" "${RG_ARGS[@]}"
        ;;
      *)
        echo "Usage: $0 release-gate {evaluate|validate-evidence|compare-baseline|rc|detect-shards|flake|checksums|build-baseline|write-metadata} [args...]" >&2
        exit 2
        ;;
    esac
  )
}

cmd_generate_cross_product() {
  (cd "$ROOT/e2e" && npm run generate-cross-product)
}

cmd_validate_cross_product() {
  (cd "$ROOT/e2e" && npm run validate-cross-product)
}

cmd_run_cross_product() {
  (cd "$ROOT/e2e" && npm run plan-cross-product-shards && npm run run-cross-product)
}

cmd_run_cross_product_shard() {
  local shard="${GDC_XP_SHARD:-}"
  if [[ -z "$shard" ]]; then
    echo "GDC_XP_SHARD is required for run-cross-product-shard" >&2
    exit 2
  fi
  (cd "$ROOT/e2e" && GDC_XP_SHARD="$shard" npm run run-cross-product-shard)
}

cmd_merge_cross_product_results() {
  (cd "$ROOT/e2e" && npm run merge-cross-product-results -- --from="$ROOT/e2e/reports")
}

cmd_validate_cross_product_results() {
  local results="${GDC_XP_RESULTS:-$ROOT/e2e/reports/final/cross-product-results.jsonl}"
  (cd "$ROOT/e2e" && npm run validate-cross-product-results -- --results="$results")
}

cmd_cleanup_cross_product() {
  (cd "$ROOT/e2e" && npm run cleanup-cross-product -- --run-id "${GDC_E2E_RUN_ID}")
}

cmd_report_cross_product() {
  (cd "$ROOT/e2e" && npm run report-cross-product)
}

cmd_continuous() {
  (cd "$ROOT/e2e" && npx tsx continuous/cli.ts "${CONTINUOUS_ARGS[@]}")
}

cmd_fault_toxi() {
  bash "$LAB_DIR/fault-toxiproxy.sh" "${TOXI_ARGS[@]}"
}

case "$CMD" in
  up) cmd_up ;;
  reset) cmd_reset ;;
  test) cmd_test ;;
  matrix) cmd_matrix ;;
  scenario) cmd_scenario ;;
  triage) cmd_triage ;;
  collect) cmd_collect ;;
  cleanup) cmd_cleanup ;;
  cleanup-stale) cmd_cleanup_stale ;;
  validate-cleanup) cmd_validate_cleanup ;;
  down) cmd_down ;;
  all) cmd_all ;;
  all-matrix) cmd_all_matrix ;;
  fault) cmd_fault ;;
  fault-toxi) cmd_fault_toxi ;;
  continuous) cmd_continuous ;;
  merge-results) cmd_merge_results ;;
  validate-results) cmd_validate_results ;;
  release-gate) cmd_release_gate ;;
  generate-cross-product) cmd_generate_cross_product ;;
  validate-cross-product) cmd_validate_cross_product ;;
  run-cross-product) cmd_run_cross_product ;;
  run-cross-product-shard) cmd_run_cross_product_shard ;;
  merge-cross-product-results) cmd_merge_cross_product_results ;;
  validate-cross-product-results) cmd_validate_cross_product_results ;;
  cleanup-cross-product) cmd_cleanup_cross_product ;;
  report-cross-product) cmd_report_cross_product ;;
  *)
    cat <<EOF
Usage: $0 {up|reset|test|matrix|scenario|triage|collect|cleanup|cleanup-stale|validate-cleanup|down|all|all-matrix|fault|fault-toxi|continuous|merge-results|validate-results|release-gate|generate-cross-product|validate-cross-product|run-cross-product|run-cross-product-shard|merge-cross-product-results|validate-cross-product-results|cleanup-cross-product|report-cross-product} [options]

  scenario --id <scenario-id> --route-processing=off|on
  triage
  all-matrix --route-processing=off|on [--lab-profile oss-v1]
  cleanup --run-id <id>
  cleanup-stale
  validate-cleanup --run-id <id>
  continuous {validate|tick|report|ensure|teardown}
  fault start|stop|reset|status <target>
  fault-toxi start latency|timeout|reset|bandwidth <target> [args]
  fault-toxi stop|status <target>
  fault-toxi reset
  merge-results [--from <dir>]
  validate-results
  release-gate evaluate --run-id <id>
  release-gate validate-evidence --commit <sha> --run-id <id>
  release-gate compare-baseline
  release-gate rc --run-id <a> --run-id <b>
  generate-cross-product
  validate-cross-product
  run-cross-product
  run-cross-product-shard   # requires GDC_XP_SHARD
  merge-cross-product-results
  validate-cross-product-results
  cleanup-cross-product
  report-cross-product

Lab profile (optional isolation):
  --lab-profile oss-v1   uses e2e/lab/.env.oss-v1-route-off|on
  GDC_E2E_LAB_PROFILE / COMPOSE_PROJECT_NAME / GDC_TEST_CONTAINER_PREFIX

Targets: database s3 sftp api runtime webhook syslog syslog-tls
Toxiproxy targets: wiremock postgres minio sftp webhook syslog
EOF
    exit 2
    ;;
esac
