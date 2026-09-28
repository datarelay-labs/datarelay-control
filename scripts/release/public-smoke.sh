#!/usr/bin/env bash
# Candidate-bound, disposable public smoke. Never reuses the operator platform stack.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE="$ROOT/docker-compose.platform.yml"

raw_run_id="${GDC_PUBLIC_SMOKE_RUN_ID:-${GITHUB_RUN_ID:-$$}}"
run_id="$(printf '%s' "$raw_run_id" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
[[ -n "$run_id" ]] || run_id="$$"

project="${GDC_PUBLIC_SMOKE_PROJECT:-gdc-public-smoke-$run_id}"
prefix="${GDC_PUBLIC_SMOKE_CONTAINER_PREFIX:-$project}"
default_network="${GDC_PUBLIC_SMOKE_DEFAULT_NETWORK:-${project}_default}"
dev_network="${GDC_PUBLIC_SMOKE_DEV_NETWORK:-${project}_dev_validation}"
env_file="${GDC_PUBLIC_SMOKE_ENV_FILE:-$ROOT/.env.public-smoke-$run_id}"
runtime_tag="${GDC_PUBLIC_SMOKE_RUNTIME_TAG:-public-smoke-$run_id}"

if [[ -e "$env_file" ]]; then
  echo "ERROR: public-smoke env file already exists: $env_file" >&2
  exit 2
fi
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1   && docker network inspect "$dev_network" >/dev/null 2>&1; then
  echo "ERROR: public-smoke network already exists: $dev_network" >&2
  exit 2
fi

if [[ -n "$(git -C "$ROOT" status --porcelain=v1)" ]]; then
  echo "ERROR: public smoke requires a clean worktree so baked provenance is exact." >&2
  exit 2
fi

read -r pg_port api_port http_port https_port < <(
  python3 - <<'PY'
import socket
socks = []
ports = []
try:
    for _ in range(4):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        socks.append(s)
        ports.append(s.getsockname()[1])
    print(*ports)
finally:
    for s in socks:
        s.close()
PY
)

export COMPOSE_PROJECT_NAME="$project"
export GDC_PLATFORM_CONTAINER_PREFIX="$prefix"
export GDC_PLATFORM_DEFAULT_NETWORK_NAME="$default_network"
export GDC_DEV_VALIDATION_NETWORK_NAME="$dev_network"
export GDC_RELEASE_ENV_FILE="$env_file"
export GDC_PLATFORM_ENV_PATH="$env_file"
export GDC_RUNTIME_IMAGE_TAG="$runtime_tag"
export GDC_PLATFORM_POSTGRES_HOST_PORT="${GDC_PUBLIC_SMOKE_POSTGRES_PORT:-$pg_port}"
export GDC_API_HOST_PORT="${GDC_PUBLIC_SMOKE_API_PORT:-$api_port}"
export GDC_HTTP_PORT="${GDC_PUBLIC_SMOKE_HTTP_PORT:-$http_port}"
export GDC_HTTPS_PORT="${GDC_PUBLIC_SMOKE_HTTPS_PORT:-$https_port}"
export GDC_PUBLIC_HTTPS_PORT="$GDC_HTTPS_PORT"

# The install path creates this unique external network after Docker is ready.
# It cannot belong to the normal operator stack because the name is run-scoped.
network_created=1
cleanup() {
  rc=$?
  trap - EXIT INT TERM
  set +e
  COMPOSE_ENV_FILES="$env_file" docker compose -p "$project" -f "$COMPOSE" down -v --remove-orphans >/dev/null 2>&1
  if [[ "$network_created" -eq 1 ]]; then
    docker network rm "$dev_network" >/dev/null 2>&1 || true
  fi
  docker image rm "gdc-platform-runtime:$runtime_tag" >/dev/null 2>&1 || true
  rm -f "$env_file"
  exit "$rc"
}
trap cleanup EXIT INT TERM

echo "Public smoke isolation:"
echo "  project=$project"
echo "  container_prefix=$prefix"
echo "  default_network=$default_network"
echo "  dev_network=$dev_network"
echo "  ports=postgres:$GDC_PLATFORM_POSTGRES_HOST_PORT api:$GDC_API_HOST_PORT http:$GDC_HTTP_PORT https:$GDC_HTTPS_PORT"

cd "$ROOT"
GDC_RELEASE_COMPOSE_FILE=docker-compose.platform.yml   bash scripts/release/install.sh --build

health_json="$(curl -fsS "http://127.0.0.1:$GDC_HTTP_PORT/health")"
expected_sha="$(git rev-parse HEAD)"

HEALTH_JSON="$health_json" python3 - "$expected_sha" <<'PY'
import json
import os
import sys

data = json.loads(os.environ["HEALTH_JSON"])
identity = data.get("build_identity") or {}
actual_sha = str(identity.get("git_sha") or "")
dirty = identity.get("git_dirty")
expected_sha = sys.argv[1]

if actual_sha != expected_sha:
    raise SystemExit(f"public-smoke build identity mismatch: expected {expected_sha}, got {actual_sha or '<missing>'}")
if dirty is not False:
    raise SystemExit(f"public-smoke build identity is not clean: git_dirty={dirty!r}")
print(f"Public smoke build identity: git_sha={actual_sha} dirty=false")
PY

echo "PUBLIC_SMOKE=PASS"
