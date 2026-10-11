# Air-gapped offline installation

Build and transfer an offline reinstall package for production hosts without internet access.

## Build (connected development system)

```bash
./scripts/build-offline-package.sh
```

Outputs:

- `offline-release/` — exploded package
- `offline-release-<version>.tar.gz` — transport archive
- `offline-release-<version>.tar.gz.sha256` — checksum

Options:

| Variable | Purpose |
|----------|---------|
| `GDC_OFFLINE_SKIP_BUILD=1` | Repackage existing `:offline` images without rebuilding |
| `GDC_OFFLINE_IMAGE_TAG` | Image tag (default: `offline`) |
| `GDC_OFFLINE_SKIP_DOCKER_DEBS=1` | Skip downloading Docker `.deb` bundle |
| `GDC_OFFLINE_OUTPUT_DIR` | Output directory (default: `./offline-release`) |

The build downloads Docker Engine `.deb` files into `packages/docker/debs/` (Ubuntu 24.04).

Operator validation checklist: `docs/deployment/offline-install-validation.md` (also copied into the offline package under `docs/`).

## Install (air-gapped production host)

See `offline-release/README-OFFLINE-INSTALL.md` inside the package after extraction.

Quick sequence:

```bash
tar -xzf offline-release-*.tar.gz
cd offline-release
sudo scripts/install-docker-offline.sh   # when Docker is not installed
# Only for an approved fresh reinstall that intentionally deletes existing data:
# scripts/reset-production-data.sh   # interactive YES; no backup is created
scripts/install-offline.sh            # keeps existing DB volumes by default
checks/verify-install.sh
```

## Stack definition

Production offline installs use `deploy/docker-compose.offline.yml` (copied to `configs/` in the package):

- Pre-loaded images only (`pull_policy: never`)
- No dev-validation fixtures
- `APP_ENV=production`, `ENABLE_DEV_VALIDATION_LAB=false`

## Related docs

- `docs/deployment/install-guide.md` — online install (`scripts/release/install.sh`)
- `docs/deployment/upgrade-guide.md` — in-place upgrade with backup
