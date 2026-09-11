#!/usr/bin/env bash
# Test-only Toxiproxy fault helper for Continuous / Full E2E Lab.
# Never used by production compose.
#
# Usage:
#   ./e2e/lab/fault-toxiproxy.sh start latency <target> [latency_ms] [jitter_ms]
#   ./e2e/lab/fault-toxiproxy.sh start timeout <target> [timeout_ms]
#   ./e2e/lab/fault-toxiproxy.sh start reset <target>
#   ./e2e/lab/fault-toxiproxy.sh start bandwidth <target> [rate_kb]
#   ./e2e/lab/fault-toxiproxy.sh stop <target>
#   ./e2e/lab/fault-toxiproxy.sh reset
#   ./e2e/lab/fault-toxiproxy.sh status <target>
#
# Targets (proxy names): wiremock | postgres | minio | sftp | webhook | syslog

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LAB_DIR="$ROOT/e2e/lab"
STATE_DIR="${GDC_E2E_FAULT_STATE_DIR:-$ROOT/e2e/reports/.fault-state}/toxiproxy"
TOXIPROXY_API="${GDC_E2E_TOXIPROXY_API:-http://127.0.0.1:28474}"
COMPOSE_FILE="$LAB_DIR/docker-compose.toxiproxy.yml"
ENV_FILE="${GDC_E2E_ENV_FILE:-$LAB_DIR/.env.route-off}"

mkdir -p "$STATE_DIR"

ACTION="${1:-}"
shift || true

api() {
  local method="$1" path="$2"
  shift 2
  curl -sf -X "$method" "${TOXIPROXY_API}${path}" "$@"
}

proxy_listen_port() {
  case "$1" in
    wiremock) echo 28081 ;;
    postgres) echo 55434 ;;
    minio) echo 59002 ;;
    sftp) echo 22223 ;;
    webhook) echo 18194 ;;
    syslog) echo 15615 ;;
    *) return 1 ;;
  esac
}

ensure_proxy() {
  local name="$1"
  if api GET "/proxies/${name}" >/dev/null 2>&1; then
    return 0
  fi
  echo "ERROR: Toxiproxy proxy '${name}' not found. Start lab toxiproxy overlay first:" >&2
  echo "  docker compose -f e2e/lab/docker-compose.full-e2e.yml -f e2e/lab/docker-compose.toxiproxy.yml --env-file e2e/lab/.env.route-off --profile e2e up -d toxiproxy" >&2
  return 1
}

clear_toxics() {
  local name="$1"
  local toxics
  toxics="$(api GET "/proxies/${name}/toxics" 2>/dev/null || echo '[]')"
  python3 - "$toxics" <<'PY' | while read -r toxic; do
import json,sys
for t in json.loads(sys.argv[1] or "[]"):
    print(t.get("name",""))
PY
    [[ -n "$toxic" ]] || continue
    api DELETE "/proxies/${name}/toxics/${toxic}" -H 'Content-Type: application/json' >/dev/null || true
  done
  rm -f "$STATE_DIR/${name}.active" "$STATE_DIR/${name}.json"
}

add_toxic() {
  local name="$1" type="$2" body="$3"
  ensure_proxy "$name"
  clear_toxics "$name"
  api POST "/proxies/${name}/toxics" -H 'Content-Type: application/json' -d "$body" >/dev/null
  echo "active" >"$STATE_DIR/${name}.active"
  echo "$body" >"$STATE_DIR/${name}.json"
  echo "toxiproxy $type applied on $name"
}

cmd_start() {
  local toxic="${1:-}"
  local target="${2:-}"
  local a="${3:-}"
  local b="${4:-}"
  [[ -n "$toxic" && -n "$target" ]] || {
    echo "Usage: $0 start {latency|timeout|reset|bandwidth} <target> [args]" >&2
    exit 2
  }
  case "$toxic" in
    latency)
      local latency_ms="${a:-2000}"
      local jitter_ms="${b:-0}"
      add_toxic "$target" latency "{\"name\":\"latency\",\"type\":\"latency\",\"stream\":\"downstream\",\"toxicity\":1.0,\"attributes\":{\"latency\":${latency_ms},\"jitter\":${jitter_ms}}}"
      ;;
    timeout)
      local timeout_ms="${a:-1}"
      add_toxic "$target" timeout "{\"name\":\"timeout\",\"type\":\"timeout\",\"stream\":\"downstream\",\"toxicity\":1.0,\"attributes\":{\"timeout\":${timeout_ms}}}"
      ;;
    reset)
      add_toxic "$target" reset '{"name":"reset_peer","type":"reset_peer","stream":"downstream","toxicity":1.0,"attributes":{"timeout":0}}'
      ;;
    bandwidth)
      local rate_kb="${a:-10}"
      add_toxic "$target" bandwidth "{\"name\":\"bandwidth\",\"type\":\"bandwidth\",\"stream\":\"downstream\",\"toxicity\":1.0,\"attributes\":{\"rate\":${rate_kb}}}"
      ;;
    *)
      echo "Unknown toxic: $toxic" >&2
      exit 2
      ;;
  esac
}

cmd_stop() {
  local target="${1:-}"
  [[ -n "$target" ]] || { echo "Usage: $0 stop <target>" >&2; exit 2; }
  if api GET "/proxies/${target}" >/dev/null 2>&1; then
    clear_toxics "$target"
  fi
  echo "toxiproxy stopped on $target"
}

cmd_reset() {
  for t in wiremock postgres minio sftp webhook syslog; do
    if api GET "/proxies/${t}" >/dev/null 2>&1; then
      clear_toxics "$t" || true
    fi
  done
  rm -f "$STATE_DIR"/*.active "$STATE_DIR"/*.json 2>/dev/null || true
  echo "toxiproxy reset done"
}

cmd_status() {
  local target="${1:-}"
  [[ -n "$target" ]] || { echo "Usage: $0 status <target>" >&2; exit 2; }
  if [[ -f "$STATE_DIR/${target}.active" ]]; then
    echo "active"
  else
    echo "inactive"
  fi
}

case "$ACTION" in
  start) cmd_start "$@" ;;
  stop) cmd_stop "$@" ;;
  reset) cmd_reset ;;
  status) cmd_status "$@" ;;
  *)
    cat <<EOF
Usage: $0 {start|stop|reset|status} ...
Toxiproxy API: $TOXIPROXY_API
Compose overlay: $COMPOSE_FILE
EOF
    exit 2
    ;;
esac
