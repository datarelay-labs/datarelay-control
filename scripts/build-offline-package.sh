#!/usr/bin/env bash
# Build an air-gapped offline installation package.
# Output:
#   offline-release/
#     └── offline_install/
#   offline-release-<version>.tar.gz (+ .sha256)
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OFFLINE_DIR="${GDC_OFFLINE_OUTPUT_DIR:-$ROOT/offline-release}"
INSTALL_DIR="$OFFLINE_DIR/offline_install"
VERSION="$(date -u +%Y%m%dT%H%M%SZ)"
if command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --short HEAD >/dev/null 2>&1; then
  VERSION="${VERSION}-$(git -C "$ROOT" rev-parse --short HEAD)"
fi
ARCHIVE_NAME="offline-release-${VERSION}.tar.gz"

declare -a IMAGE_REFS=(
  "postgres:16-alpine"
  "gdc-platform-api:offline"
  "gdc-platform-frontend:offline"
  "gdc-platform-reverse-proxy:offline"
)

die() { echo "ERROR: $*" >&2; exit 1; }

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker not found"
  docker compose version >/dev/null 2>&1 || die "docker compose plugin not found"
  docker info >/dev/null 2>&1 || die "docker daemon not reachable"
}

build_images() {
  # Match docker-compose.platform.yml shared runtime image + identity build args.
  local runtime_image="gdc-platform-runtime:${GDC_RUNTIME_IMAGE_TAG:-local}"

  if [[ -z "${GDC_BUILD_GIT_SHA:-}" ]] && command -v git >/dev/null 2>&1; then
    export GDC_BUILD_GIT_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
  fi
  if [[ -z "${GDC_BUILD_GIT_DIRTY:-}" ]] && command -v git >/dev/null 2>&1; then
    if [[ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null || true)" ]]; then
      export GDC_BUILD_GIT_DIRTY=true
    else
      export GDC_BUILD_GIT_DIRTY=false
    fi
  fi
  if [[ -z "${GDC_BUILD_SOURCE_DIGEST:-}" ]]; then
    export GDC_BUILD_SOURCE_DIGEST="$(
      PYTHONPATH="$ROOT" python3 - <<'PY' 2>/dev/null || true
from app.build_identity import compute_build_source_digest
print(compute_build_source_digest())
PY
    )"
  fi
  export GDC_BUILD_TIME="${GDC_BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
  export GDC_BUILD_WORKTREE="${GDC_BUILD_WORKTREE:-$ROOT}"

  echo "[build] Building offline images (shared runtime api, frontend, reverse-proxy)..."
  echo "[build] runtime_image=${runtime_image} git_sha=${GDC_BUILD_GIT_SHA:-unknown} dirty=${GDC_BUILD_GIT_DIRTY:-unknown}"
  docker compose -f docker-compose.platform.yml build api frontend reverse-proxy

  echo "[build] Tagging images as :offline..."
  docker tag "$runtime_image" gdc-platform-api:offline
  docker tag gdc-platform-frontend gdc-platform-frontend:offline
  docker tag gdc-platform-reverse-proxy gdc-platform-reverse-proxy:offline

  echo "[build] Pulling postgres:16-alpine (if needed)..."
  docker pull postgres:16-alpine
}

stage_package_tree() {
  echo "[stage] Preparing $INSTALL_DIR ..."
  rm -rf "$OFFLINE_DIR"
  mkdir -p \
    "$INSTALL_DIR/images" \
    "$INSTALL_DIR/docker-debs" \
    "$INSTALL_DIR/checksums"

  cp "$ROOT/scripts/offline/templates/offline_install/install.sh" "$INSTALL_DIR/install.sh"
  cp "$ROOT/scripts/offline/templates/offline_install/reset.sh" "$INSTALL_DIR/reset.sh"
  cp "$ROOT/scripts/offline/templates/offline_install/verify.sh" "$INSTALL_DIR/verify.sh"
  cp "$ROOT/scripts/offline/templates/offline_install/install-docker.sh" "$INSTALL_DIR/install-docker.sh"
  cp "$ROOT/scripts/offline/templates/offline_install/load-images.sh" "$INSTALL_DIR/load-images.sh"
  cp "$ROOT/scripts/offline/templates/offline_install/docker-compose.offline.yml" "$INSTALL_DIR/docker-compose.offline.yml"
  cp "$ROOT/scripts/offline/templates/offline_install/.env" "$INSTALL_DIR/.env"
  cp "$ROOT/scripts/offline/templates/offline_install/README.md" "$INSTALL_DIR/README.md"

  if [[ "${GDC_OFFLINE_SKIP_DOCKER_DEBS:-0}" == "1" ]]; then
    die "GDC_OFFLINE_SKIP_DOCKER_DEBS=1 is not allowed for production offline packages."
  fi
  echo "[stage] Collecting Docker .deb bundle (Ubuntu 24.04)..."
  bash "$ROOT/scripts/offline/collect-docker-debs.sh" "$INSTALL_DIR/docker-debs"

  if [[ -f "$INSTALL_DIR/DEBS.manifest" ]]; then
    cp "$INSTALL_DIR/DEBS.manifest" "$INSTALL_DIR/checksums/DEBS.manifest"
    rm -f "$INSTALL_DIR/DEBS.manifest"
  fi
  rm -f "$INSTALL_DIR/VERSION.docker" "$INSTALL_DIR/README.md.bak"

  cat >"$OFFLINE_DIR/VERSION" <<EOF
version=${VERSION}
image_tag=offline
built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
built_on=$(hostname 2>/dev/null || echo unknown)
git_commit=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)
EOF
}

export_images() {
  echo "[export] Saving Docker images to $INSTALL_DIR/images ..."
  : >"$INSTALL_DIR/checksums/IMAGES.manifest"
  local ref base
  for ref in "${IMAGE_REFS[@]}"; do
    docker image inspect "$ref" >/dev/null 2>&1 || die "Image not found locally: $ref"
    base="${ref//[:\/]/_}"
    echo "[export]   $ref -> ${base}.tar"
    docker save -o "$INSTALL_DIR/images/${base}.tar" "$ref"
    echo "$ref" >>"$INSTALL_DIR/checksums/IMAGES.manifest"
  done
}

write_checksums() {
  echo "[checksum] Writing offline_install/checksums/SHA256SUMS ..."
  (
    cd "$INSTALL_DIR"
    find . -type f ! -path './checksums/SHA256SUMS' -print0 | sort -z | xargs -0 sha256sum
  ) >"$INSTALL_DIR/checksums/SHA256SUMS"
}

chmod_scripts() {
  chmod +x \
    "$INSTALL_DIR/install.sh" \
    "$INSTALL_DIR/reset.sh" \
    "$INSTALL_DIR/verify.sh" \
    "$INSTALL_DIR/install-docker.sh" \
    "$INSTALL_DIR/load-images.sh"
}

create_archive() {
  echo "[archive] Creating $ARCHIVE_NAME ..."
  tar -C "$(dirname "$OFFLINE_DIR")" -czf "$ROOT/$ARCHIVE_NAME" "$(basename "$OFFLINE_DIR")"
  sha256sum "$ROOT/$ARCHIVE_NAME" >"$ROOT/${ARCHIVE_NAME}.sha256"
}

main() {
  require_docker

  if [[ "${GDC_OFFLINE_SKIP_BUILD:-0}" != "1" ]]; then
    build_images
  else
    echo "[build] Skipping image build (GDC_OFFLINE_SKIP_BUILD=1)"
    for ref in "${IMAGE_REFS[@]}"; do
      docker image inspect "$ref" >/dev/null 2>&1 || die "Missing image for repackage: $ref"
    done
  fi

  stage_package_tree
  export_images
  chmod_scripts
  write_checksums
  create_archive

  echo ""
  echo "============================================================"
  echo "Offline package ready"
  echo "============================================================"
  echo "Directory:  $OFFLINE_DIR"
  echo "Install dir: $INSTALL_DIR"
  echo "Archive:    $ROOT/$ARCHIVE_NAME"
  echo "Checksum:   $ROOT/${ARCHIVE_NAME}.sha256"
  echo ""
  echo "Air-gapped operator commands:"
  echo "  offline_install/reset.sh"
  echo "  offline_install/install.sh"
  echo "  offline_install/verify.sh"
}

main "$@"
