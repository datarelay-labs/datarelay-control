#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

COMPOSE_FILE="$SCRIPT_DIR/docker-compose.offline.yml"
ENV_FILE="$SCRIPT_DIR/.env"
IMAGES_DIR="$SCRIPT_DIR/images"
DOCKER_DEBS_DIR="$SCRIPT_DIR/docker-debs"
CHECKSUMS_DIR="$SCRIPT_DIR/checksums"
DRY_RUN=0
LOG_FILE=""

REQUIRED_FILES=(
  "install.sh"
  "reset.sh"
  "verify.sh"
  "install-docker.sh"
  "load-images.sh"
  "docker-compose.offline.yml"
  ".env"
  ".env.production.template"
  "README.md"
  "checksums/SHA256SUMS"
  "checksums/IMAGES.manifest"
  "checksums/DEBS.manifest"
)

REQUIRED_IMAGES=(
  "postgres:16-alpine"
  "gdc-platform-api:offline"
  "gdc-platform-frontend:offline"
  "gdc-platform-reverse-proxy:offline"
)

REQUIRED_DEBS=(
  "containerd.io_*.deb"
  "docker-ce_*.deb"
  "docker-ce-cli_*.deb"
  "docker-buildx-plugin_*.deb"
  "docker-compose-plugin_*.deb"
)

die() { echo "ERROR: $*" >&2; exit 1; }
ts() { date '+%Y-%m-%d %H:%M:%S'; }

init_logging() {
  local log_dir="$SCRIPT_DIR/logs"
  mkdir -p "$log_dir"
  LOG_FILE="$log_dir/install-$(date +%Y%m%d-%H%M%S).log"
  exec > >(tee -a "$LOG_FILE") 2>&1
  echo "[$(ts)] Logging to $LOG_FILE"
}

compose() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

usage() {
  cat <<'EOF'
Usage: install.sh [OPTION]

Options:
  --dry-run   Validate package readiness only, then exit.
              Does NOT install Docker, load images, start/stop containers, or run migrations.
  --help      Show this help message.

Dry-run checks:
  - REQUIRED_FILES
  - REQUIRED_IMAGES tar payload
  - REQUIRED_DEBS
  - SHA256SUMS
  - docker compose config
  - published port policy (only 18080)
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) DRY_RUN=1; shift ;;
      --help|-h) usage; exit 0 ;;
      *) die "Unknown option: $1 (use --help)" ;;
    esac
  done
}

ref_to_archive_name() {
  local ref="$1"
  echo "${ref//[:\/]/_}.tar"
}

check_required_files() {
  echo "[$(ts)] Checking REQUIRED_FILES ..."
  local missing=0 item
  for item in "${REQUIRED_FILES[@]}"; do
    if [[ -f "$SCRIPT_DIR/$item" ]]; then
      echo "OK   $item"
    else
      echo "MISS $item"
      missing=$((missing + 1))
    fi
  done
  [[ "$missing" -eq 0 ]] || die "REQUIRED_FILES check failed (${missing} missing)."
}

check_required_images_payload() {
  echo "[$(ts)] Checking REQUIRED_IMAGES payload ..."
  [[ -d "$IMAGES_DIR" ]] || die "Missing images directory: $IMAGES_DIR"
  local missing=0 ref tar_name
  for ref in "${REQUIRED_IMAGES[@]}"; do
    tar_name="$(ref_to_archive_name "$ref")"
    if [[ -f "$IMAGES_DIR/$tar_name" ]]; then
      echo "OK   images/$tar_name"
    else
      echo "MISS images/$tar_name"
      missing=$((missing + 1))
    fi
  done
  [[ "$missing" -eq 0 ]] || die "REQUIRED_IMAGES payload check failed (${missing} missing tar files)."
}

check_required_debs() {
  echo "[$(ts)] Checking REQUIRED_DEBS ..."
  [[ -d "$DOCKER_DEBS_DIR" ]] || die "Missing docker-debs directory: $DOCKER_DEBS_DIR"
  local missing=0 pattern matches
  shopt -s nullglob
  for pattern in "${REQUIRED_DEBS[@]}"; do
    matches=("$DOCKER_DEBS_DIR"/$pattern)
    if [[ "${#matches[@]}" -gt 0 ]]; then
      echo "OK   docker-debs/$pattern"
    else
      echo "MISS docker-debs/$pattern"
      missing=$((missing + 1))
    fi
  done
  [[ "$missing" -eq 0 ]] || die "REQUIRED_DEBS check failed (${missing} missing pattern groups)."
}

check_sha256sums() {
  echo "[$(ts)] Verifying checksums/SHA256SUMS ..."
  (
    cd "$SCRIPT_DIR"
    sha256sum -c checksums/SHA256SUMS >/dev/null
  ) || die "SHA256SUMS verification failed."
  echo "OK   SHA256SUMS"
}

check_compose_config() {
  echo "[$(ts)] Checking docker-compose config ..."
  command -v docker >/dev/null 2>&1 || die "docker command not found for compose config validation."
  docker compose version >/dev/null 2>&1 || die "docker compose plugin not found."
  compose config -q || die "docker compose config validation failed."
  echo "OK   docker compose config -q"
}

check_published_port_policy() {
  echo "[$(ts)] Checking published port policy ..."
  local published_ports
  published_ports="$(
    compose config 2>/dev/null \
      | awk '
          $1=="ports:" {in_ports=1; next}
          in_ports && $1=="-" && $2=="mode:" {next}
          in_ports && $1=="published:" {gsub(/"/,"",$2); print $2; next}
          in_ports && $1 !~ /^(published:|target:|protocol:|mode:)$/ && $1!="-" {in_ports=0}
        '
  )"

  if [[ -z "$published_ports" ]]; then
    die "No published port found; expected exactly 18080."
  fi

  local unique
  unique="$(echo "$published_ports" | sort -u)"
  if [[ "$unique" == "18080" ]]; then
    echo "OK   published ports: 18080 only"
    return 0
  fi
  echo "FOUND published ports:"
  echo "$unique" | sed 's/^/  - /'
  die "Published port policy failed. Only 18080 is allowed."
}

docker_ready() {
  command -v docker >/dev/null 2>&1 \
    && docker compose version >/dev/null 2>&1 \
    && docker info >/dev/null 2>&1
}

ensure_docker() {
  if docker_ready; then
    echo "[$(ts)] Docker engine and Compose v2 detected."
    return 0
  fi

  echo "[$(ts)] Docker not ready. Installing from docker-debs ..."
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    bash "$SCRIPT_DIR/install-docker.sh"
  elif command -v sudo >/dev/null 2>&1; then
    sudo -E bash "$SCRIPT_DIR/install-docker.sh"
  else
    die "Docker missing and sudo not available. Run as root: ./offline_install/install-docker.sh"
  fi
}

ensure_daemon_running() {
  if docker info >/dev/null 2>&1; then
    return 0
  fi
  echo "[$(ts)] Starting Docker daemon ..."
  if command -v systemctl >/dev/null 2>&1; then
    if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
      systemctl start docker || true
    else
      sudo systemctl start docker || true
    fi
  fi
  for _ in $(seq 1 20); do
    docker info >/dev/null 2>&1 && return 0
    sleep 2
  done
  die "Docker daemon is not reachable."
}

load_images() {
  echo "[$(ts)] Loading Docker images ..."
  bash "$SCRIPT_DIR/load-images.sh"
}

verify_images_loaded() {
  echo "[$(ts)] Verifying REQUIRED_IMAGES in local Docker ..."
  local missing=0 ref
  for ref in "${REQUIRED_IMAGES[@]}"; do
    if docker image inspect "$ref" >/dev/null 2>&1; then
      echo "OK   $ref"
    else
      echo "MISS $ref"
      missing=$((missing + 1))
    fi
  done
  [[ "$missing" -eq 0 ]] || die "Required images are not fully loaded (${missing} missing)."
}

ensure_env_exists() {
  [[ -f "$ENV_FILE" ]] || die "Missing .env file: $ENV_FILE"
}

start_stack() {
  echo "[$(ts)] Starting stack (docker compose up -d) ..."
  compose up -d
}

wait_postgres() {
  local user db
  user="$(awk -F= '/^POSTGRES_USER=/{print $2}' "$ENV_FILE" | tail -n 1)"
  db="$(awk -F= '/^POSTGRES_DB=/{print $2}' "$ENV_FILE" | tail -n 1)"
  [[ -n "$user" ]] || user="gdc"
  [[ -n "$db" ]] || db="gdc"

  echo "[$(ts)] Waiting for PostgreSQL readiness ..."
  for _ in $(seq 1 45); do
    if compose exec -T postgres pg_isready -U "$user" -d "$db" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  die "PostgreSQL did not become ready."
}

run_migrations() {
  echo "[$(ts)] Running DB migration ..."
  compose run --rm --no-deps api alembic upgrade head
}

seed_admin() {
  echo "[$(ts)] Seeding platform admin (create-only) ..."
  compose run --rm --no-deps api python -m app.db.seed --platform-admin-only
}

health_check() {
  echo "[$(ts)] Running health check ..."
  local ok=0
  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:18080/health" >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 3
  done
  [[ "$ok" -eq 1 ]] || die "Health check failed: http://127.0.0.1:18080/health"
}

print_result() {
  local host
  host="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [[ -n "$host" ]] || host="<host>"

  echo ""
  echo "============================================================"
  echo "Offline installation complete"
  echo "============================================================"
  echo "Access URL: http://${host}:18080/"
  echo "Verify now: ./offline_install/verify.sh"
  echo ""
}

main() {
  init_logging
  parse_args "$@"

  echo "============================================================"
  echo "Data Relay offline install"
  echo "============================================================"
  echo "Root: $SCRIPT_DIR"
  [[ "$DRY_RUN" -eq 1 ]] && echo "Mode: dry-run (validation only)"
  echo ""

  check_required_files
  check_required_images_payload
  check_required_debs
  check_sha256sums
  check_compose_config
  check_published_port_policy

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo ""
    echo "Dry-run validation PASS. No installation actions were executed."
    exit 0
  fi

  ensure_docker
  ensure_daemon_running
  load_images
  verify_images_loaded
  ensure_env_exists

  start_stack
  wait_postgres
  run_migrations
  seed_admin
  health_check
  print_result
}

main "$@"
