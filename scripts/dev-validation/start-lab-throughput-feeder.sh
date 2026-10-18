#!/usr/bin/env bash
# Start continuous lab throughput feeder (foreground). Requires platform API + fixtures.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PYTHONPATH="$ROOT"
export LAB_THROUGHPUT_API_BASE_URL="${LAB_THROUGHPUT_API_BASE_URL:-http://127.0.0.1:8000}"
# The Webhook feeder uses this API. A rotated preview port can silently starve
# the receiver while other fixture families continue to send events.
if ! curl --fail --silent --show-error --connect-timeout 2 --max-time 5   "$LAB_THROUGHPUT_API_BASE_URL/health" >/dev/null; then
  echo "LAB_THROUGHPUT_API_UNAVAILABLE: verify LAB_THROUGHPUT_API_BASE_URL and the currently served development API /health before starting the feeder" >&2
  exit 69
fi
exec python3 -m app.dev_validation_lab.lab_throughput_feeder "$@"
