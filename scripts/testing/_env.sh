# shellcheck shell=bash
# Source from other scripts in this directory (not executed standalone).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
export GDC_REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
export COMPOSE_PROFILES="${COMPOSE_PROFILES:-test}"
export GDC_TEST_COMPOSE_FILE="${GDC_TEST_COMPOSE_FILE:-$GDC_REPO_ROOT/docker-compose.test.yml}"
# Distinct from full-e2e-lab / platform fixtures that use the bare "gdc-" prefix.
export GDC_TEST_CONTAINER_PREFIX="${GDC_TEST_CONTAINER_PREFIX:-gdc-smoke}"
export GDC_TEST_COMPOSE_PROJECT="${GDC_TEST_COMPOSE_PROJECT:-gdc-platform-test}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$GDC_TEST_COMPOSE_PROJECT}"
export GDC_TEST_POSTGRES_HOST_PORT="${GDC_TEST_POSTGRES_HOST_PORT:-55441}"
export GDC_TEST_WIREMOCK_HOST_PORT="${GDC_TEST_WIREMOCK_HOST_PORT:-28080}"
export GDC_TEST_SFTP_HOST_PORT="${GDC_TEST_SFTP_HOST_PORT:-22222}"
export SOURCE_E2E_SFTP_PORT="${SOURCE_E2E_SFTP_PORT:-$GDC_TEST_SFTP_HOST_PORT}"
# Keep docker cp / fixture helpers aligned with compose container_name prefix.
# Runners that reuse a fixture owned by another compose project must override
# SOURCE_E2E_SFTP_CONTAINER after resolving the actual published-port owner.
export SOURCE_E2E_SFTP_CONTAINER="${SOURCE_E2E_SFTP_CONTAINER:-${GDC_TEST_CONTAINER_PREFIX}-sftp-test}"
export SOURCE_E2E_PG_FIXTURE_CONTAINER="${SOURCE_E2E_PG_FIXTURE_CONTAINER:-${GDC_TEST_CONTAINER_PREFIX}-postgres-query-test}"
export TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgresql://gdc:gdc@127.0.0.1:${GDC_TEST_POSTGRES_HOST_PORT}/gdc_pytest}"
export WIREMOCK_BASE_URL="${WIREMOCK_BASE_URL:-http://127.0.0.1:${GDC_TEST_WIREMOCK_HOST_PORT}}"
