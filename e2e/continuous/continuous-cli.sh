#!/usr/bin/env bash
# Continuous E2E CLI — validate / tick / report / ensure / teardown
# Usage:
#   ./e2e/continuous/continuous-cli.sh validate|tick|report|ensure|teardown [--force] [--dry-run]

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E="$ROOT/e2e"
CMD="${1:-}"
shift || true

cd "$E2E"
case "$CMD" in
  validate)
    npx tsx continuous/cli.ts validate "$@"
    ;;
  tick)
    npx tsx continuous/cli.ts tick "$@"
    ;;
  report)
    npx tsx continuous/cli.ts report "$@"
    ;;
  ensure)
    npx tsx continuous/cli.ts ensure "$@"
    ;;
  teardown)
    npx tsx continuous/cli.ts teardown "$@"
    ;;
  *)
    cat <<EOF
Usage: $0 {validate|tick|report|ensure|teardown} [options]
EOF
    exit 2
    ;;
esac
