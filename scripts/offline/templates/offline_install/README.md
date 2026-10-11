# Data Relay Offline Install

This package is designed for air-gapped environments.
Operators only use the `offline_install/` directory.

## Directory

```text
offline_install/
├ install.sh
├ reset.sh
├ verify.sh
├ install-docker.sh
├ load-images.sh
├ docker-compose.offline.yml
├ .env
├ README.md
├ images/
├ docker-debs/
└ checksums/
```

## Operator Commands (only 3)

```bash
./offline_install/reset.sh
./offline_install/install.sh
./offline_install/verify.sh
```

## Pre-install Validation

```bash
./offline_install/install.sh --help
./offline_install/install.sh --dry-run
```

`--dry-run` validates package readiness only and exits without installation actions.
It checks:
- `REQUIRED_FILES`
- `REQUIRED_IMAGES` tar payload
- `REQUIRED_DEBS`
- `checksums/SHA256SUMS`
- `docker compose config -q`
- external published port policy (`18080` only)

## Operator Procedure (4 Steps)

Follow this exact order on the air-gapped operation server.

### 1) Pre-validation

```bash
sha256sum -c offline-release-*.tar.gz.sha256
tar -xzf offline-release-*.tar.gz
cd offline-release
./offline_install/install.sh --dry-run
```

Expected result:
- archive checksum verification is `OK`
- package extraction succeeds
- dry-run ends with `Dry-run validation PASS`

### Operator-owned environment (required before install)

The package ships .env as a copy of .env.production.template with
**non-production placeholders**. Review and replace all database, JWT, encryption,
proxy reload and application secret placeholders in offline_install/.env before
installing or exposing the service. Keep this private file out of version control
and restrict its permissions (chmod 600 offline_install/.env). The immutable
.env.production.template is covered by SHA256SUMS; operator-owned .env is
intentionally excluded, so editing actual credentials does not invalidate
package integrity. The package SHA256 is **not a publisher signature**.

**The --dry-run checks package integrity and Compose shape; it does not
certify that operator credentials, restore plan or signatures are ready.**

### 2) Delete existing data

```bash
./offline_install/reset.sh
```

Expected result:
- script asks for `YES` confirmation
- only `gdc-platform` containers/volume/network are removed

### 3) Install

```bash
./offline_install/install.sh
```

Expected result:
- required files/images/debs/checksums pass
- Docker is installed automatically if missing
- images are loaded, compose stack starts, DB migration completes

### 4) Installation verification

```bash
./offline_install/verify.sh
```

Expected result:
- verification checks pass (`PASS` lines)
- script exits successfully (no failure summary)

## Access URL

- Default URL: `http://<운영서버IP>:18080/`
- Externally exposed port: `18080` only

## Notes

- `install.sh` performs full offline install:
  - required file/image/deb validation
  - Docker install (if missing)
  - Docker daemon start
  - image load + manifest check
  - `docker compose up -d`
  - DB migration
  - health checks
- `reset.sh` removes only `gdc-platform` resources.
- `verify.sh` validates runtime and connectivity checks.
