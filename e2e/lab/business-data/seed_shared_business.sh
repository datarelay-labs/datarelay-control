#!/usr/bin/env bash
# Seed shared deterministic business dataset into local E2E fixtures.
# Usage: ./e2e/lab/business-data/seed_shared_business.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BD="$ROOT/e2e/lab/business-data"
WM="${WIREMOCK_BASE_URL:-http://127.0.0.1:28080}"
PG_HOST="${SOURCE_E2E_PG_HOST:-127.0.0.1}"
PG_PORT="${SOURCE_E2E_PG_HOST_PORT:-55433}"
PG_USER="${SOURCE_E2E_PG_USER:-gdc_fixture}"
PG_PASS="${SOURCE_E2E_PG_PASSWORD:-gdc_fixture_pw}"
PG_DB="${SOURCE_E2E_PG_DATABASE:-gdc_query_fixture}"
MINIO_ENDPOINT="${SOURCE_E2E_MINIO_HOST_ENDPOINT:-http://127.0.0.1:59000}"
MINIO_ACCESS="${SOURCE_E2E_MINIO_ACCESS_KEY:-gdcminioaccess}"
MINIO_SECRET="${SOURCE_E2E_MINIO_SECRET_KEY:-gdcminioaccesssecret12}"
MINIO_BUCKET="${SOURCE_E2E_MINIO_BUCKET:-gdc-full-e2e}"
SFTP_HOST="${SOURCE_E2E_SFTP_HOST:-127.0.0.1}"
SFTP_PORT="${SOURCE_E2E_SFTP_HOST_PORT:-22222}"
SFTP_USER="${SOURCE_E2E_SFTP_USER:-gdc}"
SFTP_PASS="${SOURCE_E2E_SFTP_PASSWORD:-devlab123}"

echo "== generate deterministic dataset =="
python3 "$BD/generate_business_dataset.py" --out-dir "$BD"

echo "== postgres shared_business_* =="
if command -v psql >/dev/null 2>&1; then
  PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -f "$BD/postgres/shared_business_seed.sql"
else
  docker exec -i gdc-postgres-query-test \
    psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 <"$BD/postgres/shared_business_seed.sql"
fi

echo "== minio/s3 shared-business/ =="
# Prefer dockerized mc if available via minio container network
docker run --rm --network gdc-dev-validation \
  -v "$BD/s3:/data:ro" \
  --entrypoint /bin/sh minio/mc:latest -c "
    mc alias set local http://gdc-minio-test:9000 '$MINIO_ACCESS' '$MINIO_SECRET' &&
    mc mb -p local/$MINIO_BUCKET || true &&
    mc cp /data/customers.ndjson local/$MINIO_BUCKET/shared-business/customers.ndjson &&
    mc cp /data/orders.ndjson local/$MINIO_BUCKET/shared-business/orders.ndjson &&
    mc cp /data/customers.csv local/$MINIO_BUCKET/shared-business/customers.csv
  "

echo "== sftp shared-business/ =="
docker run --rm --network gdc-dev-validation \
  -v "$BD/sftp:/data:ro" \
  atmoz/sftp:alpine true >/dev/null 2>&1 || true
# Upload via sshpass/scp if present; else docker + lftp/curl sftp is awkward — use docker cp into volume via temp container
if command -v sshpass >/dev/null 2>&1; then
  sshpass -p "$SFTP_PASS" scp -o StrictHostKeyChecking=no -P "$SFTP_PORT" \
    "$BD/sftp/customers.ndjson" "$BD/sftp/orders.ndjson" "$BD/sftp/customers.csv" \
    "$SFTP_USER@$SFTP_HOST:upload/shared-business/" || {
      sshpass -p "$SFTP_PASS" ssh -o StrictHostKeyChecking=no -p "$SFTP_PORT" "$SFTP_USER@$SFTP_HOST" "mkdir -p upload/shared-business"
      sshpass -p "$SFTP_PASS" scp -o StrictHostKeyChecking=no -P "$SFTP_PORT" \
        "$BD/sftp/customers.ndjson" "$BD/sftp/orders.ndjson" "$BD/sftp/customers.csv" \
        "$SFTP_USER@$SFTP_HOST:upload/shared-business/"
    }
else
  # Fallback: copy into the named volume via a busybox helper mounted to sftp data is hard;
  # use docker exec + printf pipe into atmoz home if possible.
  docker exec gdc-sftp-test mkdir -p /home/gdc/upload/shared-business || true
  docker cp "$BD/sftp/customers.ndjson" gdc-sftp-test:/home/gdc/upload/shared-business/customers.ndjson
  docker cp "$BD/sftp/orders.ndjson" gdc-sftp-test:/home/gdc/upload/shared-business/orders.ndjson
  docker cp "$BD/sftp/customers.csv" gdc-sftp-test:/home/gdc/upload/shared-business/customers.csv
  docker exec gdc-sftp-test chown -R gdc:users /home/gdc/upload/shared-business || true
fi

echo "== wiremock shared-business + stateful stubs =="
"$ROOT/e2e/continuous/load-business-stubs.sh"
MAP_DIR="$ROOT/e2e/lab/fixtures/http/mappings/stateful"
shopt -s nullglob
for f in "$MAP_DIR"/*.json; do
  id="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['id'])" "$f")"
  curl -sS -X DELETE "$WM/__admin/mappings/$id" >/dev/null 2>&1 || true
  code="$(curl -sS -o /tmp/wm-post.json -w '%{http_code}' -X POST "$WM/__admin/mappings" -H 'Content-Type: application/json' --data-binary @"$f" || true)"
  echo "posted stateful $(basename "$f") -> $code"
done

echo "== webhook event sample (first customer event) =="
WEBHOOK_URL="${GDC_E2E_WEBHOOK_COLLECTOR_URL:-http://127.0.0.1:18192}/shared-business-seed"
head -n 1 "$BD/webhook/events.ndjson" | curl -sS -X POST "$WEBHOOK_URL" -H 'Content-Type: application/json' --data-binary @- >/dev/null || true

echo "shared business seed complete"
cat "$BD/fingerprint.txt"
