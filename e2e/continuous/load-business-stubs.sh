#!/usr/bin/env bash
# Load Continuous business HTTP stubs into a running WireMock (test-only).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WM="${WIREMOCK_BASE_URL:-http://127.0.0.1:28080}"
MAP_DIR="$ROOT/e2e/lab/fixtures/http/mappings"
shopt -s nullglob

post_map() {
  local f="$1"
  local id
  id="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('id',''))" "$f" 2>/dev/null || true)"
  if [[ -n "$id" ]]; then
    curl -sS -X DELETE "$WM/__admin/mappings/$id" >/dev/null 2>&1 || true
  fi
  local code
  code="$(curl -sS -o /tmp/wm-post.json -w '%{http_code}' -X POST "$WM/__admin/mappings" -H 'Content-Type: application/json' --data-binary @"$f" || true)"
  echo "posted $(basename "$f") -> $code"
}

# Business data stubs used by continuous HTTP streams
for f in "$MAP_DIR"/business-*.json; do
  post_map "$f"
done

# Auth stubs required by continuous streams (oauth2 CC + session login WireMock)
for f in \
  "$MAP_DIR"/oauth2-token.json \
  "$MAP_DIR"/oauth2-events.json \
  "$MAP_DIR"/session-login.json \
  "$MAP_DIR"/session-events.json \
  "$MAP_DIR"/bearer-events.json \
  "$MAP_DIR"/basic-events.json \
  "$MAP_DIR"/api-key-header-events.json \
  "$MAP_DIR"/jwt-refresh-token.json \
  "$MAP_DIR"/jwt-refresh-events.json \
  "$MAP_DIR"/vendor-token.json \
  "$MAP_DIR"/vendor-events.json
do
  [[ -f "$f" ]] || continue
  post_map "$f"
done

curl -sf "$WM/business/crm/contacts" >/dev/null
echo "business stubs ready"
