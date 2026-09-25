#!/usr/bin/env bash
# Classify PR/push changed paths for required status checks.
#
# Required workflows must always *run* on main-v2 PRs (no top-level paths filter).
# This script decides which heavy suites actually execute vs no-op SUCCESS.
#
# Usage:
#   BASE_REF=origin/main-v2 ./scripts/ci/detect-required-check-paths.sh
#   ./scripts/ci/detect-required-check-paths.sh --files-from - < filelist
#   ./scripts/ci/detect-required-check-paths.sh --files path1 path2 ...
#
# Outputs (stdout + optional $GITHUB_OUTPUT):
#   backend=true|false
#   migration=true|false
#   frontend=true|false
#   release=true|false
#   reason=<short>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

files_from=""
explicit_files=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --files-from)
      files_from="${2:-}"
      shift 2
      ;;
    --files)
      shift
      explicit_files=("$@")
      break
      ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

collect_changed_files() {
  if [[ ${#explicit_files[@]} -gt 0 ]]; then
    printf '%s\n' "${explicit_files[@]}"
    return
  fi
  if [[ -n "$files_from" ]]; then
    if [[ "$files_from" == "-" ]]; then
      cat
    else
      cat "$files_from"
    fi
    return
  fi

  local base="${BASE_REF:-}"
  if [[ -z "$base" ]]; then
    if [[ -n "${GITHUB_BASE_REF:-}" ]]; then
      base="origin/${GITHUB_BASE_REF}"
    else
      base="origin/main-v2"
    fi
  fi

  local head="${HEAD_REF:-HEAD}"
  if git rev-parse --verify "$base" >/dev/null 2>&1 && git rev-parse --verify "$head" >/dev/null 2>&1; then
    git diff --name-only "${base}...${head}"
  else
    # Conservative: unknown diff → run all required suites.
    echo "__UNKNOWN_DIFF__"
  fi
}

is_backend_path() {
  local f="$1"
  [[ "$f" == app/* ]] \
    || [[ "$f" == tests/* ]] \
    || [[ "$f" == "requirements.txt" ]] \
    || [[ "$f" == alembic/* ]] \
    || [[ "$f" == "pytest.ini" ]] \
    || [[ "$f" == docker-compose*.yml ]] \
    || [[ "$f" == "docker/Dockerfile.minio-test" ]] \
    || [[ "$f" == deploy/* ]] \
    || [[ "$f" == scripts/release/* ]] \
    || [[ "$f" == scripts/test/* ]] \
    || [[ "$f" == scripts/testing/* ]] \
    || [[ "$f" == "docs/testing/backend-full-test.md" ]] \
    || [[ "$f" == ".github/workflows/backend-tests.yml" ]] \
    || [[ "$f" == "scripts/ci/detect-required-check-paths.sh" ]]
}

is_migration_path() {
  local f="$1"
  [[ "$f" == alembic/* ]] \
    || [[ "$f" == "app/config.py" ]] \
    || [[ "$f" == "requirements.txt" ]] \
    || [[ "$f" == ".github/workflows/backend-tests.yml" ]] \
    || [[ "$f" == "scripts/ci/detect-required-check-paths.sh" ]]
}

is_frontend_path() {
  local f="$1"
  [[ "$f" == frontend/* ]] \
    || [[ "$f" == ".github/workflows/frontend-tests.yml" ]] \
    || [[ "$f" == "scripts/ci/detect-required-check-paths.sh" ]]
}

is_release_path() {
  local f="$1"
  [[ "$f" == e2e/framework/* ]] \
    || [[ "$f" == e2e/release-gate/* ]] \
    || [[ "$f" == "e2e/package.json" ]] \
    || [[ "$f" == "e2e/package-lock.json" ]] \
    || [[ "$f" == ".github/workflows/oss-v1-release-validation.yml" ]] \
    || [[ "$f" == "scripts/ci/detect-required-check-paths.sh" ]]
}

is_conservative_workflow_path() {
  local f="$1"
  [[ "$f" == ".github/workflows/backend-tests.yml" ]] \
    || [[ "$f" == ".github/workflows/frontend-tests.yml" ]] \
    || [[ "$f" == ".github/workflows/oss-v1-release-validation.yml" ]] \
    || [[ "$f" == "scripts/ci/detect-required-check-paths.sh" ]]
}

mapfile -t CHANGED < <(collect_changed_files | sed '/^$/d' | sort -u)

backend=false
migration=false
frontend=false
release=false
reason="docs_or_unrelated"

if [[ ${#CHANGED[@]} -eq 0 ]]; then
  reason="empty_diff_conservative"
  backend=true
  migration=true
  frontend=true
  release=true
elif [[ "${CHANGED[*]}" == *"__UNKNOWN_DIFF__"* ]]; then
  reason="unknown_diff_conservative"
  backend=true
  migration=true
  frontend=true
  release=true
else
  for f in "${CHANGED[@]}"; do
    if is_conservative_workflow_path "$f"; then
      reason="required_workflow_or_detector_changed"
      backend=true
      migration=true
      frontend=true
      release=true
      break
    fi
  done

  if [[ "$backend" != "true" ]]; then
    for f in "${CHANGED[@]}"; do
      if is_backend_path "$f"; then
        backend=true
      fi
      if is_migration_path "$f"; then
        migration=true
      fi
      if is_frontend_path "$f"; then
        frontend=true
      fi
      if is_release_path "$f"; then
        release=true
      fi
    done
    # Backend-impacting changes always include migration graph sanity (existing CI paired them).
    if [[ "$backend" == "true" ]]; then
      migration=true
    fi
    if [[ "$backend" == "true" || "$frontend" == "true" || "$release" == "true" || "$migration" == "true" ]]; then
      reason="path_matched"
    fi
  fi
fi

emit() {
  local key="$1"
  local value="$2"
  echo "${key}=${value}"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "${key}=${value}" >>"$GITHUB_OUTPUT"
  fi
}

emit backend "$backend"
emit migration "$migration"
emit frontend "$frontend"
emit release "$release"
emit reason "$reason"

echo "changed_files=${#CHANGED[@]}" >&2
if [[ ${#CHANGED[@]} -gt 0 && ${#CHANGED[@]} -le 40 ]]; then
  printf '  %s\n' "${CHANGED[@]}" >&2
fi
