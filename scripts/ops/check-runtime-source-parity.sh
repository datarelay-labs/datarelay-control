#!/usr/bin/env bash
# Prove API and Scheduler containers execute the same application source lineage.
# Compares running container image IDs and in-container identity — not Compose YAML alone.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

API_NAME="${GDC_API_CONTAINER:-gdc-platform-api}"
SCHEDULER_NAME="${GDC_SCHEDULER_CONTAINER:-gdc-platform-scheduler}"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

require_running() {
  local name="$1"
  docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null | grep -qx true \
    || die "container not running: $name"
}

image_id() {
  local name="$1"
  docker inspect -f '{{.Image}}' "$name"
}

digest_in() {
  local name="$1"
  docker exec -i "$name" python - <<'PY'
from app.build_identity import load_build_identity
import hashlib
from pathlib import Path
import os

ident = load_build_identity()
print(f"git_sha:{ident.get('git_sha')}")
print(f"git_dirty:{ident.get('git_dirty')}")
print(f"source_digest:{ident.get('source_digest')}")
print(f"live_source_digest:{ident.get('live_source_digest')}")
print(f"built_at:{ident.get('built_at')}")
print(f"route_processing_canonical:{ident.get('route_processing_canonical')}")
for rel in ("app/config.py", "app/runners/stream_runner.py"):
    data = Path(rel).read_bytes()
    print(f"{rel}:{hashlib.sha256(data).hexdigest()}")
from app.config import settings
print(f"route_processing_enabled:{bool(settings.GDC_ROUTE_PROCESSING_ENABLED)}")
env_flag = (os.environ.get("GDC_ROUTE_PROCESSING_ENABLED") or "").strip().lower()
print(f"route_processing_env:{env_flag or '<unset>'}")
PY
}

field_from() {
  local blob="$1"
  local key="$2"
  echo "$blob" | awk -F: -v k="$key" '$1==k {print substr($0, index($0,$2))}'
}

require_running "$API_NAME"
require_running "$SCHEDULER_NAME"

API_IMAGE_ID="$(image_id "$API_NAME")"
SCH_IMAGE_ID="$(image_id "$SCHEDULER_NAME")"

echo "=== Container image IDs ==="
echo "API_IMAGE_ID=$API_IMAGE_ID"
echo "SCHEDULER_IMAGE_ID=$SCH_IMAGE_ID"

API_OUT="$(digest_in "$API_NAME")"
SCH_OUT="$(digest_in "$SCHEDULER_NAME")"

echo "=== API identity ==="
echo "$API_OUT"
echo "=== Scheduler identity ==="
echo "$SCH_OUT"

API_SCHEDULER_IMAGE_PARITY=FAIL
API_SCHEDULER_GIT_SHA_PARITY=FAIL
API_SCHEDULER_SOURCE_DIGEST_PARITY=FAIL
API_SCHEDULER_CONFIG_PARITY=FAIL
API_SCHEDULER_STREAM_RUNNER_PARITY=FAIL
API_SCHEDULER_ROUTE_CONFIG_PARITY=FAIL

if [[ "$API_IMAGE_ID" == "$SCH_IMAGE_ID" ]]; then
  API_SCHEDULER_IMAGE_PARITY=PASS
else
  echo "ERROR: API and Scheduler Image IDs differ" >&2
fi

API_GIT="$(field_from "$API_OUT" git_sha)"
SCH_GIT="$(field_from "$SCH_OUT" git_sha)"
API_DIGEST="$(field_from "$API_OUT" source_digest)"
SCH_DIGEST="$(field_from "$SCH_OUT" source_digest)"
API_CFG="$(field_from "$API_OUT" app/config.py)"
SCH_CFG="$(field_from "$SCH_OUT" app/config.py)"
API_SR="$(field_from "$API_OUT" app/runners/stream_runner.py)"
SCH_SR="$(field_from "$SCH_OUT" app/runners/stream_runner.py)"
API_RP="$(field_from "$API_OUT" route_processing_enabled)"
SCH_RP="$(field_from "$SCH_OUT" route_processing_enabled)"
API_RP_ENV="$(field_from "$API_OUT" route_processing_env)"
SCH_RP_ENV="$(field_from "$SCH_OUT" route_processing_env)"

[[ "$API_GIT" == "$SCH_GIT" ]] && API_SCHEDULER_GIT_SHA_PARITY=PASS
[[ "$API_DIGEST" == "$SCH_DIGEST" && -n "$API_DIGEST" && "$API_DIGEST" != "unknown" ]] \
  && API_SCHEDULER_SOURCE_DIGEST_PARITY=PASS
[[ "$API_CFG" == "$SCH_CFG" && -n "$API_CFG" ]] && API_SCHEDULER_CONFIG_PARITY=PASS
[[ "$API_SR" == "$SCH_SR" && -n "$API_SR" ]] && API_SCHEDULER_STREAM_RUNNER_PARITY=PASS
[[ "$API_RP" == "$SCH_RP" && "$API_RP" == "True" && "$API_RP_ENV" == "$SCH_RP_ENV" ]] \
  && API_SCHEDULER_ROUTE_CONFIG_PARITY=PASS

echo "API_SCHEDULER_IMAGE_PARITY=$API_SCHEDULER_IMAGE_PARITY"
echo "API_SCHEDULER_GIT_SHA_PARITY=$API_SCHEDULER_GIT_SHA_PARITY"
echo "API_SCHEDULER_SOURCE_DIGEST_PARITY=$API_SCHEDULER_SOURCE_DIGEST_PARITY"
echo "API_SCHEDULER_CONFIG_PARITY=$API_SCHEDULER_CONFIG_PARITY"
echo "API_SCHEDULER_STREAM_RUNNER_PARITY=$API_SCHEDULER_STREAM_RUNNER_PARITY"
echo "API_SCHEDULER_ROUTE_CONFIG_PARITY=$API_SCHEDULER_ROUTE_CONFIG_PARITY"

FAILED=0
for key in \
  API_SCHEDULER_IMAGE_PARITY \
  API_SCHEDULER_GIT_SHA_PARITY \
  API_SCHEDULER_SOURCE_DIGEST_PARITY \
  API_SCHEDULER_CONFIG_PARITY \
  API_SCHEDULER_STREAM_RUNNER_PARITY \
  API_SCHEDULER_ROUTE_CONFIG_PARITY
do
  val="${!key}"
  if [[ "$val" != "PASS" ]]; then
    echo "ERROR: $key=$val" >&2
    FAILED=1
  fi
done

if [[ "$FAILED" -ne 0 ]]; then
  exit 1
fi

echo "PASS: API and Scheduler running-container source identity match"
